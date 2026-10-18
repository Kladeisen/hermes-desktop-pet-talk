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
const IMAGES = { [ID('a')]: 'data:image/png;base64,QVZBVEFS', [ID('b')]: 'data:image/webp;base64,U0hFRVQ=' }

async function setup({ desktopWindows = false, store = {}, progress = null, roster, viewport = [1024, 768] } = {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://hermes.test', pretendToBeVisual: true })
  const w = dom.window
  Object.defineProperty(w, 'innerWidth', { value: viewport[0] }); Object.defineProperty(w, 'innerHeight', { value: viewport[1] })
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} })
  const atom = initial => { let value = initial; const listeners = new Set(); return { get: () => value, set: next => { value = next; for (const fn of listeners) fn(next) }, listen: fn => { listeners.add(fn); return () => listeners.delete(fn) } } }
  const state = { focusedSessionId: atom(''), focusedStoredSessionId: atom(''), focusedSessionProfile: atom(''), focusedSessionOwner: atom(null), busyBySession: atom({}), connectionId: atom('local'), profile: atom('default') }
  const opened = [], notes = [], calls = [], said = [], cleared = []
  const host = { state, openSession: async (id, options) => opened.push({ id, options }), onEvent: () => () => {}, notify: note => notes.push(note),
    request: async method => method === 'profiles.list' ? (roster || { profiles: [{ name: 'alpha', display_name: 'Alpha', canonical_session: { id: 'chat-a' } }] }) : {} }
  const feed = { progress }
  const rest = async (path, options = {}) => {
    calls.push({ path, body: options.body })
    if (path === '/companion/capabilities') return { desktopWindows, platform: desktopWindows ? 'linux' : 'win32', reason: '' }
    if (path === '/companion/bots') return { bots: Object.fromEntries(options.body.bots.map(name => [name, { avatarId: ID('a'), pet: { spriteId: ID('b'), frameWidth: 192, frameHeight: 208, counts: [6,8,8,4,5,8,6,6,6], top: 20 }, ...(feed.progress ? { progress: feed.progress } : {}) }])) }
    if (path === '/companion/image') return { data: IMAGES[options.body.id] }
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
  return { w, run, calls, said, cleared, opened, notes, storage, feed, contributions, settle, botsOn,
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
