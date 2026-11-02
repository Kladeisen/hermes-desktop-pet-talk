// Voice start/stop lifecycle against the REAL startLive, createLiveController and delegation queue.
// Only the browser/network boundaries are mocked (getUserMedia, RTCPeerConnection, AudioContext,
// ctx.rest, timers). No microphone, audio device, provider, credentials or network.
// Run with: node --test tools/voice-lifecycle-test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const IDLE = { tracks: 0, peers: 0, audio: 0, listeners: 0, intervals: 0, frames: 0 }

// engine 'hermes' takes the API path: /session mints a key, then the SDP offer is POSTed with fetch.
// sdpReply is that fetch's response ({ status, body }); there is still no network.
// engine 'hermes-live' (Hermes' own GPT-Live) POSTs the offer to the plugin's /hermeslive/session.
// ice 'slow': gathering is still running after setLocalDescription; the test finishes it.
// queued: one deferred per session request, in order (a call and its redial each wait on their own).
function setup({ fail = '', gum = null, session = null, queued = null, ctxEvents = false, gumError = null, restError = null, engine = '', sdpReply = null, store = {}, ice = 'complete' } = {}) {
  let now = 1_000_000, serial = 0
  const sessionQueue = queued ? [...queued] : []
  const timers = new Map(), frames = new Map(), events = new Map(), contextEvents = new Map()
  const listen = (map, type, fn) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); return () => map.get(type).delete(fn) }
  const tracks = [], peers = [], contexts = [], restCalls = [], submits = [], gumCalls = [], notices = [], rpcs = []
  const atom = value => { const fns = new Set(); return { get: () => value, set: next => { value = next; for (const fn of [...fns]) fn(next) }, listen: fn => { fns.add(fn); return () => fns.delete(fn) } } }
  const state = { focusedSessionId: atom('chat-A'), focusedStoredSessionId: atom('stored-A'), focusedSessionProfile: atom('default'),
    focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' }), connectionId: atom('local'), profile: atom('default'), busyBySession: atom({}) }
  const host = { state, notify: notice => notices.push(notice), openSession: async () => {},
    onEvent: (type, fn) => listen(events, type, fn),
    request: async (method, params) => { submits.push(params.session_id + ': ' + params.text); rpcs.push({ method, ...params }) } }
  const stream = () => { const track = { kind: 'audio', enabled: true, readyState: 'live', stop() { this.readyState = 'ended' } }; tracks.push(track); return { getTracks: () => [track] } }
  const node = () => ({ gain: { value: 1 }, connect: target => target })
  class AudioContext {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; contexts.push(this) }
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
    createAnalyser() { return { ...node(), fftSize: 256, frequencyBinCount: 128, getByteFrequencyData: b => b.fill(0), getByteTimeDomainData: b => b.fill(128) } }
    createGain() { return node() }
    createMediaStreamSource() { return node() }
  }
  class RTCPeerConnection {
    constructor() { this.closed = false; this.connectionState = 'new'; this.senders = []; peers.push(this) }
    addTrack(track) { this.senders.push({ track }) }
    getSenders() { return this.senders }
    createDataChannel() {
      const dc = this.dc = { readyState: 'connecting', sent: [], late: [], send(raw) { const m = JSON.parse(raw); if (dc.readyState !== 'open') { dc.late.push(m); throw Error('closed channel') } dc.sent.push(m) } }
      return dc
    }
    async createOffer() { if (fail === 'offer') throw Error('offer failed'); return { type: 'offer', sdp: 'offer-sdp' } }
    async setLocalDescription(desc) { if (fail === 'local') throw Error('local description failed'); this.localDescription = desc; this.iceGatheringState = ice === 'slow' ? 'gathering' : 'complete' }
    async setRemoteDescription() { if (fail === 'remote') throw Error('remote description failed'); this.dc.readyState = 'open'; this.connectionState = 'connected' }
    getStats() { return Promise.resolve(new Map()) }
    close() { this.closed = true; this.connectionState = 'closed'; if (this.dc) this.dc.readyState = 'closed' }
  }
  const ctx = {
    storage: { get: key => key in store ? store[key] : (key === 'engine.v1' && engine) || undefined, set: () => {} }, onDispose: () => {},
    // The SDK's plugin-scoped tap: removed on plugin unload/reload, unlike a bare host.onEvent.
    ...(ctxEvents ? { onEvent: (type, fn) => listen(contextEvents, type, fn) } : {}),
    rest: async (path, options = {}) => {
      restCalls.push({ path, body: options.body })
      if (path === '/codexlive/session') {
        if (fail === 'rest') throw Error('session request failed')
        if (restError) throw restError
        if (sessionQueue.length) return sessionQueue.shift().promise
        if (session) return session.promise
        return fail === 'answer' ? { threadId: 'thread-no-answer' } : { answer: 'answer-sdp', threadId: 'thread-' + peers.length, handoff: 'client' }
      }
      if (path === '/hermeslive/session') {
        if (fail === 'rest') throw Error('session request failed')
        if (restError) throw restError
        if (sessionQueue.length) return sessionQueue.shift().promise
        if (session) return session.promise
        return fail === 'answer' ? { sessionId: 'live-no-answer' } : { answer: 'answer-sdp', sessionId: 'live-' + peers.length, botName: 'Hermes' }
      }
      if (path === '/session') return { clientSecret: 'fixture-only', model: 'fixture-model', offerUrl: 'https://fixture.invalid/realtime' }
      if (path === '/codexlive/stop' || path === '/voice/usage/report') return {}
      throw Error('unexpected REST ' + path)
    }
  }
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  class DetailEvent extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail } }
  const schedule = (fn, delay = 0, interval = false) => { timers.set(++serial, { fn, at: now + delay, delay, interval }); return serial }
  const sandbox = vm.createContext({
    window: new EventTarget(), CustomEvent: DetailEvent, console, ctx, Date: ClockDate, performance: { now: () => now },
    sdk: { host }, jsx: () => null, jsxs: () => null, useState: () => [], useEffect: () => {}, useRef: () => ({}),
    navigator: { mediaDevices: { enumerateDevices: async () => [], getUserMedia: async options => { gumCalls.push(options); if (gumError) throw gumError; return gum ? gum.promise : stream() } } },
    AudioContext, RTCPeerConnection, Audio: class { constructor() { throw Error('no playback in tests') } }, fetch: async () => { if (!sdpReply) throw Error('no network in tests'); return { ok: sdpReply.status < 300, status: sdpReply.status, text: async () => sdpReply.body } },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial }, cancelAnimationFrame: id => frames.delete(id),
  })
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'globalThis.plugin = {').replace(/^export (?=(?:async )?function |const |let |class )/gm, ''), sandbox)
  const run = code => vm.runInContext(code, sandbox)
  run('liveController = createLiveController(ctx); trackPetChat(ctx)')
  const advance = async ms => {
    const end = now + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      const [id, timer] = next; now = timer.at
      if (timer.interval) timer.at += timer.delay; else timers.delete(id)
      timer.fn(); await flush()
    }
    now = end; await flush()
  }
  const open = () => ({
    tracks: tracks.filter(t => t.readyState === 'live').length, peers: peers.filter(p => !p.closed).length,
    audio: contexts.filter(c => c.state !== 'closed').length,
    listeners: ['status.update', 'subagent.complete'].reduce((n, type) => n + (events.get(type)?.size || 0) + (contextEvents.get(type)?.size || 0), 0),
    intervals: [...timers.values()].filter(t => t.interval).length, frames: frames.size,
  })
  const emit = (type, payload) => { for (const fn of [...(events.get(type) || []), ...(contextEvents.get(type) || [])]) fn(payload) }
  const counts = map => Object.fromEntries([...map].map(([type, fns]) => [type, fns.size]).filter(([, size]) => size))
  // Hermes Live's delegation carries no text (vendor contract): the words arrive as input transcript first.
  const deliver = (dc, id, text) => engine === 'hermes-live'
    ? [{ type: 'session.input_transcript.delta', delta: text }, { type: 'session.delegation.created', delegation: { id, type: 'delegation', target: 'client' } }].forEach(m => dc.onmessage({ data: JSON.stringify(m) }))
    : dc.onmessage({ data: JSON.stringify({ type: 'delegation.created', item: { id, content: [{ text }] } }) })
  const focus = (runtime, stored) => { state.focusedSessionId.set(runtime); state.focusedStoredSessionId.set(stored) }
  const sessions = () => restCalls.filter(r => r.path === '/codexlive/session').length
  const stops = () => restCalls.filter(r => r.path === '/codexlive/stop').map(r => r.body.threadId)
  return { run, controller: run('liveController'), state, open, advance, emit, deliver, focus, sessions, stops, submits, rpcs, restCalls, peers, tracks, gumCalls, stream, notices,
    hostListeners: () => counts(events), pluginListeners: () => counts(contextEvents) }
}

