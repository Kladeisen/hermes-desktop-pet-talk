// Bot pets inside the Hermes window (Windows/macOS fallback) and their lines in Hermes' pet bubble.
// Run with: TALK_TEST_DEPS=/path/to/isolated/node_modules node --test tools/inapp-bots-test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
const require = createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const { JSDOM } = require('jsdom')
const source = readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const ID = c => c.repeat(64)
const IMAGES = { [ID('a')]: 'data:image/png;base64,QVZBVEFS', [ID('b')]: 'data:image/webp;base64,U0hFRVQ=', [ID('c')]: 'data:image/webp;base64,UElQUE1BSU4=' }

async function setup({ desktopWindows = false, store = {}, progress = null, roster, viewport = [1024, 768], connection = 'local', bridge = null, failPetSprite = false, hangPetSprite = false } = {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://hermes.test', pretendToBeVisual: true })
  const w = dom.window
  Object.defineProperty(w, 'innerWidth', { value: viewport[0] }); Object.defineProperty(w, 'innerHeight', { value: viewport[1] })
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} })
  const atom = initial => { let value = initial; const listeners = new Set(); return { get: () => value, set: next => { value = next; for (const fn of listeners) fn(next) }, listen: fn => { listeners.add(fn); return () => listeners.delete(fn) } } }
  const state = { focusedSessionId: atom(''), focusedStoredSessionId: atom(''), focusedSessionProfile: atom(''), focusedSessionOwner: atom(null), busyBySession: atom({}), connectionId: atom(connection), profile: atom('default') }
  if (bridge) w.hermesDesktop = { api: bridge }
  const opened = [], notes = [], calls = [], said = [], cleared = []
  const host = { state, openSession: async (id, options) => opened.push({ id, options }), onEvent: () => () => {}, notify: note => notes.push(note),
    request: async method => method === 'profiles.list' ? (roster || { profiles: [{ name: 'alpha', display_name: 'Alpha', canonical_session: { id: 'chat-a' } }] }) : {} }
  const feed = { progress }
  const feedState = { failBots: false }  // simulate a backend whose pet routes refuse this client
  const rest = async (path, options = {}) => {
    calls.push({ path, body: options.body })
    if (path === '/companion/capabilities') return { desktopWindows, platform: desktopWindows ? 'linux' : 'win32', reason: '' }
    if (path === '/companion/bots' && feedState.failBots) throw new Error('403 Forbidden')
    if (path === '/companion/bots') return { bots: Object.fromEntries(options.body.bots.map(name => [name, { avatarId: ID('a'), pet: { spriteId: ID('b'), frameWidth: 192, frameHeight: 208, counts: [6,8,8,4,5,8,6,6,6], top: 20 }, ...(feed.progress ? { progress: feed.progress } : {}) }])) }
    if (path === '/companion/image') return { data: IMAGES[options.body.id] }
    if (path === '/companion/pet-sprite') {
      if (failPetSprite) throw new Error('404 Not Found')
      if (hangPetSprite) return new Promise(() => {})
      return { slug: 'demo', spriteId: ID('c'), sprite: IMAGES[ID('c')] }
    }
    return {}
  }
  const sdk = { host, useValue: x => x?.get ? x.get() : x }
  const context = vm.createContext({ window: w, document: w.document, navigator: w.navigator, MutationObserver: w.MutationObserver, CustomEvent: w.CustomEvent, Image: w.Image, Event: w.Event,
    jsx: () => null, jsxs: () => null, sdk, useState: v => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: () => ({}),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w), performance: w.performance,
    setInterval, clearInterval, setTimeout, clearTimeout, console })
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'globalThis.plugin = {').replace(/^export (?=(?:async )?function |const |let |class )/gm, ''), context)
  const disposers = [], contributions = []
  const storage = new Map(Object.entries(store))
  const ctx = { onDispose: fn => disposers.push(fn), register: c => contributions.push(c), registerOverlayCompanion: () => () => {},
    storage: { get: k => storage.get(k), set: (k, v) => storage.set(k, v) }, rest,
    pet: { say: (text, options) => { said.push({ text, ...options }); return () => {} }, clear: id => cleared.push(id) } }
  context.plugin.register(ctx)
  const settle = async (rounds = 6) => { for (let n = 0; n < rounds; n++) await new Promise(r => setTimeout(r, 0)) }
  await settle()
  const run = code => vm.runInContext(code, context)
  const botsOn = async () => { run('botTracker.setEnabled(true)'); await run('petCompanion.syncBots()'); await settle(10) }
  return { w, run, calls, said, cleared, opened, notes, storage, feed, contributions, settle, botsOn, failBots: value => { feedState.failBots = !!value },
    pets: () => [...w.document.querySelectorAll('[data-talk-bot]')],
    cleanup: () => { disposers.splice(0).forEach(fn => fn()); w.close() } }
}

