// Companion transport across Hermes profile switches (a fresh bot chat switches the active profile).
// Runs the real installCompanionTransport against one fake broker per route; fake clock, no DOM.
// Run with: node --test tools/companion-route-test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const start = source.indexOf('function installCompanionTransport(')
const transport = source.slice(start, source.indexOf('\n// ── Pet "needs you" badge', start))
assert.ok(start > 0 && transport.length > 1000, 'installCompanionTransport not found')
const NOTICE = 'Pets closed: Hermes switched to another profile. They come back when you return.'

// Mirrors dashboard/companion_broker.py: claim/pulse/launch/release, 8 s lease, close() ends the helper.
function fakeBroker(route, clock) {
  let owner = null, issued = 0
  const b = { route, helper: false, terminations: 0 }
  const close = () => { owner = null; if (b.helper) { b.helper = false; b.terminations++ } }
  const expire = () => { if (owner && clock() - owner.pulse > 8000) close() }
  const auth = body => {
    expire()
    if (!owner || body.token !== owner.token) throw Error('Owner unavailable')
    if (body.generation !== owner.generation) throw Error('Stale owner generation')
  }
  return Object.assign(b, {
    claim: body => {
      expire()
      if (owner) throw Error('Companion already has an owner')
      if (body.connection !== 'local' || !body.profile) throw Error('Companion requires a verified local owner route')
      owner = { token: route + '#' + ++issued, generation: 'g' + issued, pulse: clock() }
      return { token: owner.token, generation: owner.generation }
    },
    pulse: body => { auth(body); owner.pulse = clock(); return { generation: owner.generation, commands: [], helper: b.helper } },
    launch: body => { auth(body); b.helper = true; owner.pulse = clock(); return { running: true, ready: true } },
    release: body => { auth(body); close(); return { released: true } },
    snapshot: () => { expire(); return { owner: !!owner, helper: b.helper, terminations: b.terminations } },
  })
}

