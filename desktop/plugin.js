// talk-desktop — Live Voice v21. Default engine: Codex Live-1 (gpt-live-1, subscription), with
// OpenAI Realtime (gpt-realtime-2.1, stored as 'hermes') and Hermes Live (Hermes' own GPT-Live) as alternatives.
// No floating window: button + button popover.
// v21: follow-window bot selection, hardened delegation, microphone test, iMessage-style transcript bubbles.
// Config: gear beside the mic → native Desktop Popover (its own portal, no clipping) with native Selects.
// Waveform: bars react to real WebAudio spectrum + WebRTC getStats level fallback — never random.
// Live: navy circle, soft blue ring; hover → red (hang up). Loading: rotating blue ring.
// Live transcript (oai-events channel), voice tools (/tool relay), Codex usage in settings.
// Connect/hangup chimes. Floating widget + pane share the same form.
// ALLOWED IMPORTS: 'react', 'react/jsx-runtime', '@hermes/plugin-sdk' (nothing else).
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useRef } from 'react'
import * as sdk from '@hermes/plugin-sdk'

const {
  Popover, PopoverContent, PopoverTrigger, Dialog, DialogContent, DialogTitle,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  host, Switch, Button
} = sdk

const KEY_VOICE = 'voice.v3'
const KEY_MIC = 'mic.v3'
const KEY_OUT = 'out.v3'
const KEY_CHAT = 'chatwork.v1'
const KEY_ASK_CHAT = 'askBeforeChat.v1'
const KEY_ENGINE = 'engine.v1'
const askBeforeChat = ctx => (ctx.storage.get(KEY_CHAT) || '1') !== '0' && (ctx.storage.get(KEY_ASK_CHAT) || '1') !== '0'
const VOICES = ['marin', 'cedar', 'alloy', 'echo', 'shimmer', 'verse', 'sage', 'ballad']
const V3_VOICES = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol']
const effVoiceFor = (engine, stored) => {
  const v = String(stored || '')
  if (engine === 'codex') return V3_VOICES.indexOf(v) >= 0 ? v : 'sol'
  return VOICES.indexOf(v) >= 0 ? v : 'marin'
}
const SENTINEL_DEFAULT = '__default'
// Built-in UI, messages, and request language are English in every browser locale.

// Allowance: Codex voice in Desktop uses a rolling 5-hour window, per plan.
// Source: learn.chatgpt.com/docs/pricing (Plus ~15-30 min; Pro 5x ~1-2.5 h; Pro 20x unlimited).
const VOICE_CAP_MIN = plan => {
  const p = String(plan || '').toLowerCase()
  if (p.indexOf('plus') >= 0) return [15, 30]
  if (p.indexOf('business') >= 0 || p.indexOf('enterprise') >= 0 || p.indexOf('edu') >= 0) return [45, 45]
  if (p.indexOf('pro') >= 0) return [60, 150]
  return null
}
const SB = 'var(--popover-surface, #ffffff)'

// The transcript's bot speaker. Hermes itself is the default profile; only a named bot gets the tag.
const botSpeaker = () => { const name = String(bus.botName || '').trim(); return !name || name === 'Hermes' ? 'Hermes' : name + ' (Bot)' }

const bus = {
  live: false, stage: 'idle', micLevel: 0, remoteLevel: 0, widget: false, err: '', muted: false,
  bands: [0, 0, 0, 0, 0, 0], remBands: [0, 0, 0, 0, 0, 0], transcriptRev: 0, spkUser: false, spkBot: false, botName: '',
  emit() {
    try {
      window.dispatchEvent(new CustomEvent('talk-desktop:state', { detail: {
        live: this.live, stage: this.stage, micLevel: this.micLevel, remoteLevel: this.remoteLevel, muted: this.muted,
        widget: this.widget, err: this.err, bands: this.bands, remBands: this.remBands,
        transcriptRev: this.transcriptRev, spkUser: this.spkUser, spkBot: this.spkBot
      } }))
    } catch {}
  },
  set(patch) { Object.assign(this, patch); this.emit() }
}

// ── Session transcript (shared by widget and pane) ────────────────────────

let transcript = []
let liveAudioMs = 0
let handoffMode = 'client'
let _delegBusy = false
let _delegQueue = null
let _lastAppendedId = ''
let _bumpTimer = null
function _bumpTranscript() {
  if (_bumpTimer) return
  _bumpTimer = setTimeout(() => { _bumpTimer = null; bus.set({ transcriptRev: (bus.transcriptRev || 0) + 1 }) }, 110)
}
function _lastOpen(role) {
  for (let i = transcript.length - 1; i >= Math.max(0, transcript.length - 6); i--) {
    if (transcript[i].role === role && !transcript[i].done) return transcript[i]
  }
  return null
}
function _recentOpen(role, now) {
  for (let i = transcript.length - 1; i >= Math.max(0, transcript.length - 6); i--) {
    const it = transcript[i]
    if (it.role === role) {
      if (it.done) return null
      return (now - (it.at || 0) < GAP_MS) ? it : null
    }
  }
  return null
}
// The v3 lane rotates turns and sends fragments (partial turn.done with 1-2 words):
// NEVER shrink or close a bubble on turn.done (that caused duplicate text
// and apparent editing). A bubble CONTINUES while same-role deltas arrive within
// GAP_MS of each other (burst-resistant); otherwise a new one opens.
// IDLE_MS only controls brightness (done=false paints at 72%).
const GAP_MS = 3500
const IDLE_MS = 8000
function _push(role, text, done) {
  transcript.push({ role: role, text: text, done: !!done, at: Date.now() })
  if (transcript.length > 240) transcript = transcript.slice(-240)
  _bumpTranscript()
}
function pushTranscript(role, text) {
  const raw = String(text == null ? '' : text)
  const now = Date.now()
  const open = role === 'bot' ? _recentOpen('bot', now) : null
  if (open) { open.text += raw; open.at = now; _bumpTranscript(); return }
  const t = raw.trim()
  if (!t) return
  _push(role, t, role !== 'bot')
}
function pushUserDelta(text) {
  const raw = String(text == null ? '' : text)
  if (!raw) return
  const now = Date.now()
  const openU = _recentOpen('user', now)
  if (openU) { openU.text += raw; openU.at = now; _bumpTranscript(); return }
  _push('user', raw, false)
}

function finalizeUser(finalText) {
  const t = String(finalText == null ? '' : finalText).trim()
  if (!t) return
  const open = _recentOpen('user', Date.now()) || _lastOpen('user')
  if (open) {
    if (t.length > String(open.text || '').length) { open.text = t; open.at = Date.now(); _bumpTranscript() }
    return
  }
  _push('user', t, true)
}

function endBotTranscript(finalText) {
  const t = String(finalText == null ? '' : finalText).trim()
  if (!t) return
  const open = _recentOpen('bot', Date.now()) || _lastOpen('bot')
  if (open) {
    if (t.length > String(open.text || '').length) { open.text = t; open.at = Date.now(); _bumpTranscript() }
    return
  }
  _push('bot', t, true)
}
function clearTranscript() { transcript = []; _bumpTranscript() }

const sleep = ms => new Promise(r => setTimeout(r, ms))
let _delegating = null

// Voice → Chat: send the request to the FOCUSED chat (the real agent replies there,
// with visible streaming in the window), then return the reply text to read aloud.
const _voiceNote = () => '[voice] Reply briefly and naturally in English so it can be READ ALOUD (2-4 sentences, no markdown or lists). The text is dictated and may contain errors, use the latest intent. Do not claim something is done before it actually is.\n\n'

// Call-time gateway listeners: the plugin-scoped ctx.onEvent (removed on plugin unload/reload) when the SDK has it.
const eventTap = ctx => typeof ctx?.onEvent === 'function' ? ctx.onEvent : typeof host?.onEvent === 'function' ? host.onEvent : null

// `owner` is the chat of the voice call that asked; queued work passes the owner bound when it was queued.
async function delegateToChat(text, owner = liveController?.owner(), ctx = null) {
  const req = String(text || '').trim()
  if (!req) return 'Empty request.'
  if (_delegating && _delegating.text === req && Date.now() - _delegating.at < 30000) return 'That request is already in progress in the chat; wait for its response.'
  const atomGet = v => { try { return v && typeof v.get === 'function' ? v.get() : v } catch { return null } }
  const sid = String(owner?.runtimeId || '')
  if (owner && owner.profile !== atomGet(host.state.focusedSessionProfile)) return 'Associated voice owner unavailable.'
  if (!sid) return 'No conversation is open in the window. Tell the user to open the chat where they want to work and repeat the request.'
  _delegating = { text: req, at: Date.now() }
  pushTranscript('tool', 'working in the chat…')
  let acc = ''
  let settled = false
  let finalText = ''
  let errText = ''
  const unsubs = []
  try {
    try {
      const on = eventTap(ctx)
      if (on) {
        const evSid = ev => String((ev && (ev.session_id != null ? ev.session_id : (ev.sessionId != null ? ev.sessionId : ((ev.payload || {}).session_id || (ev.payload || {}).sessionId)))) || '')
        // The gateway stamps each event with the connectionId of the socket it arrived on. A same-named
        // chat on another backend is not this call's chat, so a missing or different stamp fails closed.
        const ownerConn = String(owner?.connection || '')
        const evConn = ev => String((ev && (ev.connectionId || (ev.payload || {}).connectionId)) || '')
        const same = ev => !!ownerConn && evConn(ev) === ownerConn && evSid(ev) === sid && (!owner || !(ev.profile || ev.payload?.profile) || (ev.profile || ev.payload?.profile) === owner.profile)
        const evText = ev => String((ev && (ev.text != null ? ev.text : (ev.display != null ? ev.display : ((ev.payload || {}).text != null ? (ev.payload || {}).text : ((ev.payload || {}).display || ''))))) || '')
        unsubs.push(on('message.delta', ev => {
          if (!same(ev)) return
          const piece = ev && (ev.delta != null ? ev.delta : ev.text)
          if (typeof piece === 'string') acc += piece
        }))
        unsubs.push(on('message.complete', ev => {
          if (settled || !same(ev)) return
          settled = true
          finalText = evText(ev)
        }))
        unsubs.push(on('error', ev => {
          if (settled || !same(ev)) return
          settled = true
          errText = 'Agent error: ' + String((ev && (ev.message || ev.error || (ev.payload || {}).message)) || 'unknown')
        }))
      }
      if (owner) { petChat = { ...owner, status: 'Sending' }; window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat')) }
      else associatePetChat(sid, 'Sending')
      const associated = petChat
      try {
        // Chat shows only "[voice] <words>"; the gateway adds the spoken-reply note to the
        // model input (surface 'voice-live'). Older backends without that field get the old prefix.
        const voiceCtx = transcript.filter(x => x.role === 'user' || x.role === 'bot').slice(-10)
          .map(x => (x.role === 'user' ? 'User: ' : 'Bot: ') + String(x.text || '').trim()).join('\n').slice(-6000)
        try {
          await host.request('prompt.submit', { session_id: sid, text: '[voice] ' + req, surface: 'voice-live', voice_context: voiceCtx })
        } catch (e1) {
          if (!/surface|voice_context|unknown|unexpected|extra/i.test(String((e1 && e1.message) || e1))) throw e1
          await host.request('prompt.submit', { session_id: sid, text: _voiceNote() + req })
        }
        if (petChat === associated && associated?.status === 'Sending') {
          associated.status = 'Working'
          window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat'))
        }
      } catch (error) {
        if (petChat === associated && associated) window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat', { detail: { terminal: 'Error' } }))
        throw error
      }
    } catch (e) {
      return 'Could not send to the chat: ' + String((e && e.message) || e || 'error')
    }
    const t0 = Date.now()
    while (!settled && Date.now() - t0 < 240000) await sleep(300)
    if (!settled) return 'The agent is still working in the chat; tell the user the response will appear there shortly.'
    const out = (errText || finalText || acc).trim()
    return out ? out.slice(0, 4000) : 'The agent finished without visible text.'
  } finally {
    _delegating = null
    for (const u of unsubs) { try { u() } catch {} }
  }
}

async function runVoiceTool(ctx, callId, name, args, dc, call) {
  pushTranscript('tool', '· ' + name + ' ' + JSON.stringify(args || {}).slice(0, 100))
  let output = ''
  if (name === 'send_to_chat') {
    // Spoken acknowledgement: brief confirmation while the chat works.
    try {
      dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '[The real agent is ALREADY working on this request in the user’s chat. Now say ONE very short sentence (at most 8 words) in English confirming that you are handling it; do not give any results yet.]' }] } }))
      dc.send(JSON.stringify({ type: 'response.create' }))
    } catch {}
    output = await delegateToChat(String((args && (args.request || args.text)) || ''), call?.owner, ctx)
  } else {
    try {
      const r = await ctx.rest('/tool', { method: 'POST', body: { language: 'en', name: name, arguments: args || {} }, timeoutMs: 125000 })
      output = (r && r.output) || ''
    } catch (e) {
      output = 'The tool ' + name + ' failed: ' + String((e && e.message) || e).slice(0, 160)
    }
  }
  if (call && !call.active) return  // that call has ended: its result is not shown or spoken anywhere
  pushTranscript('tool', '→ ' + String(output).slice(0, 400))
  try {
    dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: String(output) } }))
    dc.send(JSON.stringify({ type: 'response.create' }))
  } catch {}
}

// Native v3 delegation: the voice model hands a task to the client.
// With "Work in the chat", run it in the focused window and return the
// result through delegation.context.append (the model reads it aloud).
function _isJunkDelegation(t) {
  const s = String(t || '').trim()
  if (!s) return true
  if (s.length > 90) return false
  const toks = s.toLowerCase().replace(/[¿?¡!.,;:…()"'«»]/g, ' ').split(/\s+/).filter(Boolean)
  if (!toks.length) return true
  const fill = new Set(['hola', 'hello', 'hey', 'dale', 'ya', 'bueno', 'bien', 'si', 'sí', 'no', 'nope', 'aló', 'alo', 'holi', 'eh', 'emm', 'mmm', 'ah', 'ahá', 'ajá', 'aja', 'ok', 'okay', 'listo', 'perfecto', 'gracias', 'thanks', 'eso', 'mismo', 'y', 'qué', 'que', 'pasó', 'paso', 'final', 'me', 'escuchas', 'estás', 'estas', 'ahí', 'ahi', 'verá', 'vera', 'oye', 'pues', 'onda', 'po'])
  const n = toks.filter(w => fill.has(w)).length
  return n / toks.length >= 0.8
}

function _plainForVoice(t) {
  let s = String(t || '')
  s = s.replace(/```[\s\S]*?```/g, ' ' + '(code block omitted)' + ' ')
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function _delegRespond(dc, itemId, text) {
  try {
    if (_liveChannels.has(dc)) { _liveSend(dc, 'session.commentary.append', itemId, text); return }
    dc.send(JSON.stringify({ type: 'delegation.context.append', delegation_item_id: itemId,
      content: [{ type: 'input_text', text: String(text || '').slice(0, 3500) }] }))
  } catch {}
}

// ── Hermes Live: Hermes' own GPT-Live (tools/voice_live.py). Vendor protocol: session.* events on the
// data channel; a delegation carries no text, so the request is what the user said last.
const _liveChannels = new WeakSet()
const _LIVE_ASK_POLICY = 'CHAT HANDOFF CONFIRMATION: Answer small talk and quick questions yourself. Before you delegate work ' +
  'to Hermes, briefly name the task and ask "Should I send that to the chat?" Then wait. Delegate only when the user\'s next ' +
  'turn clearly approves that specific task ("yes", "do it", "go ahead"). "No", silence, an ambiguous reply or a change of ' +
  'topic is not permission. An explicit request such as "do this in the chat" authorizes that task.'
// One append is at most 500 tokens (vendor cap): 1,400 characters per event keeps headroom.
function _liveSend(dc, type, delegationId, text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  for (let i = 0; i < s.length; i += 1400) dc.send(JSON.stringify({ type, delegation_id: delegationId, content: s.slice(i, i + 1400) }))
}
// Captions arrive as token deltas: they extend the open row of the same speaker, and a change of speaker opens a new row.
function _liveCaption(role, delta) {
  const raw = String(delta || '')
  for (let i = transcript.length - 1; i >= 0; i--) {
    const it = transcript[i]
    if (it.role !== 'user' && it.role !== 'bot') continue
    if (it.role === role && !it.done) { it.text += raw; it.at = Date.now(); _bumpTranscript(); return }
    break
  }
  if (raw.trim()) _push(role, raw.trim(), false)
}
function handleHermesLiveEvent(msg, dc, ctx, call, live) {
  const t = msg && msg.type
  if (t === 'session.started') { if (askBeforeChat(ctx)) try { _liveSend(dc, 'session.instructions.append', null, _LIVE_ASK_POLICY) } catch {} }
  else if (t === 'session.input_transcript.delta') _liveCaption('user', msg.delta)
  else if (t === 'session.output_transcript.delta') _liveCaption('bot', msg.delta)
  else if (t === 'session.delegation.created' && msg.delegation?.id) handleDelegation(ctx, { liveId: String(msg.delegation.id) }, dc, call)
  else if (t === 'error' && msg.error?.code !== 'context_injection_incomplete') pushTranscript('sys', 'error: ' + String(msg.error?.message || msg.error?.code || 'GPT-Live error').slice(0, 160))
  else if (t === 'session.closed') { live.ended = true; pushTranscript('sys', 'Hermes Live ended: ' + String(msg.reason || 'closed').slice(0, 80)); call.close() }
}

function handleDelegation(ctx, msg, dc, call) {
  const item = (msg && msg.item) || {}
  const live = _liveChannels.has(dc)
  const itemId = String(msg?.liveId || item.id || '')
  let req = ''
  try {
    if (Array.isArray(item.content)) req = item.content.map(c => (c && c.text) || '').join('')
  } catch {}
  req = String(req || '').trim()
  if (!req) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const it = transcript[i]
      if (it.role !== 'user' || !it.text) continue
      // Hermes Live: words already handed over are not sent again; the next words start a new row.
      if (!live || !it.sent) req = String(it.text).trim()
      if (live) it.sent = it.done = true
      break
    }
  }
  pushTranscript('tool', 'delegation: ' + (req || '…').slice(0, 180))
  if (handoffMode === 'server') {
    pushTranscript('sys', 'The server agent is on it; I will read the result when ready.')
    return
  }
  if (live && !req) {
    try { _liveSend(dc, 'session.thinking.append', itemId, 'Nothing new was said, so nothing was sent to Hermes.') } catch {}
    return
  }
  // GPT-Live itself decides what is work, so its short approvals ("okay") are not filtered as small talk.
  if (!live && _isJunkDelegation(req)) {
    pushTranscript('tool', 'small talk (not a task) — voice answers itself')
    _delegRespond(dc, itemId, 'The user was just chatting, not asking for work. Reply briefly and naturally; if they were asking about something in progress, tell them you are still on it. Nothing to run.')
    return
  }
  const chatWork = (ctx.storage.get(KEY_CHAT) || '1') !== '0'
  if (!chatWork) {
    pushTranscript('sys', 'Tasks are off: enable "Work in the chat".')
    _delegRespond(dc, itemId, 'I cannot run that: "Work in the chat" is disabled. Ask the user to enable it in the mic settings.')
    return
  }
  if (_delegBusy) {
    // Bound at enqueue to its call (owner + generation) and channel; that call's hang-up drops it.
    _delegQueue = { req, itemId, at: Date.now(), call, dc }
    pushTranscript('tool', 'queued (task in progress): ' + req.slice(0, 100))
    _delegRespond(dc, itemId, 'A task is already in progress. Tell the user you are still on it; if what they said is a correction it will be reflected in the result, if it is something new, wait for the current one to finish.')
    return
  }
  _runDelegation(ctx, dc, itemId, req, call)
}

function _runDelegation(ctx, dc, itemId, req, call) {
  _delegBusy = true
  ;(async () => {
    let out = ''
    try { out = await delegateToChat(req, call?.owner, ctx) } catch (e) { out = '' }
    if (call && !call.active) return  // the call that asked has ended: nothing is shown or spoken
    out = String(out || '').trim()
    if (!out) out = 'The task could not be completed in the chat.'
    const forVoice = _plainForVoice(out)
    pushTranscript('tool', 'result: ' + forVoice.slice(0, 160))
    // Hermes Live's commentary is Hermes' own answer, which the voice paraphrases.
    _delegRespond(dc, itemId, (_liveChannels.has(dc) ? '' : 'Task result (answer the user with this, briefly and naturally): ') + forVoice)
  })().catch(() => {}).then(() => {
    _delegBusy = false
    const q = _delegQueue
    _delegQueue = null
    if (!q || (q.call && !q.call.active)) return  // its call hung up: dropped, never run in another call
    if (Date.now() - q.at < 600000) {
      pushTranscript('tool', 'resuming queued: ' + q.req.slice(0, 100))
      _runDelegation(ctx, q.dc, q.itemId, q.req, q.call)
    } else {
      pushTranscript('sys', 'Queued task went stale and was not run.')
      _delegRespond(q.dc, q.itemId, 'The queued task went stale and was not run. Tell the user that if they still want it, to say it again and you will run it right away.')
    }
  })
}

// ── Barge-in (module state: written by events, read by the meter) ──────────
let currentBotTurnId = ''
let _lastBargeAt = 0
let _botSpeakingSince = 0
let _liveRefs = null  // { pc, audioEl, ctx } — set by startLive

function doBargeIn() {
  const now = Date.now()
  if (now - _lastBargeAt < 1200) return
  if (bus.muted) return  // No barge-in while the microphone is muted.
  _lastBargeAt = now
  const refs = _liveRefs
  const hadTurn = !!currentBotTurnId
  try {
    if (refs && refs.pc) refs.pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'audio') s.track.enabled = true })
  } catch {}
  try { if (refs && refs.audioEl) { refs.audioEl.pause(); refs.audioEl.currentTime = 0; refs.audioEl.play().catch(() => {}) } } catch {}
  bus.set({ spkBot: false, remoteLevel: 0, remBands: null })
  pushTranscript('sys', 'interrupted — I am listening')
  if (!refs || !hadTurn) return
  const tid = currentBotTurnId
  currentBotTurnId = ''
  ;(async () => {
    try { await refs.ctx.rest('/codexlive/interrupt', { method: 'POST', body: { turnId: tid }, timeoutMs: 5000 }) } catch {}
  })()
}

function maybeBarge() {
  if (bus.muted) { _botSpeakingSince = 0; return }
  const now = Date.now()
  if (bus.spkBot) {
    if (!_botSpeakingSince) _botSpeakingSince = now
    if (now - _botSpeakingSince > 600 && (bus.micLevel || 0) > 0.11) doBargeIn()
  } else {
    _botSpeakingSince = 0
  }
}

function handleRealtimeEvent(msg, dc, ctx, call) {
  const t = msg && msg.type
  if (!t) return
  // ── Codex Live-1: v3/frameless protocol ──
  if (t === 'session.started' || t === 'session.updated') return
  if (t === 'input_transcript.added') { const tx = (msg.item || {}).text; if (tx) pushUserDelta(tx); return }
  if (t === 'output_transcript.added') { const tx = (msg.item || {}).text; if (tx) pushTranscript('bot', tx); return }
  if (t === 'turn.done') {
    const tu = msg.turn || {}
    if (tu.role === 'user') finalizeUser(tu.transcript || '')
    else if (tu.role === 'assistant') endBotTranscript(tu.transcript || '')
    return
  }
  if (t === 'turn.created') {
    const tu = msg.turn || {}
    if (tu.role === 'assistant' && tu.id) currentBotTurnId = String(tu.id)
    return
  }
  if (t === 'turn.delta') return
  if (t === 'session.usage.updated') { const au = msg.usage && msg.usage.audio_duration_ms; if (au) { try { liveAudioMs = Math.max(liveAudioMs || 0, Number(au) || 0) } catch {} } return }
  if (t === 'delegation.created') { handleDelegation(ctx, msg, dc, call); return }
  if (t === 'delegation.context.appended') {
    if (handoffMode === 'server') {
      const did = String(msg.delegation_item_id || '')
      if (did && did !== _lastAppendedId) { _lastAppendedId = did; pushTranscript('tool', 'agent response streaming to the voice…') }
    }
    return
  }
  // ── Hermes realtime (realtime-2.1) ──
  if (t === 'input_audio_buffer.speech_started') bus.set({ spkUser: true })
  else if (t === 'input_audio_buffer.speech_stopped') bus.set({ spkUser: false })
  else if (t === 'output_audio_buffer.started') bus.set({ spkBot: true })
  else if (t === 'output_audio_buffer.stopped') bus.set({ spkBot: false })
  else if (t === 'conversation.item.input_audio_transcription.delta') pushUserDelta(msg.delta || '')
  else if (t === 'conversation.item.input_audio_transcription.completed') finalizeUser(msg.transcript || '')
  else if (t === 'response.output_audio_transcript.delta') pushTranscript('bot', msg.delta || '')
  else if (t === 'response.output_audio_transcript.done') endBotTranscript(msg.transcript || '')
  else if (t === 'response.function_call_arguments.done') {
    let args = {}
    try { args = JSON.parse(msg.arguments || '{}') } catch {}
    try { runVoiceTool(ctx, msg.call_id, msg.name || 'tool', args, dc, call).catch(() => {}) } catch {}
  } else if (t === 'error') {
    const m = msg.error && (msg.error.message || msg.error.code)
    if (m) pushTranscript('sys', 'error: ' + String(m).slice(0, 160))
  }
}