test('no desktop windows: bot pets appear inside Hermes, not through the pop-out helper', async () => {
  const h = await setup()
  try {
    assert.equal(h.run('petCompanion.desktopWindows'), false)
    await h.botsOn()
    const [pet] = h.pets()
    assert.ok(pet, 'bot pet is drawn inside the Hermes window')
    assert.equal(pet.getAttribute('data-talk-bot'), 'alpha')
    assert.equal(pet.querySelector('[data-bot-part=status]').textContent, 'Alpha')
    assert.equal(pet.querySelector('[data-bot-part=avatar]').getAttribute('src'), IMAGES[ID('a')])
    const paths = h.calls.map(c => c.path)
    assert.ok(paths.includes('/companion/bots'))
    for (const helper of ['/companion/claim', '/companion/launch', '/companion/pulse']) assert.ok(!paths.includes(helper), helper)
    assert.equal(h.run('petBotsOnDesktop()'), false)
  } finally { h.cleanup() }
})

test('each image is fetched once by id, however often the feed polls', async () => {
  const h = await setup()
  try {
    await h.botsOn()
    for (let n = 0; n < 3; n++) { h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots')); await h.settle() }
    const images = h.calls.filter(c => c.path === '/companion/image').map(c => c.body.id).sort()
    assert.deepEqual(images, [ID('a'), ID('b')])
    assert.ok(h.calls.filter(c => c.path === '/companion/bots').length >= 3)
  } finally { h.cleanup() }
})

test('chat opens the bot chat; X dismisses only that pet', async () => {
  const h = await setup({ roster: { profiles: [
    { name: 'alpha', display_name: 'Alpha', canonical_session: { id: 'chat-a' } },
    { name: 'beta', display_name: 'Beta', canonical_session: { id: 'chat-b' } }] } })
  try {
    await h.botsOn()
    assert.equal(h.pets().length, 2)
    h.pets()[0].querySelector('[data-bot-part=chat]').click(); await h.settle()
    assert.deepEqual(h.opened.map(o => [o.id, o.options.profile]), [['chat-a', 'alpha']])
    h.pets()[1].querySelector('[data-bot-part=close]').click(); await h.settle()
    assert.deepEqual(h.pets().map(p => p.getAttribute('data-talk-bot')), ['alpha'])
  } finally { h.cleanup() }
})

test('busy bots get one line each in Hermes\u2019 pet bubble, cleared when idle or switched off', async () => {
  const h = await setup({ store: { 'botLines.v1': '1' }, progress: { row: 8, title: 'Riddle game', detail: 'Thinking', since: Date.now() / 1000 - 90, tone: 'info' } })
  try {
    await h.botsOn()
    const line = h.said.at(-1)
    assert.equal(line.id, 'bot-alpha')
    assert.match(line.text, /^Alpha: Riddle game · Thinking \(1m\)$/)
    assert.equal(line.tone, 'info'); assert.equal(line.ttlMs, 30000)
    const before = h.said.length
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots')); await h.settle()
    assert.equal(h.said.length, before, 'an unchanged line is not re-sent on every poll')
    h.feed.progress = null
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots')); await h.settle()
    assert.ok(h.cleared.includes('bot-alpha'))
    h.storage.set('botLines.v1', '0'); h.feed.progress = { row: 7, title: 'Again', detail: 'Working', since: null, tone: 'info' }
    const count = h.said.length
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots')); await h.settle()
    assert.equal(h.said.length, count, 'setting off: no bubble lines')
  } finally { h.cleanup() }
})

test('the bot bubble line uses the plain status when the backend has no progress', async () => {
  const h = await setup()
  try {
    const line = code => JSON.parse(h.run('JSON.stringify(' + code + ')'))
    assert.deepEqual(line("petBotLine({label:'A',status:'Working'},{})"), { text: 'Working', tone: 'info' })
    assert.deepEqual(line("petBotLine({label:'A',status:'',attention:{kind:'clarify'}},{})"), { text: 'Question for you', tone: 'wait' })
    assert.equal(h.run("petBotLine({label:'A',status:''},{})"), null)
  } finally { h.cleanup() }
})

test('Hermes\u2019 pet bubble keeps 3 lines per plugin, so waiting bots go first', async () => {
  const profiles = ['a1','a2','a3','a4'].map(name => ({ name, display_name: name, canonical_session: { id: name } }))
  const h = await setup({ store: { 'botLines.v1': '1' }, roster: { profiles }, progress: { row: 7, title: 'Task', detail: 'Working', since: null, tone: 'info' } })
  try {
    await h.botsOn()
    const ids = new Set(h.said.map(s => s.id))
    assert.equal(ids.size, 3)
  } finally { h.cleanup() }
})

test('in-app bot pets wrap into columns instead of stacking on one spot when large pets run out of rows', async () => {
  const roster = count => ({ profiles: ['a1', 'a2', 'a3', 'a4'].slice(0, count).map(name => ({ name, display_name: name, canonical_session: { id: name } })) })
  for (const [vw, vh] of [[1366, 768], [1536, 800]]) for (const count of [3, 4]) for (const size of [50, 100, 200]) {
    const h = await setup({ viewport: [vw, vh], store: { 'botSize.v1': String(size) }, roster: roster(count) })
    try {
      await h.botsOn()
      await h.run('petCompanion.resetBots()'); await h.settle()
      const f = size / 100
      const boxes = h.pets().map(box => {
        const left = parseFloat(box.style.left), top = parseFloat(box.style.top)
        return { bot: box.getAttribute('data-talk-bot'), rect: [left + 90 * f, top + 90 * f, left + 186 * f, top + 194 * f] }
      })
      assert.equal(boxes.length, count)
      for (const { bot, rect: [x1, y1, x2, y2] } of boxes) {
        assert.ok(x1 >= 0 && y1 >= 0 && x2 <= vw && y2 <= vh, `${bot} stays on screen at ${size}% in ${vw}x${vh}: ${[x1, y1, x2, y2]}`)
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const [ax1, ay1, ax2, ay2] = boxes[i].rect, [bx1, by1, bx2, by2] = boxes[j].rect
        const ox = Math.min(ax2, bx2) - Math.max(ax1, bx1), oy = Math.min(ay2, by2) - Math.max(ay1, by1)
        assert.ok(!(ox > 0 && oy > 0), `${boxes[i].bot}/${boxes[j].bot} overlap at ${size}% in ${vw}x${vh}`)
      }
    } finally { h.cleanup() }
  }
})

test('dragging moves the pet and remembers where it was put', async () => {
  const h = await setup()
  try {
    await h.botsOn()
    const box = h.pets()[0], avatar = box.querySelector('[data-bot-part=avatar]')
    const at = (type, x, y) => { const e = new h.w.Event(type); Object.assign(e, { button: 0, pointerId: 1, clientX: x, clientY: y }); avatar.dispatchEvent(e) }
    const start = [parseFloat(box.style.left), parseFloat(box.style.top)]
    at('pointerdown', 500, 300); at('pointermove', 400, 350); at('pointerup', 0, 0)
    assert.deepEqual([parseFloat(box.style.left), parseFloat(box.style.top)], [start[0] - 100, start[1] + 50])
    assert.deepEqual(JSON.parse(h.storage.get('botPositions.v1')).alpha, [start[0] - 100, start[1] + 50])
  } finally { h.cleanup() }
})

test('in-app bot pets never start a native image drag', async () => {
  const h = await setup()
  try {
    await h.botsOn()
    const avatar = h.pets()[0].querySelector('[data-bot-part=avatar]')
    assert.equal(avatar.getAttribute('draggable'), 'false')
    assert.equal(avatar.dispatchEvent(new h.w.Event('dragstart', { bubbles: true, cancelable: true })), false)
  } finally { h.cleanup() }
})

test('pop out without desktop windows points to Hermes\u2019 own pop-out instead of failing', async () => {
  const h = await setup()
  try {
    const popOut = h.contributions.find(c => c.data?.id === 'talk-desktop.pet-pop-out')
    await popOut.data.run(); await h.settle()
    assert.match(h.notes.at(-1)?.message || '', /Shift-click the pet/)
    assert.equal(h.run('petCompanion.error'), '')
    assert.ok(!h.calls.some(c => c.path === '/companion/claim'))
  } finally { h.cleanup() }
})

test('Linux with desktop windows keeps bot pets on the desktop unless "Inside Hermes" is chosen', async () => {
  const linux = await setup({ desktopWindows: true })
  try {
    linux.run('botTracker.setEnabled(true)'); await linux.settle(10)
    assert.equal(linux.run('petBotsOnDesktop()'), true)
    assert.equal(linux.pets().length, 0)
    assert.ok(!linux.calls.some(c => c.path === '/companion/bots'))
  } finally { linux.cleanup() }
  const chosen = await setup({ desktopWindows: true, store: { 'botPlacement.v1': 'inapp' } })
  try {
    await chosen.botsOn()
    assert.equal(chosen.run('petBotsOnDesktop()'), false)
    assert.equal(chosen.pets().length, 1)
  } finally { chosen.cleanup() }
})

test('turning bot pets off removes the in-app layer and its bubble lines', async () => {
  const h = await setup({ store: { 'botLines.v1': '1' }, progress: { row: 7, title: 'Task', detail: 'Working', since: null, tone: 'info' } })
  try {
    await h.botsOn()
    assert.equal(h.pets().length, 1)
    h.run('botTracker.setEnabled(false)'); await h.run('petCompanion.syncBots()'); await h.settle(10)
    assert.equal(h.pets().length, 0)
    assert.equal(h.w.document.querySelector('[data-talk-bot-layer]'), null)
    assert.ok(h.cleared.includes('bot-alpha'))
  } finally { h.cleanup() }
})

test('bot lines in Hermes\u2019 pet bubble are off unless switched on', async () => {
  const h = await setup({ progress: { row: 8, title: 'Riddle game', detail: 'Thinking', since: null, tone: 'info' } })
  try {
    await h.botsOn()
    assert.equal(h.pets().length, 1, 'bot pets still appear inside Hermes')
    assert.equal(h.said.length, 0, 'no pet.say lines by default')
  } finally { h.cleanup() }
})

// A remote source (SSH host, remote gateway) is a normal source for bot pets: the backend that
// answers the chat owns the profiles, so the pets still come from it — only the window changes.
test('a remote backend draws bot pets inside Hermes even when its own system supports desktop windows', async () => {
  const h = await setup({ desktopWindows: true })
  try {
    h.run("host.state.connectionId.set('hermes-thinkpad')")
    await h.botsOn()
    assert.equal(h.run('petBotsOnDesktop()'), false, 'no helper can be spawned on another machine')
    assert.equal(h.pets().length, 1)
    assert.equal(h.pets()[0].getAttribute('data-talk-bot'), 'alpha')
    assert.ok(h.calls.some(c => c.path === '/companion/bots'))
    assert.ok(!h.calls.some(c => c.path === '/companion/claim'))
  } finally { h.cleanup() }
})

test('a backend that refuses the pet routes hides in-app pets instead of leaving empty boxes', async () => {
  const h = await setup()
  try {
    await h.botsOn()
    assert.equal(h.pets().length, 1)
    h.failBots(true)
    for (let n = 0; n < 3; n++) { h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots')); await h.settle(8) }
    assert.equal(h.run('petCompanion.inappBlocked'), true)
    assert.equal(h.pets().length, 0)
    assert.equal(h.run('botTracker.enabled()'), true, 'the roster is kept, only the drawing stops')
    h.failBots(false)
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots')); await h.settle(8)
    assert.equal(h.run('petCompanion.inappBlocked'), false)
    assert.equal(h.pets().length, 1)
  } finally { h.cleanup() }
})

// ── Hosted bot windows: a remote chat, windows drawn by this machine's backend ──────────────
function hostBridge(log, { hostWindows = true, commands = [], servePetSheet = false } = {}) {
  let pulsed = 0
  return async request => {
    log.push({ path: request.path, body: request.body })
    if (request.path.endsWith('/companion/capabilities')) return { desktopWindows: hostWindows, rendererHost: true, platform: 'linux', reason: hostWindows ? '' : 'no compositor' }
    if (request.path.endsWith('/companion/claim')) return { token: 'tok-1', generation: 'gen-1' }
    if (request.path.endsWith('/companion/pulse')) {
      const out = { generation: 'gen-1', commands: pulsed++ === 0 ? commands : [], helper: true }
      return out
    }
    if (request.path.endsWith('/companion/launch')) return { running: true, ready: true }
    if (request.path.endsWith('/companion/host/image')) return { ok: true }
    if (request.path.endsWith('/companion/pet-sprite')) return servePetSheet ? { slug: 'local-pippa', spriteId: ID('c'), sprite: IMAGES[ID('c')] } : {}
    return {}
  }
}

test('a remote chat gets desktop bot windows hosted by this machine', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge: hostBridge(log, { commands: [{ id: 'cmd-1', action: 'botChat', bot: 'alpha' }] }) })
  try {
    await h.settle(8)
    await h.botsOn()
    for (let n = 0; n < 4; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 5)) }
    const claim = log.find(c => c.path.endsWith('/companion/claim'))
    assert.equal(JSON.stringify(claim.body), JSON.stringify({ connection: 'hermes-thinkpad', profile: 'default', host: 'renderer' }))
    assert.equal(h.run('petBotsOnDesktop()'), true, 'the remote chat renders on this machine')
    assert.equal(h.pets().length, 0, 'nothing is drawn inside the Hermes window')
    const pulses = log.filter(c => c.path.endsWith('/companion/pulse'))
    assert.ok(pulses.length, 'the presentation is pushed to the local backend')
    const state = pulses.at(-1).body.state
    assert.equal(state.petVisible, false, 'no main pet for a remote chat')
    assert.equal(state.bots[0].id, 'alpha')
    assert.ok(state.bots[0].avatarId, 'images travel by id, uploaded once')
    assert.ok(state.bots[0].pet?.spriteId)
    const uploads = log.filter(c => c.path.endsWith('/companion/host/image')).map(c => c.body.id).sort()
    assert.deepEqual(uploads, [ID('a'), ID('b')])
    assert.ok(log.some(c => c.path.endsWith('/companion/launch')), 'the helper is launched once')
    assert.ok(h.opened.some(o => o.id === 'chat-a'), 'a bot click opens the chat on its own connection')
    assert.ok(log.some(c => (c.body?.acks || []).some(ack => ack.id === 'cmd-1')), 'the command is acknowledged')
  } finally { h.cleanup() }
})

