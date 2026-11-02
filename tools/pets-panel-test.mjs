// Status-bar Pets panel: pet sizes, saved settings, moved bot settings. No GTK, network or audio.
// Run with: TALK_TEST_DEPS=/path/to/isolated/node_modules node --test tools/pets-panel-test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
const require = createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const { JSDOM } = require('jsdom')
// react-dom decides at load time whether `input` events exist: give it a DOM first so sliders fire onChange.
const boot = new JSDOM('')
Object.assign(globalThis, { window: boot.window, document: boot.window.document })
const React = require('react')
const { jsx } = require('react/jsx-runtime')
const { createRoot } = require('react-dom/client')
const source = readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const shared = source.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
const wait = ms => new Promise(r => setTimeout(r, ms))

const NO_KEY = 'no OpenAI API key (set OPENAI_API_KEY or voice.gpt_live.api_key)'
async function setup({ store = {}, scale = 0.33, scaleReject = false, metaGate = null, desktopWindows = true, profile = 'default', connection = 'local', hostCapabilities = null, liveStatus = { ok: true, available: false, reason: NO_KEY, model: 'gpt-live-1', voice: 'marin' } } = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://hermes.test', pretendToBeVisual: true })
  const w = dom.window
  Object.assign(globalThis, { window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: async () => [], getUserMedia: async () => { throw Error('No capture allowed') } } })
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} })
  const atom = initial => { let value = initial; const listeners = new Set(); return { get: () => value, set: next => { value = next; for (const fn of listeners) fn(next) }, listen: fn => { listeners.add(fn); return () => listeners.delete(fn) } } }
  const state = { focusedSessionId: atom(''), focusedStoredSessionId: atom(''), focusedSessionProfile: atom(''), focusedSessionOwner: atom(null), busyBySession: atom({}), connectionId: atom(connection), profile: atom(profile) }
  // The viewer's own backend, reached through the app bridge (never through ctx.rest).
  if (hostCapabilities) w.hermesDesktop = { api: async request => request.path.endsWith('/companion/capabilities') ? hostCapabilities : {} }
  const info = { scale, enabled: true, slug: 'custom-pippa', pets: [{ slug: 'custom-pippa', installed: true }], gate: metaGate, rejectScale: scaleReject }, requests = []
  const events = new Map()
  const host = { state, openSession: async () => {}, onEvent: (type, fn) => { const handlers = events.get(type) || new Set(); events.set(type, handlers); handlers.add(fn); return () => handlers.delete(fn) }, notify: () => {},
    request: async (method, params) => {
      requests.push({ method, params })
      if (method === 'pet.info.meta') { if (info.gate) await info.gate; return { enabled: info.enabled, scale: info.scale } }
      if (method === 'pet.gallery') return { enabled: info.enabled, active: info.slug, pets: info.pets }
      if (method === 'pet.disable') { info.enabled = false; return { ok: true } }
      if (method === 'pet.select') { info.enabled = true; info.slug = params.slug; return { ok: true } }
      if (method === 'pet.scale') { if (info.rejectScale) throw Error('pet.scale refused'); info.scale = params.scale; return { ok: true, scale: params.scale } }
      if (method === 'profiles.list') return { profiles: [{ name: 'alpha', display_name: 'Alpha', canonical_session: { id: 'chat-a' } }] }
      return {}
    } }
  const pulses = []
  const rest = async (path, options = {}) => {
    if (path === '/companion/capabilities') return { desktopWindows, platform: 'linux', reason: '' }
    if (path === '/companion/claim') return { token: 't', generation: 'g' }
    if (path === '/companion/launch') return { running: true }
    if (path === '/companion/pulse') { pulses.push(options.body.state); return { generation: 'g', commands: [], helper: true } }
    if (path === '/companion/bots') return { bots: Object.fromEntries(options.body.bots.map(name => [name, {}])) }
    if (path === '/hermeslive/status') return liveStatus
    if (/session/.test(path)) throw Error('settings must never start a voice session')
    return {}
  }
  const PopoverContext = React.createContext(null), SelectContext = React.createContext(null)
  const passthrough = ({ children }) => jsx('div', { children })
  const sdk = { host, useValue: x => x?.get ? React.useSyncExternalStore(x.listen, x.get) : x,
    Dialog: ({ open, onOpenChange, children }) => jsx(PopoverContext.Provider, { value: { open, onOpenChange }, children }),
    DialogTitle: ({ children }) => jsx('h2', { children }),
    DialogContent: ({ children, ...props }) => React.useContext(PopoverContext).open ? require('react-dom').createPortal(jsx('section', { role: 'dialog', ...props, children }), w.document.body) : null,
    Popover: ({ open, onOpenChange, children }) => jsx(PopoverContext.Provider, { value: { open, onOpenChange }, children }),
    PopoverContent: ({ children, ...props }) => React.useContext(PopoverContext).open ? require('react-dom').createPortal(jsx('div', { 'data-test-popover': '', ...props, children }), w.document.body) : null,
    PopoverTrigger: ({ children }) => { const s = React.useContext(PopoverContext); return React.cloneElement(children, { 'aria-expanded': s.open, onClick: () => s.onOpenChange(!s.open) }) },
    Select: ({ value, onValueChange, children }) => jsx(SelectContext.Provider, { value: { value, onValueChange }, children: jsx('div', { 'data-select-value': value, children }) }),
    SelectItem: ({ value, disabled, children }) => { const s = React.useContext(SelectContext); return jsx('button', { 'data-select-item': value, disabled, onClick: () => s.onValueChange(value), children }) },
    SelectContent: passthrough, SelectTrigger: ({ children, ...props }) => jsx('div', { ...props, children }), SelectValue: () => null,
    Switch: ({ checked, onCheckedChange, ...props }) => jsx('button', { ...props, role: 'switch', 'aria-checked': checked, onClick: () => onCheckedChange(!checked) }),
    Button: ({ children, onClick, disabled }) => jsx('button', { onClick, disabled, children }) }
  const context = vm.createContext({ window: w, document: w.document, navigator: w.navigator, MutationObserver: w.MutationObserver, CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, Image: w.Image, Event: w.Event, jsx, jsxs: jsx, sdk,
    useState: React.useState, useEffect: React.useEffect, useRef: React.useRef,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w), performance: w.performance,
    setInterval, clearInterval, setTimeout, clearTimeout, console })
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'globalThis.plugin = {').replace(/^export (?=(?:async )?function |const |let |class )/gm, ''), context)
  const contributions = [], disposers = [], storage = new Map(Object.entries(store))
  const ctx = { onDispose: fn => disposers.push(fn), register: c => contributions.push(c), storage: { get: k => storage.get(k), set: (k, v) => storage.set(k, v) }, rest, pet: { say: () => () => {}, clear: () => {} } }
  context.plugin.register(ctx)
  const root = createRoot(w.document.getElementById('root'))
  const panel = contributions.find(c => c.id === 'pets-panel')
  await React.act(async () => root.render(panel ? panel.render() : null))
  const flush = async (fn, ms = 0) => React.act(async () => { await fn?.(); await wait(ms) })
  const run = code => vm.runInContext(code, context)
  const $ = selector => w.document.querySelector(selector)
  const slide = (el, value) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(el, String(value)); el.dispatchEvent(new w.Event('input', { bubbles: true })) }
  return { w, run, $, slide, flush, root, ctx, context, contributions, panel, storage, requests, info, state, pulses,
    emit: (type, payload = {}) => flush(() => { for (const fn of events.get(type) || []) fn(payload) }),
    botsOn: () => flush(async () => { run('botTracker.setEnabled(true)'); await run('petCompanion.syncBots()') }, 40),
    button: text => [...w.document.querySelectorAll('button')].find(b => b.textContent === text),
    open: () => flush(() => $('[data-talk-pets]').click(), 10),
    cleanup: async () => { await React.act(async () => { root.unmount(); disposers.splice(0).forEach(fn => fn()) }); w.close() } }
}