// ── Kanban announcer: speak background Kanban notices during a live call ────
// The gateway emits `status.update {kind:'process', text:'⏸ … Kanban t_x blocked: …'}`
// on the chat session that subscribed to the card. Only that chat's notices are spoken.
const _KANBAN_RE = /^\s*(?:\S+\s+)?(?:\[[^\]]*\]\s+)?(?:@\S+\s+)?Kanban\s+(t_[0-9a-z]+)\s*(.*)$/is
function _kanbanSpeech(text) {
  const m = _KANBAN_RE.exec(String(text || ''))
  if (!m) return ''
  const id = m[1]
  const rest = String(m[2] || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return 'Kanban card ' + id + ' ' + (rest || 'changed state')
}
function installKanbanAnnouncer(ctx, dc, eng, owner) {
  const on = eventTap(ctx)
  if (!on) return () => {}
  const seen = new Map()
  const off = on('status.update', ev => {
    try {
      const p = (ev && ev.payload) || ev || {}
      const text = String(p.text || ev?.text || '')
      const speech = _kanbanSpeech(text)
      if (!speech || !ownedByCall(ev, owner)) return
      const now = Date.now()
      for (const [k, at] of seen) if (now - at > 60000) seen.delete(k)
      if (seen.has(text)) return
      seen.set(text, now)
      if (!dc || dc.readyState !== 'open') return
      pushTranscript('sys', speech)
      const say = '[Background notification, not from the user] ' + speech +
        '. Tell the user this in one or two short natural sentences, in English. If it is blocked waiting for input, say it needs their approval or answer.'
      if (eng === 'hermes-live') _liveSend(dc, 'session.commentary.append', null, say)
      else if (eng === 'codex') {
        dc.send(JSON.stringify({ type: 'session.context.append', content: [{ type: 'input_text', text: say }] }))
      } else {
        dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: say }] } }))
        dc.send(JSON.stringify({ type: 'response.create' }))
      }
    } catch {}
  })
  return () => { try { off && off() } catch {} }
}

// A background event belongs to the call only when it carries the call owner's exact chat (the gateway's
// session_id), profile and connection (both stamped by Hermes Desktop per socket). Another chat, another
// route, or no stamp at all: not spoken, not shown.
function ownedByCall(ev, owner) {
  const sid = String(ev?.session_id || '')
  return !!owner?.runtimeId && sid === String(owner.runtimeId) && !!ev?.profile && petProfileKey(ev.profile) === petProfileKey(owner.profile) &&
    !!owner.connection && String(ev?.connectionId || '') === String(owner.connection)
}

// ── Sub-agent announcer: push finished background results into the live call ──
// The voice model never sees delegate results on its own, so it guessed "still
// waiting". On subagent.complete we append the result as context and ask it to
// tell the user right away. Only the call owner's results; deduped per subagent id.
function installSubagentAnnouncer(ctx, dc, eng, owner) {
  const on = eventTap(ctx)
  if (!on) return () => {}
  const seen = new Set()
  const off = on('subagent.complete', ev => {
    try {
      if (!ownedByCall(ev, owner)) return
      const p = (ev && ev.payload) || ev || {}
      const id = String(p.subagent_id || p.id || p.goal || '')
      if (!id || seen.has(id)) return
      seen.add(id)
      if (!dc || dc.readyState !== 'open') return
      const status = String(p.status || 'completed')
      const goal = String(p.goal || 'a background task').replace(/\s+/g, ' ').slice(0, 160)
      const result = String(p.summary || p.error || p.preview || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
      pushTranscript('sys', `Sub-agent ${status}: ${goal}`)
      const say = '[Background notification, not from the user] The background sub-agent for "' + goal + '" has ' +
        (status === 'completed' ? 'finished' : status) + '. Result: ' + (result || '(no summary)') +
        ' Tell the user the key result now in one to three short natural sentences, in English. This replaces any earlier "still waiting" answer.'
      if (eng === 'hermes-live') _liveSend(dc, 'session.commentary.append', null, say)
      else if (eng === 'codex') {
        dc.send(JSON.stringify({ type: 'session.context.append', content: [{ type: 'input_text', text: say }] }))
      } else {
        dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: say }] } }))
        dc.send(JSON.stringify({ type: 'response.create' }))
      }
    } catch {}
  })
  return () => { try { off && off() } catch {} }
}

// ── Animation loop: budgeted (SDK) with rAF fallback ───────────────────────

function makeLoop(draw, fps) {
  // rAF is the main clock, with an interval heartbeat: if the renderer pauses rAF
  // (occluded window/throttling), animation still ticks at a lower frame rate.
  let raf = 0
  let last = -Infinity
  let lastBeat = Date.now()
  const step = t => {
    lastBeat = Date.now()
    if (t - last >= 1000 / fps) { last = t; try { draw(t) } catch {} }
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  const iv = setInterval(() => {
    if (Date.now() - lastBeat > 400) { try { draw(performance.now()) } catch {} }
  }, 120)
  return {
    dispose: () => { try { cancelAnimationFrame(raf) } catch {}; try { clearInterval(iv) } catch {} },
    wake() {}, isDormant: () => false
  }
}

function disposeLoop(loop) { try { loop && loop.dispose && loop.dispose() } catch {} }

// ── Micro-interaction sounds (WebAudio, no assets) ─────────────────────────

function playChime(kind) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const now = ctx.currentTime
    const notes = kind === 'connect' ? [523.25, 659.25, 783.99] : [659.25, 523.25, 392.0]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0, now + i * 0.08)
      g.gain.linearRampToValueAtTime(0.12, now + i * 0.08 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.28)
      o.connect(g); g.connect(ctx.destination)
      o.start(now + i * 0.08)
      o.stop(now + i * 0.08 + 0.3)
    })
    setTimeout(() => { try { ctx.close() } catch {} }, 900)
  } catch {}
}

// ── Realtime session ──────────────────────────────────────────────────────

async function mintSession(ctx, profile, voice, allowChat) {
  const sess = await ctx.rest('/session', {
    method: 'POST',
    body: { language: 'en', profile: profile || null, voice: voice || null, allowChat: allowChat !== false, askBeforeChat: askBeforeChat(ctx) },
    timeoutMs: 45000
  })
  if (!sess || !sess.clientSecret) throw new Error('response missing clientSecret: ' + JSON.stringify(sess).slice(0, 120))
  return sess
}

// One token per voice call. Startup registers each resource on it as acquired; close() (Stop, or any
// startup failure) releases them once, newest first, and anything acquired later is released on arrival.
// Voice work keeps the call that asked for it: once that call ends, it is dropped, never retargeted.
function voiceCall(owner) {
  const held = []
  const call = {
    owner, active: true,
    hold: release => { if (call.active) held.push(release); else try { release() } catch {} },
    alive: () => { if (!call.active) throw new Error(call.reason || 'Voice start cancelled') },
    close: reason => { if (!call.active) return; call.active = false; call.reason = reason || ''; while (held.length) { try { held.pop()() } catch {} } }
  }
  return call
}

async function startLive(ctx, options) {
  const call = options.call || voiceCall()
  try { return await openLive(ctx, options, call) } catch (error) { call.close(); throw error }
}

async function openLive(ctx, { profile, voice, micId, outId, engine, log }, call) {
  const eng = engine || 'codex'
  const { hold, alive } = call
  clearTranscript()
  liveAudioMs = 0
  bus.set({ err: '', widget: true, stage: 'mint' })
  // Released last: hang-up resets the shared call state. Its queued voice work is dead from here on.
  hold(() => {
    for (let i = 0; i < transcript.length; i++) transcript[i].done = true
    _liveRefs = null
    currentBotTurnId = ''
    _botSpeakingSince = 0
    bus.set({ live: false, stage: 'idle', micLevel: 0, remoteLevel: 0, widget: false, muted: false })
  })
  log('requesting session…')
  let sess = null
  if (eng !== 'codex' && eng !== 'hermes-live') {
    sess = await mintSession(ctx, profile, voice, (ctx.storage.get(KEY_CHAT) || '1') !== '0')
    alive()
    bus.botName = sess.botName || ''
  }
  log('opening microphone…')
  const audioC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  if (micId) audioC.deviceId = { exact: micId }
  const mic = async audio => { const s = await navigator.mediaDevices.getUserMedia({ audio }); hold(() => s.getTracks().forEach(t => t.stop())); return s }
  let stream
  try {
    stream = await mic(audioC)
  } catch (e) {
    alive()
    if (micId) {
      try {
        stream = await mic({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
        pushTranscript('sys', 'Could not open the selected mic; using the system default.')
      } catch (e2) {
        throw new Error('MIC: ' + ((e2 && e2.name) || e?.name || '') + ' — check permissions or try another microphone in the settings')
      }
    } else {
      throw new Error('MIC: ' + (e?.name || '') + ' — check permissions or try another microphone in the settings')
    }
  }
  alive()
  log('mic OK')
  bus.set({ live: true, stage: 'offering', micLevel: 0, remoteLevel: 0 })

  const audioCtx = new AudioContext()
  hold(() => audioCtx.close())
  if (audioCtx.state === 'suspended') { try { await audioCtx.resume() } catch {} alive() }
  const analyserMic = audioCtx.createAnalyser(); analyserMic.fftSize = 512
  // Metering graph: keep the analyser fed independently of the destination.
  const micMute = audioCtx.createGain(); micMute.gain.value = 0
  audioCtx.createMediaStreamSource(stream).connect(analyserMic)
  analyserMic.connect(micMute); micMute.connect(audioCtx.destination)
  const remoteRef = { an: null }

  // WebRTC stats levels (independent of WebAudio — reliable Electron fallback).
  const meter = { sMic: 0, sBot: 0 }
  // Barge-in threshold: only after >600 ms of bot speech (avoid cutting short pauses).
  let botSpeakingSince = 0
  const maybeBarge = () => {
    const now = Date.now()
    if (bus.spkBot) {
      if (!botSpeakingSince) botSpeakingSince = now
      if (now - botSpeakingSince > 600 && (bus.micLevel || 0) > 0.11) doBargeIn()
    } else {
      botSpeakingSince = 0
    }
  }

  const pc = new RTCPeerConnection()
  hold(() => pc.close())
  stream.getTracks().forEach(t => pc.addTrack(t, stream))
  _liveRefs = { pc, audioEl: null, ctx }

  // Event channel: live transcript + tool calls.
  const dc = pc.createDataChannel('oai-events')
  dc.onopen = () => log('event channel open')
  const live = eng === 'hermes-live' ? { ended: false } : null
  if (live) _liveChannels.add(dc)
  dc.onmessage = ev => {
    let msg = null
    try { msg = JSON.parse(ev.data) } catch { return }
    if (live) handleHermesLiveEvent(msg, dc, ctx, call, live)
    else handleRealtimeEvent(msg, dc, ctx, call)
  }
  // Hang-up ends the GPT-Live session (and its per-minute billing) before its channel and peer go.
  if (live) hold(() => { if (!live.ended && dc.readyState === 'open') try { dc.send(JSON.stringify({ type: 'session.close' })) } catch {} })
  // The call dropped under us (peer failed, control channel lost, or a disconnect outlasting its grace):
  // release everything through the token and say so once, in plain words. While still connecting, the
  // start itself fails with this reason and reports it, so the user still hears it only once.
  let started = false, grace = 0
  const dropped = () => {
    if (!call.active) return  // our own Stop (or an earlier drop) already ended it
    call.close('CALL_DROPPED')
    if (!started) return
    const message = voiceErrorMessage(new Error('CALL_DROPPED'))
    bus.set({ err: message, widget: true, stage: 'error', live: false, micLevel: 0, remoteLevel: 0 })
    host.notify?.({ kind: 'error', message })
  }
  dc.onclose = dropped
  hold(() => clearTimeout(grace))

  // Kanban notices (blocked / completed / crashed …) arrive as status.update events on
  // the chat session, outside any voice-initiated turn. Read them aloud while live.
  hold(installKanbanAnnouncer(ctx, dc, eng, call.owner))
  hold(installSubagentAnnouncer(ctx, dc, eng, call.owner))

  let audioEl = null
  hold(() => audioEl && audioEl.pause())
  pc.ontrack = ev => {
    log('bot audio connected')
    const remoteStream = ev.streams[0]
    audioEl = new Audio()
    audioEl.srcObject = remoteStream
    audioEl.autoplay = true
    audioEl.play().catch(() => log('click to play audio'))
  if (_liveRefs) _liveRefs.audioEl = audioEl
    if (outId && audioEl.setSinkId) audioEl.setSinkId(outId).catch(e => log('output: ' + e.message))
    const an = audioCtx.createAnalyser(); an.fftSize = 256
    const src = audioCtx.createMediaStreamSource(remoteStream)
    const mute = audioCtx.createGain(); mute.gain.value = 0
    src.connect(an); an.connect(mute); mute.connect(audioCtx.destination)
    remoteRef.an = an
  }

  let connectedAt = 0
  // Close inactive bubbles to separate utterances without duplication.
  const idleTimer = setInterval(() => {
    const now = Date.now()
    let changed = false
    for (let i = 0; i < transcript.length; i++) {
      const it = transcript[i]
      if (!it.done && now - (it.at || 0) > IDLE_MS) { it.done = true; changed = true }
    }
    if (changed) _bumpTranscript()
  }, 1000)
  hold(() => clearInterval(idleTimer))
  const ctl = {}
  // Mic mute: toggle enabled on PC audio tracks (robust to device fallback).
  let mutedNow = false
  ctl.setMuted = desired => {
    if (mutedNow === desired) return mutedNow
    mutedNow = desired
    try {
      pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'audio') s.track.enabled = !mutedNow })
    } catch {}
    bus.set({ muted: mutedNow })
    pushTranscript('sys', mutedNow ? 'Microphone muted' : 'Microphone on')
    return mutedNow
  }

  ctl.toggleMute = () => ctl.setMuted(!mutedNow)

  pc.onconnectionstatechange = () => {
    log('rtc: ' + pc.connectionState)
    bus.set({ stage: pc.connectionState })
    if (pc.connectionState === 'connected') { playChime('connect'); if (!connectedAt) connectedAt = Date.now() }
    // A short network blip recovers on its own; one that lasts 10 s ends the call.
    clearTimeout(grace)
    if (pc.connectionState === 'disconnected') grace = setTimeout(dropped, 10000)
    if (pc.connectionState === 'failed') dropped()
  }
  // Hermes Live is also told, so the session itself stops listening (the track switch alone sends silence).
  if (live) {
    const setTrack = ctl.setMuted
    ctl.setMuted = desired => { const was = mutedNow, now = setTrack(desired); if (now !== was) try { dc.send(JSON.stringify({ type: now ? 'session.input_audio.mute' : 'session.input_audio.unmute' })) } catch {} return now }
  }

  log('negotiating…')
  const offer = await pc.createOffer()
  alive()
  await pc.setLocalDescription(offer)
  alive()
  if (eng === 'codex') {
    const r2 = await ctx.rest('/codexlive/session', {
      method: 'POST',
      body: { language: 'en', profile: profile || null, voice: voice || 'cove', offer: offer.sdp, askBeforeChat: askBeforeChat(ctx) },
      timeoutMs: 120000
    })
    // A session the provider created is stopped with the call, even when it arrives after Stop.
    if (r2 && r2.threadId) hold(() => ctx.rest('/codexlive/stop', { method: 'POST', body: { threadId: r2.threadId }, timeoutMs: 8000 }).catch(() => {}))
    alive()
    if (!r2 || !r2.answer) {
      throw new Error('codex live: no answer SDP')
    }
    handoffMode = (r2.handoff === 'server') ? 'server' : 'client'
    if (r2.handoffDegraded) pushTranscript('sys', 'Notice: this server does not support clientManagedHandoffs; voice tasks may run on the agent ChatGPT lane instead of your chat.')
    bus.botName = r2.botName || bus.botName || ''
    await pc.setRemoteDescription({ type: 'answer', sdp: r2.answer })
  } else if (live) {
    // Non-trickle: the offer goes out with its candidates (at most 10 s of gathering; Stop ends the wait).
    if (pc.iceGatheringState !== 'complete') await new Promise(resolve => {
      const done = () => { clearTimeout(timer); pc.onicegatheringstatechange = null; resolve() }
      const timer = setTimeout(done, 10000)
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done() }
      hold(done)
    })
    alive()
    // Hermes creates the session with its own key (the call owner's profile); only the answer comes back.
    const r3 = await ctx.rest('/hermeslive/session', { method: 'POST', body: { profile: profile || null, offer: pc.localDescription?.sdp || offer.sdp }, timeoutMs: 45000 })
    alive()
    if (!r3 || !r3.answer) throw new Error('hermes live: no answer SDP')
    handoffMode = 'client'
    bus.botName = r3.botName || bus.botName || ''
    await pc.setRemoteDescription({ type: 'answer', sdp: r3.answer })
  } else {
    const res = await fetch(sess.offerUrl + '?model=' + encodeURIComponent(sess.model), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sess.clientSecret, 'Content-Type': 'application/sdp' },
      body: offer.sdp
    })
    alive()
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error('offer ' + res.status + ': ' + t.slice(0, 140))
    }
    const answer = await res.text()
    alive()
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  }
  alive()
  log('live')

  // Poll WebRTC levels every 250 ms (audioLevel outbound=mic / inbound=bot).
  const statsTimer = setInterval(() => {
    try {
      pc.getStats().then(report => {
        try {
          report.forEach(r => {
            // Chrome: outbound-rtp.audioLevel is null (the mic uses WebAudio);
            // inbound-rtp DOES carry audioLevel (bot voice).
            const kind = r.kind || r.mediaType
            if (kind !== 'audio') return
            if (r.type === 'inbound-rtp' && typeof r.audioLevel === 'number') meter.sBot = Math.max(r.audioLevel, meter.sBot * 0.8)
          })
        } catch {}
      }).catch(() => {})
    } catch {}
  }, 250)
  hold(() => clearInterval(statsTimer))
  hold(() => {
    const durMs = connectedAt ? Date.now() - connectedAt : 0
    if (durMs > 4000) ctx.rest('/voice/usage/report', { method: 'POST', body: { durationMs: Math.round(durMs), audioMs: Math.round(liveAudioMs || 0) }, timeoutMs: 8000 }).catch(() => {})
  })

  const buf = new Uint8Array(analyserMic.frequencyBinCount)
  const bufR = new Uint8Array(256)
  const tdM = new Uint8Array(analyserMic.fftSize)
  const tdR = new Uint8Array(256)
  const NB = 6
  const binOf = f => Math.min(buf.length - 1, Math.round(f / (audioCtx.sampleRate / 2) * buf.length))
  const edges = [100, 250, 500, 900, 1600, 2800, 4500].map(binOf)
  const bandAvg = (arr, a, b) => { let s = 0; const n = Math.max(1, b - a); for (let i = a; i < b; i++) s += arr[i]; return s / n / 255 }
  let lastPush = 0
  let lastEmit = 0
  const tick = () => {
    if (!call.active) return
    let m = 0, r = 0
    const bands = [0, 0, 0, 0, 0, 0]
    const remBands = [0, 0, 0, 0, 0, 0]
    let rmsM = 0, rmsR = 0
    try {
      analyserMic.getByteFrequencyData(buf)
      for (let i = 0; i < NB; i++) {
        bands[i] = bandAvg(buf, edges[i], edges[i + 1])
        if (bands[i] > m) m = bands[i]
      }
      analyserMic.getByteTimeDomainData(tdM)
      for (let i = 0; i < tdM.length; i++) { const v = (tdM[i] - 128) / 128; rmsM += v * v }
      rmsM = Math.sqrt(rmsM / tdM.length) * 3.2
      if (remoteRef.an) {
        remoteRef.an.getByteFrequencyData(bufR)
        for (let i = 0; i < NB; i++) {
          remBands[i] = bandAvg(bufR, edges[i], edges[i + 1])
          if (remBands[i] > r) r = remBands[i]
        }
        remoteRef.an.getByteTimeDomainData(tdR)
        for (let i = 0; i < tdR.length; i++) { const v = (tdR[i] - 128) / 128; rmsR += v * v }
        rmsR = Math.sqrt(rmsR / tdR.length) * 3.2
      }
    } catch {}
    // Combine sources: RMS (time-domain) + spectrum + bot stats.
    const micLevel = bus.muted ? 0 : Math.min(1, Math.max(m, rmsM))
    const botLevel = Math.min(1, Math.max(r, rmsR, meter.sBot))
    const now = performance.now()
    if (now - lastPush > 55) {
      lastPush = now
      // Write animation fields directly (rAF reads them);
      // emit to React at only ~5 fps to avoid re-render storms that delay dragging.
      bus.micLevel = micLevel; bus.remoteLevel = botLevel; bus.bands = bands; bus.remBands = remBands
      try { maybeBarge() } catch {}
      if (now - lastEmit > 200) { lastEmit = now; bus.emit() }
    }
  }
  const meterLoop = makeLoop(tick, 24)
  hold(() => { if (bus.stage === 'connected') playChime('hangup'); disposeLoop(meterLoop) })  // released first

  started = true
  return {
    close: call.close,
    setMuted: desired => ctl.setMuted(desired),
    toggleMute: () => { try { return ctl.toggleMute() } catch {} return false }
  }
}

function useLiveState() {
  const [s, setS] = useState(() => ({ live: bus.live, stage: bus.stage, micLevel: bus.micLevel, remoteLevel: bus.remoteLevel, widget: bus.widget, err: bus.err, transcriptRev: bus.transcriptRev, spkUser: bus.spkUser, spkBot: bus.spkBot, muted: bus.muted }))
  useEffect(() => {
    const h = e => setS({ ...e.detail })
    window.addEventListener('talk-desktop:state', h)
    return () => window.removeEventListener('talk-desktop:state', h)
  }, [])
  return s
}

// ── Live waveform: JS-loop bars react to real voice ───────────────────────

function LiveBars({ size = 13, count = 5 }) {
  const refs = useRef([])
  useEffect(() => {
    const lvl = new Array(count).fill(0.25)
    const draw = () => {
      const now = performance.now()
      const live = bus.live && bus.stage === 'connected'
      const muted = bus.muted === true
      const botActive = (bus.remoteLevel || 0) > (bus.micLevel || 0)
      const spec = botActive ? bus.remBands : bus.bands
      const level = Math.max(bus.micLevel || 0, bus.remoteLevel || 0)
      let specAlive = false
      if (spec) { for (let i = 0; i < spec.length; i++) { if (spec[i] > 0.02) { specAlive = true; break } } }
      const mid = (count - 1) / 2
      for (let i = 0; i < count; i++) {
        const el = refs.current[i]
        if (!el) continue
        const w = 1 - (Math.abs(i - mid) / (mid + 1)) * 0.35
        let target
        if (!live) {
          target = 0.24 + 0.14 * Math.sin(now / 700 + i * 1.15)
        } else if (muted && !botActive) {
          // Muted mic: calm breathing; show normal waves when the bot speaks.
          target = 0.20 + 0.08 * Math.sin(now / 900 + i * 1.1)
        } else if (specAlive && spec) {
          target = Math.max(0.10, Math.pow(Math.min(1, (spec[i] || 0) * 1.9), 0.72) * w)
        } else {
          const v = Math.pow(Math.min(1, level * 1.8), 0.72)
          target = Math.max(0.10, v * (0.55 + 0.45 * w) + 0.06 * Math.sin(now / 380 + i))
          const speakingNow = botActive ? bus.spkBot : bus.spkUser
          if (speakingNow && level < 0.03) {
            // The server reported speech, but the meter has no signal yet: lively pattern.
            target = 0.22 + 0.50 * Math.abs(Math.sin(now / (150 + i * 25) + i * 1.7)) * w
          }
        }
        lvl[i] = target > lvl[i] ? lvl[i] + (target - lvl[i]) * 0.55 : lvl[i] + (target - lvl[i]) * 0.15
        const h = Math.max(2, Math.round(lvl[i] * size))
        el.style.height = h + 'px'
        el.style.opacity = live ? String(0.72 + Math.min(0.28, lvl[i] * 0.5)) : '0.5'
        el.style.background = !live ? '#a1a1aa' : (botActive ? '#a78bfa' : (muted ? '#9ca3af' : '#60a5fa'))
        el.style.boxShadow = 'none'
      }
    }
    const loop = makeLoop(draw, 24)
    return () => disposeLoop(loop)
  }, [])
  return jsx('span', {
    'aria-hidden': 'true',
    style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, height: size },
    children: Array.from({ length: count }, (_, i) => jsx('span', {
      ref: el => { refs.current[i] = el },
      style: { width: 2.5, height: 2, borderRadius: 2, background: '#a1a1aa', display: 'block' }
    }))
  })
}

function SpinnerRing({ inset = -3 }) {
  const ref = useRef(null)
  useEffect(() => {
    const loop = makeLoop(t => {
      const el = ref.current
      if (el) el.style.transform = 'rotate(' + Math.round(((t / 3.2) % 360)) + 'deg)'
    }, 30)
    return () => disposeLoop(loop)
  }, [])
  return jsx('span', {
    'aria-hidden': 'true',
    style: {
      position: 'absolute', inset, borderRadius: '50%',
      border: '2px solid rgba(59,130,246,0.18)', borderTopColor: '#3b82f6',
      borderRightColor: '#3b82f6', pointerEvents: 'none', display: 'block'
    },
    ref
  })
}

// ── Voice preview: generate a real sample with the selected voice ─────────

let _pvCache = null
let _pvSession = null
let _pvAudio = null

function _pvStopSession() {
  const cur = _pvSession
  if (!cur) return
  _pvSession = null
  try { cur.rec && cur.rec.state !== 'inactive' && cur.rec.stop() } catch {}
  try { cur.timer && clearTimeout(cur.timer) } catch {}
  try { cur.stream && cur.stream.getTracks().forEach(t => t.stop()) } catch {}
  try { cur.pc && cur.pc.close() } catch {}
  try { cur.ctxRef && cur.threadId && cur.ctxRef.rest('/codexlive/stop', { method: 'POST', body: { threadId: cur.threadId }, timeoutMs: 8000 }).catch(() => {}) } catch {}
}

function _pvPlay(url, outId) {
  try {
    if (_pvAudio) { try { _pvAudio.pause() } catch {} }
    _pvAudio = new Audio(url)
    if (outId && _pvAudio.setSinkId) _pvAudio.setSinkId(outId).catch(() => {})
    _pvAudio.play().catch(() => {})
  } catch {}
}