test('control: a normal Start then Stop releases mic, peer, audio graph, announcers and timers', async () => {
  const h = setup()
  await h.controller.action({ action: 'start' })
  assert.equal(h.open().tracks, 1); assert.equal(h.open().peers, 1)
  assert.equal(h.run('bus.live'), true)
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
  assert.equal(h.run('bus.live'), false); assert.equal(h.run('bus.stage'), 'idle')
  assert.deepEqual(h.stops(), ['thread-1'])
})

for (const step of ['offer', 'local', 'rest', 'answer', 'remote']) {
  test(`a start that fails at "${step}" releases everything it acquired, without needing Stop`, async () => {
    const h = setup({ fail: step })
    await assert.rejects(h.controller.action({ action: 'start' }))
    assert.deepEqual(h.open(), IDLE)
    assert.equal(h.run('bus.live'), false); assert.equal(h.run('bus.stage'), 'error')
    assert.ok(h.controller.snapshot().capabilities.includes('start'), 'the user can retry')
    if (step === 'answer') assert.deepEqual(h.stops(), ['thread-no-answer'])
    if (step === 'remote') assert.deepEqual(h.stops(), ['thread-1'], 'a provider session that was created is stopped')
    await assert.rejects(h.controller.action({ action: 'start' }))
    assert.equal(h.gumCalls.length, 2)
    assert.deepEqual(h.open(), IDLE, 'retries do not pile up tracks, peers, listeners or intervals')
  })
}