test('Show Hermes pet uses the Settings actions and restores the saved pet without changing bots or voice', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    await h.botsOn(); await h.open()
    assert.ok(!!control(), 'an on/off shortcut is present inside the existing Pets panel')
    assert.equal(control().getAttribute('aria-checked'), 'true')
    await h.flush(() => control().click(), 20)
    assert.equal(control().getAttribute('aria-checked'), 'false')
    assert.equal(!!h.$('[aria-label="Pet size"]'), false)
    assert.equal(h.info.slug, 'custom-pippa', 'Off preserves the selected artwork')
    await h.flush(() => control().click(), 20)
    assert.equal(control().getAttribute('aria-checked'), 'true')
    assert.equal(h.run('botTracker.enabled()'), true, 'bot-pet visibility is independent')
    const changes = h.requests.filter(r => ['pet.disable', 'pet.select', 'pet.gallery'].includes(r.method))
    assert.deepEqual(changes.map(r => [r.method, JSON.parse(JSON.stringify(r.params))]), [
      ['pet.disable', { profile: 'default' }],
      ['pet.gallery', { profile: 'default', localOnly: true }],
      ['pet.select', { profile: 'default', slug: 'custom-pippa' }]
    ])
    for (const change of changes.filter(r => r.method !== 'pet.gallery')) {
      assert.equal(h.requests[h.requests.indexOf(change) + 1]?.method, 'pet.info.meta', 'each write is read back')
    }
    assert.equal(h.storage.has('petEnabled.v1'), false, 'no second stored on/off preference')
    assert.equal(h.storage.has('engine.v1'), false, 'no voice setting changes')
  } finally { await h.cleanup() }
})

test('Show Hermes pet follows Settings changes while open by reading the owner, not trusting an event payload', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    await h.open()
    h.info.enabled = false
    await h.emit('pet.changed', { enabled: true, profile: 'unrelated', connectionId: 'remote-other' })
    assert.equal(control().getAttribute('aria-checked'), 'false', 'refresh the real owner state instead of copying untrusted event metadata')
    h.info.enabled = true
    await h.emit('pet.changed', { enabled: false })
    assert.equal(control().getAttribute('aria-checked'), 'true')
    assert.ok(h.requests.filter(r => r.method === 'pet.info.meta').every(r => r.params.profile === 'default'))
    assert.equal(h.requests.some(r => ['pet.select', 'pet.disable'].includes(r.method)), false, 'refresh never writes')
  } finally { await h.cleanup() }
})

test('Show Hermes pet cancels a pending enable when the route leaves and returns, and can retry', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    h.info.enabled = false; await h.open()
    const host = h.run('host'), request = host.request
    let release
    host.request = (method, params) => method === 'pet.gallery' ? new Promise(resolve => { release = resolve }) : request(method, params)
    await h.flush(() => { control().click(); control().click() })
    assert.equal(control().disabled, true, 'a pending action disables repeat clicks')
    await h.flush(() => { h.state.profile.set('alpha'); h.state.profile.set('default') })
    await h.flush(() => release({ active: 'custom-pippa', pets: [{ slug: 'custom-pippa', installed: true }] }))
    assert.equal(h.requests.some(r => r.method === 'pet.select'), false, 'no write after an interrupted route, even on an immediate return')
    assert.equal(control().disabled, false, 'route invalidation must release the pending control')
    host.request = request
    await h.flush(() => control().click())
    assert.equal(control().getAttribute('aria-checked'), 'true', 'a fresh explicit click works')
  } finally { await h.cleanup() }
})