async function _pvGenerate(ctx, { engine, voice, profile, micId, outId }) {
  const eng = engine || 'codex'
  const sc = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  if (micId) sc.deviceId = { exact: micId }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: sc })
  const pc = new RTCPeerConnection()
  stream.getTracks().forEach(t => pc.addTrack(t, stream))
  const dc = pc.createDataChannel('oai-events')
  let remoteStream = null
  pc.ontrack = ev => { remoteStream = (ev.streams && ev.streams[0]) || remoteStream }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  let threadId = null
  if (eng === 'codex') {
    const r = await ctx.rest('/codexlive/session', { method: 'POST', body: { language: 'en', profile: profile || null, voice, offer: offer.sdp, askBeforeChat: askBeforeChat(ctx) }, timeoutMs: 120000 })
    if (!r || !r.answer) throw new Error('sample: no answer SDP')
    threadId = r.threadId || null
    await pc.setRemoteDescription({ type: 'answer', sdp: r.answer })
  } else {
    const sess = await mintSession(ctx, profile, voice, false)
    const res = await fetch(sess.offerUrl + '?model=' + encodeURIComponent(sess.model), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sess.clientSecret, 'Content-Type': 'application/sdp' },
      body: offer.sdp
    })
    if (!res.ok) throw new Error('muestra: offer ' + res.status)
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
  }
  _pvSession = { key: eng + ':' + voice, stream, pc, rec: null, timer: null, ctxRef: ctx, threadId }
  await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (pc.connectionState === 'connected') { clearInterval(iv); resolve() }
      else if (pc.connectionState === 'failed' || Date.now() - t0 > 25000) { clearInterval(iv); reject(new Error('sample: did not connect')) }
    }, 200)
  })
  await new Promise(r => setTimeout(r, 500))
  const phrase = ('Say out loud exactly this sentence, adding nothing else: "Hi, this is voice ' + voice + ', this is how I sound when we talk."')
  try {
    if (eng === 'codex') {
      dc.send(JSON.stringify({ type: 'session.context.append', content: [{ type: 'input_text', text: phrase }] }))
    } else {
      dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }] } }))
      dc.send(JSON.stringify({ type: 'response.create' }))
    }
  } catch {}
  const url = await new Promise((resolve, reject) => {
    const chunks = []
    const t0 = Date.now()
    const startRec = () => {
      if (!remoteStream) {
        if (Date.now() - t0 > 12000) { reject(new Error('sample: no bot audio')); return }
        setTimeout(startRec, 250); return
      }
      let mime = ''
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus' } catch {}
      let mr = null
      try { mr = mime ? new MediaRecorder(remoteStream, { mimeType: mime }) : new MediaRecorder(remoteStream) } catch (e) { reject(e); return }
      if (_pvSession) _pvSession.rec = mr
      const stopSoon = () => { try { if (mr.state !== 'inactive') mr.stop() } catch {} }
      mr.ondataavailable = e => { try { if (e.data && e.data.size) chunks.push(e.data) } catch {} }
      mr.onstop = () => {
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
          if (!blob.size) { reject(new Error('sample: no data')); return }
          resolve(URL.createObjectURL(blob))
        } catch (e) { reject(e) }
      }
      dc.onmessage = ev2 => {
        try {
          const m = JSON.parse(ev2.data)
          const done = (m.type === 'turn.done' && ((m.turn || {}).role === 'assistant')) || m.type === 'response.output_audio_transcript.done'
          if (done) setTimeout(stopSoon, 1300)
        } catch {}
      }
      mr.start()
      const hard = setTimeout(stopSoon, 13000)
      if (_pvSession) _pvSession.timer = hard
    }
    startRec()
  })
  const cur = _pvSession
  if (cur) {
    try { cur.stream.getTracks().forEach(t => t.stop()) } catch {}
    try { pc.close() } catch {}
    try { if (threadId) ctx.rest('/codexlive/stop', { method: 'POST', body: { threadId }, timeoutMs: 8000 }).catch(() => {}) } catch {}
    try { cur.timer && clearTimeout(cur.timer) } catch {}
    _pvSession = null
  }
  _pvCache = { key: eng + ':' + voice, url }
  _pvPlay(url, outId)
  return url
}

// ── Settings form (shared by Popover / widget / pane) ─────────────────────

function ConfigForm({ ctx, dense = false }) {
  const [micId, setMicId] = useState(() => ctx.storage.get(KEY_MIC) || '')
  const [outId, setOutId] = useState(() => ctx.storage.get(KEY_OUT) || '')
  const [chatWork, setChatWork] = useState(() => (ctx.storage.get(KEY_CHAT) || '1') !== '0')
  const [askChat, setAskChat] = useState(() => (ctx.storage.get(KEY_ASK_CHAT) || '1') !== '0')
  const [micTest, setMicTest] = useState({ on: false, err: '' })
  const micBarRef = useRef(null)
  const micTestRef = useRef(null)
  const micTestSerial = useRef(0)
  const [devs, setDevs] = useState({ mics: [], outs: [] })
  const [info, setInfo] = useState(null)

  useEffect(() => {
    ctx.rest('/status', { timeoutMs: 20000 })
      .then(r => setInfo(r))
      .catch(e => setInfo({ error: String(e?.message || e).slice(0, 100) }))
    navigator.mediaDevices?.enumerateDevices?.()
      .then(list => setDevs({ mics: list.filter(d => d.kind === 'audioinput'), outs: list.filter(d => d.kind === 'audiooutput') }))
      .catch(() => {})
  }, [])
  useEffect(() => { ctx.storage.set(KEY_MIC, micId) }, [micId])
  useEffect(() => { ctx.storage.set(KEY_OUT, outId) }, [outId])
  useEffect(() => { ctx.storage.set(KEY_CHAT, chatWork ? '1' : '0') }, [chatWork])
  useEffect(() => { ctx.storage.set(KEY_ASK_CHAT, askChat ? '1' : '0') }, [askChat])
  useEffect(() => () => { try { _pvStopSession() } catch {} }, [])
  useEffect(() => () => { try { stopMicTest() } catch {} }, [])

  const field = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: dense ? 6 : 8 }
  const label = { fontSize: 10.5, fontWeight: 600, color: 'var(--ui-text-tertiary, #71717a)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const trigStyle = { width: '100%', minWidth: 0, overflow: 'hidden' }
  const valStyle = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', flex: '1 1 auto', minWidth: 0 }
  const opt = text => jsx('span', { title: text, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 232 }, children: text })

  const pick = (next, set) => v => { set(v === SENTINEL_DEFAULT ? '' : v) }

  const stopMicTest = () => {
    micTestSerial.current++  // a test still waiting for permission is cancelled too
    const t = micTestRef.current
    if (t) {
      try { t.stream.getTracks().forEach(x => x.stop()) } catch {}
      try { t.ctx.close() } catch {}
      try { cancelAnimationFrame(t.raf) } catch {}
    }
    micTestRef.current = null
    setMicTest({ on: false, err: '' })
  }
  const toggleMicTest = async () => {
    if (micTest.on) { stopMicTest(); return }
    // One token per test: what arrives after Stop or after the settings close is released at once.
    const mine = ++micTestSerial.current
    let stream = null, actx = null
    const release = () => { try { stream && stream.getTracks().forEach(x => x.stop()) } catch {}; try { actx && actx.close() } catch {} }
    setMicTest({ on: true, err: '' })
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true })
      if (mine !== micTestSerial.current) { release(); return }
      actx = new AudioContext()
      try { await actx.resume() } catch {}
      if (mine !== micTestSerial.current) { release(); return }
      const an = actx.createAnalyser(); an.fftSize = 512
      const mute = actx.createGain(); mute.gain.value = 0
      actx.createMediaStreamSource(stream).connect(an); an.connect(mute); mute.connect(actx.destination)
      const buf = new Uint8Array(an.fftSize)
      micTestRef.current = { stream, ctx: actx, raf: 0 }
      const loop = () => {
        const t = micTestRef.current
        if (!t) return
        try {
          an.getByteTimeDomainData(buf)
          let s = 0
          for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; s += d * d }
          const rms = Math.sqrt(s / buf.length)
          if (micBarRef.current) micBarRef.current.style.width = Math.min(100, Math.round(rms * 340)) + '%'
        } catch {}
        t.raf = requestAnimationFrame(loop)
      }
      loop()
      navigator.mediaDevices.enumerateDevices()
        .then(list => setDevs({ mics: list.filter(d => d.kind === 'audioinput'), outs: list.filter(d => d.kind === 'audiooutput') }))
        .catch(() => {})
    } catch (e) {
      release()
      if (mine !== micTestSerial.current) return
      setMicTest({ on: false, err: 'Could not open the microphone: ' + String((e && e.name) || e) })
    }
  }

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }, children: [
      jsx('div', { style: { fontSize: 13, fontWeight: 700, color: 'var(--foreground, #18181b)' }, children: 'Live Voice' }),
      info && jsx('div', {
        style: { fontSize: 10.5, fontWeight: 600, color: info.error ? '#dc2626' : '#3b82f6' },
        children: info.error ? 'no host' : 'connected'
      })
    ] }),
    // The call speaks as the pet's linked chat; the pet's chat button links the chat in front of you.
    jsx('div', { style: { fontSize: 11.5, lineHeight: 1.3, marginBottom: 10 }, children: "Voice talks to the pet's linked chat. Press the pet's chat button to link the chat you're in." }),
    // The engine and voice live in the status-bar panel now (same keys); each setting has one place.
    jsx('div', { style: { fontSize: 10, color: 'var(--ui-text-tertiary, #a1a1aa)', marginBottom: 10 }, children: 'Voice engine and voice moved to the \u{1F43E} button in the status bar.' }),
    jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }, children: [
      jsx(Switch, { checked: chatWork, onCheckedChange: v => setChatWork(!!v) }),
      jsxs('div', { style: { fontSize: 11.5, lineHeight: 1.3 }, children: [
        'Work in the chat',
        jsx('div', { style: { fontSize: 10, color: 'var(--ui-text-tertiary, #a1a1aa)' }, children: 'Tasks run in the open chat with its tools and model (your Hermes config). The voice never runs anything on its own.' }),
      ] })
    ] }),
    jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }, children: [
      jsx(Switch, { 'aria-label': 'Ask before sending to chat', checked: askChat, disabled: !chatWork, onCheckedChange: v => setAskChat(!!v) }),
      jsxs('div', { style: { fontSize: 11.5, lineHeight: 1.3 }, children: [
        'Ask before sending to chat',
        jsx('div', { style: { fontSize: 10, color: 'var(--ui-text-tertiary, #a1a1aa)' }, children: 'Ask for spoken approval before handing over a task. Applies to new calls.' }),
      ] })
    ] }),
    jsx('div', { style: { fontSize: 10, color: 'var(--ui-text-tertiary, #a1a1aa)', marginBottom: 10 }, children: 'Pet settings moved to the \u{1F43E} button in the status bar.' }),
    jsx('div', { style: { ...label, marginTop: 6, marginBottom: 6, borderTop: '1px solid var(--ui-stroke-secondary, rgba(127,127,127,0.25))', paddingTop: 8 }, children: 'Audio' }),
    jsxs('div', { style: field, children: [
      jsx('div', { style: label, children: 'Microphone' }),
      jsxs(Select, { value: micId || SENTINEL_DEFAULT, onValueChange: pick(micId, setMicId), children: [
        jsx(SelectTrigger, { style: trigStyle, children: jsx(SelectValue, { style: valStyle }) }),
        jsxs(SelectContent, { children: [
          jsx(SelectItem, { value: SENTINEL_DEFAULT, children: 'System default' }),
          ...devs.mics.map((d, i) => jsx(SelectItem, { value: String(d.deviceId), children: opt(d.label || ('Microphone ' + (i + 1))) }, 'mic-' + i))
        ] })
      ] })
    ] }),
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: -4, marginBottom: 10 }, children: [
      jsx(Button, {
        variant: micTest.on ? 'destructive' : 'secondary', size: 'sm',
        onClick: toggleMicTest,
        style: { flexShrink: 0 },
        children: micTest.on ? 'Stop' : 'Test'
      }),
      jsx('div', { style: { flex: 1, height: 7, borderRadius: 4, background: 'rgba(127,127,127,0.22)', overflow: 'hidden' }, children:
        jsx('div', { ref: micBarRef, style: { height: '100%', width: '0%', background: micTest.err ? '#dc2626' : '#22c55e' } })
      })
    ] }),
    micTest.on && !micTest.err && jsx('div', { style: { fontSize: 10, color: '#16a34a', marginTop: -6, marginBottom: 8 }, children: 'Speak and watch the bar: if it stays flat, this mic is not capturing.' }),
    micTest.err && jsx('div', { style: { fontSize: 10.5, color: '#dc2626', marginTop: -6, marginBottom: 8, lineHeight: 1.4 }, children: micTest.err }),
    jsxs('div', { style: { ...field, marginBottom: 4 }, children: [
      jsx('div', { style: label, children: 'Output' }),
      jsxs(Select, { value: outId || SENTINEL_DEFAULT, onValueChange: pick(outId, setOutId), children: [
        jsx(SelectTrigger, { style: trigStyle, children: jsx(SelectValue, { style: valStyle }) }),
        jsxs(SelectContent, { children: [
          jsx(SelectItem, { value: SENTINEL_DEFAULT, children: 'System default' }),
          ...devs.outs.map((d, i) => jsx(SelectItem, { value: String(d.deviceId), children: opt(d.label || ('Output ' + (i + 1))) }, 'out-' + i))
        ] })
      ] })
    ] }),
    devs.mics.length === 0 && jsx('div', { style: { fontSize: 10.5, color: 'var(--ui-text-tertiary, #a1a1aa)', lineHeight: 1.4 }, children: 'Devices appear after granting the microphone the first time.' }),
    jsx('div', { style: { borderTop: '1px solid var(--ui-stroke-secondary, rgba(127,127,127,0.25))', marginTop: 6, paddingTop: 8 }, children: jsx(CodexSection, { ctx }) })
  ] })
}

// ── Icons ────────────────────────────────────────────────────────────────

function CodexSection({ ctx }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)
  const [localMsg, setLocalMsg] = useState('')
  const [usage, setUsage] = useState(null)
  const [usageBusy, setUsageBusy] = useState(false)
  const usageBusyRef = useRef(false)

  const loadUsage = () => {
    if (usageBusyRef.current) return
    usageBusyRef.current = true
    setUsageBusy(true)
    const codexP = ctx.rest('/codex/usage', { timeoutMs: 30000 }).catch(e => ({ ok: false, error: String(e?.message || e).slice(0, 100) }))
    const voiceP = ctx.rest('/voice/usage', { timeoutMs: 15000 }).catch(() => ({ ok: false }))
    Promise.all([codexP, voiceP]).then(pair => {
      const cx = pair[0] && typeof pair[0] === 'object' ? pair[0] : { ok: false }
      setUsage(Object.assign({}, cx, { voice: pair[1] || null }))
    }).finally(() => { usageBusyRef.current = false; setUsageBusy(false) })
  }
  const load = () => {
    ctx.rest('/codex/status', { timeoutMs: 20000 })
      .then(r => setSt(r))
      .catch(e => setSt({ error: String(e?.message || e).slice(0, 120) }))
  }
  useEffect(() => { load() }, [])
  const loginStatus = st && st.login ? st.login.status : null
  useEffect(() => {
    if (loginStatus !== 'pending') return
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [loginStatus])

  useEffect(() => { loadUsage() }, [])
  // Refresh automatically while settings are open.
  useEffect(() => {
    const t = setInterval(() => { try { loadUsage() } catch {} }, 60000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { if (loginStatus === 'done') loadUsage() }, [loginStatus])

  const refreshSoon = () => { setTimeout(load, 700); setTimeout(load, 3000) }
  const start = async () => {
    if (busy) return
    setBusy(true); setLocalMsg('')
    try { await ctx.rest('/codex/login/start', { method: 'POST' }); refreshSoon() }
    catch (e) { setLocalMsg(String(e?.message || e).slice(0, 140)) }
    finally { setBusy(false) }
  }
  const cancel = async () => {
    try { await ctx.rest('/codex/login/cancel', { method: 'POST' }) } catch {}
    refreshSoon()
  }
  const logout = async () => {
    setBusy(true); setLocalMsg('')
    try { await ctx.rest('/codex/logout', { method: 'POST' }); setConfirmOut(false); refreshSoon() }
    catch (e) { setLocalMsg(String(e?.message || e).slice(0, 140)) }
    finally { setBusy(false) }
  }
  const copy = text => { try { navigator.clipboard?.writeText(text) } catch {} }

  let chip = { text: '…', color: 'var(--ui-text-tertiary, #71717a)' }
  if (st && st.error) chip = { text: 'no host', color: '#dc2626' }
  else if (st) {
    const oauth = st.codexOauth
    const lane = st.lane
    if (st.login && st.login.status === 'pending') chip = { text: 'waiting…', color: '#ca8a04' }
    else if (lane === 'codex-oauth' && (oauth === 'valid' || oauth === 'expired')) chip = { text: 'Active' + (oauth === 'valid' ? '' : ' (auto-renews)'), color: '#16a34a' }
    else if (lane === 'configured' || lane === 'env') chip = { text: 'API key', color: '#ca8a04' }
    else chip = { text: 'No session', color: '#dc2626' }
  }
  const pending = st && st.login && st.login.status === 'pending'
  const loginErr = st && st.login && st.login.status === 'error' ? (st.login.message || '') : ''
  const doneMsg = st && st.login && st.login.status === 'done' ? (st.login.message || 'Signed in') : ''
  const active = st && st.lane === 'codex-oauth' && (st.codexOauth === 'valid' || st.codexOauth === 'expired')

  const cbtn = (label, onClick, tone) => jsx('button', {
    type: 'button', onClick, disabled: busy,
    style: {
      flex: 1, padding: '6px 0', borderRadius: 8, fontSize: 11.5, fontWeight: 600,
      cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
      border: '1px solid ' + (tone === 'danger' ? 'rgba(220,38,38,0.45)' : tone === 'muted' ? 'rgba(127,127,127,0.4)' : 'rgba(59,130,246,0.45)'),
      background: tone === 'danger' ? 'rgba(220,38,38,0.08)' : tone === 'muted' ? 'transparent' : 'rgba(59,130,246,0.10)',
      color: tone === 'danger' ? '#dc2626' : tone === 'muted' ? 'var(--ui-text-tertiary, #71717a)' : '#3b82f6'
    },
    children: label
  })

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }, children: [
      jsx('div', { style: { flex: 1, fontSize: 10.5, fontWeight: 600, color: 'var(--ui-text-tertiary, #71717a)', textTransform: 'uppercase', letterSpacing: '0.05em' }, children: 'Session' }),
      jsx('button', {
        type: 'button', title: 'What is this',
        onClick: () => setShowInfo(x => !x),
        style: {
          width: 16, height: 16, borderRadius: '50%', padding: 0, lineHeight: 1,
          border: '1px solid rgba(127,127,127,0.45)', cursor: 'pointer',
          background: showInfo ? '#3b82f6' : 'transparent',
          color: showInfo ? '#ffffff' : 'var(--ui-text-tertiary, #71717a)',
          fontSize: 10, fontWeight: 700
        },
        children: 'i'
      }),
      jsx('div', { style: { fontSize: 11, fontWeight: 700, color: chip.color }, children: chip.text })
    ] }),
    showInfo && jsx('div', {
      style: { fontSize: 11, lineHeight: 1.5, color: 'var(--ui-text-tertiary, #71717a)', background: 'rgba(127,127,127,0.08)', borderRadius: 8, padding: '8px 10px', marginBottom: 8 },
      children: 'Voice uses the ChatGPT subscription via Codex OAuth (not an API key). Credentials live on the server only — this machine never sees them. "Active" = ready and self-renewing. Sign in: you get a link and a code; open it in your browser and enter it. Sign out disconnects the account from the server (voice + VPS Codex CLI); a backup is kept.'
    }),
    pending && jsxs('div', { style: { fontSize: 11.5, marginBottom: 8, lineHeight: 1.7 }, children: [
      jsxs('div', { children: [
        '1. Open: ',
        jsx('span', { style: { fontWeight: 600 }, children: 'auth.openai.com/codex/device' }),
        ' ',
        jsx('button', { type: 'button', onClick: () => copy(st.login.url || 'https://auth.openai.com/codex/device'), title: 'Copy link', style: { border: 'none', background: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 11, padding: 0 }, children: '(copy)' })
      ] }),
      jsxs('div', { children: [
        '2. Code: ',
        jsx('span', { style: { fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13, letterSpacing: '0.06em' }, children: st.login.code || '…' }),
        ' ',
        jsx('button', { type: 'button', onClick: () => copy(st.login.code || ''), title: 'Copy code', style: { border: 'none', background: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 11, padding: 0 }, children: '(copy)' })
      ] }),
      jsx('div', { style: { color: '#ca8a04' }, children: 'Waiting for approval… (expires in ~15 min)' })
    ] }),
    doneMsg && jsx('div', { style: { fontSize: 11, color: '#16a34a', marginBottom: 6 }, children: doneMsg }),
    loginErr && jsx('div', { style: { fontSize: 11, color: '#dc2626', marginBottom: 6, whiteSpace: 'pre-wrap' }, children: loginErr }),
    localMsg && jsx('div', { style: { fontSize: 11, color: '#dc2626', marginBottom: 6 }, children: localMsg }),
    (usage && usage.ok) && jsxs('div', { style: { marginBottom: 8 }, children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }, children: [
        jsx('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--ui-text-tertiary, #71717a)', textTransform: 'uppercase', letterSpacing: '0.05em' }, children: 'Usage' }),
        jsxs('button', { type: 'button', title: 'Refresh usage', onClick: loadUsage, style: { display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', color: usageBusy ? 'var(--ui-text-tertiary, #71717a)' : '#3b82f6', cursor: usageBusy ? 'default' : 'pointer', fontSize: 11, padding: 0 }, children: [
          usageBusy
            ? jsx('span', { style: { position: 'relative', width: 11, height: 11, display: 'inline-block' }, children: jsx(SpinnerRing, { inset: 0 }) })
            : jsx('svg', { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', children: [jsx('path', { d: 'M21 12a9 9 0 1 1-3-6.7' }), jsx('path', { d: 'M21 3v6h-6' })] }),
          'refresh'
        ] })
      ] }),
      (usage.voice && usage.voice.ok) && (function () {
        const v = usage.voice
        const r5 = v.rolling5h || {}
        const r5min = Number((r5.audioMinutes != null && r5.audioMinutes > 0) ? r5.audioMinutes : (r5.minutes || 0))
        const cap = VOICE_CAP_MIN(usage.plan)
        const lo = cap ? cap[0] : 0
        const pct = lo ? Math.max(0, Math.min(100, Math.round(r5min / lo * 100))) : 0
        const color = pct >= 80 ? '#dc2626' : pct >= 50 ? '#ca8a04' : '#16a34a'
        const capTxt = cap ? ('~' + cap[0] + (cap[1] !== cap[0] ? '-' + cap[1] : '') + ' min') : ''
        const used = r5min >= 1 ? (Math.round(r5min * 10) / 10).toString() + ' min' : Math.round(r5min * 60) + ' s'
        const r24 = v.rolling24h || {}
        const r24min = Math.round(Number(r24.audioMinutes > 0 ? r24.audioMinutes : (r24.minutes || 0)))
        return jsxs('div', { style: { marginBottom: 8 }, children: [
          jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ui-text-tertiary, #71717a)' }, children: [
            jsx('span', { children: 'Live Voice' + ' · rolling 5 h' }),
            jsx('span', { style: { fontWeight: 700, color: cap ? color : 'var(--ui-text-tertiary, #71717a)' }, children: used + (capTxt ? ' / ' + capTxt : '') })
          ] }),
          cap && jsx('div', { style: { height: 4, borderRadius: 2, background: 'rgba(127,127,127,0.18)', marginTop: 2, overflow: 'hidden' }, children:
            jsx('div', { style: { height: 4, width: pct + '%', background: color } }) }),
          jsxs('div', { style: { fontSize: 10, color: 'var(--ui-text-tertiary, #71717a)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }, children: [
            jsx('span', { children: '24 h: ' + r24min + ' min' }),
            jsx('span', { children: ((v.week && v.week.sessions) || 0) + ' sessions · 7 d: ' + Math.round((v.week && v.week.minutes) || 0) + ' min' })
          ] }),
          jsx('div', { style: { fontSize: 9.5, color: 'var(--ui-text-tertiary, #71717a)', marginTop: 1 }, children: ((v.week && v.week.sessions) || 0) > 0
            ? 'active voice min (measured on hangup) · plan allowance: Codex voice'
            : 'recorded when each call ends' })
        ] })
      })(),
      (usage.windows && Object.keys(usage.windows).length > 0) && jsx('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--ui-text-tertiary, #71717a)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }, children: 'Codex' + (usage.plan ? ' · ' + usage.plan : '') }),
      ...Object.keys(usage.windows || {}).map(label => {
        const w = usage.windows[label] || {}
        const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0))
        const color = pct >= 85 ? '#dc2626' : pct >= 60 ? '#ca8a04' : '#16a34a'
        let reset = ''
        if (w.resetsAt) {
          try {
            const num = Number(w.resetsAt)
            const ms = num > 1e12 ? num : num * 1000
            const dt = new Date(ms)
            reset = 'resets ' + dt.toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          } catch {}
        }
        return jsxs('div', { style: { fontSize: 10.5, color: 'var(--ui-text-tertiary, #71717a)', marginBottom: 5 }, children: [
          jsxs('div', { style: { display: 'flex', justifyContent: 'space-between' }, children: [
            jsx('span', { children: label }),
            jsx('span', { style: { fontWeight: 700, color }, children: pct + '% used' + ' · ' + (100 - pct) + '% left' + (pct >= 90 ? ' — near limit' : '') })
          ] }),
          jsx('div', { style: { height: 4, borderRadius: 2, background: 'rgba(127,127,127,0.18)', marginTop: 2, overflow: 'hidden' }, children:
            jsx('div', { style: { height: 4, width: pct + '%', background: color } }) }),
          reset && jsx('div', { style: { marginTop: 1 }, children: reset })
        ] }, 'ux-' + label)
      })
    ] }),
    confirmOut
      ? jsxs('div', { children: [
          jsx('div', { style: { fontSize: 11, color: '#dc2626', lineHeight: 1.5, marginBottom: 6 }, children: 'Sign out the server ChatGPT session? Affects voice and the VPS Codex CLI. A backup is kept.' }),
          jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
            cbtn('Confirm sign-out', logout, 'danger'),
            cbtn('Cancel', () => setConfirmOut(false), 'muted')
          ] })
        ] })
      : jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
          pending ? cbtn('Restart', start) : cbtn(active ? 'Restart sign-in' : 'Sign in', start),
          pending ? cbtn('Cancel', cancel, 'danger') : (active ? cbtn('Sign out', () => setConfirmOut(true), 'danger') : null)
        ] })
  ] })
}

