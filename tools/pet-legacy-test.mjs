// Run with: TALK_TEST_DEPS=/path/to/isolated/node_modules node tools/pet-badge-test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
const require = createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const React = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const source = readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
async function setup() {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://hermes.test', pretendToBeVisual: true })
  const w = dom.window
  const errors = []
  dom.virtualConsole.on('jsdomError', error => errors.push(error.message))
  Object.assign(globalThis, { window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true })
  let captures = 0
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: async () => [], getUserMedia: async () => { captures++; throw Error('No capture allowed') } } })
  const passthrough = ({ children }) => jsx('div', { children })
  const PopoverContext = React.createContext(null)
  const atom = initial => { let value = initial; const listeners = new Set(); return { get: () => value, set: next => { value = next; for (const fn of listeners) fn(next) }, listen: fn => { listeners.add(fn); return () => listeners.delete(fn) }, listeners } }
  const state = { focusedSessionId: atom(''), focusedStoredSessionId: atom(''), focusedSessionProfile: atom(''), focusedSessionOwner: atom(null), busyBySession: atom({}), connectionId: atom('local'), profile: atom('default') }
  const events = new Map(); const opened = []
  const host = { state, openSession: async (id, options) => opened.push({ id, options }), onEvent: (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); return () => events.get(type).delete(fn) } }
  const sdk = { host, useValue: x => x?.get ? React.useSyncExternalStore(x.listen, x.get) : x,
    Dialog: ({ open, onOpenChange, children }) => jsx(PopoverContext.Provider, { value: { open, onOpenChange }, children }),
    DialogTitle: ({children}) => jsx('h2',{children}),
    DialogContent: ({children,...props}) => React.useContext(PopoverContext).open ? require('react-dom').createPortal(jsx('section',{role:'dialog',...props,children}),w.document.body) : null,
    Popover: ({ open, onOpenChange, children }) => jsx(PopoverContext.Provider, { value: { open, onOpenChange }, children }),
    PopoverContent: ({ children }) => React.useContext(PopoverContext).open ? require('react-dom').createPortal(jsx('div', { 'data-test-popover': '', children }), w.document.body) : null,
    PopoverTrigger: ({ children }) => {
      const state = React.useContext(PopoverContext)
      return React.cloneElement(children, { 'aria-expanded': state.open, onClick: () => state.onOpenChange(!state.open) })
    },
    Select: passthrough, SelectContent: passthrough, SelectItem: passthrough, SelectTrigger: passthrough, SelectValue: () => null, Switch: () => null,
    Button: ({ children, onClick }) => jsx('button', { onClick, children }) }
  const context = vm.createContext({ window: w, document: w.document, navigator: w.navigator, MutationObserver: w.MutationObserver, CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, jsx, jsxs, sdk,
    useState: React.useState, useEffect: React.useEffect, useRef: React.useRef,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w), performance: w.performance,
    setInterval, clearInterval, setTimeout, clearTimeout, console })
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'globalThis.plugin = {').replace(/^export (?=(?:async )?function |const |let |class )/gm, ''), context)
  const contributions = []; const disposers = []; let companion = null
  const store = new Map()
  context.plugin.register({ onDispose: fn => disposers.push(fn), registerOverlayCompanion: owner => { companion = owner; return null }, register: c => contributions.push(c), storage: { get: k => store.get(k), set: (k, v) => store.set(k, v) }, rest: async () => ({ bots: [] }) })
  const root = createRoot(w.document.getElementById('root'))
  await React.act(async () => root.render(jsx(React.Fragment, { children: contributions.filter(c=>c.render).map(c => jsx(React.Fragment, { children: c.render() }, c.id)) })))
  const flush = async fn => React.act(async () => { fn?.(); await new Promise(r => setTimeout(r, 0)) })
  const pet = () => {
    const parent = w.document.createElement('div'); parent.style.position = 'fixed'; parent.style.left = '120px'; parent.style.top = '80px'
    parent.innerHTML = '<div style="transform:scaleX(-1)"><canvas aria-label="Buddy pet" style="width:100px;height:120px"></canvas></div>'
    w.document.body.append(parent); return parent
  }
  return { w, root, context, contributions, companion: () => vm.runInContext('liveController',context), flush, pet, errors, state, host, events, opened,
    focus: (runtime, stored, profile) => { state.focusedSessionId.set(runtime); state.focusedStoredSessionId.set(stored); state.focusedSessionProfile.set(profile); state.focusedSessionOwner.set({ connectionId: 'local', profile }); state.profile.set(profile) },
    emit: (type, event) => { for (const fn of events.get(type) || []) fn(event) },
    captures: () => captures, cleanup: async () => { await React.act(async () => { root.unmount(); disposers.forEach(fn => fn()) }); w.close() } }
}
test('status bubble has no tail, scales its body 20 percent and clears its stylesheet on unmount', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const sheet = h.w.document.querySelector('style[data-talk-pet-style]')
    assert.ok(sheet, 'pet needs its own scoped comic styling')
    assert.doesNotMatch(sheet.textContent, /\[data-talk-pet-status\]::(?:before|after)|clip-path|talk-pet-tail/)
    assert.match(sheet.textContent, /focus-visible/)
    await h.flush(() => { h.focus('r', 's', 'coder'); h.state.busyBySession.set({ r: true }) })
    const bubble = pet.querySelector('[data-talk-pet-status]')
    assert.equal(bubble.textContent, 'Working', 'decorative tail must not change spoken status')
    assert.equal(bubble.style.borderWidth, '1.2px')
    assert.equal(bubble.style.borderRadius, '10px', 'straight-sided rectangle, not an oval')
    assert.equal(bubble.style.maxWidth, '200px')
    assert.equal(bubble.style.padding, '8px 14px')
    assert.equal(bubble.style.fontSize, '15px')
    assert.equal(bubble.style.lineHeight, '22px')
    assert.equal(bubble.style.transform, '', 'real layout dimensions, not transform scaling')
    assert.equal(bubble.style.boxShadow, 'none', 'no heavy offset comic shadow')
    assert.equal(bubble.style.getPropertyValue('--talk-pet-tail-height'), '', 'no tail allowance')
    await React.act(async () => h.root.render(null))
    assert.equal(h.w.document.querySelector('style[data-talk-pet-style]'), null)
  } finally { await h.cleanup() }
})