test('a remote chat falls back to in-window pets when this machine cannot host windows', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge: hostBridge(log, { hostWindows: false }) })
  try {
    await h.settle(8)
    await h.botsOn()
    assert.equal(h.run('petBotsOnDesktop()'), false)
    assert.equal(h.pets().length, 1)
    assert.ok(!log.some(c => c.path.endsWith('/companion/claim')), 'no lease is taken when the local half cannot host')
  } finally { h.cleanup() }
})

test('choosing Inside Hermes on a remote chat never takes a host lease', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', store: { 'botPlacement.v1': 'inapp' }, bridge: hostBridge(log) })
  try {
    await h.settle(8)
    await h.botsOn()
    assert.equal(h.run('petBotsOnDesktop()'), false)
    assert.equal(h.pets().length, 1)
    assert.ok(!log.some(c => c.path.endsWith('/companion/claim')))
  } finally { h.cleanup() }
})

test('an older local backend that cannot host renderer leases keeps bot pets inside Hermes', async () => {
  const log = []
  const bridge = async request => {
    log.push({ path: request.path, body: request.body })
    if (request.path.endsWith('/companion/capabilities')) return { desktopWindows: true, platform: 'linux', reason: '' }  // no rendererHost
    return {}
  }
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge })
  try {
    await h.settle(8)
    await h.botsOn()
    assert.equal(h.run('petBotsOnDesktop()'), false, 'no host lease without the negotiated flag')
    assert.equal(h.pets().length, 1)
    assert.ok(!log.some(c => c.path.endsWith('/companion/claim')))
  } finally { h.cleanup() }
})