function HangupIcon({ size = 15, color = 'currentColor' }) {
  return jsx('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { transform: 'rotate(133deg)' },
    children: jsx('path', { d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' })
  })
}

function MicIcon({ size = 15, color = 'currentColor' }) {
  return jsx('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      jsx('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }),
      jsx('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
      jsx('line', { x1: 12, y1: 19, x2: 12, y2: 22 })
    ]
  })
}

function MicOffIcon({ size = 15, color = 'currentColor' }) {
  return jsxs('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      jsx('line', { x1: 2, y1: 2, x2: 22, y2: 22 }),
      jsx('path', { d: 'M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6' }),
      jsx('path', { d: 'M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23' }),
      jsx('line', { x1: 12, y1: 19, x2: 12, y2: 22 })
    ]
  })
}

function GearIcon({ size = 12, color = 'currentColor' }) {
  return jsx('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      jsx('circle', { cx: 12, cy: 12, r: 3 }),
      jsx('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })
    ]
  })
}

// ── Composer button ──────────────────────────────────────────────────────

function TrIcon({ size = 13, color = 'currentColor' }) {
  return jsx('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2.2, strokeLinecap: 'round', children: [
    jsx('line', { x1: 4, y1: 7, x2: 20, y2: 7 }),
    jsx('line', { x1: 4, y1: 12, x2: 20, y2: 12 }),
    jsx('line', { x1: 4, y1: 17, x2: 13, y2: 17 })
  ] })
}

// Transcript panel: popover anchored to the button (transient, closes itself).
function LivePanel() {
  const s = useLiveState()
  const stop = () => { void liveController?.action({ action: 'stop' }) }
  const dot = s.err ? '#dc2626' : (s.stage === 'connected' ? '#22c55e' : '#f59e0b')
  const status = s.err ? 'error' : (s.spkBot ? 'speaking' : (s.spkUser ? 'listening' : (s.stage === 'connected' ? 'live' : s.stage)))
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 14px 6px' }, children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 }, children: [
        jsx('span', { style: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginRight: 7, background: dot } }),
        jsx('div', { style: { fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: botSpeaker() })
      ] }),
      jsx('div', { style: { fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0, color: s.err ? '#dc2626' : (s.spkBot ? '#7c3aed' : '#3b82f6') }, children: status })
    ] }),
    jsx(TranscriptView, { max: 240 }),
    jsx('div', { style: { padding: '6px 14px 12px' }, children: jsx(Button, {
      variant: 'destructive',
      onClick: stop,
      style: { width: '100%' },
      children: 'Hang up'
    }) })
  ] })
}

function ComposerLiveButton({ ctx }) {
  const s = useLiveState()
  const [busy, setBusy] = useState(false)
  const [cfg, setCfg] = useState(false)
  useEffect(() => {
    const open = () => setCfg(true)
    window.addEventListener('talk-desktop:open-controls', open)
    return () => window.removeEventListener('talk-desktop:open-controls', open)
  }, [])
  const [micHover, setMicHover] = useState(false)
  const [muteHover, setMuteHover] = useState(false)
  const [gearHover, setGearHover] = useState(false)
  const [trHover, setTrHover] = useState(false)
  const [showTr, setShowTr] = useState(false)
  const btnRef = useRef(null)

  // Right-click bonus: if the app does not intercept it above, open settings.
  useEffect(() => {
    const h = e => {
      const el = btnRef.current
      if (!el) return
      const wrap = el.parentElement
      if (!wrap || !wrap.contains(e.target)) return
      e.preventDefault(); e.stopPropagation()
      setCfg(x => !x)
    }
    document.addEventListener('contextmenu', h, true)
    return () => document.removeEventListener('contextmenu', h, true)
  }, [])

  const toggle = async () => {
    setBusy(true)
    try { await liveController?.action({ action: bus.live || liveController?.snapshot().lifecycle === 'connecting' ? 'stop' : 'start' }) }
    catch { /* The persistent controller publishes the recoverable error. */ }
    finally { setBusy(false) }
  }

  const live = s.live && s.stage === 'connected'
  useEffect(() => { if (!s.live && !transcript.length && showTr) setShowTr(false) }, [s.live, s.transcriptRev, showTr])
  const connecting = busy || (s.live && s.stage !== 'connected' && s.stage !== 'error' && s.stage !== 'failed')
  const cs = 'var(--composer-control-size, 30px)'

  return jsxs('span', {
    'data-context-menu-skip': 'true',
    style: { display: 'inline-flex', alignItems: 'center', gap: 3 },
    children: [
      jsx('button', {
        ref: btnRef,
        type: 'button',
        'data-context-menu-skip': 'true',
        title: live ? 'Hang up Live Voice' : 'Live Voice — click to talk',
        'data-talk-live-toggle': '',
        onClick: toggle,
        onMouseEnter: () => setMicHover(true),
        onMouseLeave: () => setMicHover(false),
        style: {
          width: cs, height: cs, borderRadius: '50%', padding: 0, position: 'relative',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', cursor: 'pointer', overflow: 'visible',
          background: live
            ? (micHover ? '#1e293b' : '#0f172a')
            : (micHover ? 'var(--chrome-action-hover, rgba(0,0,0,0.06))' : 'transparent'),
          color: live ? '#ffffff' : (micHover ? 'var(--foreground, #18181b)' : 'var(--ui-text-tertiary, #71717a)'),
          boxShadow: live
            ? (micHover
              ? '0 0 0 1.5px rgba(239,68,68,0.55), 0 2px 12px rgba(239,68,68,0.28)'
              : '0 0 0 1.5px rgba(96,165,250,0.5), 0 2px 10px rgba(37,99,235,0.22)')
            : (micHover ? '0 0 0 1px var(--border, rgba(0,0,0,0.12))' : 'none'),
          transform: micHover ? 'scale(1.05)' : 'scale(1)',
          transition: 'background 160ms, color 160ms, box-shadow 160ms, transform 160ms'
        },
        children: [
          connecting && jsx(SpinnerRing, {}),
          (live && !connecting)
            ? (micHover ? jsx(HangupIcon, { size: 15 }) : jsx(LiveBars, { size: 10, count: 5 }))
            : jsx(MicIcon, { size: 15 })
        ]
      }),
      s.live && jsx('button', {
        type: 'button',
        'data-context-menu-skip': 'true',
        'data-talk-live-mute': '',
        'aria-pressed': s.muted === true,
        title: s.muted ? 'Unmute microphone' : 'Mute microphone',
        onClick: () => { try { window.__talkLiveHandle && window.__talkLiveHandle.toggleMute() } catch {} },
        onMouseEnter: () => setMuteHover(true),
        onMouseLeave: () => setMuteHover(false),
        style: {
          width: 24, height: 24, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: s.muted ? 'rgba(245,158,11,0.22)' : (muteHover ? 'var(--chrome-action-hover, rgba(0,0,0,0.09))' : 'transparent'),
          color: s.muted ? '#f59e0b' : (muteHover ? 'var(--foreground, #18181b)' : 'var(--ui-text-tertiary, #71717a)'),
          boxShadow: s.muted
            ? '0 0 0 1.5px rgba(245,158,11,0.55)'
            : (muteHover ? '0 0 0 1px var(--border, rgba(0,0,0,0.14))' : 'none'),
          opacity: (s.muted || muteHover) ? 1 : 0.8,
          transform: muteHover ? 'scale(1.1)' : 'scale(1)',
          transition: 'background 140ms, color 140ms, box-shadow 140ms, transform 140ms'
        },
        children: s.muted ? jsx(MicOffIcon, { size: 14 }) : jsx(MicIcon, { size: 14 })
      }),
      (s.live || transcript.length > 0) && jsx('span', {
        'data-context-menu-skip': 'true',
        style: { display: 'inline-flex', alignItems: 'center' },
        children: jsx(Popover, {
          open: showTr,
          onOpenChange: setShowTr,
          children: [
            jsx(PopoverTrigger, { asChild: true, children: jsx('button', {
              type: 'button',
              'data-context-menu-skip': 'true',
              title: 'Live transcript',
              'data-talk-live-transcript': '',
              onMouseEnter: () => setTrHover(true),
              onMouseLeave: () => setTrHover(false),
              style: {
                width: 22, height: 22, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: (showTr || trHover) ? 'var(--chrome-action-hover, rgba(0,0,0,0.08))' : 'transparent',
                color: showTr ? '#3b82f6' : (trHover ? 'var(--foreground, #18181b)' : 'var(--ui-text-tertiary, #71717a)'),
                opacity: (showTr || trHover) ? 1 : 0.85,
                transition: 'background 140ms, color 140ms'
              },
              children: jsx(TrIcon, { size: 13 })
            }) }),
            jsx(PopoverContent, { side: 'top', align: 'end', sideOffset: 8, style: { width: 320 },
              onFocusOutside: e => { try { e.preventDefault() } catch {} },
              children: jsx(LivePanel, {}) })
          ]
        })
      }),
      jsx('span', {
        'data-context-menu-skip': 'true',
        style: { display: 'inline-flex', alignItems: 'center' },
        children: jsx(Popover, {
          open: cfg,
          onOpenChange: setCfg,
          children: [
            jsx(PopoverTrigger, { asChild: true, children: jsx('button', {
              type: 'button',
              'data-context-menu-skip': 'true',
              title: 'Live Voice: microphone, output, chat handoff',
              'data-talk-live-gear': '',
              onMouseEnter: () => setGearHover(true),
              onMouseLeave: () => setGearHover(false),
              style: {
                width: 22, height: 22, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: (gearHover || cfg) ? 'var(--chrome-action-hover, rgba(0,0,0,0.08))' : 'transparent',
                color: (gearHover || cfg) ? '#3b82f6' : 'var(--ui-text-tertiary, #71717a)',
                opacity: (gearHover || cfg) ? 1 : 0.6,
                transform: gearHover ? 'scale(1.12)' : 'scale(1)',
                transition: 'opacity 140ms, background 140ms, color 140ms, transform 140ms'
              },
              children: jsx(GearIcon, { size: 12 })
            }) }),
            jsx(PopoverContent, {
              side: 'top', align: 'end', sideOffset: 8,
              style: { width: 300 },
              onFocusOutside: e => { try { e.preventDefault() } catch {} },
              children: jsxs('div', { children: [
                jsx(Button, { disabled: connecting, onClick: toggle, style: { width: '100%', marginBottom: 8 }, children: s.live ? 'Hang up' : (connecting ? 'Connecting…' : 'Start Live Voice') }, 'call'),
                live && jsx(Button, { onClick: () => { try { window.__talkLiveHandle?.toggleMute() } catch {} }, style: { width: '100%', marginBottom: 8 }, children: s.muted ? 'Unmute microphone' : 'Mute microphone' }, 'mute'),
                jsx(ConfigForm, { ctx }, 'config')
              ] })
            })
          ]
        })
      }),
      jsx('span', { style: { display: 'none' } })
    ]
  })
}

// ── Live transcript (Codex Live style) ────────────────────────────────────

function renderBubble(m, key) {
  if (m.role === 'sys') return jsx('div', { style: { textAlign: 'center', fontSize: 10.5, color: '#8e8e93', lineHeight: 1.4, padding: '0 8px' }, children: m.text }, 'tr-' + key)
  if (m.role === 'tool') return jsx('div', { style: { display: 'flex', justifyContent: 'center' }, children: jsxs('span', {
    style: { display: 'inline-flex', alignItems: 'flex-start', gap: 5, fontSize: 10, color: '#b0b0b6', background: 'rgba(127,127,127,0.14)', border: '1px solid rgba(127,127,127,0.18)', borderRadius: 10, padding: '3px 9px', maxWidth: '92%', lineHeight: 1.45, textAlign: 'left' }, children: [
      jsx('span', { style: { flexShrink: 0, opacity: 0.9 }, children: '⚙︎' }),
      jsx('span', { style: { wordBreak: 'break-word' }, children: m.text })
    ] }) }, 'tr-' + key)
  const isUser = m.role === 'user'
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' },
    children: [
      jsx('div', { style: { fontSize: 10, fontWeight: 600, color: '#8e8e93', margin: isUser ? '0 7px 1px 0' : '0 0 1px 7px' }, children: isUser ? 'You' : botSpeaker() }),
      jsx('div', {
        style: {
          maxWidth: '84%', padding: '6px 11px', borderRadius: 15, fontSize: 12, lineHeight: 1.35,
          background: isUser ? '#0a84ff' : '#2c2c2e', color: '#ffffff',
          borderBottomRightRadius: isUser ? 5 : 15, borderBottomLeftRadius: isUser ? 15 : 5,
          opacity: m.done === false ? 0.72 : 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
        },
        children: m.text
      })
    ]
  }, 'tr-' + key)
}

function useTranscriptRev() {
  const [rev, setRev] = useState(bus.transcriptRev)
  useEffect(() => {
    const h = () => setRev(bus.transcriptRev)
    window.addEventListener('talk-desktop:state', h)
    return () => window.removeEventListener('talk-desktop:state', h)
  }, [])
  return rev
}

function TranscriptView({ expanded, onToggle, max = 66 }) {
  const rev = useTranscriptRev()
  const boxRef = useRef(null)
  const atBottomRef = useRef(true)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    if (atBottomRef.current) { el.scrollTop = el.scrollHeight; if (more) setMore(false) }
    else setMore(true)
  }, [rev, expanded])
  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 26
    atBottomRef.current = at
    if (at && more) setMore(false)
  }
  const scrollDown = () => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setMore(false)
  }
  const items = transcript.slice(-60)
  return jsxs('div', { style: { padding: '0 12px 8px' }, children: [
    jsxs('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, cursor: onToggle ? 'pointer' : 'default' },
      onClick: onToggle || undefined, children: [
        jsx('div', { style: { fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color: '#a1a1aa', textTransform: 'uppercase' }, children: 'Conversation' }),
        onToggle && jsx('div', { style: { fontSize: 10, color: '#a1a1aa' }, children: expanded ? 'hide ▴' : 'show all ▾' })
      ]
    }),
    jsx('div', { style: { position: 'relative' }, children: [
      jsx('div', { ref: boxRef, onScroll, style: { maxHeight: max, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 2, paddingBottom: 4 }, children:
        items.length === 0
          ? jsxs('div', { style: { padding: '22px 10px 18px', textAlign: 'center', color: '#8e8e93' }, children: [
              jsx(TrIcon, { size: 18, color: '#8e8e93' }),
              jsx('div', { style: { fontSize: 10.5, marginTop: 7, lineHeight: 1.4 }, children: 'The transcript shows up here when you start talking.' })
            ] })
          : items.map((m, i) => renderBubble(m, i))
      }),
      more && jsx('button', {
        type: 'button', onClick: scrollDown,
        style: { position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', border: 'none', borderRadius: 999, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#3b82f6', color: '#ffffff', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', zIndex: 2 },
        children: '↓ ' + 'new'
      })
    ] })
  ] })
}

// The pet retains one explicit work association, never the ambient focused chat.
const petAtomGet = atom => { try { return atom?.get ? atom.get() : atom } catch { return null } }
// SDK normalizeProfileKey: empty/null profile denotes default, never a source.
const petProfileKey = value => String(value ?? '').trim() || 'default'
let petChat = null
let petCompanion = { busy: false, open: false, error: '', toggle: () => {} }
// Where bot pets appear. Desktop windows need Linux with a layer-shell compositor; the backend
// reports that once as petCompanion.desktopWindows (undefined until known = old behaviour).
const KEY_BOT_PLACE = 'botPlacement.v1'   // 'auto' | 'desktop' | 'inapp'
const KEY_BOT_LINES = 'botLines.v1'       // '1' = bot lines in Hermes' pet bubble (off by default)
let petStorage = null
// Pets panel sizes in percent, 50-200, saved; 100% = Hermes' default pet scale 0.33 and today's
// pop-out/bot look. The main-pet size drives Hermes' own display.pet.scale on the owner profile only.
const KEY_PET_SIZE = 'petSize.v1', KEY_BOT_SIZE = 'botSize.v1'
const petSizes = { pet: 100, bots: 100 }
let petOwner = 'default', petOwnerConn = '', petSizeTimer = null, petScaleTimer = null, petSizeEdits = 0
let petSizeConfirmed = 100  // the last main-pet size Hermes accepted (percent); a refused write falls back to it
let petSizeOkGen = 0        // the newest resize write Hermes accepted; an older answer may not confirm over it
let petSizeError = ''       // shown in the panel after a refused pet.scale write
let petBotReset = 0  // bumped by Reset bot positions while desktop bot windows are open; the helper re-places them
const petSizeClamp = n => Math.max(50, Math.min(200, Math.round((Number(n) || 100) / 5) * 5))
// The owner route is the backend connection and profile Hermes sat on at load; a same-named profile elsewhere is not it.
const petOwnerHere = () => { const conn = String(petAtomGet(host.state.connectionId) || ''); petOwnerConn ||= conn; return conn === petOwnerConn && petProfileKey(petAtomGet(host.state.profile)) === petOwner }
function setPetSize(which, value, rpc = true) {
  petSizes[which] = petSizeClamp(value)
  if (which === 'pet' && !rpc) petSizeConfirmed = petSizes.pet  // an owner-scoped read is Hermes' own size
  window.dispatchEvent(new CustomEvent('talk-desktop:sizes')); window.dispatchEvent(new CustomEvent('talk-desktop:state'))
  clearTimeout(petSizeTimer)
  petSizeTimer = setTimeout(() => { petStorage?.set?.(KEY_PET_SIZE, String(petSizes.pet)); petStorage?.set?.(KEY_BOT_SIZE, String(petSizes.bots)) }, 200)
  if (which !== 'pet' || !rpc) return
  petSizeEdits++; clearTimeout(petScaleTimer)
  const sent = petSizes.pet, gen = petSizeEdits
  petScaleTimer = setTimeout(() => {
    if (!petOwnerHere()) return
    Promise.resolve(host.request?.('pet.scale', { scale: Math.round(3.3 * sent) / 1000, profile: petOwner })).then(() => {
      if (gen > petSizeOkGen) { petSizeOkGen = gen; petSizeConfirmed = sent }
      // Only the newest edit decides what the slider shows. An answer from an older drag must
      // not pull a newer size back, while the newest success restores the size an even older
      // failure rolled the slider off.
      if (gen !== petSizeEdits) return
      if (petSizes.pet !== sent) { petSizes.pet = sent; window.dispatchEvent(new CustomEvent('talk-desktop:sizes')) }
      petStorage?.set?.(KEY_PET_SIZE, String(sent))
      if (petSizeError) { petSizeError = ''; window.dispatchEvent(new CustomEvent('talk-desktop:sizes')) }
    }, () => {
      // Hermes refused this size. If the user has already moved on, stay quiet and let the newer
      // write settle; rolling back here would undo a size that write may well accept.
      if (gen !== petSizeEdits) return
      petSizeError = "Couldn't resize the main pet \u2014 try again"
      petSizes.pet = petSizeConfirmed
      petStorage?.set?.(KEY_PET_SIZE, String(petSizes.pet))  // a refused size must not become the stored one
      window.dispatchEvent(new CustomEvent('talk-desktop:sizes'))
    })
  }, 200)
}
// Hermes' real main-pet scale on the owner route, read without writing. `edits` is the drag generation
// at request time: a slider move while the read is in flight wins. `apply` may return false to drop it.
function readMainPetSize(edits = petSizeEdits, apply = null) {
  if (!petOwnerHere()) return
  Promise.resolve(host.request?.('pet.info.meta', { profile: petOwner })).then(meta => {
    if (!petOwnerHere() || (apply && apply(meta) === false)) return
    if (edits === petSizeEdits && meta?.enabled && typeof meta.scale === 'number' && meta.scale > 0) setPetSize('pet', meta.scale / 0.0033, false)
  }).catch(() => {})
}
const petBotPlacement = () => {
  const pref = petStorage?.get?.(KEY_BOT_PLACE) || 'auto'
  return pref === 'inapp' || petCompanion.desktopWindows === false ? 'inapp' : 'desktop'
}
const petBotsOnDesktop = () => !!botTracker?.enabled() && petBotPlacement() === 'desktop'
const petBotsInApp = () => !!botTracker?.enabled() && petBotPlacement() === 'inapp'
const petPopOutHint = 'Shift-click the pet to pop it out: this system uses Hermes\u2019 own pop-out'
function petSessionOptions(owner) {
  return { profile: owner.profile, intent: 'in-place', ...(owner.connection ? { route: { connectionId: owner.connection, profile: owner.profile, mode: owner.connection === 'local' ? 'local' : 'remote' } } : {}) }
}
function associatePetChat(runtimeId, status = 'Working') {
  if (!runtimeId || runtimeId !== petAtomGet(host.state.focusedSessionId)) return
  petChat = { runtimeId, storedId: String(petAtomGet(host.state.focusedStoredSessionId) || ''), profile: String(petAtomGet(host.state.focusedSessionProfile) || ''), connection: petAtomGet(host.state.focusedSessionOwner)?.connectionId || '', status }
  window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat'))
}