test('chat button is disabled without an associated session and does not intercept pet drag', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const chat = pet.querySelector('[data-talk-pet-chat]')
    assert.ok(chat, 'the pet needs chat access')
    assert.equal(chat.disabled, true)
    assert.equal(chat.title, 'No associated chat yet')
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Reply to Hermes…', 'idle bubble invites a quick reply')
    let drags = 0; pet.addEventListener('pointerdown', () => drags++)
    chat.dispatchEvent(new h.w.Event('pointerdown', { bubbles: true })); chat.click()
    assert.equal(drags, 0); assert.equal(h.opened.length, 0)
  } finally { await h.cleanup() }
})
test('busy association survives chat switches and opens exact durable session with its captured profile', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => { h.focus('runtime-a', 'stored:a', 'coder'); h.state.busyBySession.set({ 'runtime-a': true }) })
    const chat = pet.querySelector('[data-talk-pet-chat]'); const bubble = pet.querySelector('[data-talk-pet-status]')
    assert.equal(bubble.textContent, 'Working'); assert.equal(bubble.hidden, false)
    assert.equal(bubble.getAttribute('aria-live'), 'polite'); assert.equal(bubble.style.pointerEvents, 'auto', 'bubble is clickable for quick replies')
    await h.flush(() => { h.focus('runtime-b', 'stored-b', 'other'); h.state.busyBySession.set({ 'runtime-a': true, 'runtime-b': true }) })
    assert.match(chat.title, /stored:a/); assert.match(chat.title, /coder/)
    await h.flush(() => chat.click())
    assert.equal(JSON.stringify(h.opened), JSON.stringify([{ id: 'stored:a', options: { profile: 'coder', intent: 'in-place', route: { connectionId: 'local', profile: 'coder', mode: 'local' } } }]))
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})
test('bubble uses only exact-session terminal events and clears unknown idle without claiming completion', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => { h.focus('r-a', 's-a', 'coder'); h.state.busyBySession.set({ 'r-a': true }) })
    const bubble = pet.querySelector('[data-talk-pet-status]'); const chat = pet.querySelector('[data-talk-pet-chat]')
    await h.flush(() => { h.emit('message.complete', { session_id: 'r-b' }); h.emit('error', {}); h.emit('message.complete', { session_id: 'r-a', profile: 'wrong' }); h.emit('tool.start', { session_id: 'r-b', payload: { name: 'terminal' } }) })
    assert.equal(bubble.textContent, 'Working', 'foreign/missing IDs or wrong profiles cannot finish the associated turn or fabricate tool activity')
    await h.flush(() => h.state.busyBySession.set({ 'r-a': false }))
    assert.equal(bubble.textContent, 'Reply to Hermes…', 'idle alone does not prove Finished')
    await h.flush(() => h.emit('message.complete', { session_id: 'r-a', profile: 'coder', payload: { status: 'complete' } }))
    assert.equal(bubble.textContent, 'Finished'); assert.equal(bubble.hidden, false)
    await h.flush(() => chat.click()); assert.equal(h.opened[0].id, 's-a', 'last associated chat remains accessible')
    await React.act(async () => { await new Promise(r => setTimeout(r, 5100)) })
    assert.equal(bubble.textContent, 'Reply to Hermes…', 'terminal beat is tiny and transient')
    await h.flush(() => { h.state.busyBySession.set({ 'r-a': true }); h.emit('message.complete', { session_id: 'r-a', payload: { status: 'error', error: 'failed' } }) })
    assert.equal(bubble.textContent, 'Error', 'structured terminal failure is never Finished')
    await h.flush(() => h.emit('error', { session_id: 'r-b', message: 'foreign' }))
    assert.equal(bubble.textContent, 'Error')
    await React.act(async () => h.root.render(null))
    assert.equal(h.state.busyBySession.listeners.size, 2, 'tracking belongs to plugin lifetime')
    assert.deepEqual(Object.fromEntries([...h.events].map(([key, listeners]) => [key, listeners.size]).filter(([, size]) => size)), {
      'message.complete': 2, error: 2, 'message.start': 1,
      'plugin.talk-desktop.attention': 1, 'gateway.ready': 1,
      'subagent.start': 1, 'subagent.spawn_requested': 1,
      'subagent.progress': 1, 'subagent.tool': 1, 'subagent.complete': 1,
    }, 'one chat tracker, bot tracker, attention monitor and narrator survive composer remount')
    assert.equal(pet.querySelector('[data-talk-pet-status]'), null); assert.equal(pet.querySelector('[data-talk-pet-chat]'), null)
  } finally { await h.cleanup() }
})
test('voice delegation captures its chat before submit and retains it after focus changes', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => h.focus('voice-runtime', 'voice-stored', 'voice-owner'))
    vm.runInContext('startLive = async () => ({close(){}})', h.context)
    await h.companion().action({action:'start'})
    let submitted
    h.host.request = async (method, params) => {
      submitted = { method, params }
      h.focus('other-runtime', 'other-stored', 'other-owner')
      h.emit('message.complete', { session_id: 'voice-runtime', connectionId: 'local', payload: { text: 'Actual reply.' }, text: 'Actual reply.' })
    }
    await h.flush(() => vm.runInContext('window.delegation = delegateToChat("test request")', h.context))
    assert.equal(await h.w.delegation, 'Actual reply.')
    const chat = pet.querySelector('[data-talk-pet-chat]')
    assert.match(chat.title, /voice-stored/)
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Finished')
    await h.flush(() => chat.click())
    assert.equal(h.opened[0].id, 'voice-stored'); assert.equal(h.opened[0].options.profile, 'voice-owner')
    assert.equal(submitted.method, 'prompt.submit'); assert.equal(submitted.params.session_id, 'voice-runtime')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})