test('a remote chat also pops the main pet out through this machine', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge: hostBridge(log, { commands: [{ id: 'cmd-bots', action: 'bots' }] }) })
  try {
    await h.settle(8)
    await h.botsOn()
    h.run('petCompanion.wantPopOut = true')
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots'))
    for (let n = 0; n < 5; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 5)) }
    assert.equal(h.run('petCompanion.open'), true, 'the launch reply marks the window as up')
    const last = log.filter(c => c.path.endsWith('/companion/pulse')).at(-1).body.state
    assert.equal(last.petVisible, true, 'the hosted window shows the main pet')
    assert.equal(last.pet?.spriteId, ID('c'), 'using the sheet the chat backend resolved')
    assert.equal(last.descriptor?.controls?.length, 4, 'the pop-out keeps its controls')
    assert.ok(log.some(c => c.path.endsWith('/companion/host/image') && c.body.id === ID('c')), 'the sheet is uploaded once')
    assert.equal(h.run('botTracker.enabled()'), false, 'a non-bot command drives the real controller')
    assert.ok(log.some(c => (c.body?.acks || []).some(a => a.id === 'cmd-bots' && a.ok)))
    assert.equal(h.pets().length, 0, 'the in-app pet is hidden while popped out')
  } finally { h.cleanup() }
})