test('Show Hermes pet keeps its confirmed state after a refusal, reports it and allows retry', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    await h.open()
    const host = h.run('host'), request = host.request
    host.request = (method, params) => method === 'pet.disable' ? Promise.reject(Error('private backend detail')) : request(method, params)
    await h.flush(() => control().click())
    assert.equal(control().getAttribute('aria-checked'), 'true', 'a refusal never pretends to be off')
    assert.equal(control().disabled, false)
    assert.match(h.$('[role="alert"]').textContent, /Couldn't change the Hermes pet/)
    assert.equal(h.w.document.body.textContent.includes('private backend detail'), false)
    host.request = request
    await h.flush(() => control().click())
    assert.equal(control().getAttribute('aria-checked'), 'false')
    assert.equal(!!h.$('[role="alert"]'), false)
  } finally { await h.cleanup() }
})

for (const enabled of [true, false]) for (const failure of ['rejected', 'malformed']) {
  test(`Show Hermes pet invalidates accepted ${enabled ? 'disable' : 'enable'} before a ${failure} readback`, async () => {
    const h = await setup()
    const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
    try {
      h.info.enabled = enabled; await h.open()
      const host = h.run('host'), request = host.request
      let settle
      host.request = (method, params) => method === 'pet.info.meta'
        ? new Promise((resolve, reject) => { settle = () => failure === 'rejected' ? reject(Error('offline')) : resolve({ enabled: 'unknown' }) })
        : request(method, params)
      await h.flush(() => control().click())
      assert.equal(typeof settle, 'function', 'the accepted write reaches readback')
      assert.equal(h.info.enabled, !enabled, 'the host changed without emitting pet.changed')
      assert.equal(control().disabled, true, 'readback is still pending')
      const pendingChecked = control().getAttribute('aria-checked')
      await h.flush(() => settle())
      assert.equal(control().disabled, true, 'failed readback must not re-enable a stale switch')
      assert.equal(pendingChecked, 'false', 'acceptance invalidates the old state before readback settles')
      assert.equal(control().getAttribute('aria-checked'), 'false', 'unknown state is not shown as confirmed On')
      assert.match(h.$('[role="alert"]').textContent, /Couldn't change the Hermes pet/)
      const writes = () => h.requests.filter(r => ['pet.disable', 'pet.select'].includes(r.method)).length
      const count = writes()
      await h.flush(() => control().click())
      assert.equal(writes(), count, 'unknown state cannot issue another write')
      host.request = request
      await h.open(); await h.open()
      assert.equal(control().disabled, false, 'a fresh valid readback restores the control')
      assert.equal(control().getAttribute('aria-checked'), String(!enabled))
      assert.equal(!!h.$('[role="alert"]'), false)
    } finally { await h.cleanup() }
  })
}

for (const enabled of [true, false]) {
  test(`Show Hermes pet retains confirmed ${enabled ? 'On' : 'Off'} when the write acknowledgement refuses it`, async () => {
    const h = await setup()
    const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
    try {
      h.info.enabled = enabled; await h.open()
      const host = h.run('host'), request = host.request
      const reads = h.requests.filter(r => r.method === 'pet.info.meta').length
      host.request = (method, params) => method === (enabled ? 'pet.disable' : 'pet.select') ? Promise.resolve({ ok: false }) : request(method, params)
      await h.flush(() => control().click())
      assert.equal(h.info.enabled, enabled)
      assert.equal(control().getAttribute('aria-checked'), String(enabled), 'a refused write leaves the confirmed state intact')
      assert.equal(control().disabled, false, 'a refused write remains retryable')
      assert.equal(h.requests.filter(r => r.method === 'pet.info.meta').length, reads, 'a refusal never reaches readback')
      assert.match(h.$('[role="alert"]').textContent, /Couldn't change the Hermes pet/)
      host.request = request
      await h.flush(() => control().click())
      assert.equal(control().getAttribute('aria-checked'), String(!enabled))
    } finally { await h.cleanup() }
  })
}

for (const boundary of ['gallery', 'readback']) for (const teardown of ['close', 'unmount']) {
  test(`Show Hermes pet ignores a pending ${boundary} after ${teardown}`, async () => {
    const h = await setup()
    const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
    try {
      h.info.enabled = boundary === 'readback'; await h.open()
      const host = h.run('host'), request = host.request
      let settle
      host.request = (method, params) => method === (boundary === 'gallery' ? 'pet.gallery' : 'pet.info.meta')
        ? new Promise(resolve => { settle = resolve }) : request(method, params)
      await h.flush(() => control().click())
      assert.equal(typeof settle, 'function', 'the action is pending at the intended boundary')
      assert.equal(control().disabled, true)
      if (teardown === 'close') await h.open()
      else await h.flush(() => h.root.render(null))
      assert.equal(!!control(), false)
      host.request = request
      if (teardown === 'unmount') await h.flush(() => h.root.render(h.panel.render()))
      await h.open()
      assert.equal(control().disabled, false, 'a fresh panel reads the host and releases the pending control')
      assert.equal(control().getAttribute('aria-checked'), 'false')
      await h.flush(() => settle(boundary === 'gallery'
        ? { active: 'custom-pippa', pets: [{ slug: 'custom-pippa', installed: true }] }
        : { enabled: true }))
      assert.equal(h.requests.some(r => r.method === 'pet.select'), false, 'a late gallery never enables the pet')
      assert.equal(control().getAttribute('aria-checked'), 'false', 'a late readback never overwrites the fresh state')
      assert.equal(control().disabled, false)
      assert.equal(!!h.$('[role="alert"]'), false)
    } finally { await h.cleanup() }
  })
}

test('Show Hermes pet reads the latest selected artwork on enable and never downloads a missing pet', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    h.info.enabled = false; await h.open()
    h.info.slug = 'new-pet'; h.info.pets.push({ slug: 'new-pet', installed: true })
    await h.flush(() => control().click())
    assert.equal(h.requests.find(r => r.method === 'pet.select').params.slug, 'new-pet')
    await h.flush(() => control().click())
    h.info.slug = 'missing-pet'
    const count = h.requests.filter(r => r.method === 'pet.select').length
    await h.flush(() => control().click())
    assert.equal(h.requests.filter(r => r.method === 'pet.select').length, count, 'no implicit install or fallback to different artwork')
    assert.equal(control().getAttribute('aria-checked'), 'false')
    assert.match(h.$('[role="alert"]').textContent, /Choose an installed pet/)
    h.info.slug = ''; h.info.pets = []
    await h.flush(() => control().click())
    assert.equal(h.requests.filter(r => r.method === 'pet.select').length, count, 'an empty installation also stays off')
    h.info.pets = [{ slug: 'first-local', installed: true }]
    await h.flush(() => control().click())
    assert.equal(h.requests.filter(r => r.method === 'pet.select').at(-1).params.slug, 'first-local', 'first installed pet only when no saved choice exists')
  } finally { await h.cleanup() }
})