test('new turns reset terminal status and completed work can yield to a newly started focused chat', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => { h.focus('r-a', 's-a', 'coder'); h.state.busyBySession.set({ 'r-a': true }); h.emit('message.complete', { session_id: 'r-a' }); h.state.busyBySession.set({}) })
    await h.flush(() => h.state.busyBySession.set({ 'r-a': true }))
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Working', 'a new turn is not still Finished')
    await h.flush(() => { h.state.busyBySession.set({}); h.focus('r-b', 's-b', 'other'); h.state.busyBySession.set({ 'r-b': true }) })
    await h.flush(() => pet.querySelector('[data-talk-pet-chat]').click())
    assert.equal(h.opened[0].id, 's-b'); assert.equal(h.opened[0].options.profile, 'other')
    await h.flush(() => pet.remove()); assert.equal(h.w.document.querySelector('[data-talk-pet-chat]'), null)
    const next = h.pet(); await h.flush()
    assert.equal(next.querySelectorAll('[data-talk-pet-chat]').length, 1)
    assert.equal(next.querySelectorAll('[data-talk-pet-status]').length, 1)
  } finally { await h.cleanup() }
})
test('rejected voice submit reports Error rather than claiming the agent is working', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => h.focus('r', 's', 'coder'))
    vm.runInContext('startLive = async () => ({close(){}})', h.context)
    await h.companion().action({action:'start'})
    h.host.request = async () => {
      assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Sending')
      throw Error('submit rejected')
    }
    await h.flush(() => vm.runInContext('window.delegation = delegateToChat("test rejection")', h.context))
    assert.match(await h.w.delegation, /submit rejected/)
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Error')
  } finally { await h.cleanup() }
})
test('background associated turns update without borrowing current focus and remount clears stale idle', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => { h.focus('r-a', 's-a', 'coder'); h.state.busyBySession.set({ 'r-a': true }); h.focus('r-b', 's-b', 'other'); h.emit('message.complete', { session_id: 'r-a' }); h.state.busyBySession.set({}) })
    await h.flush(() => h.state.busyBySession.set({ 'r-a': true }))
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Working')
    await h.flush(() => pet.querySelector('[data-talk-pet-chat]').click()); assert.equal(h.opened[0].id, 's-a')
    await React.act(async () => h.root.render(null))
    await h.flush(() => h.state.busyBySession.set({}))
    await React.act(async () => h.root.render(jsx(React.StrictMode, { children: h.contributions.filter(c=>c.render).map(c => jsx(React.Fragment, { children: c.render() }, c.id)) })))
    await h.flush()
    assert.equal(pet.querySelectorAll('[data-talk-pet-chat]').length, 1)
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Reply to Hermes…')
    assert.equal(h.state.busyBySession.listeners.size, 2)
    assert.deepEqual(Object.fromEntries([...h.events].map(([key, listeners]) => [key, listeners.size]).filter(([, size]) => size)), {
      'message.complete': 2, error: 2, 'message.start': 1,
      'plugin.talk-desktop.attention': 1, 'gateway.ready': 1,
      'subagent.start': 1, 'subagent.spawn_requested': 1,
      'subagent.progress': 1, 'subagent.tool': 1, 'subagent.complete': 1,
    }, 'one chat tracker, bot tracker, attention monitor and narrator survive composer remount')
  } finally { await h.cleanup() }
})
test('unmount retains transient terminal status under the persistent controller', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => { h.focus('r', 's', 'coder'); h.state.busyBySession.set({ r: true }); h.emit('message.complete', { session_id: 'r' }); h.state.busyBySession.set({}) })
    await React.act(async () => h.root.render(null))
    await React.act(async () => h.root.render(jsx(React.Fragment, { children: h.contributions.filter(c=>c.render).map(c => jsx(React.Fragment, { children: c.render() }, c.id)) })))
    await h.flush()
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent, 'Finished')
    await h.flush(() => pet.querySelector('[data-talk-pet-chat]').click()); assert.equal(h.opened[0].id, 's')
  } finally { await h.cleanup() }
})
test('rectangular balloon is centered below the art so animation never moves it', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => { h.focus('r', 's', 'coder'); h.state.busyBySession.set({ r: true }) })
    const bubble = pet.querySelector('[data-talk-pet-status]')
    // 100px fallback art at x=0 (anchor-relative); 100.8px fallback body => centered left is -1px.
    assert.equal(bubble.style.left, '-1px', 'bubble is centered over the art')
    // 120px fallback art; ~41px body; 8px gap below the art => bottom is -49px relative to the anchor.
    assert.equal(bubble.style.bottom, '-49px', 'body sits 8px under the art fallback')
    assert.equal(bubble.style.visibility, 'visible')
    assert.doesNotMatch(h.w.document.querySelector('style[data-talk-pet-style]').textContent, /talk-pet-tail|::before|::after/)
    await h.flush(() => { pet.style.left = '0px'; pet.style.top = '0px' })
    assert.equal(bubble.style.visibility, 'visible', 'in the top-left corner the bubble still fits under the pet without covering it')
    assert.equal(bubble.textContent, 'Working', 'clipping does not falsify status')
    await h.flush(() => { pet.style.left = '120px'; pet.style.top = '80px' })
    assert.equal(bubble.style.visibility, 'visible', 'safe position restores bubble')
  } finally { await h.cleanup() }
})