test('an image this backend refuses is not retried on every poll', async () => {
  const log = []
  const bridge = async request => {
    log.push({ path: request.path, body: request.body })
    if (request.path.endsWith('/companion/capabilities')) return { desktopWindows: true, rendererHost: true }
    if (request.path.endsWith('/companion/claim')) return { token: 't', generation: 'g' }
    if (request.path.endsWith('/companion/pulse')) return { generation: 'g', commands: [], helper: true }
    if (request.path.endsWith('/companion/launch')) return { running: true }
    if (request.path.endsWith('/companion/host/image')) throw new Error('413 Image too large')
    return {}
  }
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge })
  try {
    await h.settle(8); await h.botsOn()
    for (let n = 0; n < 6; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 5)) }
    const uploads = log.filter(c => c.path.endsWith('/companion/host/image')).map(c => c.body.id).sort()
    assert.deepEqual(uploads, [ID('a'), ID('b')], 'one attempt per id, then it waits for a route change')
  } finally { h.cleanup() }
})

test('a hosted pop-out that cannot open gives the in-app pet back', async () => {
  const bridge = async request => {
    if (request.path.endsWith('/companion/capabilities')) return { desktopWindows: true, rendererHost: true }
    if (request.path.endsWith('/companion/claim')) throw new Error('409 Companion already has an owner')
    if (request.path.endsWith('/companion/pulse')) return { generation: 'g', commands: [], helper: false }
    return {}
  }
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge })
  try {
    await h.settle(8); await h.botsOn()
    h.run('petCompanion.open = true')
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots'))
    for (let n = 0; n < 8; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 5)) }
    assert.equal(h.run('petCompanion.open'), false, 'the in-app pet is released when no window opened')
  } finally { h.cleanup() }
})