function setup({ bots = false } = {}) {
  let now = 1_000_000, serial = 0
  const timers = new Map(), notices = [], requests = [], brokers = {}, contributions = [], hooks = {}
  const atom = value => ({ get: () => value, set: next => { value = next } })
  const state = { connectionId: atom('local'), profile: atom('default'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' }) }
  const routeKey = () => state.connectionId.get() + '/' + state.profile.get()
  const broker = key => (brokers[key] ||= fakeBroker(key, () => now))
  const desk = { on: bots }
  // ctx.rest always reaches the broker of the *active* route, like Hermes' plugin REST.
  const ctx = {
    register: c => contributions.push(c),
    rest: async (url, options = {}) => {
      const op = url.split('/').pop(), key = routeKey(), body = options.body || {}
      requests.push({ op, route: key, token: body.token })
      const reply = broker(key)[op](body)
      if (op === 'claim') hooks.claim?.()
      return reply
    },
  }
  const controller = { owner: () => null, startTarget: () => null, action: async () => {},
    snapshot: () => ({ lifecycle: 'idle', status: '', muted: false, bands: [], capabilities: ['bots'], botsEnabled: desk.on, bots: [] }) }
  class ClockDate extends Date { static now() { return now } }
  const companion = {}
  const scope = vm.createContext({
    host: { state, notify: note => notices.push(note) }, ctx, controller, petCompanion: companion,
    petAtomGet: a => a?.get?.(), petProfileKey: v => String(v ?? '').trim() || 'default', petChat: null,
    botTracker: { enabled: () => desk.on, refresh: async () => {}, showing: () => false }, petBotsOnDesktop: () => desk.on,
    petPopOutHint: 'hint', sdk: {}, document: { documentElement: {} },
    window: { dispatchEvent() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    CustomEvent: class { constructor(type) { this.type = type } }, Date: ClockDate,
    setTimeout: (fn, ms) => { timers.set(++serial, { fn, when: now + (ms || 0) }); return serial },
    clearTimeout: id => timers.delete(id),
  })
  vm.runInContext(transport + '\nglobalThis.dispose = installCompanionTransport(ctx, controller)', scope)
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
  const advance = async ms => {
    const end = now + ms
    for (;;) {
      const next = [...timers].filter(([, t]) => t.when <= end).sort((a, b) => a[1].when - b[1].when)[0]
      if (!next) break
      now = next[1].when; timers.delete(next[0])
      await next[1].fn(); await flush()
    }
    now = end
  }
  return {
    companion, notices, requests, hooks, desk, scope, flush, advance, broker,
    claims: () => requests.filter(r => r.op === 'claim').map(r => r.route),
    switchTo: (connection, profile) => { state.connectionId.set(connection); state.profile.set(profile) },
    openPet: async () => { await contributions.find(c => c.id === 'pet-pop-out').data.run(); await flush() },
    done: () => {
      // A lease token only ever goes back to the route that issued it.
      for (const r of requests) if (r.token) assert.ok(r.token.startsWith(r.route + '#'), `token ${r.token} sent to ${r.route} (${r.op})`)
      try { scope.dispose() } catch {}
    },
  }
}

test('switching profile while the pop-out is open shows one short notice and sends nothing to the new profile', async () => {
  const h = setup()
  try {
    await h.openPet()
    assert.equal(h.companion.open, true)
    h.switchTo('local', 'dummy')
    await h.advance(1000)
    assert.equal(h.companion.open, false)
    assert.deepEqual(h.notices.map(({ kind, message }) => ({ kind, message })), [{ kind: 'warning', message: NOTICE }])
    assert.deepEqual(h.requests.filter(r => r.route !== 'local/default'), [])
    await h.advance(9000)
    assert.equal(h.notices.length, 1, 'one notice, not one per tick')
    assert.deepEqual(h.broker('local/default').snapshot(), { owner: false, helper: false, terminations: 1 })
  } finally { h.done() }
})

for (const [what, bots, show] of [['the pop-out', false, true], ['desktop bot pets only', true, false]]) {
  test(`returning to the owner profile after the old lease expired relaunches ${what} on a new lease`, async () => {
    const h = setup({ bots })
    try {
      if (show) await h.openPet(); else { await h.companion.syncBots(); await h.flush() }
      assert.deepEqual([h.companion.open, h.companion.helper], [show, true])
      h.switchTo('local', 'dummy')
      await h.advance(10000)
      assert.equal(h.notices.length, 1)
      assert.deepEqual(h.broker('local/default').snapshot(), { owner: false, helper: false, terminations: 1 }, 'old lease expired, helper ended')
      h.switchTo('local', 'default')
      await h.advance(2000)
      assert.deepEqual(h.claims(), ['local/default', 'local/default'], 'a new lease is claimed')
      assert.ok(h.requests.some(r => r.op === 'launch' && r.token === 'local/default#2'), 'relaunched on the new lease')
      assert.deepEqual([h.companion.open, h.companion.helper], [show, true], 'same pop-out visibility as before')
      assert.equal(h.broker('local/default').snapshot().helper, true)
      await h.advance(20000)
      assert.equal(h.broker('local/default').snapshot().helper, true, 'the new lease is kept alive')
    } finally { h.done() }
  })
}

test('a quick return while the old lease is still alive replaces it with a new lease', async () => {
  const h = setup()
  try {
    await h.openPet()
    h.switchTo('local', 'dummy')
    await h.advance(500)
    h.switchTo('local', 'default')
    await h.advance(2000)
    assert.deepEqual(h.claims(), ['local/default', 'local/default'])
    assert.deepEqual([h.companion.open, h.companion.helper], [true, true])
    assert.equal(h.broker('local/default').snapshot().helper, true)
  } finally { h.done() }
})

test('no relaunch on any other route; the pets still come back on the owner route', async () => {
  const h = setup()
  try {
    await h.openPet()
    h.switchTo('local', 'dummy'); await h.advance(10000)
    h.switchTo('local', 'other'); await h.advance(3000)
    h.switchTo('remote', 'default'); await h.advance(3000)
    assert.deepEqual(h.claims(), ['local/default'])
    assert.deepEqual(h.requests.filter(r => r.route !== 'local/default'), [], 'nothing sent to other routes')
    assert.equal(h.companion.helper, false)
    h.switchTo('local', 'default'); await h.advance(2000)
    assert.deepEqual(h.claims(), ['local/default', 'local/default'])
    assert.equal(h.companion.open, true)
  } finally { h.done() }
})

for (const how of ['close', 'dispose']) {
  test(`${how} cancels a pending recovery`, async () => {
    const h = setup()
    try {
      await h.openPet()
      h.switchTo('local', 'dummy'); await h.advance(1000)
      assert.equal(h.notices.length, 1, 'recovery is pending')
      if (how === 'close') await h.companion.hide(); else h.scope.dispose()
      await h.flush()
      h.switchTo('local', 'default'); await h.advance(5000)
      assert.deepEqual(h.claims(), ['local/default'], 'no relaunch')
      assert.equal(h.companion.open, false)
    } finally { h.done() }
  })
}

test('an old lease token is never sent to another route, even when the route moves during the claim', async () => {
  const h = setup()
  try {
    h.hooks.claim = () => { h.hooks.claim = null; h.switchTo('local', 'dummy') }
    await h.openPet()
    await h.advance(3000)
    assert.deepEqual(h.requests.filter(r => r.route === 'local/dummy'), [], 'the default lease never reaches dummy')
    assert.equal(h.notices.length, 1)
    h.switchTo('local', 'default'); await h.advance(2000)
    assert.equal(h.companion.helper, true)
    assert.ok(h.requests.filter(r => r.token).every(r => r.route === 'local/default'))
  } finally { h.done() }
})