test('right rail falls back to measured canvas when alpha is unavailable, not wider anchor', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    pet.getBoundingClientRect = () => ({ left: 120, top: 80, width: 300, height: 120 })
    pet.querySelector('canvas').getBoundingClientRect = () => ({ left: 140, top: 80, right: 240, width: 100, height: 120 })
    await h.flush(() => h.w.dispatchEvent(new h.w.Event('resize')))
    const mic = pet.querySelector('[data-talk-pet-mic]')
    assert.equal(mic.style.left, '130px', 'full canvas right + 10px gap, relative to fixed anchor')
    assert.equal(mic.style.right, 'auto', 'anchor width must not decide sprite clearance')
    assert.equal(pet.querySelector('[data-talk-pet-chat]').style.left, '172px')
    assert.equal(mic.style.visibility, 'visible')
    assert.equal(pet.style.left, '120px', 'plugin never repositions the core pet')
  } finally { await h.cleanup() }
})

test('right rail clips safely at viewport edge and restores during drag and resize', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const mic = pet.querySelector('[data-talk-pet-mic]')
    assert.equal(mic.style.left, '110px', 'controls sit beyond full canvas + 10px')
    await h.flush(() => { pet.style.left = '900px'; pet.style.top = '0px'; h.focus('r', 's', 'coder'); h.state.busyBySession.set({ r: true }) })
    assert.equal(mic.style.left, '110px', 'rail remains RIGHT when the edge is crowded')
    assert.equal(mic.style.visibility, 'hidden', 'hide rather than cover pet or silently flip left')
    assert.equal(pet.style.left, '900px', 'do not clamp core pet position')
    const bubble = pet.querySelector('[data-talk-pet-status]')
    assert.equal(bubble.style.visibility, 'visible', 'at the top edge the bubble still fits under the pet')
    assert.equal(bubble.style.bottom, '-49px', 'and stays attached directly under it')
    assert.equal(bubble.style.getPropertyValue('--talk-pet-tail-height'), '')
    await h.flush(() => { pet.style.left = '120px'; pet.querySelector('canvas').style.width = '180px'; h.w.dispatchEvent(new h.w.Event('resize')) })
    assert.equal(mic.style.left, '190px')
    assert.equal(mic.style.visibility, 'visible')
    assert.equal(h.errors.length, 0)
  } finally { await h.cleanup() }
})

test('secondary bot toggle retains an opaque circular surface', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected" })', h.context))
    const transcript=pet.querySelector('[data-talk-pet-action="bots"]')
    assert.equal(transcript.style.background, 'var(--popover-surface)')
    assert.equal(transcript.style.borderWidth, '1px')
    assert.equal(transcript.style.borderColor, 'var(--ui-stroke-secondary)')
    assert.equal(transcript.style.bottom, '27px', 'transcript occupies middle of compact three-button rail')
    assert.equal(pet.querySelector('[data-talk-pet-chat]').style.bottom, '54px', 'chat occupies top of compact rail')
    assert.equal(pet.querySelector('[data-talk-pet-popout]').style.bottom, '0px', 'pop-out occupies bottom without overlap')
  } finally { await h.cleanup() }
})

test('pet buttons retain original circular styling and sizes beside the comic balloon', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected" })', h.context))
    for (const button of pet.querySelectorAll('button')) {
      const large = button.hasAttribute('data-talk-pet-mic') || button.dataset.talkPetAction === 'mute'
      assert.equal(button.style.width, large ? '36px' : '24px')
      assert.equal(button.style.height, large ? '36px' : '24px')
      assert.equal(button.style.borderRadius, '50%')
      assert.doesNotMatch(button.style.boxShadow, /2px 3px 0/)
      if (large || button.hasAttribute('data-talk-pet-chat')) assert.equal(button.style.background, 'var(--popover-surface)')
    }
  } finally { await h.cleanup() }
})