// Bug 8: a failed start says why. Failures arrive as the browser and the Hermes desktop transport
// deliver them: getUserMedia DOMException names, and ctx.rest rejections whose message is
// "<status>: <body>", wrapped by Electron IPC. The backend strings are read from plugin_api.py.
const backend = fs.readFileSync(new URL('../dashboard/plugin_api.py', import.meta.url), 'utf8')
const raised = re => { const m = backend.match(re); assert.ok(m, 'backend message not found: ' + re); return m[1] }
const viaIpc = text => Error(`Error invoking remote method 'hermes:api': Error: ${text}`)
const MIC = "Can't open the microphone — check permission or pick another mic"
const CODEX = 'Codex CLI not found — install it or switch the voice engine'
const QUOTA = 'Voice limit reached — wait for the reset or switch the voice engine'
const NETWORK = "Can't reach the voice backend — check the connection"
const GENERIC = 'Voice unavailable — try again'
const failures = [
  ['microphone permission denied', { gumError: { name: 'NotAllowedError' } }, MIC],
  ['no microphone device', { gumError: { name: 'NotFoundError' } }, MIC],
  ['Codex CLI not found', { restError: () => viaIpc('502: ' + JSON.stringify({ detail: raised(/RuntimeError\("(codex was not found[^"]*)"\)/) })) }, CODEX],
  ['quota reached (backend code)', { restError: () => viaIpc('502: ' + JSON.stringify({ detail: raised(/"(LIVE_QUOTA_REACHED:[^"]*)"/) })) }, QUOTA],
  ['usage limit reported by Codex live', { restError: () => viaIpc('502: {"detail":"codex live: You\'ve hit your usage limit. Try again later."}') }, QUOTA],
  ['backend refused the connection', { restError: () => viaIpc('connect ECONNREFUSED 127.0.0.1:9119') }, NETWORK],
  ['backend timed out', { restError: () => viaIpc('Timed out connecting to Hermes backend after 120000ms') }, NETWORK],
  ['backend gateway unavailable', { restError: () => viaIpc('503: Service Unavailable') }, NETWORK],
  ['control: an unclassified backend failure', { restError: () => viaIpc('502: {"detail":"codex live: no answer SDP"}') }, GENERIC],
  ['control: a local negotiation failure', { fail: 'offer' }, GENERIC],
  // The Hermes engine's SDP offer goes straight to the provider; failures read "offer <status>: <body>".
  ['Hermes engine: provider unavailable (503)', { engine: 'hermes', sdpReply: { status: 503, body: 'Service Unavailable' } }, NETWORK],
  ['Hermes engine: provider gateway timeout (504)', { engine: 'hermes', sdpReply: { status: 504, body: 'Gateway Timeout' } }, NETWORK],
  ['Hermes engine: quota exhausted (insufficient_quota)', { engine: 'hermes', sdpReply: { status: 429, body: JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }) } }, QUOTA],
  ['control: Hermes engine, an unclassified offer rejection', { engine: 'hermes', sdpReply: { status: 400, body: 'Bad SDP' } }, GENERIC],
  // Hermes Live: /hermeslive/session answers with a code (never the vendor body); the desktop words it.
  ['Hermes Live: no OpenAI API key', { engine: 'hermes-live', restError: () => viaIpc('503: ' + JSON.stringify({ detail: raised(/"(HERMES_LIVE_NO_KEY:[^"]*)"/) })) }, 'Hermes Live needs an OpenAI API key — add it in Hermes Settings → Keys → OpenAI API Key (for Whisper STT + TTS)'],
  ['Hermes Live: OpenAI rejected the key', { engine: 'hermes-live', restError: () => viaIpc('502: ' + JSON.stringify({ detail: raised(/"(HERMES_LIVE_KEY_REJECTED:[^"]*)"/) })) }, 'OpenAI rejected the API key for Hermes Live — check it in Hermes settings'],
  ['Hermes Live: this Hermes has no GPT-Live', { engine: 'hermes-live', restError: () => viaIpc('503: ' + JSON.stringify({ detail: raised(/"(HERMES_LIVE_UNSUPPORTED:[^"]*)"/) })) }, 'This Hermes has no Hermes Live voice mode — update Hermes or switch the voice engine'],
  ['Hermes Live: OpenAI quota', { engine: 'hermes-live', restError: () => viaIpc('502: ' + JSON.stringify({ detail: raised(/"(LIVE_QUOTA_REACHED:[^"]*Hermes Live[^"]*)"/) })) }, QUOTA],
  ['Hermes Live: OpenAI unreachable from Hermes', { engine: 'hermes-live', restError: () => viaIpc('502: ' + JSON.stringify({ detail: raised(/"(HERMES_LIVE_UNREACHABLE:[^"]*)"/) })) }, NETWORK],
  ['control: Hermes Live, an unclassified failure', { engine: 'hermes-live', restError: () => viaIpc('502: {"detail":"Hermes Live session failed (500)"}') }, GENERIC],
]
for (const [name, mock, message] of failures) {
  test(`a failed start explains itself: ${name}`, async () => {
    const h = setup({ ...mock, restError: mock.restError?.() || null })
    await assert.rejects(h.controller.action({ action: 'start' }))
    assert.equal(h.run('bus.err'), message)
    assert.equal(h.controller.snapshot().lifecycle, 'error')
    assert.deepEqual(h.notices.map(n => [n.kind, n.message]), [['error', message]], 'the reason is shown once')
    assert.deepEqual(h.open(), IDLE)
  })
}

test('Stop before mic permission resolves never keeps the mic or requests a session', async () => {
  const gum = deferred(), h = setup({ gum })
  const pending = h.controller.action({ action: 'start' })
  await flush()
  assert.ok(h.controller.snapshot().capabilities.includes('stop'), 'Stop is offered while connecting')
  await h.controller.action({ action: 'stop' })
  assert.equal(h.controller.snapshot().lifecycle, 'idle')
  gum.resolve(h.stream())
  await pending
  assert.deepEqual(h.open(), IDLE)
  assert.equal(h.sessions(), 0)
  assert.equal(h.run('bus.stage'), 'idle'); assert.equal(h.run('bus.err'), '')
})

test('Stop during negotiation releases at once, returns the UI to idle and stops the late session', async () => {
  const session = deferred(), h = setup({ session })
  const pending = h.controller.action({ action: 'start' })
  await flush()
  assert.equal(h.sessions(), 1)
  assert.ok(h.controller.snapshot().capabilities.includes('stop'), 'Stop is offered while connecting')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
  assert.equal(h.run('bus.live'), false); assert.equal(h.run('bus.stage'), 'idle')
  assert.equal(h.controller.snapshot().lifecycle, 'idle'); assert.equal(h.controller.owner(), null)
  session.resolve({ answer: 'answer-sdp', threadId: 'late-thread' })
  await pending
  assert.deepEqual(h.stops(), ['late-thread'])
  assert.deepEqual(h.open(), IDLE)
  assert.equal(h.run('bus.stage'), 'idle'); assert.equal(h.run('bus.err'), '')
  await h.controller.action({ action: 'start' })
  assert.equal(h.open().tracks, 1, 'a fresh start works afterwards')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

// A1 runs in chat A, A2 waits behind it; the user hangs up and starts a call in chat B before A1's result lands.
async function replaceCallWhileWorkIsPending(h, beforeHangUp = () => {}) {
  await h.controller.action({ action: 'start' })
  const oldDc = h.peers[0].dc
  h.deliver(oldDc, 'item-A1', 'Inspect the first document'); await flush()
  h.state.busyBySession.set({ 'chat-A': true })
  h.deliver(oldDc, 'item-A2', 'Apply the pending correction'); await flush()
  beforeHangUp(oldDc); await flush()
  await h.controller.action({ action: 'stop' })
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'FIRST_DOCUMENT_RESULT' })
  h.state.busyBySession.set({})
  h.focus('chat-B', 'stored-B')
  h.state.busyBySession.set({ 'chat-B': true })
  await h.controller.action({ action: 'start' })
  assert.equal(h.controller.owner().runtimeId, 'chat-B')
  const newDc = h.peers[1].dc
  await h.advance(300)
  h.emit('message.complete', { session_id: 'chat-B', profile: 'default', connectionId: 'local', text: 'B_RESULT' })
  await h.advance(300)
  return { oldDc, newDc }
}

test('work queued in a hung-up call is dropped: it never runs in the next call and nothing is read back', async () => {
  const h = setup()
  const { oldDc, newDc } = await replaceCallWhileWorkIsPending(h)
  assert.deepEqual(h.submits, ['chat-A: [voice] Inspect the first document'], 'A2 must not be retargeted to chat B')
  assert.deepEqual(oldDc.late.filter(m => m.type === 'delegation.context.append').map(m => m.delegation_item_id), [], 'no read-back on the dead call')
  assert.deepEqual(newDc.sent.filter(m => m.type === 'delegation.context.append'), [], 'no read-back into the new call')
  assert.ok(!h.run('transcript').some(x => String(x.text).includes('FIRST_DOCUMENT_RESULT')), "A's result stays out of B's transcript")
  assert.equal(h.run('_delegBusy'), false)
  await h.controller.action({ action: 'stop' })
})

test('a voice tool result that settles after hang-up is not sent or shown in the next call', async () => {
  const h = setup()
  const { oldDc, newDc } = await replaceCallWhileWorkIsPending(h, dc => dc.onmessage({ data: JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'tool-A', name: 'send_to_chat', arguments: JSON.stringify({ request: 'Check the build' }) }) }))
  assert.deepEqual(oldDc.late.filter(m => m.item?.type === 'function_call_output'), [])
  assert.deepEqual(newDc.sent.filter(m => m.item?.type === 'function_call_output'), [])
  await h.controller.action({ action: 'stop' })
})

// Background events as Hermes delivers them: the gateway's session_id (the runtime chat that owns the
// work) plus the profile and connectionId the desktop stamps on each event from the socket it arrived on.
const subagentDone = (session_id, profile, connectionId, id, summary) =>
  ({ type: 'subagent.complete', session_id, profile, connectionId, payload: { subagent_id: id, status: 'completed', goal: 'goal ' + id, summary } })
const spoken = dc => dc.sent.filter(m => m.type === 'session.context.append').map(m => m.content[0].text)
const shown = h => h.run('transcript').map(x => x.text)

test("sub-agent results are spoken only when they come from the call's own chat, profile and connection", async () => {
  const h = setup()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.emit('subagent.complete', subagentDone('chat-A', 'default', 'local', 'own', 'OWN_RESULT'))
  h.emit('subagent.complete', subagentDone('chat-B', 'default', 'local', 'other-chat', 'FOREIGN_CHAT_RESULT'))
  h.emit('subagent.complete', subagentDone('chat-A', 'coder', 'local', 'other-profile', 'FOREIGN_PROFILE_RESULT'))
  h.emit('subagent.complete', subagentDone('chat-A', 'default', 'ssh-box', 'other-connection', 'FOREIGN_CONNECTION_RESULT'))
  const said = spoken(dc)
  assert.equal(said.length, 1, 'only the own result reaches the call')
  assert.match(said[0], /OWN_RESULT/)
  assert.ok(!shown(h).some(t => /goal other-/.test(t)), 'foreign results are not shown in the call transcript either')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

test('a sub-agent result without full ownership (chat, profile and connection) is not spoken', async () => {
  for (const ownerConnection of ['local', '']) {
    const h = setup()
    // '' = Hermes could not resolve the focused chat's connection; the call still starts.
    h.state.focusedSessionOwner.set(ownerConnection ? { connectionId: ownerConnection, profile: 'default' } : null)
    await h.controller.action({ action: 'start' })
    const dc = h.peers[0].dc
    const unowned = [
      { ...subagentDone('chat-A', 'default', 'local', 'no-session', 'NO_SESSION'), session_id: undefined },
      { ...subagentDone('chat-A', 'default', 'local', 'no-profile', 'NO_PROFILE'), profile: undefined },
      { ...subagentDone('chat-A', 'default', 'local', 'no-connection', 'NO_CONNECTION'), connectionId: undefined },
      subagentDone('chat-A', 'default', '', 'blank-connection', 'BLANK_CONNECTION'),
      { type: 'subagent.complete', payload: { subagent_id: 'bare', status: 'completed', goal: 'bare', summary: 'BARE', session_id: 'chat-A' } },
    ]
    for (const event of unowned) h.emit('subagent.complete', event)
    if (!ownerConnection) h.emit('subagent.complete', { ...subagentDone('chat-A', 'default', 'local', 'stamped', 'STAMPED') })
    assert.deepEqual(spoken(dc), [], `nothing spoken (owner connection "${ownerConnection}")`)
    if (ownerConnection) {
      h.emit('subagent.complete', subagentDone('chat-A', 'default', 'local', 'own', 'OWN_RESULT'))
      assert.equal(spoken(dc).length, 1, 'control: the fully stamped own result is still spoken')
    }
    await h.controller.action({ action: 'stop' })
    assert.deepEqual(h.open(), IDLE)
  }
})

const kanbanNotice = (session_id, profile, connectionId, card) =>
  ({ type: 'status.update', session_id, profile, connectionId, payload: { kind: 'process', text: `⏸ Kanban ${card} blocked: needs input` } })

test("Kanban notices are spoken only for the call's own chat, profile and connection", async () => {
  const h = setup()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.emit('status.update', kanbanNotice('chat-B', 'default', 'local', 't_otherchat'))
  h.emit('status.update', kanbanNotice('chat-A', 'coder', 'local', 't_otherprofile'))
  h.emit('status.update', kanbanNotice('chat-A', 'default', 'ssh-box', 't_otherconn'))
  h.emit('status.update', { ...kanbanNotice('chat-A', 'default', 'local', 't_nosession'), session_id: undefined })
  h.emit('status.update', { ...kanbanNotice('chat-A', 'default', 'local', 't_noprofile'), profile: undefined })
  h.emit('status.update', { ...kanbanNotice('chat-A', 'default', 'local', 't_noconn'), connectionId: undefined })
  h.emit('status.update', kanbanNotice('chat-A', 'default', 'local', 't_own'))
  const said = spoken(dc)
  assert.equal(said.length, 1, 'only the own notice reaches the call: ' + said.map(t => t.match(/t_\w+/)?.[0]).join(', '))
  assert.match(said[0], /t_own/)
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

test('call-time listeners use the plugin-scoped ctx.onEvent, and none are left after Stop', async () => {
  const h = setup({ ctxEvents: true })
  const atLoad = h.hostListeners()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  assert.deepEqual(h.hostListeners(), atLoad, 'the call adds no bare host.onEvent listeners')
  assert.deepEqual(h.pluginListeners(), { 'status.update': 1, 'subagent.complete': 1 })
  h.deliver(dc, 'item-A1', 'Inspect the first document'); await flush()
  assert.deepEqual(h.hostListeners(), atLoad, 'delegated work adds no bare host.onEvent listeners')
  assert.deepEqual(h.pluginListeners(), { 'status.update': 1, 'subagent.complete': 1, 'message.delta': 1, 'message.complete': 1, error: 1 })
  h.emit('subagent.complete', subagentDone('chat-A', 'default', 'local', 'own', 'OWN_RESULT'))
  assert.equal(spoken(dc).length, 1, 'the own result still reaches the call through ctx.onEvent')
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'DONE' })
  await h.advance(300)
  assert.deepEqual(h.pluginListeners(), { 'status.update': 1, 'subagent.complete': 1 }, 'delegation listeners leave when the work settles')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.pluginListeners(), {}, 'no call listeners left after Stop')
  assert.deepEqual(h.hostListeners(), atLoad)
  assert.deepEqual(h.open(), IDLE)
})

test('control: within one call, queued work runs in its own chat even after focus moves, and reads back on its channel', async () => {
  const h = setup()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.deliver(dc, 'item-A1', 'Inspect the first document'); await flush()
  h.state.busyBySession.set({ 'chat-A': true })
  h.deliver(dc, 'item-A2', 'Apply the pending correction'); await flush()
  h.focus('chat-B', 'stored-B')
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'ONE' })
  await h.advance(300)
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'TWO' })
  await h.advance(300)
  assert.deepEqual(h.submits, ['chat-A: [voice] Inspect the first document', 'chat-A: [voice] Apply the pending correction'])
  const results = dc.sent.filter(m => m.type === 'delegation.context.append' && /^Task result/.test(m.content[0].text))
  assert.deepEqual(results.map(m => [m.delegation_item_id, m.content[0].text.split(': ').pop()]), [['item-A1', 'ONE'], ['item-A2', 'TWO']])
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

// Privacy: every gateway event is stamped with the connectionId of the socket it arrived on. A chat
// with the same runtime id and profile name can live on another backend, so its reply must never be
// read into this call.
test("a voice task reads back a reply only from the call owner's connection", async () => {
  const h = setup()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.deliver(dc, 'item-C1', 'Check the build log'); await flush()
  const readBacks = () => dc.sent.filter(m => m.type === 'delegation.context.append')
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'remote-other', text: 'FOREIGN_BACKEND_RESULT' })
  await h.advance(400)
  assert.deepEqual(readBacks(), [], 'a reply stamped by another backend is not read back')
  h.emit('message.delta', { session_id: 'chat-A', profile: 'default', connectionId: 'remote-other', delta: 'FOREIGN_DELTA' })
  h.emit('error', { session_id: 'chat-A', profile: 'default', connectionId: 'remote-other', message: 'FOREIGN_ERROR' })
  await h.advance(400)
  assert.deepEqual(readBacks(), [], 'deltas and errors from another backend do not settle this task')
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'OWN_RESULT' })
  await h.advance(400)
  assert.equal(readBacks().length, 1)
  assert.match(readBacks()[0].content[0].text, /OWN_RESULT$/)
  assert.ok(!/FOREIGN/.test(JSON.stringify(dc.sent)), 'nothing from the other backend reaches the voice channel')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

test('a voice task with no resolved owner connection fails closed: no reply is read back', async () => {
  const h = setup()
  h.state.focusedSessionOwner.set(null)
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.deliver(dc, 'item-D1', 'Check the build log'); await flush()
  assert.deepEqual(h.submits, ['chat-A: [voice] Check the build log'], 'the task itself still runs in the chat')
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'UNRESOLVED_OWNER_RESULT' })
  await h.advance(400)
  assert.deepEqual(dc.sent.filter(m => m.type === 'delegation.context.append' && /UNRESOLVED_OWNER_RESULT/.test(m.content[0].text)), [])
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

// ── Group G: Hermes Live (Hermes' own GPT-Live) through the same startLive, controller and call token ──
// Vendor protocol: session.* events on the data channel; the delegation carries no text.
const hermesLive = (extra = {}) => setup({ engine: 'hermes-live', ...extra })
const sentOf = (dc, type) => dc.sent.filter(m => m.type === type)
const serverEvent = (dc, event) => dc.onmessage({ data: JSON.stringify(event) })
const plain = value => JSON.parse(JSON.stringify(value))

test('Hermes Live: start negotiates through /hermeslive/session, and Stop closes the session and releases everything', async () => {
  const h = hermesLive()
  await h.controller.action({ action: 'start' })
  assert.deepEqual(h.restCalls.map(r => r.path), ['/hermeslive/session'], 'no realtime key mint, no Codex session')
  assert.deepEqual(plain(h.restCalls[0].body), { profile: null, offer: 'offer-sdp' })
  assert.equal(h.run('bus.live'), true); assert.equal(h.open().tracks, 1)
  const dc = h.peers[0].dc
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(dc.sent.map(m => m.type), ['session.close'], 'the session is closed before its channel goes')
  assert.deepEqual(h.open(), IDLE)
  assert.equal(h.run('bus.stage'), 'idle')
})

test("Hermes Live: a bot chat's call negotiates on the bot's own profile", async () => {
  const h = hermesLive()
  h.state.focusedSessionProfile.set('coder'); h.state.profile.set('coder'); h.state.focusedSessionOwner.set({ connectionId: 'local', profile: 'coder' })
  await h.controller.action({ action: 'start' })
  assert.equal(h.restCalls[0].body.profile, 'coder')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

for (const step of ['offer', 'local', 'rest', 'answer', 'remote']) {
  test(`Hermes Live: a start that fails at "${step}" releases everything it acquired`, async () => {
    const h = hermesLive({ fail: step })
    await assert.rejects(h.controller.action({ action: 'start' }))
    assert.deepEqual(h.open(), IDLE)
    assert.equal(h.run('bus.stage'), 'error')
    await assert.rejects(h.controller.action({ action: 'start' }))
    assert.deepEqual(h.open(), IDLE, 'retries do not pile up tracks, peers, listeners or intervals')
  })
}

test('Hermes Live: Stop while the session is being created releases at once, and the late answer is never applied', async () => {
  const session = deferred(), h = hermesLive({ session })
  const pending = h.controller.action({ action: 'start' })
  await flush()
  assert.equal(h.restCalls.filter(r => r.path === '/hermeslive/session').length, 1)
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE); assert.equal(h.controller.snapshot().lifecycle, 'idle')
  session.resolve({ answer: 'answer-sdp', sessionId: 'late' })
  await pending
  assert.equal(h.peers[0].connectionState, 'closed', 'the late answer is not applied to the closed peer')
  assert.deepEqual(h.open(), IDLE); assert.equal(h.run('bus.err'), '')
})

test('Hermes Live: a delegation becomes exactly one prompt.submit on the owner chat, and the reply goes back as commentary', async () => {
  const h = hermesLive()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.deliver(dc, 'del-1', 'Check whether the build is green'); await flush()
  h.focus('chat-B', 'stored-B')  // focus moves on: the reply still belongs to chat A
  assert.deepEqual(h.rpcs.map(r => [r.method, r.session_id, r.text, r.surface]), [['prompt.submit', 'chat-A', '[voice] Check whether the build is green', 'voice-live']])
  assert.match(h.rpcs[0].voice_context, /User: Check whether the build is green/)
  h.emit('message.complete', { session_id: 'chat-A', profile: 'default', connectionId: 'local', text: 'The **build** is green.' })
  await h.advance(300)
  assert.deepEqual(sentOf(dc, 'session.commentary.append').map(m => [m.delegation_id, m.content]), [['del-1', 'The build is green.']])
  assert.deepEqual(dc.sent.filter(m => !m.type.startsWith('session.')), [], 'nothing in another engine\u2019s protocol')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

test('Hermes Live: GPT-Live decides what to delegate, so short approvals reach the chat; a delegation before any words does not', async () => {
  const h = hermesLive()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  serverEvent(dc, { type: 'session.delegation.created', delegation: { id: 'del-0', type: 'delegation', target: 'client' } }); await flush()
  assert.deepEqual(h.rpcs, [], 'nothing said yet: nothing is sent')
  assert.deepEqual(sentOf(dc, 'session.thinking.append').map(m => m.delegation_id), ['del-0'], 'the delegation is settled quietly')
  h.deliver(dc, 'del-1', 'okay'); await flush()
  assert.deepEqual(h.rpcs.map(r => r.text), ['[voice] okay'])
  await h.controller.action({ action: 'stop' })
})

test('Hermes Live: with "Work in the chat" off a delegation is refused out loud, and nothing reaches the chat', async () => {
  const h = hermesLive({ store: { 'chatwork.v1': '0' } })
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.deliver(dc, 'del-1', 'Delete the old branches'); await flush()
  assert.deepEqual(h.rpcs, [])
  assert.deepEqual(sentOf(dc, 'session.commentary.append').map(m => m.delegation_id), ['del-1'])
  assert.match(sentOf(dc, 'session.commentary.append')[0].content, /Work in the chat/)
  await h.controller.action({ action: 'stop' })
})

test('Hermes Live: work queued in a hung-up call is dropped, never run or read back in the next call', async () => {
  const h = hermesLive()
  const { oldDc, newDc } = await replaceCallWhileWorkIsPending(h)
  assert.deepEqual(h.submits, ['chat-A: [voice] Inspect the first document'], 'A2 is not retargeted to chat B')
  assert.deepEqual(oldDc.late.filter(m => m.type === 'session.commentary.append'), [], 'no read-back on the dead call')
  assert.deepEqual(newDc.sent.filter(m => m.type === 'session.commentary.append'), [], 'no read-back into the new call')
  assert.equal(h.run('_delegBusy'), false)
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

test('Hermes Live: mute switches the mic track off and tells the session; unmute reverses both', async () => {
  const h = hermesLive()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  await h.controller.action({ action: 'setMuted', muted: true })
  assert.equal(h.tracks[0].enabled, false); assert.equal(h.run('bus.muted'), true)
  await h.controller.action({ action: 'setMuted', muted: false })
  assert.equal(h.tracks[0].enabled, true)
  assert.deepEqual(dc.sent.map(m => m.type), ['session.input_audio.mute', 'session.input_audio.unmute'])
  await h.controller.action({ action: 'stop' })
  assert.equal(h.run('bus.muted'), false); assert.deepEqual(h.open(), IDLE)
})

test("Hermes Live: sub-agent and Kanban notices are spoken only for the call's own chat, profile and connection", async () => {
  const h = hermesLive()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  h.emit('subagent.complete', subagentDone('chat-A', 'default', 'local', 'own', 'OWN_RESULT'))
  h.emit('subagent.complete', subagentDone('chat-B', 'default', 'local', 'other-chat', 'FOREIGN_CHAT_RESULT'))
  h.emit('subagent.complete', subagentDone('chat-A', 'coder', 'local', 'other-profile', 'FOREIGN_PROFILE_RESULT'))
  h.emit('subagent.complete', subagentDone('chat-A', 'default', 'ssh-box', 'other-connection', 'FOREIGN_CONNECTION_RESULT'))
  h.emit('status.update', kanbanNotice('chat-B', 'default', 'local', 't_otherchat'))
  h.emit('status.update', kanbanNotice('chat-A', 'coder', 'local', 't_otherprofile'))
  h.emit('status.update', kanbanNotice('chat-A', 'default', 'local', 't_own'))
  const said = sentOf(dc, 'session.commentary.append')
  assert.deepEqual(said.map(m => m.delegation_id), [null, null], 'background notices belong to no delegation')
  assert.match(said[0].content, /OWN_RESULT/); assert.match(said[1].content, /t_own/)
  assert.ok(!said.some(m => /FOREIGN|t_other/.test(m.content)))
  assert.deepEqual(dc.sent.filter(m => m.type !== 'session.commentary.append'), [], 'nothing in another engine\u2019s protocol')
  await h.controller.action({ action: 'stop' })
  assert.deepEqual(h.open(), IDLE)
})

test('Hermes Live: "Ask before sending to chat" reaches the voice as a session instruction once the session starts', async () => {
  for (const [store, expected] of [[{}, 1], [{ 'askBeforeChat.v1': '0' }, 0], [{ 'chatwork.v1': '0' }, 0]]) {
    const h = hermesLive({ store })
    await h.controller.action({ action: 'start' })
    const dc = h.peers[0].dc
    serverEvent(dc, { type: 'session.started', session: { id: 'live-1' } })
    const sent = sentOf(dc, 'session.instructions.append')
    assert.equal(sent.length, expected, JSON.stringify(store))
    if (expected) { assert.equal(sent[0].delegation_id, null); assert.match(sent[0].content, /Should I send that to the chat\?/) }
    await h.controller.action({ action: 'stop' })
  }
})

test('Hermes Live: transcript rows follow the live captions, and a session the server ends releases the call', async () => {
  const h = hermesLive()
  await h.controller.action({ action: 'start' })
  const dc = h.peers[0].dc
  // Token-style deltas, each carrying its own leading space (as every other engine's captions do).
  for (const delta of ['What', ' is', ' the weather?']) serverEvent(dc, { type: 'session.input_transcript.delta', delta, start_ms: 0, end_ms: 900 })
  for (const delta of ['Let', ' me', ' check.']) serverEvent(dc, { type: 'session.output_transcript.delta', delta, start_ms: 900, end_ms: 1500 })
  serverEvent(dc, { type: 'session.input_transcript.delta', delta: ' Thanks', start_ms: 1600, end_ms: 1900 })
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(transcript.map(x => [x.role, x.text]))')), [['user', 'What is the weather?'], ['bot', 'Let me check.'], ['user', 'Thanks']],
    'turns alternate: speech after a reply opens a new row instead of joining the earlier one')
  serverEvent(dc, { type: 'session.closed', reason: 'expired', usage: { seconds: 61 } })
  assert.deepEqual(h.open(), IDLE)
  assert.equal(h.run('bus.live'), false)
  assert.ok(h.run('transcript').some(x => /Hermes Live ended: expired/.test(x.text)))
  assert.ok(h.controller.snapshot().capabilities.includes('start'), 'the user can call again')
})

test('Hermes Live: the offer waits for ICE gathering so it carries its candidates, at most 10 s; Stop during the wait releases at once', async () => {
  const h = hermesLive({ ice: 'slow' })
  const pending = h.controller.action({ action: 'start' })
  await flush()
  assert.equal(h.restCalls.length, 0, 'not sent while gathering')
  const peer = h.peers[0]
  peer.localDescription = { type: 'offer', sdp: 'offer-sdp-with-candidates' }
  peer.iceGatheringState = 'complete'; peer.onicegatheringstatechange?.()
  await pending
  assert.equal(h.restCalls[0].body.offer, 'offer-sdp-with-candidates')
  await h.controller.action({ action: 'stop' })
  const slow = hermesLive({ ice: 'slow' }), late = slow.controller.action({ action: 'start' })
  await flush(); await slow.advance(10_000); await late
  assert.equal(slow.restCalls[0].body.offer, 'offer-sdp', 'gathering that never finishes still starts with what it has')
  await slow.controller.action({ action: 'stop' })
  const cancel = hermesLive({ ice: 'slow' }), cancelled = cancel.controller.action({ action: 'start' })
  await flush()
  await cancel.controller.action({ action: 'stop' })
  assert.deepEqual(cancel.open(), IDLE)
  await cancel.advance(10_000); await cancelled
  assert.deepEqual(cancel.restCalls, [], 'no session is created for a cancelled call')
  assert.equal(cancel.run('bus.err'), '')
})

// ── Follow-up H: a call that drops ends cleanly, says so once in plain words, and can be redialled ──
const DROPPED = 'Call dropped — check the connection and call again'
const engines = [['Codex', ''], ['Hermes Live', 'hermes-live']]
const peerState = (pc, state) => { pc.connectionState = state; pc.onconnectionstatechange?.() }
for (const [label, engine] of engines) {
  test(`${label}: a connection that fails mid-call releases everything and says "Call dropped" once`, async () => {
    const h = setup({ engine })
    await h.controller.action({ action: 'start' })
    peerState(h.peers[0], 'failed')
    await h.advance(60_000)
    assert.deepEqual(h.open(), IDLE)
    assert.equal(h.run('bus.live'), false); assert.equal(h.run('bus.err'), DROPPED)
    assert.deepEqual(h.notices.map(n => [n.kind, n.message]), [['error', DROPPED]], 'one toast')
    assert.ok(h.controller.snapshot().capabilities.includes('start'), 'the user can call again')
  })
}

const channelClosed = dc => { dc.readyState = 'closed'; dc.onclose?.() }
for (const [label, engine] of engines) {
  test(`${label}: losing only the control channel ends the call — mic, peer and audio released, "Call dropped" once`, async () => {
    const h = setup({ engine })
    await h.controller.action({ action: 'start' })
    channelClosed(h.peers[0].dc)
    await h.advance(60_000)
    assert.deepEqual(h.open(), IDLE)
    assert.equal(h.run('bus.live'), false); assert.equal(h.run('bus.err'), DROPPED)
    assert.deepEqual(h.notices.map(n => n.message), [DROPPED])
    assert.ok(h.controller.snapshot().capabilities.includes('start'))
  })

  test(`${label}: a disconnect that outlasts the 10 s grace ends the call`, async () => {
    const h = setup({ engine })
    await h.controller.action({ action: 'start' })
    peerState(h.peers[0], 'disconnected')
    await h.advance(9_000)
    assert.equal(h.open().tracks, 1, 'still inside the grace: the call waits for the network')
    await h.advance(1_500)
    assert.deepEqual(h.open(), IDLE)
    assert.equal(h.run('bus.err'), DROPPED); assert.deepEqual(h.notices.map(n => n.message), [DROPPED])
  })

  test(`${label}: a disconnect that recovers within the grace keeps the call`, async () => {
    const h = setup({ engine })
    await h.controller.action({ action: 'start' })
    peerState(h.peers[0], 'disconnected')
    await h.advance(5_000)
    peerState(h.peers[0], 'connected')
    await h.advance(60_000)
    assert.equal(h.run('bus.live'), true); assert.equal(h.open().tracks, 1); assert.equal(h.open().peers, 1)
    assert.deepEqual(h.notices, []); assert.equal(h.run('bus.err'), '')
    await h.controller.action({ action: 'stop' })
    assert.deepEqual(h.open(), IDLE)
  })

  test(`${label}: an explicit Stop stays quiet even when the channel closes and a disconnect was pending`, async () => {
    const h = setup({ engine })
    await h.controller.action({ action: 'start' })
    const pc = h.peers[0]
    peerState(pc, 'disconnected')
    await h.controller.action({ action: 'stop' })
    channelClosed(pc.dc)
    await h.advance(60_000)
    assert.deepEqual(h.open(), IDLE)
    assert.deepEqual(h.notices, []); assert.equal(h.run('bus.err'), ''); assert.equal(h.run('bus.stage'), 'idle')
  })

  test(`${label}: a channel that closes while the call is still connecting gives one reason, not two`, async () => {
    const session = deferred(), h = setup({ engine, session })
    const pending = h.controller.action({ action: 'start' })
    await flush()
    channelClosed(h.peers[0].dc)
    session.resolve(engine ? { answer: 'answer-sdp', sessionId: 'late' } : { answer: 'answer-sdp', threadId: 'late' })
    await assert.rejects(pending)
    await h.advance(60_000)
    assert.deepEqual(h.open(), IDLE)
    assert.deepEqual(h.notices.map(n => n.message), [DROPPED], 'the start reports the drop, once')
    assert.ok(h.controller.snapshot().capabilities.includes('start'))
  })
}

// #4: hanging up while connecting must not leave Start dead until the old request returns (120 s / 45 s).
for (const [label, engine] of engines) {
  for (const oldFirst of [true, false]) {
    test(`${label}: hang up while connecting, then call again at once — the redial negotiates now, and the old late answer (${oldFirst ? 'first' : 'last'}) never goes live`, async () => {
      const [old, next] = [deferred(), deferred()], h = setup({ engine, queued: [old, next] })
      const answer = id => engine ? { answer: 'answer-sdp', sessionId: id } : { answer: 'answer-sdp', threadId: id }
      const sessionPath = engine ? '/hermeslive/session' : '/codexlive/session'
      const first = h.controller.action({ action: 'start' })
      await flush()
      await h.controller.action({ action: 'stop' })
      assert.ok(h.controller.snapshot().capabilities.includes('start'), 'Start is offered again right after hanging up')
      const second = h.controller.action({ action: 'start' })
      await flush()
      assert.equal(h.restCalls.filter(r => r.path === sessionPath).length, 2, 'the redial negotiates without waiting for the old request')
      assert.equal(h.gumCalls.length, 2)
      const settleOld = async () => {
        old.resolve(answer('late')); await first
        assert.equal(h.peers[0].closed, true, 'the old peer stays closed')
        assert.equal(h.open().tracks, 1, 'only the redial holds the mic'); assert.equal(h.open().peers, 1)
        if (!engine) assert.ok(h.stops().includes('late'), 'the late provider session is stopped')
      }
      if (oldFirst) {
        await settleOld()
        assert.equal(h.controller.snapshot().lifecycle, 'connecting', 'the redial is still connecting, untouched')
      }
      next.resolve(answer('new')); await second
      if (!oldFirst) await settleOld()
      assert.equal(h.run('bus.live'), true); assert.equal(h.peers[1].closed, false, 'the redial is the live call')
      assert.ok(h.controller.snapshot().capabilities.includes('stop'))
      assert.deepEqual(h.notices, []); assert.equal(h.run('bus.err'), '')
      await h.controller.action({ action: 'stop' })
      assert.deepEqual(h.open(), IDLE)
    })
  }
}

// #6: a Start that cannot run says why, once, and opens nothing.
const NO_CHAT = 'Open a chat first — voice talks to a chat'
const OTHER_CHAT = "Voice is linked to another chat — press the pet's chat button to link this one"
test('Start with no chat to talk to (fresh draft) says "Open a chat first" once and opens no mic', async () => {
  const h = setup()
  h.focus('', '')
  await assert.rejects(h.controller.action({ action: 'start' }))
  assert.equal(h.run('bus.err'), NO_CHAT)
  assert.deepEqual(h.notices.map(n => [n.kind, n.message]), [['error', NO_CHAT]])
  assert.equal(h.gumCalls.length, 0); assert.deepEqual(h.open(), IDLE)
  h.focus('chat-A', 'stored-A')
  await h.controller.action({ action: 'start' })
  assert.equal(h.run('bus.live'), true); assert.equal(h.run('bus.err'), '', 'control: a real chat starts and clears the reason')
  await h.controller.action({ action: 'stop' })
})

test("Start while the pet's chat is on another profile says how to link this chat, once, and opens no mic", async () => {
  const h = setup()
  await h.controller.action({ action: 'start' }); await h.controller.action({ action: 'stop' })
  h.state.profile.set('coder'); h.state.focusedSessionProfile.set('coder'); h.state.focusedSessionOwner.set({ connectionId: 'local', profile: 'coder' }); h.focus('chat-C', 'stored-C')
  await flush()
  await assert.rejects(h.controller.action({ action: 'start' }))
  assert.equal(h.run('bus.err'), OTHER_CHAT)
  assert.deepEqual(h.notices.map(n => n.message), [OTHER_CHAT])
  assert.equal(h.gumCalls.length, 1, 'no second mic'); assert.deepEqual(h.open(), IDLE)
})