test('Show Hermes pet rejects unconfirmed writes and stays available when all pets are off', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    h.info.enabled = false; await h.open()
    assert.equal(control().disabled, false, 'turning on is still reachable with no visible pets')
    const host = h.run('host'), request = host.request
    host.request = (method, params) => method === 'pet.select' ? Promise.resolve({ ok: true }) : request(method, params)
    await h.flush(() => control().click())
    assert.equal(control().getAttribute('aria-checked'), 'false', 'a successful acknowledgement is not a readback')
    assert.match(h.$('[role="alert"]').textContent, /Couldn't change the Hermes pet/)
    await h.flush(() => h.state.connectionId.set('remote-other'))
    assert.equal(control().disabled, true, 'same profile name on another backend is not the owner')
    await h.flush(() => control().click())
    assert.ok(h.requests.filter(r => r.method === 'pet.select').every(r => r.params.profile === 'default'))
  } finally { await h.cleanup() }
})

test('Show Hermes pet does not keep showing a stale value if the opening read fails', async () => {
  const h = await setup()
  const control = () => h.$('[role="switch"][aria-label="Show Hermes pet"]')
  try {
    await h.open(); await h.open()
    const host = h.run('host'), request = host.request
    host.request = (method, params) => method === 'pet.info.meta' ? Promise.reject(Error('offline')) : request(method, params)
    await h.open()
    assert.equal(control().disabled, true, 'unknown state cannot be toggled from an old closure')
    assert.match(h.$('[role="alert"]').textContent, /Couldn't read the Hermes pet/)
    host.request = request
    await h.open(); await h.open()
    assert.equal(control().disabled, false)
    assert.equal(!!h.$('[role="alert"]'), false)
  } finally { await h.cleanup() }
})

test('Show Hermes pet cannot write through an unknown backend connection', async () => {
  const h = await setup({ connection: '' })
  try {
    await h.open()
    const control = h.$('[role="switch"][aria-label="Show Hermes pet"]')
    assert.equal(control.disabled, true, 'unknown connection is not proof of the owner route')
    await h.flush(() => control.click())
    assert.equal(h.requests.some(r => ['pet.select', 'pet.disable'].includes(r.method)), false)
  } finally { await h.cleanup() }
})

test('Pets panel sits in the status bar, shows both sizes, applies live, saves and resets to 100%', async () => {
  const h = await setup({ store: { 'botSize.v1': '80' } })
  try {
    assert.equal(h.panel?.area, 'statusBar.right')
    const chip = () => h.$('[data-talk-pets]')
    assert.equal(chip().textContent, '🐾 Pets & voice', 'the chip says what it opens')
    assert.match(chip().getAttribute('title'), /pet 100%, bot pets 80%/, 'the sizes stay in the tooltip')
    assert.equal(chip().getAttribute('aria-label'), 'Pets & voice', 'the chip has an accessible name')
    await h.botsOn(); await h.open()
    assert.match(h.$('[data-test-popover]').textContent, /^Pets/)
    const pet = h.$('[aria-label="Pet size"]'), bots = h.$('[aria-label="Bot pets (all) size"]')
    assert.deepEqual([pet.min, pet.max, pet.step, pet.value, bots.value], ['50', '200', '5', '100', '80'])
    assert.match(h.$('[data-test-popover]').textContent, /Saved · applies live/)
    await h.flush(() => h.slide(bots, 150))
    assert.equal(h.$('[data-talk-pets]').textContent, '🐾 Pets & voice')
    assert.match(h.$('[data-talk-pets]').getAttribute('title'), /bot pets 150%/, 'applies while dragging')
    assert.equal(h.run('liveController.snapshot().botSize'), 150)
    assert.equal(h.storage.get('botSize.v1'), '80', 'saving is debounced')
    await h.flush(null, 260)
    assert.equal(h.storage.get('botSize.v1'), '150')
    await h.flush(() => [...h.w.document.querySelectorAll('button')].find(b => b.textContent === 'Reset').click(), 260)
    assert.equal(h.$('[data-talk-pets]').textContent, '🐾 Pets & voice')
    assert.match(h.$('[data-talk-pets]').getAttribute('title'), /pet 100%, bot pets 100%/)
    assert.deepEqual([h.storage.get('petSize.v1'), h.storage.get('botSize.v1')], ['100', '100'])
    assert.equal(h.run('liveController.snapshot().petSize'), 100)
  } finally { await h.cleanup() }
})

test('main pet slider reads the current Hermes scale, sends pet.scale once per drag, and clamps to 50-200%', async () => {
  const h = await setup({ scale: 0.495 })
  try {
    await h.open()
    assert.equal(h.$('[aria-label="Pet size"]').value, '150', 'an Alt+scroll change shows when the panel opens')
    await h.flush(() => { h.slide(h.$('[aria-label="Pet size"]'), 120); h.slide(h.$('[aria-label="Pet size"]'), 130) }, 260)
    const sent = () => h.requests.filter(r => r.method === 'pet.scale').map(r => r.params.scale)
    assert.deepEqual(sent(), [0.429], '100% = 0.33, debounced to one call')
    await h.flush(() => h.run('setPetSize("pet", 500)'), 260)
    await h.flush(() => h.run('setPetSize("pet", 10)'), 260)
    assert.deepEqual(sent(), [0.429, 0.66, 0.165])
    assert.equal(h.storage.get('petSize.v1'), '50')
  } finally { await h.cleanup() }
})

test('the Pet slider belongs to the owner route: never shown or sent on another profile or backend', async () => {
  const h = await setup({ store: { 'petSize.v1': '120' }, scale: 0.396 })
  const pet = () => h.$('[aria-label="Pet size"]'), sent = () => h.requests.filter(r => r.method === 'pet.scale')
  const startReads = h.requests.filter(r => r.method === 'pet.info.meta').length
  try {
    await h.flush(() => h.state.profile.set('alpha'))
    await h.open()
    // Booleans only: a failing assert on a JSDOM node inspects the whole DOM and exhausts memory.
    assert.equal(!!pet(), false, 'Hermes sits on another bot profile')
    assert.match(h.$('[data-test-popover]').textContent, /Pet size applies on the default profile/)
    assert.deepEqual(sent(), [], 'no write on another profile')
    assert.equal(h.requests.filter(r => r.method === 'pet.info.meta').length, startReads, 'no read on another profile')
    await h.flush(() => h.state.profile.set('default'), 20)
    assert.equal(pet()?.value, '120', 'back on the owner profile, re-read from Hermes')
    assert.equal(h.storage.get('petSize.v1'), '120')
    await h.flush(() => { h.slide(pet(), 150); h.state.connectionId.set('remote-other') }, 260)
    assert.deepEqual(sent(), [], 'a same-named profile on another backend is not the owner')
    assert.equal(!!pet(), false, 'no Pet slider on another backend')
  } finally { await h.cleanup() }
})

test('the main pet size is read at plugin start, so the pop-out is not stale before the panel is opened', async () => {
  const h = await setup({ store: { 'petSize.v1': '100' }, scale: 0.495 })
  try {
    assert.equal(h.run('petSizes.pet'), 150, 'start reads Hermes\u2019 real scale')
    assert.equal(h.run('petSizeConfirmed'), 150)
    assert.deepEqual(h.requests.filter(r => r.method === 'pet.scale'), [], 'a read never writes')
    await h.flush(null, 260)
    assert.equal(h.storage.get('petSize.v1'), '150', 'the read size is the stored one')
  } finally { await h.cleanup() }
})

test('a slider move during the start read wins over the stale answer', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = await setup({ metaGate: gate, scale: 0.495 })
  try {
    await h.flush(() => h.run('setPetSize("pet", 120)'), 260)
    await h.flush(() => release(), 20)
    assert.equal(h.run('petSizes.pet'), 120, 'the newer drag is not overwritten by the slow read')
    assert.equal(h.storage.get('petSize.v1'), '120')
  } finally { await h.cleanup() }
})