test('pet mute stacks above a larger mic without overlapping other controls', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const badge = pet.querySelector('[data-talk-pet-mic]')
    const mute = pet.querySelector('[data-talk-pet-action="mute"]')
    assert.ok(mute.hidden, 'mute stays hidden while idle')
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected" })', h.context))
    const buttons = [badge, mute, pet.querySelector('[data-talk-pet-chat]'), ...['transcript'].map(action => pet.querySelector(`[data-talk-pet-action="${action}"]`))]
    for (const button of [badge, mute]) {
      assert.equal(button.style.width, '36px')
      assert.equal(button.style.height, '36px')
      assert.equal(button.style.boxSizing, 'border-box')
      assert.equal(button.style.left, '110px')
      assert.equal(button.style.right, 'auto')
      assert.equal(button.style.pointerEvents, 'auto')
      assert.equal(button.style.overflow, 'visible', 'mirrored loading ring must not clip')
    }
    assert.equal(badge.style.bottom, '0px')
    assert.equal(mute.style.bottom, '42px', 'mute is ABOVE main mic with a 6px gap')
    const rects = buttons.map(button => ({ x: Number.parseFloat(button.style.left), y: Number.parseFloat(button.style.bottom), w: Number.parseFloat(button.style.width), h: Number.parseFloat(button.style.height) }))
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i]
      assert.ok(a.x >= 110 && a.y >= 0 && a.y + a.h <= 120, 'controls are RIGHT beyond full canvas bounds')
      for (const b of rects.slice(i + 1)) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'control hit targets must not overlap')
    }
    await h.flush(() => vm.runInContext('bus.set({ muted: true, stage: "disconnected" })', h.context))
    assert.ok(!mute.hidden && mute.style.display !== 'none', 'mute stays visible while muted/reconnecting')
    assert.equal(mute.style.bottom, '42px')
    await h.flush(() => vm.runInContext('bus.set({ live: false, stage: "idle", muted: false })', h.context))
    assert.ok(mute.hidden, 'ending the call hides mute')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('pet mic and mute keep opaque theme contrast independently of composer styling', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const badge = pet.querySelector('[data-talk-pet-mic]')
    const mute = pet.querySelector('[data-talk-pet-action="mute"]')
    const original = h.w.document.querySelector('[data-talk-live-toggle]')
    const assertSurface = button => {
      assert.equal(button.style.background, 'var(--popover-surface)')
      assert.equal(button.style.opacity, '1')
      assert.equal(button.style.borderWidth, '2px')
      assert.equal(button.style.borderRadius, '50%')
      assert.match(button.style.borderColor, /var\(--(ui-stroke-secondary|ui-accent)\)/)
      assert.match(button.style.boxShadow, /0 3px 10px var\(--ui-stroke-secondary\)/)
      assert.match(button.style.color, /var\(--/)
    }
    assertSurface(badge)
    const idleBorder = badge.style.borderColor
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected" })', h.context))
    assertSurface(badge); assertSurface(mute)
    assert.notEqual(badge.style.borderColor, idleBorder, 'live mic has an accent outline')
    const unmutedShadow = mute.style.boxShadow
    await h.flush(() => vm.runInContext('bus.set({ muted: true })', h.context))
    assertSurface(badge); assertSurface(mute)
    assert.notEqual(mute.style.boxShadow, unmutedShadow, 'muted control is persistently highlighted')
    assert.match(mute.style.boxShadow, /inset/)
    const sharedGlow = badge.style.boxShadow
    await h.flush(() => {
      original.style.background = 'transparent'
      original.style.opacity = '.2'
      original.style.width = '28px'
      original.style.boxShadow = '0 0 7px var(--ui-accent)'
      const originalMute = h.w.document.querySelector('[data-talk-live-mute]')
      originalMute.style.background = 'transparent'
      originalMute.style.opacity = '.2'
      originalMute.style.width = '22px'
    })
    assertSurface(badge); assertSurface(mute)
    assert.equal(badge.style.width, '36px'); assert.equal(mute.style.width, '36px')
    assert.equal(mute.style.bottom, '42px')
    assert.equal(badge.style.boxShadow, sharedGlow, 'composer mutations cannot overwrite shared pet styling')
    await h.flush(() => mute.dispatchEvent(new h.w.MouseEvent('mouseover', { bubbles: true })))
    assertSurface(mute)
    assert.equal(mute.getAttribute('aria-pressed'), 'true')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('badge renders shared live bands and hover hangup independently of the composer', async () => {
  const h = await setup()
  try {
    h.pet(); await h.flush()
    const badge = h.w.document.querySelector('[data-talk-pet-mic]')
    const source = h.w.document.querySelector('[data-talk-live-toggle]')
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected", bands: [1,.7,.5,.8,1], micLevel: .8 })', h.context))
    await React.act(async () => { await new Promise(r => setTimeout(r, 100)) })
    assert.deepEqual([...badge.querySelectorAll('i')].map(b=>b.style.height), ['10px','7px','5px','8px','10px'])
    const firstBar = badge.querySelector('i')
    await h.flush(() => vm.runInContext('bus.set({bands:[.3,.5,.9,.5,.3]})', h.context))
    assert.equal(badge.querySelector('i'), firstBar, 'meter updates must retain DOM nodes so transitions can animate')
    assert.equal(firstBar.style.height, '3px')
    assert.ok(badge.style.boxShadow.endsWith(source.style.boxShadow), 'pet elevation must preserve the original live animation glow')
    await h.flush(() => badge.dispatchEvent(new h.w.MouseEvent('mouseover', { bubbles: true })))
    assert.ok(badge.querySelector('svg[style*="133deg"]'), 'hover shows actual hangup icon')
    assert.equal(source.querySelector('svg'), null, 'pet hover cannot modify composer state')
    await h.flush(() => badge.dispatchEvent(new h.w.MouseEvent('mouseout', { bubbles: true })))
    assert.equal(badge.querySelector('svg'), null, 'leaving restores waveform')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('separate pet mute button toggles the owned session without hangup or drag', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    let drags = 0; pet.addEventListener('pointerdown', () => drags++)
    const muteCode = source.slice(source.indexOf('  let mutedNow = false'), source.indexOf('\n  pc.onconnectionstatechange'))
    assert.ok(muteCode.includes('s.track.enabled = !mutedNow'), 'exercise the actual track mute implementation')
    await h.flush(() => h.focus('mute-runtime', 'mute-stored', 'default'))
    vm.runInContext('window.testTrack = { enabled: true, kind: "audio" }; window.testCloses = 0; const pc = { getSenders: () => [{ track: window.testTrack }] }; const ctl = { close() { window.testCloses++ } }; ' + muteCode + '; startLive = async () => { _liveRefs = { pc }; bus.set({ live: true, stage: "connected" }); return ctl }', h.context)
    await h.flush(() => { void h.companion().action({ action:'start' }) })
    const mute = pet.querySelector('[data-talk-pet-action="mute"]')
    assert.ok(mute, 'a distinct visible mute button must sit beside the badge')
    assert.equal(mute.title, 'Mute microphone')
    await h.flush(() => { mute.dispatchEvent(new h.w.Event('pointerdown', { bubbles: true })); mute.click() })
    assert.equal(h.w.testTrack.enabled, false)
    assert.equal(mute.title, 'Unmute microphone')
    assert.equal(mute.getAttribute('aria-label'), 'Unmute microphone')
    assert.equal(mute.getAttribute('aria-pressed'), 'true')
    assert.ok(mute.querySelector('line[x1="2"][x2="22"]'), 'muted mic-slash is persistent')
    assert.ok(!mute.hidden && !mute.parentElement.hidden)
    assert.equal(h.w.testCloses, 0); assert.equal(drags, 0)
    await h.flush(() => mute.dispatchEvent(new h.w.MouseEvent('mouseover', { bubbles: true })))
    await h.flush(() => vm.runInContext('bus.set({ spkBot: true, spkUser: true, micLevel: 1 }); doBargeIn(); maybeBarge()', h.context))
    assert.equal(h.w.testTrack.enabled, false, 'hover cannot unmute')
    await h.flush(() => vm.runInContext('bus.set({ stage: "disconnected" })', h.context))
    assert.ok(!mute.hidden && mute.style.display !== 'none', 'mute remains available while the session is live, even reconnecting')
    await h.flush(() => mute.click())
    assert.equal(h.w.testTrack.enabled, true); assert.equal(mute.title, 'Mute microphone')
    assert.equal(h.w.testCloses, 0)
    const originalMute = h.w.document.querySelector('[data-talk-live-mute]')
    await h.flush(() => pet.remove())
    assert.equal(originalMute.style.transform, 'scale(1)', 'pet removal clears forwarded companion hover')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('composer settings remain separate and composer transcript remains available with bot toggle', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    assert.equal(pet.querySelector('[data-talk-pet-action="gear"]'), null, 'pet settings button removed')
    const gear = h.w.document.querySelector('[data-talk-live-gear]')
    assert.ok(gear, 'composer settings remain available')
    await h.flush(() => gear.click())
    assert.equal(gear.getAttribute('aria-expanded'), 'true')
    assert.equal(h.w.document.querySelectorAll('[data-test-popover]').length, 1)
    assert.ok(h.w.document.body.textContent.includes('Voice engine'))
    assert.equal(pet.querySelector('[data-test-popover]'), null)
    await h.flush(() => gear.click())
    assert.equal(h.w.document.querySelectorAll('[data-test-popover]').length, 0)
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected" }); pushTranscript("user", "actual shared transcript")', h.context))
    const tr = h.w.document.querySelector('[data-talk-live-transcript]')
    assert.ok(tr, 'composer keeps transcript affordance')
    await h.flush(() => tr.click())
    assert.ok(h.w.document.body.textContent.includes('actual shared transcript'))
    assert.equal(pet.querySelector('[data-talk-pet-action="transcript"]'), null)
    assert.ok(pet.querySelector('[data-talk-pet-action="bots"]'))
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('composer disappearance leaves independent pet controls without observer errors', async () => {
  const h = await setup()
  const original = h.w.document.querySelector('[data-talk-live-toggle]')
  const group = original.parentElement
  try {
    const pet = h.pet(); await h.flush()
    const badge = pet.querySelector('[data-talk-pet-mic]')
    await h.flush(() => original.remove())
    assert.equal(badge.style.display, 'flex')
    assert.equal(h.errors.length, 0, 'detached source must not throw in the observer')
    await h.flush(() => group.prepend(original))
    assert.equal(badge.hidden, false)
    assert.equal(badge.querySelector('svg').getAttribute('width'), '15')
    assert.equal(pet.querySelectorAll('[data-talk-pet-mic]').length, 1)
    assert.equal(pet.querySelectorAll('[data-talk-pet-action]').length, 3)
  } finally { if (!original.isConnected) group.prepend(original); await h.cleanup() }
})

test('pending pet start has a rotating loading ring and can cancel the sole start owner', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const badge = pet.querySelector('[data-talk-pet-mic]')
    await h.flush(() => h.focus('voice-r', 'voice-s', 'coder'))
    vm.runInContext('startLive = () => { window.testStarts = (window.testStarts || 0) + 1; bus.set({ stage: "mint" }); return new Promise(resolve => { window.testConnect = () => { bus.set({ live: true, stage: "connected" }); resolve({ close() { window.testCloses=(window.testCloses||0)+1;bus.set({live:false,stage:"idle"}) } }) } }) }', h.context)
    await h.flush(() => badge.click())
    assert.equal(badge.dataset.voiceState, 'connecting')
    await React.act(async () => { await new Promise(r => setTimeout(r, 100)) })
    const spinner = badge.querySelector('.pet-spinner')
    assert.ok(spinner, 'loading uses the shared rotating ring')
    assert.match(h.w.document.querySelector('[data-talk-pet-style]').textContent, /pet-spin.*rotate\(360deg\)/)
    assert.equal(badge.dataset.action, 'stop'); assert.equal(badge.disabled, false)
    await h.flush(() => badge.click())
    assert.equal(h.w.testStarts, 1, 'pending click cannot launch another session')
    await h.flush(() => h.w.testConnect())
    assert.equal(badge.dataset.voiceState, 'disconnected'); assert.equal(h.w.testCloses, 1)
    assert.equal(badge.querySelector('.pet-spinner'), null)
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('reload remount leaves one badge and ignores nonfloating pet previews', async () => {
  const h = await setup()
  try {
    const preview = h.w.document.createElement('div')
    preview.innerHTML = '<div><canvas aria-label="Buddy pet"></canvas></div>'
    h.w.document.body.append(preview)
    await h.flush(); assert.equal(preview.querySelector('[data-talk-pet-mic]'), null)
    h.pet(); await h.flush()
    await React.act(async () => h.root.render(null))
    assert.equal(h.w.document.querySelectorAll('[data-talk-pet-mic]').length, 0)
    assert.equal(h.w.document.querySelectorAll('[data-talk-pet-action]').length, 0)
    await React.act(async () => h.root.render(jsx(React.StrictMode, { children: h.contributions.filter(c=>c.render).map(c => jsx(React.Fragment, { children: c.render() }, c.id)) })))
    await h.flush()
    assert.equal(h.w.document.querySelectorAll('[data-talk-pet-mic]').length, 1)
    await h.flush(() => h.focus('voice-r', 'voice-s', 'coder'))
    vm.runInContext('startLive = async () => { window.testStarts = (window.testStarts || 0) + 1; return { close() { window.testCloses = (window.testCloses || 0) + 1; bus.set({live:false, stage: "idle"}) } } }', h.context)
    await h.flush(() => h.w.document.querySelector('[data-talk-pet-mic]').click())
    assert.equal(h.w.testStarts, 1, 'pet click must start voice directly')
    assert.ok(!h.w.document.body.textContent.includes('Start Live Voice'), 'settings must stay closed')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('pet click starts and hangs up through the existing composer action without settings', async () => {
  const h = await setup()
  try {
    h.pet(); await h.flush()
    const badge = h.w.document.querySelector('[data-talk-pet-mic]')
    await h.flush(() => h.focus('voice-r', 'voice-s', 'coder'))
    vm.runInContext('startLive = async () => { window.testStarts = (window.testStarts || 0) + 1; return { close() { window.testCloses = (window.testCloses || 0) + 1; bus.set({live:false, stage: "idle"}) } } }', h.context)
    await h.flush(() => badge.click())
    assert.equal(h.w.testStarts, 1, 'pet click must invoke voice start')
    assert.ok(!h.w.document.body.textContent.includes('Start Live Voice'), 'settings stay closed')
    assert.equal(h.contributions.filter(c => c.area === 'composer.leading').length, 1)
    assert.ok(h.w.document.querySelector('button[title="Live Voice — click to talk"]'), 'composer fallback remains')
    let closes = 0
    h.w.__talkLiveHandle = { close: () => { closes++; vm.runInContext('bus.set({ live: false, stage: "idle", muted: false })', h.context) } }
    await h.flush(() => vm.runInContext('bus.set({ live: true, stage: "connected" })', h.context))
    await h.flush(() => badge.click())
    assert.equal(h.w.testCloses, 1, 'same pet button hangs up the controller-owned session')
    assert.equal(h.w.testStarts, 1, 'hangup must not start a second session')
    assert.ok(!h.w.document.body.textContent.includes('Start Live Voice'))
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('badge reports connection truth, muted icon and error details from shared bus', async () => {
  const h = await setup()
  try {
    h.pet(); await h.flush()
    const badge = h.w.document.querySelector('[data-talk-pet-mic]')
    for (const [patch, expected] of [
      [{ live: false, stage: 'idle', muted: false, err: '' }, 'disconnected'],
      [{ live: true, stage: 'mint' }, 'connecting'],
      [{ live: true, stage: 'offering' }, 'connecting'],
      [{ stage: 'connected' }, 'live'],
      [{ muted: true }, 'muted'],
      [{ stage: 'disconnected' }, 'connecting'],
      [{ live: false, stage: 'error', err: 'connection lost' }, 'disconnected']
    ]) {
      await h.flush(() => vm.runInContext(`bus.set(${JSON.stringify(patch)})`, h.context))
      assert.equal(badge.dataset.voiceState, expected)
      assert.match(badge.title, new RegExp(expected))
      assert.equal(badge.getAttribute('aria-label'), badge.title)
      if (expected === 'muted') assert.ok(h.w.document.querySelector('[data-talk-pet-action="mute"] line[x1="2"][x2="22"]'))
    }
    assert.match(badge.title, /connection lost/)
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('badge attaches to unmirrored floating pet and tracks remount without duplicates', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const badge = pet.querySelector('[data-talk-pet-mic]')
    assert.ok(badge, 'floating pet needs a mic badge')
    assert.equal(badge.parentElement, pet)
    assert.equal(badge.style.position, 'absolute')
    assert.equal(badge.style.left, '110px')
    assert.equal(badge.style.right, 'auto')
    pet.style.left = '300px'; pet.style.top = '240px'; pet.firstChild.style.transform = 'none'
    pet.querySelector('canvas').style.width = '180px'; await h.flush()
    assert.equal(badge.parentElement, pet)
    let drags = 0; pet.addEventListener('pointerdown', () => drags++)
    badge.dispatchEvent(new h.w.Event('pointerdown', { bubbles: true })); assert.equal(drags, 0)
    await h.flush(() => pet.remove())
    const next = h.pet(); await h.flush()
    assert.equal(h.w.document.querySelectorAll('[data-talk-pet-mic]').length, 1)
    assert.equal(next.querySelector('[data-talk-pet-mic]').parentElement, next)
    await React.act(async () => h.root.unmount())
    assert.equal(h.w.document.querySelectorAll('[data-talk-pet-mic]').length, 0)
    assert.equal(h.w.document.querySelectorAll('[data-talk-pet-action]').length, 0)
    h.pet(); await h.flush(); assert.equal(h.w.document.querySelectorAll('[data-talk-pet-mic]').length, 0)
  } finally { await h.cleanup() }
})

test('persistent owner survives composer and badge unmount with exact navigation and desired mute', async () => {
  const h = await setup()
  try {
    assert.ok(h.companion(), 'plugin registers a persistent companion owner')
    await h.flush(() => { h.focus('runtime-a', 'stored-a', 'owner-a'); h.state.busyBySession.set({ 'runtime-a': true }) })
    await React.act(async () => h.root.render(null))
    h.focus('runtime-b', 'stored-b', 'owner-b')
    await h.companion().action({ action: 'chat' })
    assert.deepEqual(JSON.parse(JSON.stringify(h.opened)), [{ id: 'stored-a', options: { profile: 'owner-a', intent: 'in-place', route: { connectionId: 'local', profile: 'owner-a', mode: 'local' } } }])
    h.emit('message.complete', { session_id: 'runtime-a', profile: 'owner-a', payload: {} })
    assert.equal(h.companion().snapshot().status, 'Finished')
    assert.equal(h.captures(), 0)
    assert.equal(h.companion().snapshot().capabilities.includes('start'), false, 'different foreground profile cannot start the captured owner')
  } finally { await h.cleanup() }
})
test('missing association cannot create or choose another session', async () => {
  const h = await setup()
  try {
    assert.ok(h.companion())
    assert.equal(h.companion().snapshot().capabilities.includes('start'), false)
    await assert.rejects(h.companion().action({ action: 'start' }))
    assert.equal(h.captures(), 0)
    assert.equal(h.opened.length, 0)
  } finally { await h.cleanup() }
})

const submitted = h => { const sent = []; h.host.request = async (method, body) => { sent.push({ method, body }) }; return sent }
const press = (h, el, key) => el.dispatchEvent(new h.w.KeyboardEvent('keydown', { key, bubbles: true }))
test('clicking the in-app bubble opens a reply field; Enter sends exactly the text to the pet chat', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const sent = submitted(h)
    await h.flush(() => h.focus('r', 's', 'coder'))
    const bubble = pet.querySelector('[data-talk-pet-status]')
    assert.equal(bubble.textContent, 'Reply to Hermes…')
    let drags = 0; pet.addEventListener('pointerdown', () => drags++)
    bubble.dispatchEvent(new h.w.Event('pointerdown', { bubbles: true }))
    await h.flush(() => bubble.click())
    assert.equal(drags, 0, 'clicking the bubble does not drag the pet')
    const input = bubble.querySelector('input[data-pet-reply]')
    assert.ok(input, 'bubble turned into a text field')
    await h.flush(() => h.state.busyBySession.set({ r: true }))
    assert.ok(bubble.querySelector('input[data-pet-reply]'), 'status updates never replace the field while typing')
    await h.flush(() => h.state.busyBySession.set({}))
    input.value = '  thanks, ship it  '
    await h.flush(() => press(h, input, 'Enter'))
    await h.flush()
    assert.equal(JSON.stringify(sent), JSON.stringify([{ method: 'prompt.submit', body: { session_id: 'r', text: 'thanks, ship it' } }]))
    assert.equal(bubble.querySelector('input'), null, 'field closes after sending')
    assert.equal(bubble.textContent, 'Working', 'bubble returns to showing status')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})
test('in-app reply: Escape and empty text send nothing; no chat explains instead of sending', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const sent = submitted(h)
    const bubble = pet.querySelector('[data-talk-pet-status]')
    await h.flush(() => h.focus('r', 's', 'coder'))
    await h.flush(() => bubble.click()); let input = bubble.querySelector('input')
    input.value = 'never mind'; await h.flush(() => press(h, input, 'Escape'))
    assert.equal(bubble.querySelector('input'), null); assert.equal(bubble.textContent, 'Reply to Hermes…')
    await h.flush(() => bubble.click()); input = bubble.querySelector('input')
    input.value = '   '; await h.flush(() => press(h, input, 'Enter'))
    assert.equal(sent.length, 0)
    await h.flush(() => h.focus('', '', ''))
    await h.flush(() => bubble.click()); input = bubble.querySelector('input')
    input.value = 'hello?'; await h.flush(() => press(h, input, 'Enter')); await h.flush()
    assert.equal(sent.length, 0, 'no chat, nothing sent')
    assert.equal(bubble.textContent, 'Open a chat first')
  } finally { await h.cleanup() }
})
test('in-app pet hides while popped out and returns when the pop-out closes', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    assert.equal(pet.style.visibility, '')
    await h.flush(() => { vm.runInContext("petCompanion.open = true; window.dispatchEvent(new CustomEvent('talk-desktop:companion'))", h.context) })
    for (const node of [pet, ...pet.querySelectorAll('*')]) {
      assert.equal(h.w.getComputedStyle(node).visibility, 'hidden', 'in-app sprite and controls hidden while popped out')
    }
    await h.flush(() => { vm.runInContext("petCompanion.open = false; window.dispatchEvent(new CustomEvent('talk-desktop:companion'))", h.context) })
    assert.equal(pet.style.visibility, '', 'restored when the pop-out closes')
    await h.flush(() => { vm.runInContext("petCompanion.open = true; window.dispatchEvent(new CustomEvent('talk-desktop:companion'))", h.context) })
    await React.act(async () => h.root.render(null))
    assert.equal(pet.style.visibility, '', 'unmounting the plugin never leaves the core pet hidden')
  } finally { await h.cleanup() }
})