test('a backend without the pet sheet route reports it instead of throwing', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge: hostBridge(log), failPetSprite: true })
  try {
    await h.settle(8)
    h.run('petCompanion.wantPopOut = true')
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots'))
    for (let n = 0; n < 5; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 5)) }
    assert.match(String(h.run('petCompanion.error')), /restart Hermes/, 'the missing route is named')
    assert.equal(h.run('petCompanion.open'), false, 'no empty window is left open')
    assert.ok(!log.some(c => c.path.endsWith('/companion/pulse')), 'nothing is published without a sheet')
  } finally { h.cleanup() }
})

test('a sheet request that never answers does not hide the pet or wedge the loop', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge: hostBridge(log), hangPetSprite: true })
  try {
    await h.settle(8)
    h.run('HOST_FETCH_MS = 60')
    h.run('petCompanion.wantPopOut = true')
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots'))
    for (let n = 0; n < 12; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 15)) }
    assert.equal(h.run('petCompanion.open'), false, 'no window means the in-app pet stays')
    assert.equal(h.run('petCompanion.wantPopOut'), false, 'the intent is dropped, not left pending')
    assert.match(String(h.run('petCompanion.error')), /restart Hermes/)
  } finally { h.cleanup() }
})

test('a load-time host probe miss is retried when the pop-out is asked for', async () => {
  let calls = 0
  const bridge = async request => {
    if (request.path.endsWith('/companion/capabilities')) {
      calls += 1
      if (calls === 1) throw new Error('backend not ready')
      return { desktopWindows: true, rendererHost: true }
    }
    return {}
  }
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge })
  try {
    await h.settle(8)
    assert.equal(h.run('petCompanion.hostWindows'), false, 'the first miss is not final')
    assert.equal(await h.run('probeHostWindows()'), true, 'asking again finds the backend')
    assert.equal(h.run('petCompanion.hostWindows'), true)
  } finally { h.cleanup() }
})

test('when the chat backend has no sheet route the local copy is used', async () => {
  const log = []
  const h = await setup({ desktopWindows: true, connection: 'hermes-thinkpad', bridge: hostBridge(log, { servePetSheet: true }), failPetSprite: true })
  try {
    await h.settle(8)
    h.run('petCompanion.wantPopOut = true')
    h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:bots'))
    for (let n = 0; n < 6; n++) { await h.settle(10); await new Promise(r => setTimeout(r, 5)) }
    assert.equal(h.run('petCompanion.open'), true, 'the window opens with this machine\'s artwork')
    const state = log.filter(c => c.path.endsWith('/companion/pulse')).at(-1).body.state
    assert.equal(state.pet?.spriteId, ID('c'))
    assert.ok(log.some(c => c.body?.id === ID('c')), 'the sheet was uploaded once')
  } finally { h.cleanup() }
})