// In-app pet companion only: attach outside PetSprite's mirrored wrapper.
// PetSprite's accessible canvas label is the only stable core hook available.
function PetLiveBadge() {
  useEffect(() => {
    const sheet = document.createElement('style')
    sheet.setAttribute('data-talk-pet-style', '')
    // Local theme-derived tokens: the sprite supplies the pink, while its
    // companion ink/surfaces remain readable with every installed skin.
    sheet.textContent = `
      [data-talk-pet-popped-out], [data-talk-pet-popped-out] * {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [data-talk-pet-status], [data-talk-pet-mic], [data-talk-pet-chat], [data-talk-pet-action] {
        --talk-pet-ink: var(--foreground, var(--ui-text-secondary));
        --talk-pet-surface: color-mix(in srgb, var(--popover-surface) 94%, var(--ui-accent) 6%);
      }

      [data-talk-pet-mic]:focus-visible, [data-talk-pet-chat]:focus-visible, [data-talk-pet-action]:focus-visible {
        outline: 2px solid var(--ui-accent); outline-offset: 4px;
      }
    ` + petButtonCSS
    document.head.appendChild(sheet)
    const badge = document.createElement('button')
    badge.type = 'button'
    badge.setAttribute('data-talk-pet-mic', '')
    badge.setAttribute('data-context-menu-skip', 'true')
    badge.title = 'Live Voice — click to talk'
    badge.setAttribute('aria-label', badge.title)
    Object.assign(badge.style, {
      position: 'absolute', right: '0px', bottom: '0px', width: '36px', height: '36px',
      zIndex: '3', borderRadius: '50%', padding: '5px', display: 'flex',
      alignItems: 'center', justifyContent: 'center', cursor: 'pointer', pointerEvents: 'auto',
      background: 'var(--popover-surface)', color: 'var(--ui-text-secondary)',
      border: '1px solid var(--ui-stroke-secondary)', boxShadow: '0 2px 6px var(--ui-stroke-secondary)'
    })
    const chat = document.createElement('button')
    chat.type = 'button'
    chat.setAttribute('data-talk-pet-chat', '')
    chat.setAttribute('data-context-menu-skip', 'true')
    chat.disabled = true
    chat.title = 'No associated chat yet'
    chat.setAttribute('aria-label', chat.title)
    // A separate row leaves all existing voice hit targets unchanged.
    Object.assign(chat.style, { position: 'absolute', right: '42px', bottom: '42px', width: '24px', height: '24px', padding: '3px', boxSizing: 'border-box', borderRadius: '50%', zIndex: '3', pointerEvents: 'auto', cursor: 'pointer', background: 'var(--popover-surface)', color: 'var(--ui-text-secondary)', border: '1px solid var(--ui-stroke-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' })
    chat.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/></svg>'
    chat.addEventListener('pointerdown', e => e.stopPropagation())
    const bubble = document.createElement('div')
    bubble.setAttribute('data-talk-pet-status', '')
    bubble.setAttribute('role', 'status')
    bubble.setAttribute('aria-live', 'polite')
    bubble.setAttribute('aria-atomic', 'true')
    bubble.hidden = true
    Object.assign(bubble.style, { position: 'absolute', right: '24px', bottom: 'calc(54% + 18px)', pointerEvents: 'none', zIndex: '3' }, petBubbleStyle(petDescriptor(false, false).statusBox))
    const popout = chat.cloneNode(false)
    popout.removeAttribute('data-talk-pet-chat')
    popout.setAttribute('data-talk-pet-popout', '')
    popout.setAttribute('data-talk-pet-action', 'popout')
    popout.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 3h7v7M21 3l-9 9M10 5H4v15h15v-6"/></svg>'
    popout.addEventListener('pointerdown', e => e.stopPropagation())
    popout.addEventListener('click', e => { e.stopPropagation(); if (!popout.disabled) void petCompanion.toggle() })
    const paintPopout = () => {
      popout.disabled = petCompanion.busy
      // No desktop pop-out here (Windows, macOS, non-layer-shell Linux): Hermes' own one stays.
      popout.style.display = petCompanion.desktopWindows === false ? 'none' : 'flex'
      popout.title = petCompanion.open ? 'Close pop-out pet' : 'Pop out pet'
      popout.setAttribute('aria-label', popout.title)
      popout.setAttribute('aria-pressed', String(petCompanion.open))
      popout.setAttribute('aria-busy', String(petCompanion.busy))
      popout.dataset.companionError = petCompanion.error
      popout.style.color = petCompanion.open ? 'var(--ui-accent)' : 'var(--ui-text-secondary)'
    }
    window.addEventListener('talk-desktop:companion', paintPopout)
    // While the pet is popped out, hide the in-app pet (sprite and controls); restore on close.
    let hiddenAnchor = null, previousInert = null
    const restoreAnchor = () => {
      if (!hiddenAnchor) return
      hiddenAnchor.removeAttribute('data-talk-pet-popped-out')
      if (previousInert === null) hiddenAnchor.removeAttribute('inert')
      else hiddenAnchor.setAttribute('inert', previousInert)
      hiddenAnchor = null; previousInert = null
    }
    const applyPoppedOut = () => {
      const anchor = badge.parentElement
      if (hiddenAnchor && (hiddenAnchor !== anchor || !petCompanion.open)) restoreAnchor()
      if (!anchor || !petCompanion.open) return
      if (!hiddenAnchor) { hiddenAnchor = anchor; previousInert = anchor.getAttribute('inert') }
      anchor.setAttribute('data-talk-pet-popped-out', '')
      anchor.setAttribute('inert', '')
    }
    window.addEventListener('talk-desktop:companion', applyPoppedOut)
    paintPopout()
    const extras = [chat, bubble, popout]
    let layout = () => {}, sync = () => {}
    let notice = '', noticeTimer = null
    const flash = text => { notice = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ''; paintChat() }, 3000); paintChat() }
    const paintChat = () => {
      const narrated = workNarration && workNarration.until > Date.now() ? workNarration.text : ''
      const waiting = attentionSummary(petOwnsAttention)
      const status = notice || petCompanion.error || (waiting ? petAttentionLabel(waiting.kind) : '') || narrated || petChat?.status || ''
      petSetBubbleText(bubble, status || petReplyHint)
      bubble.hidden = false

      layout()
    }

    petQuickReply(bubble, {
      send: text => { void liveController.action({ action: 'reply', text }).catch(error => flash(error?.message === 'Open a chat first' ? 'Open a chat first' : 'Could not send')) },
      repaint: () => paintChat()
    })
    const onChatChange = () => { paintChat(); sync() }
    window.addEventListener('talk-desktop:pet-chat', onChatChange)
    window.addEventListener('talk-desktop:companion', onChatChange)
    window.addEventListener('talk-desktop:state', onChatChange)
    paintChat()
    const companions = []
    const addCompanion = (action, right, bottom) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-talk-pet-action', action)
      button.setAttribute('data-context-menu-skip', 'true')
      const item = { action, right, bottom, button }
      companions.push(item)
      button.addEventListener('pointerdown', e => e.stopPropagation())
    }
    addCompanion('mute', 0, 42)
    addCompanion('bots', 42, 0)
    const setPx = (element, key, value) => {
      const next = Math.round(value) + 'px'
      if (element.style[key] !== next) element.style[key] = next
    }
    const visibleBounds = petBoundsReader()
    layout = () => {
      const anchor = badge.parentElement
      const canvas = anchor?.querySelector('canvas[aria-label]')
      if (!canvas) return
      const rect = anchor.getBoundingClientRect()
      const sprite = canvas.getBoundingClientRect()
      const width = sprite.width || parseFloat(canvas.style.width) || 192
      const height = sprite.height || parseFloat(canvas.style.height) || 208
      const x = rect.width ? rect.left : parseFloat(anchor.style.left) || 0
      const y = rect.height ? rect.top : parseFloat(anchor.style.top) || 0
      const vw = window.innerWidth, vh = window.innerHeight
      const bounds = visibleBounds(canvas) || { left: 0, top: 0, right: 1, bottom: 1 }
      // The canvas lives inside an optionally horizontally mirrored wrapper.
      const mirrored = /^matrix\(-/.test(window.getComputedStyle(canvas.parentElement).transform)
      const spriteX = (sprite.width ? sprite.left : x) + width * (mirrored ? 1 - bounds.right : bounds.left)
      const spriteY = (sprite.height ? sprite.top : y) + height * bounds.top
      const artWidth = width * (bounds.right - bounds.left)
      const artHeight = height * (bounds.bottom - bounds.top)
      const descriptor = companionDescriptor(bus.live), box = descriptor.statusBox
      Object.assign(bubble.style, petBubbleStyle(box))
      const bw = bubble.offsetWidth || 100.8, bh = bubble.offsetHeight || 40.8
      const { left, top, bubbleVisible, controls, utility } = petLayout(
        { left: spriteX, top: spriteY, width: artWidth, height: artHeight }, { width: vw, height: vh }, { width: bw, height: bh }, descriptor)
      // Pop-out is the in-app utility slot right of the shared chat/transcript controls.
      controls.push(utility)
      const elements=[badge,companions[0].button,chat,companions[1].button,popout]
      controls.forEach((position,i) => {
        const button=elements[i]
        button.style.right = 'auto'
        setPx(button, 'left', Math.ceil(position.left - x))
        setPx(button, 'bottom', (rect.height || height) - (position.top - y) - position.size)
        setPx(button, 'width', position.size);setPx(button,'height',position.size)
        button.style.visibility = position.visible ? 'visible' : 'hidden'
        button.dataset.petPlacement = position.visible ? 'right' : 'clipped'
      })
      bubble.style.right = 'auto'
      setPx(bubble, 'left', left - x)
      setPx(bubble, 'bottom', (rect.height || height) - (top - y) - bh)
      bubble.style.visibility = bubbleVisible ? 'visible' : 'hidden'
      bubble.dataset.petPlacement = bubble.style.visibility === 'visible' ? 'top-left' : 'clipped'

    }
    const sizeObserver = window.ResizeObserver ? new window.ResizeObserver(layout) : null
    window.addEventListener('resize', layout)
    const alphaTimer = setInterval(() => { if (!document.hidden && badge.isConnected) layout() }, 320)
    const controls = [badge, companions[0].button, chat, companions[1].button], pending = new Set()
    sync = () => {
      const snapshot = { ...liveController.snapshot(), owner: petChat }
      badge.dataset.voiceError = bus.err || ''
      petButtons(snapshot).forEach((control, i) => petPaintButton(controls[i], control, snapshot, pending.has(control.action)))
      layout()
    }
    const clearHover = () => controls.forEach(button => { button.dataset.petHover = '' })
    controls.forEach(button => {
      petBindFeedback(button, sync)
      button.addEventListener('click', e => {
        e.stopPropagation()
        if (button.disabled) return
        const action = button.dataset.action
        delete button.dataset.actionError
        pending.add(action); sync()
        void liveController.action({ action, ...(action === 'setMuted' ? { muted: !bus.muted } : {}) })
          .catch(() => { button.dataset.actionError = 'Action unavailable' })
          .finally(() => { pending.delete(action); sync() })
      })
    })
    const paint = () => sync()
    window.addEventListener('talk-desktop:state', paint)
    paint()
    badge.addEventListener('pointerdown', e => e.stopPropagation())
    const attach = () => {
      let anchor = null
      for (const canvas of document.querySelectorAll('canvas[aria-label]')) {
        if (!/ pet$/.test(canvas.getAttribute('aria-label') || '')) continue
        const candidate = canvas.parentElement?.parentElement
        if (candidate && candidate.style.position === 'fixed' && candidate.style.pointerEvents !== 'none') { anchor = candidate; break }
      }
      if (anchor && badge.parentElement !== anchor) {
        sizeObserver?.disconnect()
        anchor.appendChild(badge)
        companions.forEach(item => anchor.appendChild(item.button))
        extras.forEach(element => anchor.appendChild(element))
        sizeObserver?.observe(anchor)
        layout()
        applyPoppedOut()
      } else if (!anchor && badge.parentElement) {
        sizeObserver?.disconnect()
        clearHover()
        badge.remove()
        companions.forEach(item => item.button.remove())
        extras.forEach(element => element.remove())
      }
      layout()
      applyPoppedOut()
    }
    const observer = new MutationObserver(records => {
      if (records.some(r => !badge.contains(r.target) && !extras.some(element => element.contains(r.target)) && !companions.some(item => item.button.contains(r.target)))) attach()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'style'] })
    attach()
    const stopCapabilities = liveController?.subscribe(() => { paintChat(); sync() })
    return () => {
      stopCapabilities?.()
      clearInterval(alphaTimer); clearTimeout(noticeTimer)
      window.removeEventListener('talk-desktop:companion', paintPopout)
      window.removeEventListener('talk-desktop:companion', applyPoppedOut)
      restoreAnchor()
      window.removeEventListener('talk-desktop:pet-chat', onChatChange)
      window.removeEventListener('talk-desktop:companion', onChatChange)
      window.removeEventListener('talk-desktop:state', onChatChange)
      sizeObserver?.disconnect()
      window.removeEventListener('resize', layout)
      observer.disconnect(); clearHover()
      window.removeEventListener('talk-desktop:state', paint)
      badge.remove(); companions.forEach(item => item.button.remove()); extras.forEach(element => element.remove()); sheet.remove()
    }
  }, [])
  return null
}


