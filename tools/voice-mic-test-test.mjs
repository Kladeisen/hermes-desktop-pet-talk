// Settings "Test" microphone button: every test it starts is released by Stop or by closing the
// settings, including one whose permission prompt is still open. The real ConfigForm is rendered;
// only getUserMedia, AudioContext and animation frames are fakes. No microphone, audio or network.
// Run with: TALK_TEST_DEPS=/path/to/isolated/node_modules node --test tools/voice-mic-test-test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
const require = createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const { JSDOM } = require('jsdom')
const React = require('react')
const { jsx } = require('react/jsx-runtime')
const { createRoot } = require('react-dom/client')
const source = readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

async function mount({ meterFails = false } = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://hermes.test' })
  const w = dom.window
  Object.assign(globalThis, { window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true })
  const tracks = [], contexts = [], prompts = [], frames = new Map()
  let serial = 0
  const stream = () => { const track = { kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended' } }; tracks.push(track); return { getTracks: () => [track] } }
  // Each getUserMedia call waits like an open permission prompt until the test answers it.
  const mediaDevices = { enumerateDevices: async () => [], getUserMedia: () => { const prompt = deferred(); prompts.push(prompt); return prompt.promise } }
  const node = () => ({ gain: { value: 1 }, connect: target => target })
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = {}; contexts.push(this) }
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
    createAnalyser() { return { ...node(), fftSize: 512, getByteTimeDomainData: b => b.fill(128) } }
    createGain() { return node() }
    createMediaStreamSource() { if (meterFails) throw Error('meter failed'); return node() }
  }
  const atom = value => ({ get: () => value, set: next => { value = next }, listen: () => () => {} })
  const host = { state: { focusedSessionId: atom(''), focusedStoredSessionId: atom(''), focusedSessionProfile: atom(''), busyBySession: atom({}) }, onEvent: () => () => {}, notify: () => {} }
  const passthrough = ({ children }) => jsx('div', { children })
  const sdk = { host, Popover: passthrough, PopoverContent: passthrough, PopoverTrigger: passthrough, Dialog: passthrough, DialogContent: passthrough, DialogTitle: passthrough,
    Select: passthrough, SelectContent: passthrough, SelectItem: passthrough, SelectTrigger: passthrough, SelectValue: () => null,
    Switch: ({ checked, onCheckedChange, ...props }) => jsx('button', { ...props, role: 'switch', 'aria-checked': checked, onClick: () => onCheckedChange(!checked) }),
    Button: ({ children, onClick, disabled }) => jsx('button', { onClick, disabled, children }) }
  const context = vm.createContext({ window: w, document: w.document, navigator: { mediaDevices }, CustomEvent: w.CustomEvent, Event: w.Event, jsx, jsxs: jsx, sdk, AudioContext,
    useState: React.useState, useEffect: React.useEffect, useRef: React.useRef,
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial }, cancelAnimationFrame: id => frames.delete(id),
    performance: w.performance, setInterval, clearInterval, setTimeout, clearTimeout, console })
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'globalThis.plugin = {').replace(/^export (?=(?:async )?function |const |let |class )/gm, ''), context)
  const store = new Map()
  const ctx = { storage: { get: k => store.get(k), set: (k, v) => store.set(k, v) },
    rest: async path => { if (/session/.test(path)) throw Error('settings must never start a voice session'); return {} } }
  const root = createRoot(w.document.getElementById('root'))
  const act = fn => React.act(async () => { await fn?.(); for (let i = 0; i < 20; i++) await Promise.resolve() })
  await act(() => root.render(jsx(vm.runInContext('ConfigForm', context), { ctx })))
  const button = text => [...w.document.querySelectorAll('button')].find(b => b.textContent === text) || null
  let mounted = true
  return {
    w, act, button, prompts, stream,
    click: text => act(() => { const b = button(text); assert.ok(b !== null, 'no button ' + text); b.click() }),
    open: () => ({ tracks: tracks.filter(t => t.readyState === 'live').length, audio: contexts.filter(c => c.state !== 'closed').length, frames: frames.size }),
    unmount: () => act(() => { mounted = false; root.unmount() }),
    cleanup: async () => { if (mounted) await act(() => root.unmount()); w.close() },
  }
}
const IDLE = { tracks: 0, audio: 0, frames: 0 }

test('control: Test opens the mic meter and Stop releases the mic, audio context and frame loop', async () => {
  const h = await mount()
  try {
    await h.click('Test')
    assert.equal(h.prompts.length, 1)
    await h.act(() => h.prompts[0].resolve(h.stream()))
    assert.deepEqual(h.open(), { tracks: 1, audio: 1, frames: 1 })
    assert.ok(h.button('Stop') !== null)
    await h.click('Stop')
    assert.deepEqual(h.open(), IDLE)
    assert.ok(h.button('Test') !== null)
  } finally { await h.cleanup() }
})

test('Stop while the permission prompt is open: the mic granted afterwards is released at once', async () => {
  const h = await mount()
  try {
    await h.click('Test')
    await h.click('Stop')
    await h.act(() => h.prompts[0].resolve(h.stream()))
    assert.deepEqual(h.open(), IDLE, 'no capture after Stop')
    assert.ok(h.button('Test') !== null, 'the button stays on Test')
    assert.ok(!h.w.document.body.textContent.includes('Speak and watch the bar'), 'no meter hint for a stopped test')
  } finally { await h.cleanup() }
})

test('Closing settings while the permission prompt is open: the mic granted afterwards is released at once', async () => {
  const h = await mount()
  try {
    await h.click('Test')
    await h.unmount()
    await h.act(() => h.prompts[0].resolve(h.stream()))
    assert.deepEqual(h.open(), IDLE, 'no capture after the settings closed')
  } finally { await h.cleanup() }
})

test('Stop, then Test again: the first late grant is released and only the second test keeps the mic', async () => {
  const h = await mount()
  try {
    await h.click('Test')
    await h.click('Stop')
    await h.click('Test')
    await h.act(() => h.prompts[0].resolve(h.stream()))
    assert.deepEqual(h.open(), IDLE, 'the stopped test keeps nothing')
    await h.act(() => h.prompts[1].resolve(h.stream()))
    assert.deepEqual(h.open(), { tracks: 1, audio: 1, frames: 1 })
    await h.click('Stop')
    assert.deepEqual(h.open(), IDLE)
  } finally { await h.cleanup() }
})

test('A meter that fails to start releases the mic and the audio context, and says why', async () => {
  const h = await mount({ meterFails: true })
  try {
    await h.click('Test')
    await h.act(() => h.prompts[0].resolve(h.stream()))
    assert.deepEqual(h.open(), IDLE)
    assert.ok(h.w.document.body.textContent.includes('Could not open the microphone'))
    assert.ok(h.button('Test') !== null)
  } finally { await h.cleanup() }
})