test('a refused main-pet resize is not called saved: the panel says so and the slider returns to the confirmed size', async () => {
  const h = await setup({ store: { 'petSize.v1': '100' }, scaleReject: true })
  try {
    await h.open()
    const pet = () => h.$('[aria-label="Pet size"]')
    assert.equal(pet().value, '100')
    await h.flush(() => h.slide(pet(), 150), 300)
    assert.match(h.$('[data-test-popover]').textContent, /Couldn't resize the main pet \u2014 try again/)
    assert.equal(h.$('[aria-label="Pet size"]').value, '100', 'the slider shows the last confirmed size')
    assert.equal(h.run('petSizes.pet'), 100)
    assert.equal(h.storage.get('petSize.v1'), '100', 'a refused size is never saved')
    assert.ok(!h.$('[data-test-popover]').textContent.includes('Saved'), 'no success wording after a refusal')
    h.info.rejectScale = false
    await h.flush(() => h.slide(h.$('[aria-label="Pet size"]'), 120), 300)
    assert.equal(h.$('[aria-label="Pet size"]').value, '120')
    assert.match(h.$('[data-test-popover]').textContent, /Saved · applies live/, 'a later success clears the error')
    assert.equal(h.storage.get('petSize.v1'), '120')
  } finally { await h.cleanup() }
})

test('an older refused resize never undoes a newer resize Hermes accepts', async () => {
  const h = await setup({ store: { 'petSize.v1': '100' }, scale: 0.33 })
  try {
    await h.open()
    const host = h.run('host'), original = host.request, pending = []
    host.request = (method, params) => method === 'pet.scale'
      ? new Promise((resolve, reject) => pending.push({ params, resolve, reject }))
      : original(method, params)
    const pet = () => h.$('[aria-label="Pet size"]')
    await h.flush(() => h.slide(pet(), 150), 260)
    await h.flush(() => h.slide(pet(), 120), 260)
    assert.deepEqual(pending.map(p => p.params.scale), [0.495, 0.396], 'one write per drag, both in flight')
    await h.flush(() => pending[0].reject(Error('first resize refused')), 20)
    assert.equal(pet().value, '120', 'the older failure does not roll back the newer intended size')
    assert.equal(h.run('petSizeError'), '', 'an older failure settles silently while a newer write is in flight')
    h.info.scale = pending[1].params.scale
    await h.flush(() => pending[1].resolve({ ok: true, scale: h.info.scale }), 260)
    assert.equal(pet().value, '120', 'the slider shows the accepted size')
    assert.equal(h.run('petSizes.pet'), 120)
    assert.equal(h.run('petSizeConfirmed'), 120)
    assert.equal(h.run('liveController.snapshot().petSize'), 120, 'the pop-out follows the accepted size')
    assert.equal(h.storage.get('petSize.v1'), '120', 'the accepted size is the stored one')
    assert.ok(!h.$('[data-test-popover]').textContent.includes('Couldn\'t resize'), 'no error after the newer write succeeded')
    assert.match(h.$('[data-test-popover]').textContent, /Saved · applies live/)
  } finally { await h.cleanup() }
})

test('a late answer from an older accepted resize never confirms over the newer one', async () => {
  const h = await setup({ store: { 'petSize.v1': '100' }, scale: 0.33 })
  try {
    await h.open()
    const host = h.run('host'), original = host.request, pending = []
    host.request = (method, params) => method === 'pet.scale'
      ? new Promise((resolve, reject) => pending.push({ params, resolve, reject }))
      : original(method, params)
    const pet = () => h.$('[aria-label="Pet size"]')
    await h.flush(() => h.slide(pet(), 150), 260)
    await h.flush(() => h.slide(pet(), 120), 260)
    await h.flush(() => pending[1].resolve({ ok: true, scale: pending[1].params.scale }), 20)
    await h.flush(() => pending[0].resolve({ ok: true, scale: pending[0].params.scale }), 20)
    assert.equal(pet().value, '120', 'the newest accepted size stays shown')
    assert.equal(h.run('petSizes.pet'), 120)
    assert.equal(h.run('petSizeConfirmed'), 120, 'a late older answer cannot become the confirmed size')
    assert.equal(h.storage.get('petSize.v1'), '120')
  } finally { await h.cleanup() }
})

test('a slow opening read never undoes a newer slider move', async () => {
  const h = await setup()
  try {
    let release
    h.info.gate = new Promise(resolve => { release = resolve })
    await h.open()
    await h.flush(() => h.slide(h.$('[aria-label="Pet size"]'), 150))
    await h.flush(() => release(), 260)
    assert.equal(h.$('[aria-label="Pet size"]').value, '150')
    assert.equal(h.storage.get('petSize.v1'), '150')
    assert.deepEqual(h.requests.filter(r => r.method === 'pet.scale').map(r => r.params.scale), [0.495])
  } finally { await h.cleanup() }
})

test('size sliders show only for pets that are out; the other settings stay reachable', async () => {
  const h = await setup({ desktopWindows: false, store: { 'botSize.v1': '80' } })
  const pet = () => h.$('[aria-label="Pet size"]'), bots = () => h.$('[aria-label="Bot pets (all) size"]')
  const reopen = async () => { await h.open(); await h.open() }
  try {
    h.info.enabled = false
    await h.open()
    assert.deepEqual([!!pet(), !!bots(), !!h.button('Reset')], [false, false, false], 'no pets: no size controls')
    assert.ok(h.$('[aria-label="Where bot pets appear"]'), 'the other settings stay')
    assert.match(h.$('[data-test-popover]').textContent, /Sizes show here while a pet is out/)
    h.info.enabled = true; await reopen()
    assert.deepEqual([!!pet(), !!bots()], [true, false], 'main pet only')
    h.info.enabled = false; await h.botsOn(); await reopen()
    assert.deepEqual([!!pet(), !!bots()], [false, true], 'bot pets only')
    await h.flush(() => h.button('Reset').click(), 260)
    assert.equal(h.storage.get('botSize.v1'), '100')
    assert.deepEqual(h.requests.filter(r => r.method === 'pet.scale'), [], 'Reset leaves the hidden main size alone')
  } finally { await h.cleanup() }
})

test('in-app bot pets scale their whole box and keep at least 40 px of the pet on screen', async () => {
  for (const size of [50, 100, 200]) {
    const h = await setup({ desktopWindows: false, store: { 'botSize.v1': String(size) } })
    try {
      await h.flush(async () => { h.run('botTracker.setEnabled(true)'); await h.run('petCompanion.syncBots()') }, 30)
      const box = h.$('[data-talk-bot]'), f = size / 100
      assert.equal(box.style.transform, `scale(${f})`)
      for (const [x, y] of [[-5000, -5000], [5000, 5000]]) {
        const avatar = box.querySelector('[data-bot-part=avatar]')
        const at = (type, cx, cy) => { const e = new h.w.Event(type); Object.assign(e, { button: 0, pointerId: 1, clientX: cx, clientY: cy }); avatar.dispatchEvent(e) }
        await h.flush(() => { at('pointerdown', 0, 0); at('pointermove', x, y); at('pointerup', x, y) })
        const left = parseFloat(box.style.left), top = parseFloat(box.style.top)
        const pet = { left: left + 90 * f, right: left + 186 * f, top: top + 90 * f, bottom: top + 194 * f }
        assert.ok(Math.min(pet.right, h.w.innerWidth) - Math.max(pet.left, 0) >= 40, `${size}% x ${x}`)
        assert.ok(Math.min(pet.bottom, h.w.innerHeight) - Math.max(pet.top, 0) >= 40, `${size}% y ${y}`)
      }
    } finally { await h.cleanup() }
  }
})

test('pop-out pet follows the main pet size and its pet, rail and bubble fit the resized window', () => {
  // Window sizes from companion/native_platform.py scaled_window (tests/test_native_platform.py checks them).
  for (const [size, width, height] of [[50, 307, 237], [100, 384, 320], [200, 538, 486]]) {
    const dom = new JSDOM('<body><canvas id="pet"></canvas><div id="status"></div><button id="close"></button></body>', { runScripts: 'outside-only', pretendToBeVisual: true })
    const w = dom.window, posted = []
    try {
      Object.defineProperty(w, 'innerWidth', { value: width }); Object.defineProperty(w, 'innerHeight', { value: height })
      w.HTMLCanvasElement.prototype.getContext = () => ({}); w.Image = class {}
      w.webkit = { messageHandlers: { companion: { postMessage: s => posted.push(JSON.parse(s)) } } }
      w.eval(shared + '\n' + readFileSync(new URL('../companion/view.js', import.meta.url), 'utf8'))
      w.petReceive({ generation: 'g', state: { lifecycle: 'idle', capabilities: ['start', 'bots'], bands: [], muted: false, petSize: size }, acks: {} })
      const scale = 0.8 * size / 100
      assert.equal(w.document.getElementById('pet').style.width, 192 * scale + 'px')
      const descriptor = w.eval('petDescriptor(false,false)')
      const art = { left: 140 + 192 * scale * 0.1, top: 80, width: 192 * scale * 0.8, height: 208 * scale }
      const g = w.eval('petLayout')(art, { width, height }, { width: 200, height: 40.8 }, descriptor)
      assert.ok(g.fits && g.secondaryFits && g.utility.visible, `${size}% rail fits`)
      assert.ok(g.bubbleVisible, `${size}% bubble fits`)
      assert.ok(g.top >= art.top + art.height, `${size}% bubble below the pet`)
    } finally { w.close() }
  }
})

test('voice settings no longer hold the bot pet settings, only a pointer to the Pets panel', async () => {
  const h = await setup()
  try {
    await h.flush(() => h.root.render(jsx(h.run('ConfigForm'), { ctx: h.ctx })))
    const text = h.w.document.body.textContent
    assert.ok(text.includes('Pet settings moved to the \u{1F43E} button in the status bar.'))
    assert.equal(h.$('[aria-label="Where bot pets appear"]'), null)
    assert.equal(h.$('[aria-label="Bot status in the pet bubble"]'), null)
    assert.ok(!text.includes('Bot pets'))
  } finally { await h.cleanup() }
})

test('Pets panel holds placement, bot lines and sub-agent progress on the same keys with the same effects', async () => {
  const h = await setup()
  try {
    await h.botsOn()
    await h.open()
    assert.equal(h.$('[aria-label="Where bot pets appear"]').closest('[data-select-value]').dataset.selectValue, 'auto')
    assert.equal(h.$('[data-talk-bot]'), null, 'desktop windows by default here')
    await h.flush(() => h.$('[data-select-item="inapp"]').click(), 40)
    assert.equal(h.storage.get('botPlacement.v1'), 'inapp')
    assert.ok(h.$('[data-talk-bot]'), 'bot pets move inside Hermes')
    const lines = h.$('[aria-label="Bot status in the pet bubble"]')
    assert.equal(lines.getAttribute('aria-checked'), 'false', 'off by default')
    await h.flush(() => lines.click())
    assert.equal(h.storage.get('botLines.v1'), '1')
    const narrate = h.$('[aria-label="Show sub-agent progress in the pet bubble"]')
    assert.equal(narrate.getAttribute('aria-checked'), 'true', 'on by default')
    await h.flush(() => narrate.click())
    assert.equal(h.storage.get('narrateWork.v1'), '0')
    assert.equal(h.w.document.querySelectorAll('[aria-label="Where bot pets appear"]').length, 1, 'one place for each setting')
  } finally { await h.cleanup() }
  const none = await setup({ desktopWindows: false })
  try {
    await none.flush(null, 20); await none.open()
    assert.equal(none.$('[data-select-item="desktop"]').disabled, true)
    assert.match(none.$('[data-test-popover]').textContent, /Desktop windows are not available on this system/)
  } finally { await none.cleanup() }
})

test('Reset bot positions clears saved in-app spots and resets desktop windows only when they are open', async () => {
  const h = await setup({ desktopWindows: false, store: { 'botPositions.v1': JSON.stringify({ alpha: [5, 5] }) } })
  try {
    await h.flush(null, 20); await h.open()
    assert.equal(h.button('Reset bot positions').disabled, true, 'no bot pets showing')
    await h.botsOn()
    const box = h.$('[data-talk-bot]')
    assert.equal(box.style.left, '5px')
    await h.flush(() => h.button('Reset bot positions').click())
    assert.deepEqual(JSON.parse(h.storage.get('botPositions.v1')), {})
    assert.notEqual(box.style.left, '5px', 're-laid out at its default spot')
    assert.equal(h.run('liveController.snapshot().botReset'), 0, 'no desktop windows: nothing sent')
  } finally { await h.cleanup() }
  const d = await setup()
  try {
    await d.botsOn(); await d.flush(null, 300); await d.open()
    await d.flush(() => d.button('Reset bot positions').click(), 300)
    assert.equal(d.pulses.at(-1).botReset, 1, 'the open desktop bot windows go back to their spots')
  } finally { await d.cleanup() }
})

test('the Pets panel scrolls inside the height Radix allows, so a larger UI zoom cannot clip it', async () => {
  const h = await setup()
  try {
    await h.open()
    const content = h.$('[data-test-popover]')
    assert.equal(content.style.overflowY, 'auto', 'the panel scrolls vertically')
    assert.match(content.style.maxHeight, /var\(--radix-popover-content-available-height\)/, 'bounded by the space Radix measured')
  } finally { await h.cleanup() }
})

test('the pop-out no longer resizes on the wheel: the slider owns the size', () => {
  const view = readFileSync(new URL('../companion/view.js', import.meta.url), 'utf8')
  assert.ok(!/addEventListener\('wheel'/.test(view))
})

// ── Group G: the voice engine (and the voice that depends on it) live in this panel ──
const voicePanel = h => h.$('[data-test-popover]').textContent
const selected = (h, label) => h.$(`[aria-label="${label}"]`)?.closest('[data-select-value]')?.dataset.selectValue
const items = (h, label) => [...h.$(`[aria-label="${label}"]`).closest('[data-select-value]').querySelectorAll('[data-select-item]')].map(b => [b.dataset.selectItem, b.textContent])

test('the panel is "Pets & voice": Codex Live is the default engine, labelled honestly, and changes apply to the next call', async () => {
  const h = await setup()
  try {
    assert.equal(h.$('[data-talk-pets]').textContent, '🐾 Pets & voice', 'the chip text names the panel')
    await h.open()
    assert.match(voicePanel(h), /^Pets & voice/)
    assert.equal(selected(h, 'Voice engine'), 'codex')
    assert.deepEqual(items(h, 'Voice engine'), [['codex', 'Codex Live \u2014 ChatGPT subscription'], ['hermes', 'OpenAI Realtime \u2014 API key or Codex sign-in'], ['hermes-live', 'Hermes Live \u2014 your OpenAI key (~$0.05/min)']], 'labelled by what you pay with, not the shared model name')
    assert.equal(selected(h, 'Voice'), 'sol', 'Codex voices')
    assert.match(voicePanel(h), /Applies to the next call/)
    assert.equal(h.w.document.querySelectorAll('[aria-label="Voice engine"]').length, 1)
  } finally { await h.cleanup() }
})

test('choosing Hermes Live saves the new value, explains why it cannot start yet, and shows the voice Hermes is set to', async () => {
  const h = await setup()
  try {
    await h.open()
    await h.flush(() => h.$('[data-select-item="hermes-live"]').click(), 10)
    assert.equal(h.storage.get('engine.v1'), 'hermes-live')
    assert.equal(selected(h, 'Voice engine'), 'hermes-live')
    const text = voicePanel(h)
    assert.match(text, /needs an OpenAI API key/i)
    assert.match(text, /\$0\.05 per minute/)
    assert.match(text, /Add an OpenAI API key in Hermes Settings \u2192 Keys \u2192 OpenAI API Key \(for Whisper STT \+ TTS\)/)
    assert.ok(!text.includes(NO_KEY), 'the raw env-var reason is not shown as text')
    const reason = [...h.w.document.querySelectorAll('[data-test-popover] [title]')].find(el => el.getAttribute('title') === NO_KEY)
    assert.ok(reason, 'the raw reason stays as the tooltip')
    assert.equal(h.$('[aria-label="Voice"]'), null, 'Hermes picks the GPT-Live voice from its own settings')
    assert.match(text, /Voice: marin \(set in Hermes settings\)/)
    await h.open(); await h.open()
    assert.equal(selected(h, 'Voice engine'), 'hermes-live', 'the new value round-trips')
    assert.ok(h.requests.every(r => !/session|prompt/.test(r.method)), 'no call is started from settings')
  } finally { await h.cleanup() }
  const ready = await setup({ store: { 'engine.v1': 'hermes-live' }, liveStatus: { ok: true, available: true, reason: null, model: 'gpt-live-1', voice: 'cedar' } })
  try {
    await ready.open()
    assert.ok(!voicePanel(ready).includes('Not available'), 'no warning once a key resolves')
    assert.match(voicePanel(ready), /Voice: cedar/)
  } finally { await ready.cleanup() }
})

test('old saved engines keep working: "hermes" stays the OpenAI Realtime lane with its own voices, "codex" keeps its voices', async () => {
  const h = await setup({ store: { 'engine.v1': 'hermes', 'voice.v3': 'cedar' } })
  try {
    await h.open()
    assert.equal(selected(h, 'Voice engine'), 'hermes')
    assert.equal(selected(h, 'Voice'), 'cedar')
    assert.match(voicePanel(h), /OpenAI API key if one is set, otherwise your Codex sign-in/)
    await h.flush(() => h.$('[data-select-item="verse"]').click())
    assert.equal(h.storage.get('voice.v3'), 'verse')
    await h.flush(() => h.$('[data-select-item="codex"]').click())
    assert.equal(h.storage.get('engine.v1'), 'codex')
    assert.equal(selected(h, 'Voice'), 'sol', 'a realtime voice is not a Codex voice')
    await h.flush(() => h.$('[data-select-item="cove"]').click())
    assert.equal(h.storage.get('voice.v3'), 'cove')
  } finally { await h.cleanup() }
})

test('the voice gear no longer holds the engine or voice, only a pointer to the 🐾 panel', async () => {
  const h = await setup({ store: { 'engine.v1': 'hermes-live' } })
  try {
    await h.flush(() => h.root.render(jsx(h.run('ConfigForm'), { ctx: h.ctx })))
    const text = h.w.document.body.textContent, pointer = 'Voice engine and voice moved to the \u{1F43E} button in the status bar.'
    assert.equal(h.$('[aria-label="Voice engine"]'), null)
    assert.equal(h.$('[aria-label="Voice"]'), null)
    assert.ok(text.includes(pointer))
    const rest = text.replace(pointer, '')
    assert.ok(!rest.includes('Voice engine') && !rest.includes('Codex Live-1') && !rest.includes('gpt-realtime'), 'no engine field outside the pointer line')
    assert.ok(text.includes('Work in the chat') && text.includes('Ask before sending to chat'), 'chat settings stay in the gear')
    assert.equal(h.storage.get('engine.v1'), 'hermes-live', 'opening the gear does not rewrite the engine')
  } finally { await h.cleanup() }
})

test('a remote chat can choose desktop bot windows when this machine hosts them', async () => {
  const h = await setup({ connection: 'hermes-thinkpad', hostCapabilities: { desktopWindows: true, rendererHost: true } })
  try {
    await h.open()
    const item = () => h.$('[data-select-item="desktop"]')
    assert.equal(item().disabled, false, 'Desktop windows stays selectable off a local chat')
    assert.match(h.$('[data-test-popover]').textContent, /while the chat stays on the other connection/)
    await h.flush(() => item().click(), 20)
    assert.equal(h.storage.get('botPlacement.v1'), 'desktop', 'the choice is saved as-is')
    assert.equal(h.$('[data-select-value]').getAttribute('data-select-value'), 'desktop', 'and shown back')
  } finally { await h.cleanup() }
})

test('a remote chat whose local backend cannot host keeps the pets inside Hermes', async () => {
  for (const hostCapabilities of [null, { desktopWindows: true }, { desktopWindows: false, rendererHost: true }]) {
    const h = await setup({ connection: 'hermes-thinkpad', hostCapabilities })
    try {
      await h.open()
      assert.equal(h.$('[data-select-item="desktop"]').disabled, true, 'no host lease means no desktop choice')
      assert.match(h.$('[data-test-popover]').textContent, /need the local backend/)
    } finally { await h.cleanup() }
  }
})