// COMPANION_SHARED_BEGIN — helper extracts this pure, plugin-owned module.
function petBoundsReader() {
  // Use the in-app pose anchor on both surfaces, with a bounded rolling envelope.
  let sampledCanvas = null, sampleKey = '', lastSample = 0, alphaFrames = [], alphaBounds = null
  return canvas => {
    const key = canvas.width + ':' + canvas.height
    if (canvas !== sampledCanvas || key !== sampleKey) {
      sampledCanvas = canvas; sampleKey = key; lastSample = 0; alphaFrames = []; alphaBounds = null
    }
    if (!window.CanvasRenderingContext2D || Date.now() - lastSample < 300) return alphaBounds
    lastSample = Date.now()
    try {
      const w = canvas.width, h = canvas.height
      if (!w || !h || w * h > 2000000) return alphaBounds
      const pixels = canvas.getContext('2d')?.getImageData(0, 0, w, h).data
      if (!pixels) return alphaBounds
      let left = w, top = h, right = 0, bottom = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (pixels[(y * w + x) * 4 + 3] < 32) continue
        left = Math.min(left, x); top = Math.min(top, y)
        right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1)
      }
      if (right <= left || bottom <= top) return alphaBounds
      const next = { left: left / w, top: top / h, right: right / w, bottom: bottom / h }
      const previous = alphaFrames[alphaFrames.length - 1]
      if (previous && ['left', 'top', 'right', 'bottom'].some(edge => Math.abs(next[edge] - previous[edge]) > 0.12)) alphaFrames = []
      alphaFrames.push(next)
      if (alphaFrames.length > 3) alphaFrames.shift()
      const envelope = {
        left: Math.min(...alphaFrames.map(b => b.left)), top: Math.min(...alphaFrames.map(b => b.top)),
        right: Math.max(...alphaFrames.map(b => b.right)), bottom: Math.max(...alphaFrames.map(b => b.bottom))
      }
      if (!alphaBounds || Object.keys(envelope).some(edge => envelope[edge] !== alphaBounds[edge])) alphaBounds = envelope
    } catch { /* Unreadable canvas keeps the conservative fallback. */ }
    return alphaBounds
  }
}
function petDescriptor(active, muted) {
  return {
    // Grid: row 1 = call + mute (large, side by side); row 0 = chat, transcript, utility (small, above).
    version: 1, anchor: 'visible-art', gap: 10, controlGap: 6, surface: 'popover', ink: 'foreground',
    controls: [
      { action: active ? 'stop' : 'start', icon: active ? 'stop' : 'microphone', label: active ? 'stop' : 'start', size: 36, column: 0, row: 1, feedback: 'voice' },
      { action: 'setMuted', icon: muted ? 'microphone-off' : 'microphone', label: muted ? 'unmute' : 'mute', size: 36, column: 1, row: 1, feedback: 'mute' },
      { action: 'chat', icon: 'chat', label: 'chat', size: 24, column: 0, row: 0 },
      { action: 'bots', icon: 'bots', label: 'bots', size: 24, column: 1, row: 0 }
    ],
    statusBox: { width: 200, fontSize: 15, lineHeight: 22, radius: 10, paddingX: 14, paddingY: 8, border: 1.2 }
  }
}
const petButtonCSS = '[data-pet-button]:focus-visible{outline:2px solid var(--ui-accent);outline-offset:4px}.pet-spinner{animation:pet-spin 1.15s linear infinite}@keyframes pet-spin{to{transform:rotate(360deg)}}'
function petButtons(state) {
  const active = ['connecting', 'connected'].includes(state?.lifecycle)
  return (state?.descriptor || petDescriptor(active, !!state?.muted)).controls.map(control => ({
    ...control, active, visible: !!state && (control.feedback === 'voice' || state.capabilities.includes(control.action)),
    disabled: !state?.capabilities?.includes(control.action)
  }))
}
function petBindFeedback(button, paint) {
  for (const [event, entering] of [['mouseover', true], ['mouseout', false], ['focus', true], ['blur', false]]) {
    button.addEventListener(event, e => { if (!entering && button.contains(e.relatedTarget)) return; button.dataset.petHover = entering ? 'true' : ''; paint() })
  }
}
function petPaintButton(button, control, state, pending = false) {
  const hover = button.dataset.petHover === 'true', voice = control.feedback === 'voice', large = !!control.feedback
  const live = state?.lifecycle === 'connected', connecting = voice && state?.lifecycle === 'connecting'
  const paths = {
    microphone: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
    'microphone-off': '<line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/>',
    stop: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    chat: '<path d="M4 4h16v12H9l-5 4V4Z"/>',
    bots: '<circle cx="8" cy="7" r="3"/><circle cx="17" cy="8" r="2"/><path d="M2 21v-3a6 6 0 0 1 12 0v3m2-7a4 4 0 0 1 6 4v3"/>',
    transcript: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="13" y2="17"/>'
  }
  const icon = voice ? (live && hover ? 'stop' : 'microphone') : control.icon
  const size = voice ? 15 : control.feedback === 'mute' ? 14 : control.action === 'chat' ? 16 : 13
  let html = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${control.action === 'chat' ? 1.7 : control.action === 'transcript' ? 2.2 : 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${icon === 'stop' ? ' style="transform:rotate(133deg)"' : ''}>${Object.hasOwn(paths, icon) ? paths[icon] : ''}</svg>`
  if (voice && live && !hover) html = '<span style="display:flex;align-items:center;gap:2px;height:10px" aria-hidden="true">' + `<i style="display:block;width:2.5px;border-radius:2px;background:${state.muted ? '#9ca3af' : '#60a5fa'};height:2px;transition:height 100ms"></i>`.repeat(5) + '</span>'
  if (connecting) html += '<span class="pet-spinner" aria-hidden="true" style="position:absolute;inset:-3px;border-radius:50%;border:2px solid rgba(59,130,246,0.18);border-top-color:#3b82f6;border-right-color:#3b82f6;pointer-events:none"></span>'
  if (button._petMarkup !== html) { button.innerHTML = html; button._petMarkup = html }
  button.querySelectorAll('i').forEach((bar, i) => {
    const band = Number.isFinite(state?.bands?.[i]) ? Math.max(0, Math.min(1, state.bands[i])) : 0
    bar.style.height = Math.max(2, Math.round(band * 10)) + 'px'
  })
  const glow = voice && live ? (hover ? '0 0 0 1.5px rgba(239,68,68,0.55), 0 2px 12px rgba(239,68,68,0.28)' : '0 0 0 1.5px rgba(96,165,250,0.5), 0 2px 10px rgba(37,99,235,0.22)') : ''
  Object.assign(button.style, {
    position:'absolute', width:control.size+'px', height:control.size+'px', boxSizing:'border-box', overflow:'visible', zIndex:'3', pointerEvents:'auto',
    display:control.visible?'flex':'none', alignItems:'center', justifyContent:'center', borderRadius:'50%', padding:large?'6px':'3px', background:'var(--popover-surface)', opacity:'1',
    color:large && control.active?'var(--ui-accent)':'var(--foreground, var(--ui-text-secondary))', borderWidth:large?'2px':'1px', borderStyle:'solid', borderColor:large && control.active?'var(--ui-accent)':'var(--ui-stroke-secondary)',
    boxShadow:large?'0 3px 10px var(--ui-stroke-secondary)' + (control.active && state?.muted?', inset 0 0 0 2px var(--ui-accent)':'') + (glow?', '+glow:''):'none',
    cursor:control.disabled||pending?'not-allowed':'pointer', transform:hover&&!control.disabled?'scale(1.05)':'scale(1)', transition:'color 160ms, box-shadow 160ms, transform 160ms'
  })
  const labels = {bots:'Show bot pets',start:'Start Live Voice',stop:'Stop Live Voice',mute:'Mute microphone',unmute:'Unmute microphone',chat:'Open associated chat',transcript:'Open live transcript in Hermes'}
  button.dataset.petButton = ''; button.dataset.action = control.action
  button.hidden = !control.visible; button.disabled = control.disabled || pending
  button.title = labels[control.label]
  if (voice) {
    button.dataset.voiceState = live ? (state.muted ? 'muted' : 'live') : connecting ? 'connecting' : 'disconnected'
    button.title = 'Live Voice — ' + button.dataset.voiceState + (button.dataset.voiceError ? ' (' + button.dataset.voiceError + ')' : '') + (control.action === 'stop' ? ' — click to hang up' : control.disabled ? ' — select an available chat' : ' — click to talk')
  }
  if (control.action === 'chat') button.title = state?.owner ? state.owner.storedId + ' · ' + state.owner.profile + ' — ' + (state.status || 'Idle') : state?.capabilities?.includes('chat') ? 'Open selected chat' : 'No associated chat yet'
  if (button.dataset.actionError) button.title += ' — ' + button.dataset.actionError
  button.setAttribute('aria-label', button.title); button.setAttribute('aria-busy', String(pending || connecting))
  if (control.action === 'bots') button.setAttribute('aria-pressed', String(!!state?.botsEnabled))
  if (control.feedback === 'mute') button.setAttribute('aria-pressed', String(!!state?.muted))
}
const petReplyHint = 'Reply to Hermes…'
// One wording for both pets when Hermes is blocked on the user (approval / clarify / sudo).
// Short on purpose: the pop-out hides a bubble that would not fit its window.
function petAttentionLabel(kind) {
  return kind === 'clarify' ? 'Question for you' : kind === 'sudo' ? 'Needs password' : 'Needs approval'
}
// One bubble look for both pets (the in-app pet's original styling).
function petBubbleStyle(box) {
  return { maxWidth: box.width + 'px', padding: box.paddingY + 'px ' + box.paddingX + 'px', borderRadius: box.radius + 'px',
    fontSize: box.fontSize + 'px', fontWeight: '650', lineHeight: box.lineHeight + 'px', textAlign: 'center',
    background: 'color-mix(in srgb, var(--popover-surface) 94%, var(--ui-accent) 6%)', color: 'var(--foreground, var(--ui-text-secondary))',
    borderWidth: box.border + 'px', borderStyle: 'solid', borderColor: 'var(--ui-stroke-secondary)', boxShadow: 'none',
    overflowWrap: 'anywhere', whiteSpace: 'normal', boxSizing: 'border-box' }
}
// Status text never overwrites a reply the user is typing.
function petSetBubbleText(bubble, text) {
  if (bubble.dataset.editing === 'true') return
  if (bubble.textContent !== text) bubble.textContent = text
  const hint = text === petReplyHint
  bubble.dataset.hint = String(hint)
  bubble.style.opacity = hint ? '0.72' : '1'
}
// The status bubble shows status until clicked; then it is a one-line reply field.
function petQuickReply(bubble, { send, keyboard = () => {}, repaint = () => {} }) {
  let input = null
  bubble.style.pointerEvents = 'auto'; bubble.style.cursor = 'text'
  bubble.tabIndex = 0
  bubble.title = 'Click to type a quick reply'
  let idle = null
  const close = () => {
    clearTimeout(idle)
    if (!input) return
    const field = input; input = null
    delete bubble.dataset.editing
    bubble.style.width = ''
    field.remove()
    keyboard(false); repaint()
  }
  const open = () => {
    if (input) return
    input = document.createElement('input')
    input.type = 'text'; input.maxLength = 500; input.placeholder = 'Enter to send · Esc to cancel'
    input.setAttribute('aria-label', 'Quick reply to Hermes'); input.setAttribute('data-pet-reply', '')
    Object.assign(input.style, { width: '100%', boxSizing: 'border-box', border: '0', outline: 'none', margin: '0', padding: '0',
      background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left' })
    bubble.dataset.editing = 'true'
    bubble.style.opacity = '1'
    bubble.style.width = bubble.style.maxWidth
    bubble.replaceChildren(input)
    keyboard(true)
    // The pop-out holds the keyboard while open; give it back if left untouched.
    const touch = () => { clearTimeout(idle); idle = setTimeout(close, 30000) }
    touch()
    input.addEventListener('input', touch)
    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); const text = input.value.trim(); close(); if (text) send(text) }
    })
    input.addEventListener('blur', () => setTimeout(close, 0))
    input.addEventListener('pointerdown', e => e.stopPropagation())
    input.focus()
    repaint()
  }
  bubble.addEventListener('pointerdown', e => e.stopPropagation())
  bubble.addEventListener('click', e => { e.stopPropagation(); open() })
  bubble.addEventListener('keydown', e => { if (!input && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open() } })
  return { editing: () => !!input, open, close }
}
function petLayout(art, viewport, body, descriptor) {
  const { left: spriteX, top: spriteY, width: artWidth, height: artHeight } = art
  const { width: vw, height: vh } = viewport
  const { width: bw, height: bh } = body
  const primarySize=Math.max(...descriptor.controls.filter(c=>c.row===1).map(c=>c.size))
  const secondarySize=Math.max(...descriptor.controls.filter(c=>c.row===0).map(c=>c.size))
  const gap=descriptor.controlGap, pitch=primarySize+gap, railWidth=pitch+primarySize
  const railHeight=secondarySize+gap+primarySize
  // Three small slots (chat, transcript, utility) span the same width as call + mute.
  const smallPitch=(railWidth-secondarySize)/2
  const railX = spriteX + artWidth + descriptor.gap
  const railY = Math.max(8, Math.min(vh - railHeight - 8, spriteY + Math.max(0, artHeight - railHeight)))
  const fits = railX >= 8 && railX + primarySize <= vw - 8 && vh >= railHeight + 16
  const secondaryFits = fits && railX + railWidth <= vw - 8
  const left = Math.floor(Math.max(8, Math.min(vw - bw - 8, spriteX + artWidth / 2 - bw / 2)))
  // Below the pet: her seated base barely moves between animation frames, so the bubble stays still.
  const below = Math.floor(spriteY + artHeight + 8), above = Math.floor(spriteY - bh - 12)
  const top = below + bh <= vh - 8 ? below : Math.max(8, above)
  const clear = top >= spriteY + artHeight + 4 || top + bh <= spriteY - 8
  const clearRail = !fits || left + bw <= railX - 6 || left >= railX + railWidth + 6 || top + bh <= railY - 6 || top >= railY + railHeight + 6
  const place=(row,column,size)=>({left:railX+column*(row?pitch:smallPitch),top:railY+(row?secondarySize+gap:0),size,visible:row===1&&column===0?fits:secondaryFits})
  const controls=descriptor.controls.map(c=>place(c.row,c.column,c.size))
  // Close (native) / Pop-out (in-app) takes the far-right small slot, away from Call.
  const utility = place(0, 2, secondarySize)
  return { railX, railY, fits, secondaryFits, left, top, controls, utility, bubbleVisible: clear && clearRail && vw >= bw + 16 && vh >= bh + 16 }
}
// One bot pet: sprite/avatar, two-line status bubble, chat and dismiss. The same code
// draws the desktop bot windows (companion/botview.js) and the bot pets inside Hermes.
// `el(part)` finds an element (avatar, sprite, status, title, detail, time, chat, close);
// `post` receives typed messages; `drag(phase, event)` overrides window dragging.
const PET_BOT_PARTS = ['avatar','sprite','status','title','detail','time','chat','close']
function petBotCSS(scope) {
  const s = part => (scope ? scope + ' ' : '') + '[data-bot-part=' + part + ']'
  return [
    s('avatar') + ',' + s('sprite') + '{position:absolute;left:90px;top:90px;width:96px;height:104px;object-fit:contain;cursor:grab;touch-action:none;-webkit-user-drag:none;-webkit-user-select:none;user-select:none}',
    s('sprite') + '{display:none;image-rendering:pixelated}',
    s('status') + '{position:absolute;left:138px;bottom:154px;transform:translateX(-50%);box-sizing:border-box;width:max-content;max-width:248px;padding:5px 9px;border:1px solid var(--bot-border,#8a7b97);border-radius:8px;background:var(--bot-surface,#292530);color:var(--bot-ink,#f5eff9);font-size:13px;line-height:17px;text-align:center;overflow:hidden}',
    s('status') + '[data-tone=wait]{border-color:#e0b25c}',
    s('status') + '[data-tone=error]{border-color:#e06c6c}',
    s('title') + '{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    s('line') + '{display:flex;justify-content:center;gap:5px;white-space:nowrap}',
    s('detail') + '{overflow:hidden;text-overflow:ellipsis;min-width:0}',
    s('time') + '{flex:none;opacity:.75;font-variant-numeric:tabular-nums}',
    s('title') + '[hidden],' + s('time') + '[hidden]{display:none}',
    s('chat') + ',' + s('close') + '{position:absolute;top:150px;width:24px;height:24px;border:1px solid var(--bot-border,#8a7b97);border-radius:50%;background:var(--bot-surface,#292530);color:var(--bot-ink,#f5eff9);display:grid;place-items:center;padding:3px;cursor:pointer}',
    s('chat') + '{left:196px}', s('close') + '{left:226px}',
    s('chat') + ':disabled{opacity:.5}',
    s('chat') + ':focus-visible,' + s('close') + ':focus-visible{outline:2px solid var(--bot-accent,#c79cef);outline-offset:3px}'
  ].join('\n')
}
const PET_BOT_MARKUP = '<img data-bot-part="avatar" alt="Bot" draggable="false"><canvas data-bot-part="sprite" width="192" height="208" role="img" aria-label="Animated bot pet"></canvas>' +
  '<div data-bot-part="status" role="status" aria-live="polite"><div data-bot-part="title" hidden></div><div data-bot-part="line"><span data-bot-part="detail"></span><span data-bot-part="time" hidden></span></div></div>' +
  '<button type="button" data-bot-part="chat" aria-label="Open bot chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H9l-5 4V4Z"/></svg></button>' +
  '<button type="button" data-bot-part="close" aria-label="Dismiss bot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
function petBotView({ el, post, drag }) {
  const avatar = el('avatar'), status = el('status')
  // Two-line bubble: line 1 = card title (one line, ellipsis), line 2 = step + timer (timer never cut).
  const title = el('title'), detail = el('detail'), time = el('time')
  const chat = el('chat'), close = el('close')
  const sprite = el('sprite'), ctx = sprite.getContext('2d')
  let sheet = null, source = '', timer = null, row = 0, frame = 0, counts = [], loadSerial = 0
  let bot = null, generation = '', serial = 0, clock = null, shape = ''
  const pending = new Map()
  const stop = () => { if (timer !== null) clearInterval(timer); timer = null }
  const draw = () => {
    ctx.clearRect(0,0,192,208)
    ctx.drawImage(sheet,frame*192,row*208,192,208,0,0,192,208)
    sprite.dataset.row = String(row); sprite.dataset.frame = String(frame)
  }
  const animate = () => {
    stop()
    if (!sheet || !bot) return
    draw()
    timer = setInterval(() => { frame = (frame+1)%counts[row]; draw() }, 160)
  }
  // Backend progress (Kanban card + live step): {row, title, detail, since, tone}.
  const ROWS = new Set([0,3,5,6,7,8])
  const progress = () => {
    const p = bot?.progress
    const text = v => typeof v === 'string' && v.length <= 80
    return p && typeof p === 'object' && ROWS.has(p.row) && text(p.title) && text(p.detail) &&
      (p.since === null || p.since === undefined || (typeof p.since === 'number' && Number.isFinite(p.since))) ? p : null
  }
  const stopClock = () => { if (clock !== null) clearInterval(clock); clock = null }
  const show = (heading, text, timed, tone = 'info') => {
    title.textContent = heading; title.hidden = !heading
    detail.textContent = text
    time.textContent = timed; time.hidden = !timed
    status.dataset.tone = tone
  }
  // Input region follows the bubble's real size, so no dead click zone around a short label.
  const postShape = () => {
    const b = status.getBoundingClientRect?.()
    const bubble = b && b.width > 0 ? [Math.floor(b.left), Math.floor(b.top), Math.ceil(b.width) + 1, Math.ceil(b.height) + 1] : [40,30,200,50]
    const next = JSON.stringify(bubble)
    if (next !== shape) { shape = next; post({type:'shape',rectangles:[bubble,[90,90,96,104],[196,150,60,30]]}) }
  }
  const paintStatus = () => {
    if (!bot) { stopClock(); show('', 'Owner disconnected', ''); return }
    const live = progress()
    if (bot.attention) { stopClock(); show('', petAttentionLabel(bot.attention.kind), '', 'wait') }
    else if (!live) { stopClock(); show('', bot.status || bot.label, '') }
    else {
      const timed = typeof live.since === 'number'
      // An explicit idle (row 0, no text) shows the name, overriding the coarse Working guess.
      show(live.title, live.detail || (live.title ? '' : bot.label), timed ? '· ' + petElapsed(live.since) : '', live.tone || 'info')
      if (timed) { if (clock === null) clock = setInterval(paintStatus, 1000) }
      else stopClock()
    }
    postShape()
  }
  // The bubble ends 4 px above the highest visible pixel of any pose (sheet 'top', half scale).
  const anchor = () => {
    const top = bot?.pet?.top
    const head = 90 + (Number.isInteger(top) && top >= 0 && top < 208 ? top / 2 : 0)
    status.style.bottom = Math.round(240 - head + 4) + 'px'
  }
  // Any regular Petdex grid: 192x208 cells, 1-16 columns, 9-16 rows (nine state rows used).
  const SPRITE_ID = /^[0-9a-f]{64}$/, SPRITE_DATA = /^data:image\/(webp|png);base64,/
  const gridOk = (image, list) => {
    const w = image.naturalWidth, h = image.naturalHeight, columns = w / 192, rows = h / 208
    return Number.isInteger(columns) && Number.isInteger(rows) && columns >= 1 && columns <= 16 &&
      rows >= 9 && rows <= 16 && list.every(n => n <= columns)
  }
  const paintPet = () => {
    const pet = bot?.pet
    const valid = pet && pet.frameWidth === 192 && pet.frameHeight === 208 &&
      Array.isArray(pet.counts) && pet.counts.length === 9 && pet.counts.every(n=>Number.isInteger(n)&&n>0&&n<=16) &&
      typeof pet.spriteId === 'string' && SPRITE_ID.test(pet.spriteId) &&
      (source === pet.spriteId || (typeof pet.sprite === 'string' && SPRITE_DATA.test(pet.sprite)))
    const live = progress()
    const nextRow = bot?.attention ? 6 : live ? live.row : ({Working:7,Finished:3,Error:5}[bot?.status] ?? 0)
    if (row !== nextRow) { row = nextRow; frame = 0 }
    if (!valid) {
      stop(); ++loadSerial; source = ''; sheet = null
      sprite.style.display = 'none'; avatar.style.display = ''; return
    }
    counts = pet.counts
    if (source === pet.spriteId && sheet) {
      if (!gridOk(sheet, counts)) { stop(); source = ''; sheet = null; sprite.style.display = 'none'; avatar.style.display = ''; return }
      frame %= counts[row]; draw(); if (timer === null) animate(); return
    }
    if (source === pet.spriteId) return
    stop(); source = pet.spriteId; sheet = null; frame = 0
    sprite.style.display = 'none'; avatar.style.display = ''
    const ticket = ++loadSerial, image = new Image()
    image.onload = () => {
      if (ticket !== loadSerial || !bot) return
      if (!gridOk(image, counts)) { source = ''; return }
      sheet = image; avatar.style.display = 'none'; sprite.style.display = 'block'; animate()
    }
    image.onerror = () => { if(ticket === loadSerial) { source = ''; sprite.style.display='none'; avatar.style.display='' } }
    image.src = pet.sprite
  }
  const command = action => {
    if (!bot || (action === 'botChat' && !bot.chat)) return
    const id = bot.id+'-'+Date.now().toString(36)+'-'+(++serial)
    pending.set(id, action)
    setTimeout(() => pending.delete(id), 16000)
    post({type:'command',command:{id,generation,action,bot:bot.id}})
  }
  chat.onclick = () => command('botChat')
  close.onclick = () => command('botDismiss')
  const moved = drag || (phase => post({type:'drag',phase}))
  let dragging = false
  for (const target of [avatar, sprite]) {
    // Never a native drag: it offers the image to other apps, and one that stalls the
    // transfer blocks the helper's GTK thread (every pet froze). Pointer events move the pet.
    target.addEventListener('dragstart', event => event.preventDefault())
    target.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      dragging = true; target.setPointerCapture?.(event.pointerId); moved('start', event)
    })
    target.addEventListener('pointermove', event => { if (dragging) moved('move', event) })
    for (const type of ['pointerup','pointercancel','lostpointercapture']) target.addEventListener(type, event => {
      if (dragging) { dragging = false; moved('end', event) }
    })
  }
  const receive = message => {
    if (generation && generation !== message.generation) pending.clear()
    for (const [id, action] of pending) {
      const ack = message.acks?.[id]
      if (ack) { pending.delete(id); if (ack.ok && action === 'botChat') post({type:'reveal'}) }
    }
    bot = message.bot; generation = message.generation
    paintPet()
    if (!bot) { chat.disabled = true; paintStatus(); return }
    anchor()
    paintStatus()
    avatar.alt = bot.label
    if (bot.avatar) avatar.src = bot.avatar
    else avatar.removeAttribute('src')
    chat.disabled = !bot.chat
    chat.setAttribute('aria-label', 'Open ' + bot.label + ' chat')
    close.setAttribute('aria-label', 'Dismiss ' + bot.label)
  }
  const dispose = () => { stop(); stopClock(); ++loadSerial; pending.clear() }
  return { receive, dispose }
}
function petElapsed(since) {
  const s = Math.max(0, Math.floor(Date.now()/1000 - since))
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s/60) + 'm' : Math.floor(s/3600) + 'h ' + Math.floor(s%3600/60) + 'm'
}
// COMPANION_SHARED_END
function companionDescriptor(active) { return petDescriptor(active, bus.muted) }

// One short reason per start failure the plugin can tell apart; anything else stays generic.
// ctx.rest rejects with "<status>: <body>", behind Electron's IPC prefix; the Hermes engine's SDP
// offer rejects with "offer <status>: <body>".
function voiceErrorMessage(error) {
  const text = String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  if (/^MIC:/.test(text)) return "Can't open the microphone — check permission or pick another mic"
  if (/^CALL_DROPPED$/.test(text)) return 'Call dropped — check the connection and call again'
  if (/^NO_CHAT$/.test(text)) return 'Open a chat first — voice talks to a chat'
  if (/^OTHER_CHAT$/.test(text)) return "Voice is linked to another chat — press the pet's chat button to link this one"
  if (/codex was not found/i.test(text)) return 'Codex CLI not found — install it or switch the voice engine'
  if (/LIVE_QUOTA_REACHED|usage limit|insufficient_quota/i.test(text)) return 'Voice limit reached — wait for the reset or switch the voice engine'
  // Hermes Live (/hermeslive/session) answers with a code, never the vendor body.
  // Named after the Hermes field Hermes Live reads first (VOICE_TOOLS_OPENAI_KEY).
  if (/HERMES_LIVE_NO_KEY/.test(text)) return 'Hermes Live needs an OpenAI API key — add it in Hermes Settings → Keys → OpenAI API Key (for Whisper STT + TTS)'
  if (/HERMES_LIVE_KEY_REJECTED/.test(text)) return 'OpenAI rejected the API key for Hermes Live — check it in Hermes settings'
  if (/HERMES_LIVE_UNSUPPORTED/.test(text)) return 'This Hermes has no Hermes Live voice mode — update Hermes or switch the voice engine'
  if (/HERMES_LIVE_UNREACHABLE|^(?:offer )?50[34]:|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|socket hang up|Timed out connecting|Failed to fetch/i.test(text)) return "Can't reach the voice backend — check the connection"
  return 'Voice unavailable — try again'
}

// Plugin lifetime owns the single call, including while every composer is absent.
let liveController = null
function createLiveController(ctx) {
  // call: this voice call's token; inflight: the token whose start is still negotiating (null when none).
  let disposed = false, inflight = null, handle = null, call = null
  let voiceOwner = null
  const starting = () => !!call && !handle
  const notify = () => window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat'))
  const valid = owner => !!owner?.runtimeId && !!owner?.storedId && !!owner?.profile
  const foreground = owner => owner?.profile === petAtomGet(host.state.focusedSessionProfile) && (!owner?.connection || (owner.connection === petAtomGet(host.state.connectionId) && owner.profile === petAtomGet(host.state.profile)))
  const focusedTarget = () => ({ runtimeId: String(petAtomGet(host.state.focusedSessionId) || ''), storedId: String(petAtomGet(host.state.focusedStoredSessionId) || ''), profile: String(petAtomGet(host.state.focusedSessionProfile) || ''), connection: petAtomGet(host.state.focusedSessionOwner)?.connectionId || '' })
  const startTarget = () => petChat || focusedTarget()
  // Chat button retargets to the selected Hermes chat only when nothing is in flight:
  // no call, no pending start/reply, and the linked chat is not working.
  const canRetarget = () => {
    if (starting() || inflight || handle || bus.live) return false
    // Sending/Working = in flight; Finished/Error = result still on the bubble (clears after 5s).
    if (petChat && (['Sending','Working','Finished','Error'].includes(petChat.status) || (petAtomGet(host.state.busyBySession) || {})[petChat.runtimeId])) return false
    const focused = focusedTarget()
    return valid(focused) && foreground(focused)
  }
  // Stop also cancels a call that is still connecting: its token releases what it holds now.
  const stop = () => {
    const ending = call, live = handle
    call = null
    handle = null
    window.__talkLiveHandle = null
    voiceOwner = null
    // Hanging up a call that is still connecting frees Start at once; its late answer closes itself.
    if (inflight === ending) inflight = null
    ending?.close()
    live?.close()
    notify()
  }
  // A start that fails says why once: in the voice UI and as one toast.
  const report = error => {
    const message = voiceErrorMessage(error)
    bus.set({ err: message, live: false, stage: 'error', micLevel: 0, remoteLevel: 0 })
    host.notify?.({ kind: 'error', message })
  }
  const start = async () => {
    if (disposed || inflight || handle) return
    if (!petChat) associatePetChat(String(petAtomGet(host.state.focusedSessionId) || ''), '')
    if (!valid(petChat) || !foreground(petChat)) {
      // No chat to talk to, or the pet's chat is not the one in front of the user (another profile/backend).
      const error = new Error(valid(petChat) && valid(focusedTarget()) ? 'OTHER_CHAT' : 'NO_CHAT')
      report(error); throw error
    }
    const owner = { ...petChat }
    const mine = call = voiceCall(owner)
    voiceOwner = owner
    inflight = mine
    bus.set({ stage: 'connecting' })
    try {
      const engine = ctx.storage.get(KEY_ENGINE) || 'codex'
      const result = await startLive(ctx, { call: mine, profile: owner.profile === 'default' ? '' : owner.profile, engine,
        voice: effVoiceFor(engine, ctx.storage.get(KEY_VOICE) || ''), micId: ctx.storage.get(KEY_MIC) || '', outId: ctx.storage.get(KEY_OUT) || '', log: () => {} })
      if (disposed || call !== mine) { result.close(); return }
      handle = result
      window.__talkLiveHandle = result
    } catch (error) {
      if (call !== mine) return  // hung up while connecting: cancelled, not an error
      call = null
      voiceOwner = null
      report(error)
      throw error
    } finally { if (inflight === mine) inflight = null; notify() }
  }
  // Quick reply typed into the pet's bubble: an ordinary user message in its chat.
  const replyTarget = () => valid(petChat) && foreground(petChat) ? petChat : valid(startTarget()) && foreground(startTarget()) ? startTarget() : null
  const sendReply = async raw => {
    const text = typeof raw === 'string' ? raw.trim().slice(0, 500) : ''
    if (!text) throw new Error('Empty reply')
    if (!replyTarget()) throw new Error('Open a chat first')
    if (!valid(petChat) || !foreground(petChat)) associatePetChat(String(petAtomGet(host.state.focusedSessionId) || ''), '')
    const target = petChat
    if (!valid(target) || !foreground(target)) throw new Error('Open a chat first')
    target.status = 'Sending'; notify()
    try {
      await host.request('prompt.submit', { session_id: target.runtimeId, text })
    } catch (error) {
      if (petChat === target) window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat', { detail: { terminal: 'Error' } }))
      throw error
    }
    if (petChat === target && target.status === 'Sending') { target.status = 'Working'; notify() }
  }
  const action = async command => {
    if (disposed) throw new Error('Owner unavailable')
    const handlers = {
      start,
      stop,
      setMuted: () => { if (!handle || typeof command.muted !== 'boolean') throw new Error('Voice unavailable'); handle.setMuted(command.muted) },
      chat: () => {
        if (canRetarget() && focusedTarget().runtimeId !== petChat?.runtimeId) associatePetChat(focusedTarget().runtimeId, '')
        if (!valid(petChat)) throw new Error('Chat unavailable')
        const owner = { ...petChat }; return host.openSession(owner.storedId, petSessionOptions(owner))
      },
      bots: async () => { botTracker?.setEnabled(!botTracker.enabled()); await petCompanion.syncBots?.() },
      hidePet: () => petCompanion.hide?.(),
      botChat: () => botTracker?.openChat(command.bot),
      botDismiss: () => { if (!botTracker?.showing(command.bot)) throw new Error('Bot unavailable'); botTracker.dismiss(command.bot) },
      reply: () => sendReply(command.text)
    }
    if (!handlers[command.action]) throw new Error('Unknown action')
    await handlers[command.action]()
  }
  const snapshot = () => ({
    descriptor: companionDescriptor(starting() || bus.live),
    botsEnabled: !!botTracker?.enabled(),
    bots: petBotsOnDesktop() ? (botTracker?.bots() || []).map(({avatar, ...bot}) => bot) : [],
    lifecycle: starting() ? 'connecting' : bus.live ? (bus.stage === 'connected' ? 'connected' : 'connecting') : bus.stage === 'error' ? 'error' : 'idle',
    status: petChat?.status || '', muted: !!bus.muted, petSize: petSizes.pet, botSize: petSizes.bots, botReset: petBotReset,
    narration: workNarration && workNarration.until > Date.now() ? { text: workNarration.text, tone: workNarration.tone, until: workNarration.until } : null,
    // Omitted (not null) when nothing waits, so an older broker only rejects it while a wait is open.
    ...(attentionSummary(petOwnsAttention) ? { attention: attentionSummary(petOwnsAttention) } : {}),
    bands: (bus.spkBot ? bus.remBands : bus.bands).slice(0, 6),
    capabilities: [ ...(valid(startTarget()) && foreground(startTarget()) && !inflight && !handle ? ['start'] : []), ...(starting() || handle ? ['stop'] : []), ...(bus.live ? ['setMuted'] : []), ...(valid(petChat) || canRetarget() ? ['chat'] : []), 'bots', ...(replyTarget() ? ['reply'] : []) ]
  })
  const subscribers = new Set()
  let publishTimer = null
  const publish = () => { if (!bus.live && bus.stage === 'idle' && !starting()) { call = null; handle = null; voiceOwner = null; window.__talkLiveHandle = null } if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; subscribers.forEach(fn => fn()) }, 100) }
  window.addEventListener('talk-desktop:state', publish)
  window.addEventListener('talk-desktop:pet-chat', publish)
  const changedRoute = () => { if (voiceOwner && !foreground(voiceOwner)) stop(); notify() }
  const offProfile = host.state.focusedSessionProfile?.listen?.(changedRoute)
  const offConnection = host.state.connectionId?.listen?.(changedRoute)
  const offBackendProfile = host.state.profile?.listen?.(changedRoute)
  const offFocus = [host.state.focusedSessionId, host.state.focusedStoredSessionId, host.state.focusedSessionOwner].map(atom => atom?.listen?.(notify))
  const controller = { registered: false, action, snapshot, startTarget, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) }, owner: () => voiceOwner, dispose: () => {
    disposed = true; stop(); offProfile?.(); offConnection?.(); offBackendProfile?.(); subscribers.clear(); clearTimeout(publishTimer)
    offFocus.forEach(off => off?.())
    window.removeEventListener('talk-desktop:state', publish); window.removeEventListener('talk-desktop:pet-chat', publish)
  } }
  ctx.onDispose?.(controller.dispose)
  return controller
}

function installCompanionTransport(ctx, controller) {
  let disposed = false, launching = false, lease = null, route = null, timer = null, pumping = false, lastSuccess = 0, backingOff = false, petVisible = false, recovery = null, watcher = null
  const update = changes => { Object.assign(petCompanion, changes); window.dispatchEvent(new CustomEvent('talk-desktop:companion')) }
  update({ busy: false, open: false, helper: false, error: '' })
  const pending = new Map(), completed = new Map(), acknowledgements = new Map()
  const at = r => petAtomGet(host.state.connectionId) === r.connection && petProfileKey(petAtomGet(host.state.profile)) === r.profile
  const sameRoute = () => route && at(route)
  const report = error => host.notify?.({ kind: 'error', message: String(error?.message || 'Pop-out pet unavailable').slice(0, 180) })
  const rest = (path, body) => ctx.rest('/companion/' + path, { method: 'POST', body, timeoutMs: path==='launch'?20000:4000 })
  const presentation = () => {
    const state = controller.snapshot()
    const target = controller.owner() || petChat || controller.startTarget()
    const exact = target?.connection === route.connection && target?.profile === route.profile
    const theme = {}
    const css = window.getComputedStyle(document.documentElement)
    for (const [key, token] of [['surface','--popover-surface'],['ink','--foreground'],['border','--ui-stroke-secondary'],['accent','--ui-accent']]) {
      const color = css.getPropertyValue(token).trim()
      if (/^(#[a-fA-F0-9]{3,8}|rgba?\([0-9.,% ]+\))$/.test(color)) theme[key] = color
    }
    return { ...state, petVisible, bands: state.bands.map(n => Number.isFinite(n) ? Math.max(0,Math.min(1,n)) : 0), theme,
      capabilities: [...(exact ? state.capabilities : state.capabilities.filter(a => ['stop','setMuted','bots'].includes(a))), 'hidePet'],
      ...(exact ? { owner: {runtimeId:target.runtimeId,storedId:target.storedId,profile:target.profile,connection:target.connection} } : {}) }
  }
  const abandon = () => { clearTimeout(timer); timer = null; lease = null; route = null; pending.clear(); completed.clear(); acknowledgements.clear(); petVisible = false; update({ open: false, helper: false }) }
  // The route moved away (a fresh bot chat switches Hermes' profile): the old lease is out of reach and
  // expires. Remember what was open; relaunch on a new lease only when this exact route is active again.
  const cancel = () => { recovery = null; clearTimeout(watcher); watcher = null }
  const watch = () => { clearTimeout(watcher); watcher = recovery && !disposed ? setTimeout(resume, 1000) : null }
  const routeLost = () => {
    const back = route && !disposed && (petVisible || petBotsOnDesktop()) ? { ...route, lease, petVisible, bots: petBotsOnDesktop() } : null
    abandon()
    if (!back) return
    recovery = back; watch()
    host.notify?.({ kind: 'warning', message: 'Pets closed: Hermes switched to another profile. They come back when you return.', durationMs: 10000 })
  }
  const resume = async () => {
    watcher = null
    const back = recovery
    if (!back || disposed) return
    if (lease || launching || !at(back)) return watch()
    // Its own issuing route: retire the old lease (usually expired already) before a new claim.
    if (back.lease) { const old = back.lease; back.lease = null; await rest('release', old).catch(() => {}); if (recovery !== back) return }
    if (lease || launching || !at(back)) return watch()
    recovery = null
    if (back.petVisible || (back.bots && petBotsOnDesktop())) await launch(back.petVisible, true)
  }
  const pulse = async () => {
    if (disposed || !lease || pumping) return
    if (!sameRoute()) { routeLost(); return } // never send the old token to another route
    pumping = true
    const current = lease
    let succeeded = false
    try {
      const sent = [...acknowledgements.values()]
      const reply = await rest('pulse', { ...current, state: presentation(), acks: sent })
      if (disposed || lease !== current || !sameRoute()) return
      lastSuccess = Date.now()
      succeeded = true
      backingOff = false
      sent.forEach(ack => acknowledgements.delete(ack.id))
      update({ open: reply.helper === true && petVisible, helper: reply.helper === true })
      for (const command of (reply.commands || []).slice(0,32)) {
        if (command.generation !== current.generation) continue
        if (completed.has(command.id)) { acknowledgements.set(command.id, completed.get(command.id)); continue }
        if (pending.has(command.id) || pending.size >= 32) continue
        const operation = (async () => {
          let ack
          try {
            if (!sameRoute() || (!presentation().capabilities.includes(command.action) && !(['botChat','botDismiss'].includes(command.action) && botTracker?.showing(command.bot)))) throw new Error('Action unavailable')
            await controller.action(command)
            ack = { id: command.id, ok: true }
          } catch { ack = { id: command.id, ok: false, error: 'Owner action unavailable' } }
          if (lease !== current || disposed) return
          pending.delete(command.id); completed.set(command.id, ack); acknowledgements.set(command.id,ack)
          while (completed.size>256) completed.delete(completed.keys().next().value)
          // Flush completed actions promptly; keep a single serialized pulse.
          if (!pumping && !backingOff) { clearTimeout(timer); timer = setTimeout(pulse,0) }
        })()
        pending.set(command.id, operation)
      }
    } catch {
      backingOff = true
      if (Date.now()-lastSuccess > 6000) abandon()
    } finally {
      pumping = false
      if (lease && !disposed) timer = setTimeout(pulse,succeeded && acknowledgements.size ? 0 : 200)
    }
  }
  const launch = async (showPet = true, auto = false) => {
    if (disposed || launching) return
    if (!auto) cancel() // a new choice by the user replaces a pending recovery
    if (petCompanion.desktopWindows === false) {
      if (showPet) host.notify?.({ kind: 'info', message: petPopOutHint })
      return
    }
    petVisible = showPet || petVisible
    launching = true
    update({ busy: true, error: '' })
    try {
      if (lease) {
        if (!sameRoute()) throw new Error('The pop-out pet is bound to a different owner route')
        const current = lease
        await rest('pulse', { ...current, state:presentation(), acks:[] })
        if (disposed || lease !== current) return
        if (!sameRoute()) { routeLost(); return }
        if (!petVisible && !petBotsOnDesktop()) { await rest('release',current); abandon(); return }
        // Close can cancel a pending promotion while the existing bot helper stays up.
        if (showPet && !petVisible) { void pulse(); return }
        const reply = await rest('launch',current)
        if (disposed || lease !== current) return
        if (!sameRoute()) { routeLost(); return }
        if (!petVisible && !petBotsOnDesktop()) { await rest('release',current); abandon(); return }
        update({ open: reply.running === true && petVisible, helper: reply.running === true })
        void pulse()
        return
      }
      const connection = petAtomGet(host.state.connectionId)
      const profile = petProfileKey(petAtomGet(host.state.profile))
      const focused = petAtomGet(host.state.focusedSessionOwner)
      if (connection !== 'local') throw new Error('The pop-out pet requires the local backend — switch to a local chat')
      // A recovery returns to the remembered owner route itself; the focused chat may still be elsewhere.
      if (showPet && !auto && !focused?.connectionId) throw new Error('The pop-out pet cannot resolve the focused chat owner — select a known local chat')
      if (showPet && !auto && (focused.connectionId !== connection || petProfileKey(focused.profile) !== profile)) throw new Error('The focused chat owner differs from the active backend — select its local backend first')
      route = { connection, profile }
      lease = await rest('claim',route)
      if (disposed || !sameRoute()) { if (sameRoute()) await rest('release',lease); routeLost(); return }
      lastSuccess = Date.now()
      const current = lease
      await rest('pulse', { ...current, state:presentation(), acks:[] })
      if (disposed || lease !== current) return
      if (!sameRoute()) { routeLost(); return }
      if (!petVisible && !petBotsOnDesktop()) { await rest('release',current); abandon(); return }
      const reply = await rest('launch',current)
      if (disposed || lease !== current) return
      if (!sameRoute()) { routeLost(); return }
      if (!petVisible && !petBotsOnDesktop()) { await rest('release',current); abandon(); return }
      update({ open: reply.running === true && petVisible, helper: reply.running === true })
      void pulse()
    } catch (error) {
      if (lease && sameRoute()) await rest('release',lease).catch(()=>{})
      abandon(); if (!disposed) { update({ error: String(error?.message || 'Pop-out pet unavailable').slice(0,180) }); report(error) }
    } finally { launching = false; update({ busy: false }) }
  }
  const close = async () => {
    if (disposed) return
    cancel()
    petVisible = false; update({ open: false })
    // Record close intent even while claim/publication/launch is unresolved.
    if (launching) return
    if (petBotsOnDesktop() && lease) { await pulse(); return }
    launching = true; update({ busy: true, error: '' })
    const current = lease
    try { if (current && sameRoute()) await rest('release',current); abandon() }
    catch (error) { update({ error: String(error?.message || 'Could not close the pop-out pet').slice(0,180) }); report(error) }
    finally { launching = false; update({ busy: false }) }
  }
  petCompanion.hide = close
  petCompanion.syncBots = async () => {
    window.dispatchEvent(new CustomEvent('talk-desktop:bots'))
    if (petBotsOnDesktop()) { await botTracker.refresh(); await launch(false) }
    else if (!petVisible) await close()
    else await pulse()
  }
  petCompanion.toggle = () => petCompanion.open ? close() : launch()
  ctx.register({ id:'pet-pop-out', area:sdk.PALETTE_AREA || 'commandPalette', data:{ id:'talk-desktop.pet-pop-out', label:'Talk Desktop: Pop out pet', keywords:['pet','companion','voice','pop out'], run:launch } })
  ctx.register({ id:'pet-pop-in', area:sdk.PALETTE_AREA || 'commandPalette', data:{ id:'talk-desktop.pet-pop-in', label:'Talk Desktop: Close pop-out pet', run:close } })
  return () => { disposed = true; cancel(); const current=lease; if (current && sameRoute()) void rest('release',current).catch(()=>{}); abandon() }
}

// ── Pet "needs you" badge ──────────────────────────────────────────────
// The backend half (attention.py) observes Hermes' on_human_input_request /
// on_human_input_resolved hooks and pushes the open set as the plugin event
// `plugin.talk-desktop.attention`. GET /attention re-syncs after load and
// reconnects. Like the core pet's waiting pose, any open wait counts.
const ATTENTION_EVENT = 'plugin.talk-desktop.attention'
const ATTENTION_KINDS = ['approval', 'clarify', 'sudo']
let petAttention = { boot: '', seq: -1, requests: [] }
let botTracker = null
function attentionSummary(owns = () => true) {
  const requests = petAttention.requests.filter(owns)
  return requests.length ? { kind: requests[0].kind, count: Math.min(requests.length, 16) } : null
}
// The main pet shows every wait except those a visible bot pet already shows, so nothing is lost
// while bot pets are off.
const petOwnsAttention = request => !((petCompanion.helper && petBotsOnDesktop()) || petBotsInApp()) || !botTracker?.showing(request.profile)
function installAttention(ctx) {
  let disposed = false, timer = null, fetching = false, failures = 0
  const changed = () => window.dispatchEvent(new CustomEvent('talk-desktop:state'))
  const validRequest = r => !!r && typeof r.id === 'string' && ATTENTION_KINDS.includes(r.kind)
  // While something is open, re-sync now and then in case a resolve broadcast was missed.
  const schedule = () => { clearTimeout(timer); timer = petAttention.requests.length ? setTimeout(() => { void refresh() }, 30000) : null }
  const apply = data => {
    if (disposed || !data || typeof data !== 'object' || !Array.isArray(data.requests)) return
    const boot = String(data.boot || ''), seq = Number(data.seq)
    if (!Number.isFinite(seq)) return
    if (boot === petAttention.boot && seq < petAttention.seq) return // older than what we have
    const before = JSON.stringify(petAttention.requests)
    petAttention = { boot, seq, requests: data.requests.filter(validRequest).slice(0, 16).map(r => ({ id: r.id, kind: r.kind, profile: typeof r.profile === 'string' && r.profile ? r.profile.slice(0, 64) : 'default', since: Number(r.since) || 0 })).sort((a, b) => a.since - b.since) }
    if (JSON.stringify(petAttention.requests) !== before) changed()
    schedule()
  }
  const refresh = async () => {
    if (disposed || fetching || typeof ctx.rest !== 'function') return
    fetching = true
    try { apply(await ctx.rest('/attention', { timeoutMs: 5000 })); failures = 0 }
    catch {
      // A failed first load or a missed resolve would otherwise stick: retry with backoff, a few times.
      clearTimeout(timer); timer = null
      if (!disposed && (petAttention.seq < 0 || petAttention.requests.length) && failures < 6)
        timer = setTimeout(() => { void refresh() }, Math.min(30000, 5000 * 2 ** failures++))
    } finally { fetching = false }
  }
  const offs = [
    host.onEvent?.(ATTENTION_EVENT, event => apply(event?.payload)),
    host.onEvent?.('gateway.ready', () => { void refresh() })
  ]
  void refresh()
  return () => {
    disposed = true; clearTimeout(timer)
    offs.forEach(off => { try { off?.() } catch {} })
    petAttention = { boot: '', seq: -1, requests: [] }
  }
}

// ── Bot pets: one visual-only pet per bot profile ─────────────────────────
// Each bot is a Hermes profile. The roster comes from the gateway's profiles.list
// (polled only while bot pets are on); status comes from:
//   - message.start / message.complete / error events stamped with the bot's profile
//     (bot chats the app has a socket for), live;
//   - public SDK busy state for captured, connection-qualified focused owners;
//     idle clears Working but only a verified terminal event proves Finished;
//   - profiles.list worker_session.last_active inside the Bots panel's 150 s window
//     (background workers), coarse;
//   - needs-you waits tagged with the bot's profile by the talk-desktop-alerts plugin.
// Bot pets never capture audio, start voice or submit prompts.
const BOT_POLL_MS = 30000, BOT_WORK_WINDOW_S = 150, BOT_DONE_MS = 5000, BOT_MAX = 12
// Same rule as clean_label in dashboard/companion_broker.py: odd spaces become one space, other
// invisible/control characters go except the ZWJ and VS16 that join emoji; 40 code points at most.
const petBotLabel = value => [...String(value ?? '').replace(/\p{Zs}/gu, ' ').replace(/(?![\u200d\ufe0f])[\p{C}\p{Zl}\p{Zp}]/gu, '')
  .replace(/ +/g, ' ').trim()].slice(0, 40).join('').trim()
function createBotTracker(ctx, { now = () => Date.now() } = {}) {
  let enabled = false, disposed = false, timer = null, fetching = false
  let roster = [], generation = 0
  // Content-free, bounded counters for the actual SDK -> tracker boundary.
  // Reset per enable/route; never retain session IDs, text or wire payloads.
  let eventCounts = {}
  const countEvent = (phase, reason) => {
    const key = phase + ':' + reason
    eventCounts[key] = Math.min(99999, (eventCounts[key] || 0) + 1)
  }
  const turns = new Map(), dismissed = new Set(), doneTimers = new Map()
  const changed = () => window.dispatchEvent(new CustomEvent('talk-desktop:state'))
  const profileOf = event => String(event?.profile || event?.payload?.profile || '').trim() || 'default'
  const known = name => roster.some(bot => bot.name === name)
  const parse = reply => (Array.isArray(reply?.profiles) ? reply.profiles : [])
    .filter(p => p && typeof p.name === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.name) && !p.is_default && p.name !== 'default')
    .slice(0, BOT_MAX)
    .map(p => ({
      name: p.name,
      label: petBotLabel(p.display_name) || petBotLabel(p.name),
      hasAvatar: p.has_avatar === true,
      chatId: String(p.canonical_session?.resolved_id || p.canonical_session?.id || p.last_session?.id || '').slice(0, 200),
      workerAt: Number(p.worker_session?.last_active) || 0
    }))
  const refresh = async () => {
    if (disposed || fetching || host.state.connectionId?.get?.() !== 'local' || typeof host.request !== 'function') return
    fetching = true
    const revision = generation
    try {
      const next = parse(await host.request('profiles.list', {}))
      if (!disposed && revision === generation && host.state.connectionId?.get?.() === 'local') {
        const different = JSON.stringify(next) !== JSON.stringify(roster)
        roster = next
        // Starts can race discovery. Retain them only for confirmed roster members.
        for (const name of turns.keys()) if (!known(name)) {
          turns.delete(name); activeSessions.delete(name)
          clearTimeout(doneTimers.get(name)); doneTimers.delete(name)
        }
        for (const [id, association] of owners) if (association && !known(association.name)) owners.delete(id)
        reconcile()
        if (different) changed()
      }
    } catch {} finally { if (revision === generation) fetching = false }
  }
  const schedule = () => { clearTimeout(timer); timer = enabled && !disposed ? setTimeout(() => { void refresh().finally(schedule) }, BOT_POLL_MS) : null }
  const finish = (name, status) => {
    clearTimeout(doneTimers.get(name))
    turns.set(name, status)
    doneTimers.set(name, setTimeout(() => { if (turns.get(name) === status) { turns.delete(name); changed() } }, BOT_DONE_MS))
    changed()
  }
  const activeSessions = new Map(), owners = new Map()
  const startSession = (name, id) => {
    const association = owners.get(id)
    if (association?.name === name) association.closed = false
    if (!activeSessions.has(name)) activeSessions.set(name, new Set())
    activeSessions.get(name).add(id)
    clearTimeout(doneTimers.get(name)); turns.set(name, 'Working'); changed()
  }
  const clearSession = (name, id) => {
    const active = activeSessions.get(name)
    if (!active?.delete(id) || active.size) return
    activeSessions.delete(name)
    if (turns.get(name) === 'Working') { turns.delete(name); changed() }
  }
  // Only the public, connection-qualified focused owner can bind a runtime.
  // Never attribute the other entries in busyBySession to the focused profile.
  const reconcile = () => {
    if (disposed || !enabled || host.state.connectionId?.get?.() !== 'local') return
    const owner = host.state.focusedSessionOwner?.get?.()
    const id = host.state.focusedSessionId?.get?.(), stored = host.state.focusedStoredSessionId?.get?.()
    const previous = owners.get(id)
    if (previous && (!owner || owner.connectionId !== previous.connection || owner.profile !== previous.name || stored !== previous.stored)) {
      clearSession(previous.name, id)
      owners.set(id, null) // conflicting runtime is quarantined until the route resets
    }
    if (owner?.connectionId && owner.connectionId !== 'local' && id && !owners.has(id)) owners.set(id, null)
    if (owner?.connectionId === 'local' && known(owner.profile) && typeof id === 'string' && id && typeof stored === 'string' && stored && !owners.has(id)) {
      owners.set(id, { name: owner.profile, stored, connection: owner.connectionId, busy: false })
    }
    const busy = host.state.busyBySession?.get?.()
    if (!busy || typeof busy !== 'object' || Array.isArray(busy)) return
    for (const [runtime, association] of owners) {
      if (!association || !known(association.name)) continue
      const next = busy[runtime] === true
      if (next && !association.busy) startSession(association.name, runtime)
      else if (!next && association.busy) clearSession(association.name, runtime)
      association.busy = next
    }
  }
  // Derived SDK atoms can notify one at a time during a focus transaction.
  const reconcileSoon = () => {
    const revision = generation
    Promise.resolve().then(() => { if (revision === generation) reconcile() })
  }
  const resetRoute = () => {
    eventCounts = {}
    generation++; fetching = false; roster = []; turns.clear(); activeSessions.clear(); owners.clear()
    doneTimers.forEach(clearTimeout); doneTimers.clear()
    if (enabled) void refresh()
    changed()
  }
  const offConnection = host.state.connectionId?.listen?.(resetRoute)
  const offProfile = host.state.profile?.listen?.(resetRoute)
  const eventKey = (event, phase) => {
    if (disposed || !enabled || host.state.connectionId?.get?.() !== 'local') return null
    const connection = event?.connectionId || event?.connection_id
    const name = profileOf(event), id = String(event?.session_id || event?.sessionId || event?.payload?.session_id || '')
    const association = owners.get(id), focusedOwner = host.state.focusedSessionOwner?.get?.()
    const contradictsFocus = id === host.state.focusedSessionId?.get?.() &&
      (focusedOwner?.connectionId !== association?.connection || focusedOwner?.profile !== association?.name || host.state.focusedStoredSessionId?.get?.() !== association?.stored)
    const owned = association?.connection === 'local' && association.name === name && !contradictsFocus
    // A missing stamp is not local by default: require this exact captured
    // runtime/profile owner. Explicit foreign stamps always fail closed.
    if (connection !== 'local' && (connection || !owned)) { countEvent(phase, connection ? 'foreign-connection' : 'missing-connection'); return null }
    // Keep bounded, exactly stamped starts while discovery is in flight. They
    // cannot expose a pet or chat route until profiles.list confirms membership.
    const discovering = fetching && name !== 'default' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) && (turns.has(name) || turns.size < BOT_MAX)
    if (!known(name) && !discovering) { countEvent(phase, 'unknown-profile'); return null }
    if (!id) { countEvent(phase, 'missing-session'); return null }
    return { name, id }
  }
  const terminal = (event, failed = false) => {
    const key = eventKey(event, 'terminal')
    if (!key) return
    const outcome = event?.payload?.status
    if (!failed && !['complete', 'completed', 'error', 'failed', 'interrupted'].includes(outcome)) { countEvent('terminal', 'unknown-outcome'); return }
    const active = activeSessions.get(key.name), association = owners.get(key.id)
    const owned = association?.connection === 'local' && association.name === key.name && !association.closed
    if (!active?.delete(key.id) && !owned) { countEvent('terminal', 'no-observed-start'); return }
    if (owned) {
      association.closed = true
      // Consume the current busy snapshot: a queued atom notification or roster
      // reply must not resurrect this terminal. A later false -> true can start.
      association.busy = host.state.busyBySession?.get?.()?.[key.id] === true
    }
    countEvent('terminal', 'accepted')
    if (active?.size) return
    activeSessions.delete(key.name)
    if (outcome === 'interrupted') { turns.delete(key.name); changed() }
    else finish(key.name, failed || outcome === 'error' || outcome === 'failed' ? 'Error' : 'Finished')
  }
  const offs = [
    ...['busyBySession', 'focusedSessionOwner', 'focusedSessionId', 'focusedStoredSessionId'].map(key => host.state[key]?.listen?.(reconcileSoon)),
    host.onEvent?.('message.start', event => {
      const key = eventKey(event, 'start'); if (!key) return
      countEvent('start', 'accepted')
      startSession(key.name, key.id)
    }),
    host.onEvent?.('message.complete', event => terminal(event)),
    host.onEvent?.('error', event => terminal(event, true))
  ]
  const attentionFor = name => attentionSummary(request => request.profile === name)
  const statusFor = bot => {
    const turn = turns.get(bot.name)
    if (turn) return turn
    const age = now() / 1000 - bot.workerAt
    return bot.workerAt && age >= 0 && age < BOT_WORK_WINDOW_S ? 'Working' : ''
  }
  const describe = bot => ({ id: bot.name, label: bot.label, status: statusFor(bot), avatar: bot.hasAvatar, chat: !!bot.chatId, ...(attentionFor(bot.name) ? { attention: attentionFor(bot.name) } : {}) })
  const tracker = {
    enabled: () => enabled,
    setEnabled: on => {
      on = !!on
      if (on === enabled || disposed) return
      enabled = on
      eventCounts = {}
      generation++
      fetching = false
      roster = []; turns.clear(); activeSessions.clear(); owners.clear()
      doneTimers.forEach(clearTimeout); doneTimers.clear()
      // X'd pets come back when the toggle is cycled off and on.
      if (!enabled) dismissed.clear()
      if (enabled) void refresh()
      schedule(); changed()
    },
    bots: () => enabled ? roster.filter(bot => !dismissed.has(bot.name)).map(describe) : [],
    all: () => roster.map(describe),
    showing: name => enabled && known(name) && !dismissed.has(name),
    dismiss: name => { if (known(name) && !dismissed.has(name)) { dismissed.add(name); changed() } },
    openChat: async name => {
      const bot = roster.find(item => item.name === name)
      if (disposed || !enabled || dismissed.has(name) || host.state.connectionId?.get?.() !== 'local' || !bot?.chatId) throw new Error('Bot chat unavailable')
      return host.openSession(bot.chatId, { profile: bot.name, intent: 'in-place', route: { connectionId: 'local', profile: bot.name, mode: 'local' } })
    },
    refresh,
    diagnostics: () => ({ enabled, discovering: fetching, local: host.state.connectionId?.get?.() === 'local', events: { ...eventCounts } }),
    // Palette check: what each bot pet would show right now, without opening windows.
    report: async () => {
      await refresh()
      // Why each pet animates or stays static (bundled sheet, gallery sheet, or no match).
      let sprites = {}
      try { sprites = (await ctx.rest?.('/companion/sprites', { method: 'POST', body: { bots: roster.map(bot => bot.name) }, timeoutMs: 4000 }))?.bots || {} } catch {}
      const lines = roster.map(bot => { const d = describe(bot), why = typeof sprites[bot.name] === 'string' ? ', ' + sprites[bot.name].slice(0, 60) : ''; return bot.label + ': ' + (d.attention ? petAttentionLabel(d.attention.kind) : d.status || 'Idle') + why })
      const counts = Object.entries(eventCounts).map(([key, value]) => key + '=' + value).join(', ') || 'no start/terminal events observed'
      host.notify?.({ kind: 'info', message: (lines.length ? lines.join(' · ').slice(0, 600) : 'No bots found') + ' | ' + counts })
      return lines
    },
    dispose: () => {
      disposed = true; clearTimeout(timer)
      offConnection?.(); offProfile?.(); activeSessions.clear(); owners.clear()
      doneTimers.forEach(t => clearTimeout(t)); doneTimers.clear()
      offs.forEach(off => { try { off?.() } catch {} })
      roster = []; turns.clear(); dismissed.clear(); enabled = false
    }
  }
  return tracker
}

function trackPetChat(ctx) {
  let previousBusy = {}, statusTimer = null
  const paintChat = () => window.dispatchEvent(new CustomEvent('talk-desktop:pet-chat'))
  const sameChatEvent = event => {
    const id = String(event?.session_id || event?.sessionId || event?.payload?.session_id || event?.payload?.sessionId || '')
    const profile = event?.profile || event?.payload?.profile
    return !!petChat && !!id && id === petChat.runtimeId && (!profile || profile === petChat.profile)
  }
  const terminal = status => {
    if (!petChat) return
    clearTimeout(statusTimer)
    const target = petChat
    target.status = status; paintChat()
    statusTimer = setTimeout(() => { if (petChat === target && target.status === status) { target.status = ''; paintChat() } }, 5000)
  }
  const onChatChange = event => { if (event.detail?.terminal) terminal(event.detail.terminal) }
  window.addEventListener('talk-desktop:pet-chat', onChatChange)
  const eventDisposers = [
    host.onEvent?.('message.complete', event => { if (sameChatEvent(event)) terminal(event.payload?.status === 'error' ? 'Error' : 'Finished') }),
    host.onEvent?.('error', event => { if (sameChatEvent(event)) terminal('Error') })
  ]
  const observeBusy = () => {
    const busy = petAtomGet(host.state.busyBySession) || {}
    const focused = String(petAtomGet(host.state.focusedSessionId) || '')
    if (!liveController?.owner() && focused && busy[focused] && !previousBusy[focused] && (!petChat || petChat.runtimeId === focused || !busy[petChat.runtimeId])) associatePetChat(focused)
    if (petChat && busy[petChat.runtimeId] && !previousBusy[petChat.runtimeId]) petChat.status = 'Working'
    if (petChat && !busy[petChat.runtimeId] && petChat.status === 'Working') petChat.status = ''
    previousBusy = { ...busy }; paintChat()
  }
  const stopBusy = host.state.busyBySession?.listen?.(observeBusy)
  observeBusy()
  ctx.onDispose?.(() => { clearTimeout(statusTimer); eventDisposers.forEach(fn => fn?.()); stopBusy?.(); window.removeEventListener('talk-desktop:pet-chat', onChatChange); petChat = null })
}

// Resolve only after React committed the actual persistent transcript panel.
function openCompanionTranscript() {
  return new Promise((resolve, reject) => {
    let timer
    const check = () => {
      const panel = document.querySelector('[data-talk-companion-transcript]')
      if (!panel?.isConnected || window.getComputedStyle(panel).display === 'none' || window.getComputedStyle(panel).visibility === 'hidden') return
      observer.disconnect(); clearTimeout(timer); resolve()
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    timer = setTimeout(() => { observer.disconnect(); reject(new Error('Transcript panel did not mount')) }, 1500)
    window.dispatchEvent(new CustomEvent('talk-desktop:open-transcript'))
    check()
  })
}
// Status-bar Pets panel: one place for every pet setting (no buttons on the pets themselves).
function PetsPanel({ ctx }) {
  const [open, setOpen] = useState(false)
  const [sizes, setSizes] = useState(() => ({ ...petSizes }))
  const [sizeErr, setSizeErr] = useState(petSizeError)
  useEffect(() => { const h = () => { setSizes({ ...petSizes }); setSizeErr(petSizeError) }; window.addEventListener('talk-desktop:sizes', h); return () => window.removeEventListener('talk-desktop:sizes', h) }, [])
  // Opening (or returning to the owner route) re-reads Hermes' scale, so an Alt+scroll or Settings → Pet
  // change shows here. A read that a slider move overtook is dropped: the user's latest choice wins.
  const [, routeMoved] = useState(0)
  useEffect(() => { const offs = [host.state.profile, host.state.connectionId].map(atom => atom?.listen?.(() => routeMoved(n => n + 1))); return () => offs.forEach(off => off?.()) }, [])
  const ownerHere = petOwnerHere(), [mainOut, setMainOut] = useState(null)
  useEffect(() => {
    if (!open || !ownerHere) return
    let live = true
    readMainPetSize(petSizeEdits, meta => { if (!live) return false; if (typeof meta?.enabled === 'boolean') setMainOut(meta.enabled) })
    return () => { live = false }
  }, [open, ownerHere])
  // Moved here from the voice gear: same keys, same effects.
  const [botPlace, setBotPlace] = useState(() => ctx.storage.get(KEY_BOT_PLACE) || 'auto')
  const [botLines, setBotLines] = useState(() => ctx.storage.get(KEY_BOT_LINES) === '1')
  const [narrate, setNarrate] = useState(() => (ctx.storage.get(KEY_NARRATE) || '1') !== '0')
  const [, repaint] = useState(0)
  useEffect(() => { const h = () => repaint(n => n + 1); for (const t of ['talk-desktop:companion', 'talk-desktop:state']) window.addEventListener(t, h); return () => { for (const t of ['talk-desktop:companion', 'talk-desktop:state']) window.removeEventListener(t, h) } }, [])
  const noDesktopWindows = petCompanion.desktopWindows === false
  const chooseBotPlace = value => {
    if (!['auto', 'desktop', 'inapp'].includes(value)) return
    setBotPlace(value); ctx.storage.set(KEY_BOT_PLACE, value); void petCompanion.syncBots?.()
  }
  // Voice engine and voice, moved here from the voice gear: same keys, read at the next call's start.
  const [engine, setEngine] = useState(() => ctx.storage.get(KEY_ENGINE) || 'codex')
  const [voice, setVoice] = useState(() => ctx.storage.get(KEY_VOICE) || '')
  const [liveStatus, setLiveStatus] = useState(null)  // Hermes' own answer: available, reason, voice. Never a key.
  useEffect(() => {
    if (!open || engine !== 'hermes-live') return
    let live = true
    Promise.resolve(ctx.rest('/hermeslive/status', { timeoutMs: 15000 })).then(r => { if (live) setLiveStatus(r || null) })
      .catch(() => { if (live) setLiveStatus({ available: false, reason: 'Hermes did not answer' }) })
    return () => { live = false }
  }, [open, engine])
  const chooseEngine = value => { if (['codex', 'hermes', 'hermes-live'].includes(value)) { setEngine(value); ctx.storage.set(KEY_ENGINE, value) } }
  const chooseVoice = value => { setVoice(value); ctx.storage.set(KEY_VOICE, value) }
  const botsShowing = (botTracker?.bots() || []).length > 0
  const showPet = ownerHere && (mainOut !== false || !!petCompanion.open), showSizes = showPet || botsShowing
  const toggle = (label, hint, checked, onChange) => jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }, children: [
    jsx(Switch, { 'aria-label': label, checked, onCheckedChange: onChange }),
    jsxs('div', { style: { fontSize: 11.5, lineHeight: 1.3 }, children: [label, jsx('div', { style: { fontSize: 10, color: 'var(--ui-text-tertiary, #a1a1aa)' }, children: hint })] })
  ] })
  const muted = { fontSize: 10, color: 'var(--ui-text-tertiary, #a1a1aa)' }
  const slider = (which, label) => jsxs('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, marginBottom: 8 }, children: [
    jsx('span', { style: { width: 92 }, children: label }),
    jsx('input', { type: 'range', min: 50, max: 200, step: 5, value: sizes[which], 'aria-label': label + ' size', onChange: e => setPetSize(which, e.target.value), style: { flex: '1 1 auto', minWidth: 0 } }),
    jsx('span', { style: { width: 38, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, children: sizes[which] + '%' })
  ] })
  return jsx('span', { 'data-context-menu-skip': 'true', style: { display: 'inline-flex', alignItems: 'center' }, children: jsx(Popover, { open, onOpenChange: setOpen, children: [
    jsx(PopoverTrigger, { asChild: true, children: jsx('button', { type: 'button', 'data-talk-pets': '', 'data-context-menu-skip': 'true', 'aria-label': 'Pets & voice',
      title: 'Pets & voice \u2014 pet ' + sizes.pet + '%, bot pets ' + sizes.bots + '%. Sizes and settings.',
      style: { border: 'none', background: open ? 'var(--chrome-action-hover, rgba(0,0,0,0.08))' : 'transparent', color: 'var(--ui-text-tertiary, #71717a)', cursor: 'pointer', fontSize: 11, padding: '1px 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' },
      children: '\u{1F43E} Pets & voice' }) }),
    jsx(PopoverContent, { side: 'top', align: 'end', sideOffset: 8, style: { width: 290, maxHeight: 'var(--radix-popover-content-available-height)', overflowY: 'auto' }, children: jsxs('div', { style: { display: 'flex', flexDirection: 'column' }, children: [
      jsx('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--foreground, #18181b)' }, children: 'Pets & voice' }),
      showPet && slider('pet', 'Pet'), botsShowing && slider('bots', 'Bot pets (all)'),
      (!ownerHere || !showSizes) && jsx('div', { style: { ...muted, marginBottom: 6 }, children: !ownerHere ? 'Pet size applies on the ' + petOwner + ' profile.' : 'Sizes show here while a pet is out.' }),
      showSizes && jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
        jsx(Button, { variant: 'secondary', size: 'sm', onClick: () => { if (showPet) setPetSize('pet', 100); if (botsShowing) setPetSize('bots', 100) }, children: 'Reset' }),
        sizeErr ? jsx('span', { style: { ...muted, color: '#dc2626' }, children: sizeErr }) : jsx('span', { style: muted, children: 'Saved · applies live' })
      ] }),
      jsx('div', { style: { borderTop: '1px solid var(--ui-stroke-secondary, rgba(127,127,127,0.25))', margin: '10px 0 8px' } }),
      jsxs(Select, { value: noDesktopWindows && botPlace === 'desktop' ? 'inapp' : botPlace, onValueChange: chooseBotPlace, children: [
        jsx(SelectTrigger, { style: { width: '100%' }, 'aria-label': 'Where bot pets appear', children: jsx(SelectValue, {}) }),
        jsxs(SelectContent, { children: [
          jsx(SelectItem, { value: 'auto', children: 'Automatic' }),
          jsx(SelectItem, { value: 'desktop', disabled: noDesktopWindows, children: 'Desktop windows' }),
          jsx(SelectItem, { value: 'inapp', children: 'Inside Hermes' })
        ] })
      ] }),
      jsx('div', { style: { ...muted, lineHeight: 1.3, margin: '4px 0 10px' }, children: noDesktopWindows
        ? 'Desktop windows are not available on this system, so bot pets appear inside Hermes.'
        : 'Automatic uses desktop windows where this system supports them, otherwise inside Hermes.' }),
      toggle('Bot status in the pet bubble', 'Off by default. With bot pets inside Hermes, also show the latest busy bot\u2019s step in Hermes\u2019 own pet bubble. Several busy bots replace each other there.', botLines,
        v => { setBotLines(!!v); ctx.storage.set(KEY_BOT_LINES, v ? '1' : '0'); window.dispatchEvent(new CustomEvent('talk-desktop:state')) }),
      toggle('Show sub-agent progress in the pet bubble', 'On by default. Short lines while background sub-agents work, and when they finish.', narrate,
        v => { setNarrate(!!v); ctx.storage.set(KEY_NARRATE, v ? '1' : '0') }),
      jsx(Button, { variant: 'secondary', size: 'sm', disabled: !botsShowing, onClick: () => { void petCompanion.resetBots?.() }, children: 'Reset bot positions' }),
      jsx('div', { style: { borderTop: '1px solid var(--ui-stroke-secondary, rgba(127,127,127,0.25))', margin: '10px 0 8px' } }),
      jsx('div', { style: { fontSize: 11.5, fontWeight: 600, marginBottom: 6 }, children: 'Voice' }),
      jsxs(Select, { value: engine, onValueChange: chooseEngine, children: [
        jsx(SelectTrigger, { style: { width: '100%' }, 'aria-label': 'Voice engine', children: jsx(SelectValue, {}) }),
        jsxs(SelectContent, { children: [
          jsx(SelectItem, { value: 'codex', children: 'Codex Live \u2014 ChatGPT subscription' }),
          jsx(SelectItem, { value: 'hermes', children: 'OpenAI Realtime \u2014 API key or Codex sign-in' }),
          jsx(SelectItem, { value: 'hermes-live', children: 'Hermes Live \u2014 your OpenAI key (~$0.05/min)' })
        ] })
      ] }),
      jsx('div', { style: { ...muted, lineHeight: 1.3, margin: '4px 0 8px' }, children: engine === 'codex' ? 'On your Codex subscription \u2014 recommended.'
        : engine === 'hermes' ? 'The plugin\u2019s own realtime connection: your OpenAI API key if one is set, otherwise your Codex sign-in.'
        : 'Hermes\u2019 own voice mode. Needs an OpenAI API key in Hermes; OpenAI bills about $0.05 per minute.' }),
      engine === 'hermes-live' && liveStatus && !liveStatus.available && (() => {
        const reason = String(liveStatus.reason || 'Hermes cannot start it')
        // Hermes' own reason names env vars; point at the actual settings field and keep the reason as a tooltip.
        const keyMissing = /api[_ ]?key|OPENAI_API_KEY|gpt_live/i.test(reason)
        return jsx('div', { title: reason, style: { fontSize: 10.5, color: '#b45309', lineHeight: 1.3, marginBottom: 8 },
          children: keyMissing ? 'Add an OpenAI API key in Hermes Settings \u2192 Keys \u2192 OpenAI API Key (for Whisper STT + TTS)'
            : 'Not available yet: ' + reason })
      })(),
      engine === 'hermes-live'
        ? jsx('div', { style: { fontSize: 11.5, marginBottom: 8 }, children: liveStatus?.voice ? 'Voice: ' + liveStatus.voice + ' (set in Hermes settings)' : 'Voice: set in Hermes settings' })
        : jsxs(Select, { value: effVoiceFor(engine, voice), onValueChange: chooseVoice, children: [
          jsx(SelectTrigger, { style: { width: '100%' }, 'aria-label': 'Voice', children: jsx(SelectValue, {}) }),
          jsx(SelectContent, { children: (engine === 'codex' ? V3_VOICES : VOICES).map(v => jsx(SelectItem, { value: v, children: v }, v)) })
        ] }),
      jsx('div', { style: { ...muted, marginTop: 4 }, children: 'Applies to the next call.' })
    ] }) })
  ] }) })
}
function CompanionTranscript() {
  const [open, setOpen] = useState(false)
  useEffect(() => { const show = () => setOpen(true); window.addEventListener('talk-desktop:open-transcript', show); return () => window.removeEventListener('talk-desktop:open-transcript', show) }, [])
  if (!open) return null
  return jsx(Dialog, { open, onOpenChange: setOpen, children: jsxs(DialogContent, { 'data-talk-companion-transcript': '', 'aria-label': 'Live transcript', style: { width: 320, maxHeight: '70vh', overflow: 'auto' }, children: [jsx(DialogTitle, { children: 'Live transcript' }), jsx('button', { 'aria-label': 'Close transcript', onClick: () => setOpen(false), children: 'Close' }), jsx(LivePanel, {})] }) })
}

// ── The pet narrates background work (sub-agents) ──────────────────────────
// Listens to subagent.start / subagent.progress / subagent.complete gateway
// events and turns them into short pet bubbles via ctx.pet.say. One bubble
// id per sub-agent so lines replace in place instead of stacking; progress is
// throttled; finishes also fire a native notification (shown only while the
// user is away from Hermes). Toggle: storage key KEY_NARRATE ('0' = off).
const KEY_NARRATE = 'narrateWork.v1'
let workNarration = null
let narrationTimer = null
const NARRATE_PROGRESS_MS = 3 * 60 * 1000
const narrateClip = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').replace(/\*\*|__|[*`|]|(^|\s)[#>]+\s/g, '$1').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}
const narrateDuration = secs => {
  const s = Number(secs)
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}
// First meaningful sentence of a summary, minus headings/boilerplate.
const narrateGist = summary => {
  const lines = String(summary || '').split('\n').map(l => l.replace(/^[\s>*#\-–•\d.)]+/, '').trim()).filter(Boolean)
  const line = lines.find(l => l.length > 12 && !/^(summary|result|what i did|outcome)s?:?$/i.test(l)) || lines[0] || ''
  return line.split(/(?<=[.!?])\s/)[0]
}
export function createWorkNarrator(ctx, { now = () => Date.now() } = {}) {
  const pet = ctx.pet
  const agents = new Map()
  const enabled = () => (ctx.storage?.get?.(KEY_NARRATE) || '1') !== '0'
  const payloadOf = event => event?.payload || event || {}
  const idOf = p => String(p.subagent_id || p.id || p.delegation_id || p.goal || 'subagent')
  const say = (id, text, tone, ttlMs) => {
    if (!enabled()) return
    const line = narrateClip(text, 120)
    // Mirror into the pop-out pet window, which never sees pet.say:
    // the companion transport publishes `narration` in its snapshot.
    workNarration = { text: line, tone, until: now() + (ttlMs || 6000) }
    try { window.dispatchEvent(new CustomEvent('talk-desktop:state')) } catch {}
    clearTimeout(narrationTimer)
    narrationTimer = setTimeout(() => { try { window.dispatchEvent(new CustomEvent('talk-desktop:state')) } catch {} }, (ttlMs || 6000) + 50)
    if (!pet?.say) return
    try { pet.say(line, { id: `work-${id}`.slice(0, 64), tone, ttlMs }) } catch {}
  }
  const label = (p, prev) => narrateClip(p.goal || prev?.goal || p.preview || 'background task', 60)
  const onStart = event => {
    const p = payloadOf(event); const id = idOf(p)
    if (agents.has(id)) return
    const entry = { goal: label(p), startedAt: now(), lastSaid: now() }
    agents.set(id, entry)
    say(id, `On it: ${entry.goal}`, 'wait', 8000)
  }
  const onProgress = event => {
    const p = payloadOf(event); const id = idOf(p); const entry = agents.get(id)
    if (!entry || now() - entry.lastSaid < NARRATE_PROGRESS_MS) return
    entry.lastSaid = now()
    const mins = Math.round((now() - entry.startedAt) / 60000)
    const what = narrateClip(p.preview || p.tool_name || p.text || '', 50)
    say(id, `Still on ${narrateClip(entry.goal, 40)} (${mins} min)${what ? ` · ${what}` : ''}`, 'wait', 8000)
  }
  const onComplete = event => {
    const p = payloadOf(event); const id = idOf(p); const entry = agents.get(id)
    agents.delete(id)
    const goal = narrateClip(entry?.goal || label(p), 40)
    const status = String(p.status || 'completed')
    const took = narrateDuration(p.duration_seconds ?? (entry ? (now() - entry.startedAt) / 1000 : 0))
    const failed = status === 'failed' || status === 'error'
    const interrupted = status === 'interrupted'
    const gist = narrateGist(p.error || p.summary || p.preview)
    const head = failed ? `Failed: ${goal}` : interrupted ? `Stopped: ${goal}` : `Done: ${goal}`
    const text = `${head}${took ? ` (${took})` : ''}${gist ? ` — ${gist}` : ''}`
    say(id, text, failed ? 'error' : 'info', 30000)
    if (enabled() && ctx.os?.notify) {
      try { ctx.os.notify({ title: failed ? 'Sub-agent failed' : interrupted ? 'Sub-agent stopped' : 'Sub-agent finished', body: narrateClip(`${goal}${gist ? ` — ${gist}` : ''}`, 200) }) } catch {}
    }
  }
  const sub = ctx.onEvent || host.onEvent
  const disposers = [
    sub?.('subagent.start', onStart),
    sub?.('subagent.spawn_requested', onStart),
    sub?.('subagent.progress', onProgress),
    sub?.('subagent.tool', onProgress),
    sub?.('subagent.complete', onComplete)
  ]
  const dispose = () => { disposers.forEach(fn => { try { fn?.() } catch {} }); agents.clear(); clearTimeout(narrationTimer); workNarration = null; try { pet?.clear?.() } catch {} }
  return { onStart, onProgress, onComplete, dispose, agents }
}

// ── Bot pets inside the Hermes window ───────────────────────────────────
// Where the plugin's desktop windows can't run (Windows, macOS, Linux without layer-shell),
// or when chosen in settings, bot pets float inside the Hermes window instead. Same
// petBotView as the desktop windows; data from POST /companion/bots (no pop-out lease),
// images fetched once per id from /companion/image. Optionally one line per busy bot goes
// to Hermes' own pet bubble (ctx.pet.say), which Hermes mirrors into its own pop-out.
const BOT_INAPP_POLL_MS = 2000, BOT_INAPP_HIDDEN_POLL_MS = 5000
const BOT_LINE_TTL_MS = 30000, BOT_LINE_REFRESH_MS = 20000, BOT_LINE_MIN_GAP_MS = 5000, BOT_LINE_MAX = 3
const KEY_BOT_POS = 'botPositions.v1'
const BOT_IMAGE = /^data:image\/(webp|png|jpeg);base64,/
function petBotLine(bot, entry) {
  const p = entry?.progress
  if (bot.attention) return { text: petAttentionLabel(bot.attention.kind), tone: 'wait' }
  if (p && typeof p === 'object' && (p.title || p.detail)) {
    const timed = typeof p.since === 'number' && Number.isFinite(p.since) && Date.now() / 1000 - p.since >= 60
    const body = [p.title, p.detail].filter(v => typeof v === 'string' && v).join(' · ')
    return { text: body + (timed ? ' (' + petElapsed(p.since) + ')' : ''), tone: p.tone === 'error' ? 'error' : p.tone === 'wait' ? 'wait' : 'info' }
  }
  if (bot.status) return { text: bot.status, tone: bot.status === 'Error' ? 'error' : 'info' }
  return null
}
function installInAppBots(ctx) {
  let disposed = false, timer = null, fetching = false, layer = null, style = null
  const generation = 'inapp-' + Date.now().toString(36)
  let feed = {}
  const images = new Map(), loading = new Set(), views = new Map(), lines = new Map()
  const positions = (() => {
    try { const v = JSON.parse(ctx.storage?.get?.(KEY_BOT_POS) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
  })()
  const savePositions = () => { try { ctx.storage?.set?.(KEY_BOT_POS, JSON.stringify(positions)) } catch {} }
  const viewport = () => ({ width: window.innerWidth || 1280, height: window.innerHeight || 800 })
  // Keep the pet itself (box x 90..186, y 90..194) on screen; the box is 280x240 like a desktop window,
  // scaled from its top-left by the Pets panel's bot size (at least ~45 px of the pet stays visible).
  const scale = () => petSizes.bots / 100
  const place = (box, x, y) => {
    const { width, height } = viewport(), f = scale()
    box.style.left = Math.round(Math.max(-80 * f, Math.min(width - 200 * f, x))) + 'px'
    box.style.top = Math.round(Math.max(-80 * f, Math.min(height - 200 * f, y))) + 'px'
  }
  const spot = index => {
    const { width, height } = viewport(), f = scale()
    // One column down the right edge, further columns to the left once the next row would pass the
    // bottom (the desktop windows wrap the same way). `rows` counts slots that stay a pet apart.
    const top = 64, step = 170 * f, last = height - 200 * f
    let rows = 1
    while (rows < 64) {
      const next = Math.min(top + rows * step, last), prev = Math.min(top + (rows - 1) * step, last)
      if (next - prev < 104 * f + 20) break
      rows++
    }
    const column = Math.floor(index / rows)
    return [width - 10 - 280 * f - column * 220 * f, top + (index % rows) * step]
  }
  const ensureLayer = () => {
    if (!style?.isConnected) {
      style = document.createElement('style')
      style.setAttribute('data-talk-bot-style', '')
      style.textContent = petBotCSS('[data-talk-bot]') + '\n[data-talk-bot]{position:absolute;width:280px;height:240px;pointer-events:none;color:var(--bot-ink);transform-origin:0 0}' +
        '\n[data-talk-bot] [data-bot-part=avatar],[data-talk-bot] [data-bot-part=sprite],[data-talk-bot] [data-bot-part=chat],[data-talk-bot] [data-bot-part=close]{pointer-events:auto}' +
        '\n[data-talk-bot] [data-bot-part=status]{pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}'
      document.head.append(style)
    }
    if (layer?.isConnected) return layer
    layer = document.createElement('div')
    layer.setAttribute('data-talk-bot-layer', '')
    Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '40', overflow: 'hidden', font: '15px system-ui' })
    for (const [name, value] of [['--bot-surface', 'var(--popover-surface, #292530)'], ['--bot-ink', 'var(--foreground, #f5eff9)'], ['--bot-border', 'var(--ui-stroke-secondary, #8a7b97)'], ['--bot-accent', 'var(--ui-accent, #c79cef)']]) layer.style.setProperty(name, value)
    document.body.append(layer)
    return layer
  }
  const dragger = (name, box) => {
    let start = null
    return (phase, event) => {
      // Positions come from the box's own left/top (set by place), not layout measurement.
      if (phase === 'start') { start = { x: event.clientX - (parseFloat(box.style.left) || 0), y: event.clientY - (parseFloat(box.style.top) || 0) }; return }
      if (!start) return
      if (phase !== 'end') place(box, event.clientX - start.x, event.clientY - start.y)
      if (phase === 'end') { start = null; positions[name] = [parseFloat(box.style.left), parseFloat(box.style.top)]; savePositions() }
    }
  }
  const command = (name, item, message) => {
    if (message?.type !== 'command' || message.command?.bot !== name) return
    const { id, action } = message.command
    const run = action === 'botChat' ? () => botTracker?.openChat(name) : action === 'botDismiss' ? () => botTracker?.dismiss(name) : null
    if (!run || typeof id !== 'string') return
    Promise.resolve().then(run).then(() => ({ ok: true }), error => ({ ok: false, error: String(error?.message || 'Unavailable').slice(0, 120) }))
      .then(ack => { if (views.get(name) === item) { item.acks[id] = ack; render() } })
  }
  const mount = (name, index) => {
    const box = document.createElement('div')
    box.setAttribute('data-talk-bot', name)
    box.innerHTML = PET_BOT_MARKUP
    ensureLayer().append(box)
    const saved = positions[name]
    const at = Array.isArray(saved) && saved.length === 2 && saved.every(Number.isFinite) ? saved : spot(index)
    place(box, at[0], at[1])
    const item = { box, acks: {} }
    item.view = petBotView({ el: part => box.querySelector('[data-bot-part=' + part + ']'), post: message => command(name, item, message), drag: dragger(name, box) })
    views.set(name, item)
    return item
  }
  const fetchImage = id => {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id) || images.has(id) || loading.has(id) || !ctx.rest) return
    loading.add(id)
    ctx.rest('/companion/image', { method: 'POST', body: { id }, timeoutMs: 15000 })
      .then(reply => {
        if (disposed || typeof reply?.data !== 'string' || !BOT_IMAGE.test(reply.data)) return
        images.set(id, reply.data)
        while (images.size > 24) images.delete(images.keys().next().value)
        render()
      }).catch(() => {}).finally(() => loading.delete(id))
  }
  const sayLines = shown => {
    const on = ctx.storage?.get?.(KEY_BOT_LINES) === '1' && typeof ctx.pet?.say === 'function'
    const now = Date.now(), keep = new Set()
    const busy = on ? shown.map(bot => [bot, petBotLine(bot, feed[bot.id])]).filter(([, line]) => line)
      .sort((a, b) => (b[1].tone === 'wait') - (a[1].tone === 'wait')).slice(0, BOT_LINE_MAX) : []
    for (const [bot, line] of busy) {
      keep.add(bot.id)
      const text = narrateClip(bot.label + ': ' + line.text, 120), last = lines.get(bot.id)
      if (last && last.text === text && last.tone === line.tone && now - last.at < BOT_LINE_REFRESH_MS) continue
      if (last && now - last.at < BOT_LINE_MIN_GAP_MS) continue
      try { ctx.pet.say(text, { id: ('bot-' + bot.id).slice(0, 64), tone: line.tone, ttlMs: BOT_LINE_TTL_MS }); lines.set(bot.id, { text, tone: line.tone, at: now }) } catch {}
    }
    for (const name of [...lines.keys()]) if (!keep.has(name)) { lines.delete(name); try { ctx.pet?.clear?.(('bot-' + name).slice(0, 64)) } catch {} }
  }
  const render = () => {
    if (disposed) return
    const shown = petBotsInApp() ? (botTracker?.bots() || []) : []
    const wanted = new Set(shown.map(bot => bot.id))
    for (const [name, item] of views) if (!wanted.has(name)) { item.view.dispose(); item.box.remove(); views.delete(name) }
    if (!shown.length && layer) { layer.remove(); layer = null }
    shown.forEach((bot, index) => {
      const item = views.get(bot.id) || mount(bot.id, index)
      const zoom = 'scale(' + scale() + ')'
      if (item.box.style.transform !== zoom) { item.box.style.transform = zoom; place(item.box, parseFloat(item.box.style.left) || 0, parseFloat(item.box.style.top) || 0) }
      const entry = feed[bot.id] || {}
      const sheet = entry.pet?.spriteId ? images.get(entry.pet.spriteId) : null
      const acks = item.acks; item.acks = {}
      item.view.receive({ generation, acks, bot: { ...bot, avatar: (entry.avatarId && images.get(entry.avatarId)) || null,
        ...(sheet ? { pet: { ...entry.pet, sprite: sheet } } : {}), ...(entry.progress ? { progress: entry.progress } : {}) } })
    })
    sayLines(shown)
    if (shown.some(bot => !feed[bot.id]) && Date.now() - lastPoll > 1000) void poll()
  }
  let lastPoll = 0
  const poll = async () => {
    const names = petBotsInApp() ? (botTracker?.bots() || []).map(bot => bot.id) : []
    if (disposed || fetching || !ctx.rest) return
    if (!names.length) { feed = {}; render(); return }
    fetching = true; lastPoll = Date.now()
    try {
      const reply = await ctx.rest('/companion/bots', { method: 'POST', body: { bots: names }, timeoutMs: 6000 })
      const bots = reply?.bots
      feed = bots && typeof bots === 'object' && !Array.isArray(bots) ? bots : {}
      for (const entry of Object.values(feed)) { fetchImage(entry?.avatarId); fetchImage(entry?.pet?.spriteId) }
    } catch {} finally { fetching = false }
    render()
  }
  const schedule = () => {
    clearTimeout(timer)
    // Polls only while bot pets are shown inside Hermes; toggling or a placement change restarts it.
    timer = disposed || !petBotsInApp() ? null : setTimeout(() => { void poll().finally(schedule) }, document.hidden ? BOT_INAPP_HIDDEN_POLL_MS : BOT_INAPP_POLL_MS)
  }
  const onBots = () => { void poll().finally(schedule) }
  petCompanion.resetBots = async () => {
    for (const name of Object.keys(positions)) delete positions[name]
    savePositions()
    ;[...views.values()].forEach((item, index) => place(item.box, ...spot(index)))
    if (petBotsOnDesktop() && petCompanion.helper) { petBotReset++; await petCompanion.syncBots?.() }
  }
  const onResize = () => { for (const item of views.values()) place(item.box, parseFloat(item.box.style.left) || 0, parseFloat(item.box.style.top) || 0) }
  window.addEventListener('talk-desktop:state', render)
  window.addEventListener('talk-desktop:bots', onBots)
  window.addEventListener('resize', onResize)
  // Whether this backend can open the plugin's own desktop windows (Linux layer-shell only).
  Promise.resolve(ctx.rest?.('/companion/capabilities', { method: 'POST', body: {}, timeoutMs: 6000 })).then(reply => {
    if (disposed || typeof reply?.desktopWindows !== 'boolean') return
    petCompanion.desktopWindows = reply.desktopWindows
    petCompanion.desktopReason = String(reply.reason || '').slice(0, 160)
    window.dispatchEvent(new CustomEvent('talk-desktop:companion'))
    window.dispatchEvent(new CustomEvent('talk-desktop:bots'))
  }).catch(() => {})
  schedule()
  return () => {
    disposed = true; clearTimeout(timer)
    window.removeEventListener('talk-desktop:state', render)
    window.removeEventListener('talk-desktop:bots', onBots)
    window.removeEventListener('resize', onResize)
    for (const item of views.values()) item.view.dispose()
    views.clear(); layer?.remove(); style?.remove(); layer = null
    for (const name of lines.keys()) { try { ctx.pet?.clear?.(('bot-' + name).slice(0, 64)) } catch {} }
    lines.clear()
  }
}

// ── Contribution registration ────────────────────────────────────────────

export default {
  id: 'talk-desktop',
  name: 'Desktop-pet-talk',
  register(ctx) {
    petStorage = ctx.storage
    petOwner = petProfileKey(petAtomGet(host.state.profile)); petOwnerConn = String(petAtomGet(host.state.connectionId) || '')
    petSizes.pet = petSizeClamp(ctx.storage?.get?.(KEY_PET_SIZE) ?? 100); petSizes.bots = petSizeClamp(ctx.storage?.get?.(KEY_BOT_SIZE) ?? 100)
    petSizeConfirmed = petSizes.pet
    readMainPetSize()  // the pop-out is sized before the panel is ever opened
    liveController = createLiveController(ctx)
    trackPetChat(ctx)
    ctx.onDispose?.(installAttention(ctx))
    botTracker = createBotTracker(ctx)
    ctx.onDispose?.(() => { botTracker?.dispose(); botTracker = null })
    ctx.register({ id: 'pet-bot-status', area: sdk.PALETTE_AREA || 'commandPalette', data: { id: 'talk-desktop.bot-status', label: 'Talk Desktop: Show bot pet status', keywords: ['pet', 'bot', 'pets', 'status'], run: () => botTracker?.report() } })
    const stopTransport = installCompanionTransport(ctx, liveController)
    ctx.onDispose?.(stopTransport)
    const narrator = createWorkNarrator(ctx)
    ctx.onDispose?.(narrator.dispose)
    ctx.onDispose?.(installInAppBots(ctx))
    ctx.register({ id: 'pet-live-badge', area: 'statusBar.right', render: () => jsx(PetLiveBadge, {}) })
    ctx.register({ id: 'companion-transcript', area: 'statusBar.right', render: () => jsx(CompanionTranscript, {}) })
    ctx.register({ id: 'pets-panel', area: 'statusBar.right', render: () => jsx(PetsPanel, { ctx }) })
    ctx.register({
      id: 'composer-live',
      area: 'composer.leading',
      render: () => jsx(ComposerLiveButton, { ctx })
    })
  }
}
