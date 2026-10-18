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
async function setup({ generic = true, rest } = {}) {
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
  const state = { focusedSessionId: atom(''), focusedStoredSessionId: atom(''), focusedSessionProfile: atom(''), busyBySession: atom({}) }
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
    Select: passthrough, SelectContent: passthrough, SelectItem: passthrough, SelectTrigger: passthrough, SelectValue: () => null,
    Switch: ({checked,onCheckedChange,...props}) => jsx('button',{...props,role:'switch','aria-checked':checked,onClick:()=>onCheckedChange(!checked)}),
    Button: ({ children, onClick }) => jsx('button', { onClick, children }) }
  const context = vm.createContext({ window: w, document: w.document, navigator: w.navigator, MutationObserver: w.MutationObserver, CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, jsx, jsxs, sdk,
    useState: React.useState, useEffect: React.useEffect, useRef: React.useRef,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w), performance: w.performance,
    setInterval, clearInterval, setTimeout, clearTimeout, console })
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'globalThis.plugin = {').replace(/^export (?=(?:async )?function |const |let |class )/gm, ''), context)
  const contributions = []; const disposers = []; let companion = null
  const store = new Map()
  context.plugin.register({ onDispose: fn => disposers.push(fn), registerOverlayCompanion: generic ? owner => { companion = owner; return () => {} } : undefined, register: c => contributions.push(c), storage: { get: k => store.get(k), set: (k, v) => store.set(k, v) }, rest: rest || (async () => ({ bots: [] })) })
  const root = createRoot(w.document.getElementById('root'))
  await React.act(async () => root.render(jsx(React.Fragment, { children: contributions.filter(c => c.render).map(c => jsx(React.Fragment, { children: c.render() }, c.id)) })))
  const flush = async fn => React.act(async () => { fn?.(); await new Promise(r => setTimeout(r, 0)) })
  const pet = () => {
    const parent = w.document.createElement('div'); parent.style.position = 'fixed'; parent.style.left = '120px'; parent.style.top = '80px'
    parent.innerHTML = '<div style="transform:scaleX(-1)"><canvas aria-label="Buddy pet" style="width:100px;height:120px"></canvas></div>'
    w.document.body.append(parent); return parent
  }
  const currentController = () => vm.runInContext('liveController', context)
  return { w, root, context, contributions, companion: currentController, dispose: () => disposers.splice(0).forEach(fn => fn()), flush, pet, errors, state, host, events, opened,
    focus: (runtime, stored, profile) => { state.focusedSessionId.set(runtime); state.focusedStoredSessionId.set(stored); state.focusedSessionProfile.set(profile) },
    emit: (type, event) => { for (const fn of events.get(type) || []) fn(event) },
    captures: () => captures, cleanup: async () => { await React.act(async () => { root.unmount(); disposers.forEach(fn => fn()) }); w.close() } }
}

test('chat confirmation defaults on, persists, and changes no active call', async () => {
  const h = await setup(); const store = new Map(); const requests = []
  const ctx = {storage:{get:k=>store.get(k),set:(k,v)=>store.set(k,v)},rest:async(path,options={})=>{requests.push({path,method:options.method||'GET'});return {bots:[]}}}
  const render = () => React.act(async()=>h.root.render(jsx(vm.runInContext('ConfigForm',h.context),{ctx})))
  const ask = () => h.w.document.querySelector('[aria-label="Ask before sending to chat"]')
  try {
    await h.flush(()=>vm.runInContext('bus.set({live:true,stage:"connected"})',h.context))
    await render()
    assert.ok(ask(),'confirmation switch must be present')
    assert.equal(ask().getAttribute('aria-checked'),'true')
    assert.match(h.w.document.body.textContent,/Applies to new calls/)
    assert.equal(h.w.document.querySelectorAll('[role="switch"]')[1],ask())
    await h.flush(()=>ask().click())
    assert.equal(store.get('askBeforeChat.v1'),'0')
    await React.act(async()=>h.root.render(null)); await render()
    assert.equal(ask().getAttribute('aria-checked'),'false','preference survives remount')
    await h.flush(()=>ask().click())
    await h.flush(()=>h.w.document.querySelector('[role="switch"]').click())
    assert.equal(ask().disabled,true,'Work in the chat remains the master switch')
    assert.equal(store.get('askBeforeChat.v1'),'1','disabled preference is retained')
    assert.equal(vm.runInContext('bus.live',h.context),true)
    assert.ok(requests.every(r=>r.method==='GET'&&!r.path.endsWith('/session')),'only existing read-only settings requests are allowed')
    assert.equal(h.captures(),0); assert.deepEqual(h.errors,[])
  } finally { await h.cleanup() }
})

test("settings say voice talks to the pet's linked chat, instead of offering a bot picker that does nothing", async () => {
  const h = await setup(); const store = new Map()
  const ctx = {storage:{get:k=>store.get(k),set:(k,v)=>store.set(k,v)},rest:async()=>({bots:['alpha-bot','beta-bot']})}
  try {
    await React.act(async()=>h.root.render(jsx(vm.runInContext('ConfigForm',h.context),{ctx})))
    await h.flush()
    const text = h.w.document.body.textContent
    assert.match(text, /Voice talks to the pet's linked chat\. Press the pet's chat button to link the chat you're in\./)
    assert.ok(!text.includes("Voice follows the chat you're in"), 'the old promise is gone')
    for (const gone of ['Auto (current window)', 'Luna (host)', 'alpha-bot', 'beta-bot']) assert.ok(!text.includes(gone), 'picker option still shown: ' + gone)
    assert.equal(store.has('lastProfile.v3'), false, 'no bot choice is stored')
    assert.equal(h.captures(),0); assert.deepEqual(h.errors,[])
  } finally { await h.cleanup() }
})

test('the transcript names a named bot with "(Bot)" but Hermes plainly', async () => {
  const h = await setup()
  const panel = () => h.w.document.body.textContent
  const render = async botName => {
    await h.flush(() => vm.runInContext(`bus.set({ botName: ${JSON.stringify(botName)} })`, h.context))
    await React.act(async () => h.root.render(jsx(vm.runInContext('LivePanel', h.context), {})))
  }
  try {
    await render('Hermes')
    assert.ok(panel().includes('Hermes'), 'the default profile is Hermes')
    assert.ok(!panel().includes('Hermes (Bot)'), 'no "(Bot)" after Hermes')
    assert.ok(!panel().includes('Luna'), 'the vendor fallback is gone')
    await render('Luna')
    assert.ok(panel().includes('Luna (Bot)'), 'a named bot keeps the "(Bot)" tag')
    assert.equal(h.captures(), 0); assert.deepEqual(h.errors, [])
  } finally { await h.cleanup() }
})

test('pop-out hides the complete in-app pet subtree through layout updates and restores it on close', async () => {
  const h = await setup()
  try {
    const pet = h.pet(); await h.flush()
    const composer = h.w.document.querySelector('[data-talk-live-toggle]')
    const setOpen = open => vm.runInContext(`petCompanion.open=${open};window.dispatchEvent(new CustomEvent('talk-desktop:companion'))`, h.context)
    for (let cycle = 0; cycle < 2; cycle++) {
      await h.flush(() => setOpen(true))
      await h.flush(() => h.w.dispatchEvent(new h.w.Event('resize')))
      await h.flush(() => h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:state')))
      for (const node of [pet, ...pet.querySelectorAll('*')]) {
        assert.equal(h.w.getComputedStyle(node).visibility, 'hidden', node.outerHTML.slice(0, 120))
        assert.equal(h.w.getComputedStyle(node).pointerEvents, 'none')
      }
      assert.equal(pet.hasAttribute('inert'), true)
      assert.equal(h.w.getComputedStyle(composer).visibility, 'visible', 'composer fallback stays available')
      await h.flush(() => setOpen(false))
      assert.equal(pet.hasAttribute('inert'), false)
      assert.equal(h.w.getComputedStyle(pet.querySelector('canvas')).visibility, 'visible')
      assert.equal(h.w.getComputedStyle(pet.querySelector('[data-talk-pet-popout]')).visibility, 'visible')
    }
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})

test('popped-out state follows pet remounts without overwriting existing visibility or inert state', async () => {
  const h = await setup()
  try {
    const first = h.pet(); first.style.visibility = 'collapse'; first.setAttribute('inert', 'existing')
    await h.flush()
    await h.flush(() => vm.runInContext("petCompanion.open=true;window.dispatchEvent(new CustomEvent('talk-desktop:companion'))", h.context))
    await h.flush(() => first.remove())
    assert.equal(first.hasAttribute('data-talk-pet-popped-out'), false)
    assert.equal(first.getAttribute('inert'), 'existing')
    assert.equal(first.style.visibility, 'collapse')
    const second = h.pet(); await h.flush()
    assert.equal(h.w.getComputedStyle(second.querySelector('[data-talk-pet-popout]')).visibility, 'hidden')
    assert.equal(second.hasAttribute('inert'), true)
    await h.flush(() => vm.runInContext("petCompanion.open=false;window.dispatchEvent(new CustomEvent('talk-desktop:companion'))", h.context))
    assert.equal(second.hasAttribute('inert'), false)
    assert.equal(h.w.getComputedStyle(second.querySelector('canvas')).visibility, 'visible')
  } finally { await h.cleanup() }
})

test('badge teardown removes companion listeners and restores its hidden anchor', async () => {
  const h = await setup()
  try {
    await React.act(async () => h.root.render(null))
    const active = new Set(), add = h.w.addEventListener.bind(h.w), remove = h.w.removeEventListener.bind(h.w)
    h.w.addEventListener = (type, fn, options) => { if (type === 'talk-desktop:companion') active.add(fn); add(type, fn, options) }
    h.w.removeEventListener = (type, fn, options) => { if (type === 'talk-desktop:companion') active.delete(fn); remove(type, fn, options) }
    await React.act(async () => h.root.render(jsx(React.Fragment, { children: h.contributions.filter(c => c.render).map(c => jsx(React.Fragment, { children: c.render() }, c.id)) })))
    const pet = h.pet(); await h.flush()
    await h.flush(() => vm.runInContext("petCompanion.open=true;window.dispatchEvent(new CustomEvent('talk-desktop:companion'))", h.context))
    assert.ok(active.size > 0)
    await React.act(async () => h.root.render(null))
    assert.equal(active.size, 0)
    assert.equal(pet.hasAttribute('data-talk-pet-popped-out'), false)
    assert.equal(pet.hasAttribute('inert'), false)
    assert.equal(h.w.getComputedStyle(pet.querySelector('canvas')).visibility, 'visible')
    await h.flush(() => h.w.dispatchEvent(new h.w.CustomEvent('talk-desktop:companion')))
    assert.equal(pet.hasAttribute('inert'), false)
  } finally { await h.cleanup() }
})

test('one descriptor specifies both surfaces, exact sizes and tail-free status box', async () => {
  const h = await setup()
  try {
    const d = h.companion().snapshot().descriptor
    assert.equal(d.version, 1)
    assert.equal(d.anchor, 'visible-art')
    assert.deepEqual(Array.from(d.controls, c => c.size), [36,36,24,24])
    assert.equal(d.statusBox.width, 200)
    assert.equal(d.statusBox.fontSize, 15)
    assert.equal(d.statusBox.lineHeight, 22)
    assert.equal(d.statusBox.radius, 10)
    assert.doesNotMatch(JSON.stringify(d), /"(?:tail|gear|html|script)"/i)
    assert.equal(h.context.plugin.name, 'Desktop-pet-talk')
    assert.equal(h.context.plugin.id, 'talk-desktop')
  } finally { await h.cleanup() }
})
test('owner tracks exact association after all UI unmounts and never follows a foreign completion', async () => {
  const h = await setup()
  try {
    await h.flush(() => { h.focus('ra','sa','owner-a'); h.state.busyBySession.set({ ra:true }) })
    await React.act(async () => h.root.render(null))
    h.focus('rb','sb','owner-b')
    h.emit('message.complete',{ session_id:'rb',profile:'owner-b' })
    assert.equal(h.companion().snapshot().status,'Working')
    await h.companion().action({action:'chat'})
    assert.equal(JSON.stringify(h.opened),JSON.stringify([{id:'sa',options:{profile:'owner-a',intent:'in-place'}}]))
    h.emit('message.complete',{session_id:'ra',profile:'owner-a'})
    assert.equal(h.companion().snapshot().status,'Finished')
    assert.equal(h.companion().snapshot().capabilities.includes('start'),false)
    h.dispose()
    assert.equal(h.state.busyBySession.listeners.size,0)
    assert.equal([...h.events.values()].reduce((n,v)=>n+v.size,0),0)
  } finally { await h.cleanup() }
})
test('missing association never captures audio or creates a session',async()=>{
  const h=await setup()
  try {
    assert.equal(h.companion().snapshot().capabilities.includes('start'),false)
    await assert.rejects(h.companion().action({action:'start'}))
    await assert.rejects(h.companion().action({action:'chat'}))
    assert.equal(h.captures(),0); assert.equal(h.opened.length,0)
  } finally { await h.cleanup() }
})
test('fresh verified focused chat advertises the same start through the pop-out',async()=>{
  let presented
  const h=await setup({rest:async(path,{body}={})=>{
    if(path.endsWith('/claim'))return {token:'fixture',generation:'fixture'}
    if(path.endsWith('/pulse')){presented=body.state;return {helper:true,commands:[]}}
    return path.endsWith('/launch')?{running:true}:{bots:[]}
  }})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
    h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    await h.flush(()=>h.focus('fresh-runtime','fresh-stored','default'))
    assert.ok(h.companion().snapshot().capabilities.includes('start'))
    await React.act(async()=>h.contributions.find(c=>c.id==='pet-pop-out').data.run())
    assert.ok(presented.capabilities.includes('start'),'transport must not discard a valid first start')
    assert.equal(presented.owner.storedId,'fresh-stored')
    assert.equal(vm.runInContext('petChat',h.context),null,'reading eligibility must not reassign the pet')
    assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})
test('one persistent call survives composer unmount and applies desired mute, then stops on disposal',async()=>{
  const h=await setup()
  try {
    await h.flush(()=>h.focus('r','s','owner'))
    vm.runInContext('startLive = async () => { window.starts=(window.starts||0)+1; bus.set({live:true,stage:"connected"}); return { setMuted: desired => bus.set({muted:desired}), close: () => {window.closes=(window.closes||0)+1;bus.set({live:false,stage:"idle"})} } }',h.context)
    await h.flush(()=>h.w.document.querySelector('[data-talk-live-toggle]').click())
    await React.act(async()=>h.root.render(null))
    await h.companion().action({action:'start'})
    await h.companion().action({action:'setMuted',muted:true})
    await h.companion().action({action:'setMuted',muted:true})
    assert.equal(h.companion().snapshot().muted,true)
    assert.equal(h.w.starts,1); assert.equal(h.w.closes,undefined)
    h.dispose(); assert.equal(h.w.closes,1)
  } finally { await h.cleanup() }
})
test('pending start cannot duplicate and a disposed owner closes a late handle',async()=>{
  const h=await setup()
  try {
    h.focus('r','s','owner')
    // Each start waits on its own answer. Start while connecting is a no-op; after Stop a redial starts at
    // once (follow-up #4: it used to wait for the old request), and every late answer closes itself.
    vm.runInContext('window.finishers=[];startLive = () => {window.starts=(window.starts||0)+1;return new Promise(resolve=>window.finishers.push(()=>resolve({close:()=>window.closes=(window.closes||0)+1})))}',h.context)
    const pending=h.companion().action({action:'start'})
    await h.companion().action({action:'start'})
    assert.equal(h.w.starts,1,'a second Start while connecting does not start twice')
    await h.companion().action({action:'stop'})
    const redial=h.companion().action({action:'start'})
    assert.equal(h.w.starts,2,'after hanging up, the redial starts at once')
    h.dispose();h.w.finishers.forEach(finish=>finish());await pending;await redial
    assert.equal(h.w.closes,2,'both late handles are closed')
    assert.equal(h.w.__talkLiveHandle,null)
  } finally { await h.cleanup() }
})
test('composer retains transcript while pet controller rejects removed transcript action',async()=>{
 const h=await setup()
 try {
  await h.flush(()=>vm.runInContext('bus.set({live:true,stage:"connected"});pushTranscript("user","private words")',h.context))
  const button=h.w.document.querySelector('[data-talk-live-transcript]');assert.ok(button)
  await h.flush(()=>button.click())
  assert.ok(h.w.document.body.textContent.includes('private words'))
  await assert.rejects(h.companion().action({action:'transcript'}),/Unknown action/)
  assert.doesNotMatch(JSON.stringify(h.companion().snapshot()),/private words/)
  assert.equal(h.captures(),0)
 } finally {await h.cleanup()}
})
test('descriptor follows voice state and mute with no duplicate presentation owner',async()=>{
  const h=await setup()
  try {
    vm.runInContext('bus.set({live:true,stage:"connected",muted:true})',h.context)
    const d=h.companion().snapshot().descriptor
    assert.equal(d.controls[0].action,'stop');assert.equal(d.controls[1].label,'unmute')
    assert.equal(h.contributions.filter(c=>c.id==='pet-live-badge').length,1)
  } finally { await h.cleanup() }
})

test('older host keeps the original in-app badge and current host has only generic presentation', async () => {
  const h = await setup({generic:false})
  try {
    const pet=h.pet();await h.flush()
    assert.ok(pet.querySelector('[data-talk-pet-mic]'))
    await h.flush(()=>{h.focus('r','s','a');h.state.busyBySession.set({r:true})})
    assert.equal(pet.querySelector('[data-talk-pet-status]').textContent,'Working')
    await h.flush(()=>pet.querySelector('[data-talk-pet-chat]').click())
    assert.equal(h.opened[0].id,'s')
    assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})
test('same profile on a different connection stops the captured voice owner',async()=>{
 const h=await setup({generic:false})
 try {
  // Install before creating a fresh controller to exercise actual SDK atom subscriptions.
  vm.runInContext('liveController.dispose()',h.context)
  const atom=initial=>{let value=initial;const listeners=new Set();return{get:()=>value,set:v=>{value=v;listeners.forEach(fn=>fn(v))},listen:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}}
  h.state.connectionId=atom('local');h.state.profile=atom('default');h.state.focusedSessionOwner=atom({connectionId:'local',profile:'default'})
  h.context.testCtx={storage:{get:()=>null},onDispose:()=>{}}
  vm.runInContext('liveController=createLiveController(testCtx);startLive=async()=>({close:()=>window.routeCloses=(window.routeCloses||0)+1})',h.context)
  h.focus('r','s','default');await h.companion().action({action:'start'})
  h.state.connectionId.set('remote-source')
  assert.equal(h.w.routeCloses,1)
  h.companion().dispose()
 }finally{await h.cleanup()}
})

test('chat navigation pins captured connection as well as durable ID and profile',async()=>{
 const h=await setup({generic:false})
 try {
  h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
  await h.flush(()=>{h.focus('r','s','default');h.state.busyBySession.set({r:true})})
  await h.companion().action({action:'chat'})
  assert.equal(h.opened[0].options.route?.connectionId,'local')
  assert.equal(h.opened[0].options.route?.profile,'default')
 }finally{await h.cleanup()}
})

test('shared layout reacts to plugin descriptor sizing rather than a second fixed layout',async()=>{
 const h=await setup({generic:false})
 try {
  const positions=vm.runInContext('(()=>{const d=petDescriptor(true,false);d.controls[0].size=40;d.controls[1].size=40;return petLayout({left:100,top:100,width:80,height:100},{width:800,height:600},{width:100,height:32},d).controls})()',h.context)
  assert.equal(positions[0].size,40)
  assert.equal(positions[1].top+46,positions[0].top)
  assert.equal(positions[2].left,positions[1].left+46)
 }finally{await h.cleanup()}
})

test('supported SDK alone exposes an explicit pop-out, without custom bridge registration', async () => {
  const h = await setup({generic:false})
  try {
    const command=h.contributions.find(c=>c.id==='pet-pop-out')
    assert.ok(command, 'explicit plugin-owned pop-out command missing')
    assert.equal(typeof command.data.run,'function')
    assert.equal(h.companion().registered,false)
    assert.equal(typeof h.companion().subscribe,'function')
  } finally {await h.cleanup()}
})

test('in-app pop-out toggles the shared transport once, deduplicates busy clicks, and never captures audio', async () => {
  const calls=[]; let finishLaunch
  const h=await setup({rest:async(path)=>{
    if (!path.startsWith('/companion/')) return {bots:[]}
    calls.push(path)
    if(path.endsWith('/claim')) return {token:'fixture-only',generation:'fixture-generation'}
    if(path.endsWith('/launch')) return new Promise(resolve=>{finishLaunch=()=>resolve({running:true})})
    return {helper:true,commands:[]}
  }})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
    h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    const pet=h.pet();await h.flush()
    const button=pet.querySelector('[data-talk-pet-popout]')
    assert.ok(button,'compact in-app pop-out button missing')
    assert.equal(button.title,'Pop out pet');assert.equal(button.style.width,'24px');assert.equal(button.style.borderRadius,'50%')
    await h.flush(()=>{button.click();button.click();void h.contributions.find(c=>c.id==='pet-pop-out').data.run()})
    assert.equal(calls.filter(p=>p.endsWith('/launch')).length,1)
    assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-busy'),'true')
    await h.flush(()=>finishLaunch())
    assert.equal(button.title,'Close pop-out pet');assert.equal(button.getAttribute('aria-pressed'),'true')
    const controls=[pet.querySelector('[data-talk-pet-chat]'),pet.querySelector('[data-talk-pet-action="bots"]'),button]
    const bottoms=controls.map(b=>parseFloat(b.style.bottom))
    assert.ok(bottoms[0]-bottoms[1]>=24 && bottoms[1]-bottoms[2]>=24,'secondary controls must not overlap')
    await h.flush(()=>button.click())
    assert.equal(calls.filter(p=>p.endsWith('/release')).length,1)
    assert.equal(button.title,'Pop out pet');assert.equal(h.captures(),0)
    await React.act(async()=>h.root.render(null))
    assert.equal(pet.querySelector('[data-talk-pet-popout]'),null)
  } finally {await h.cleanup()}
})

test('SDK empty default gateway profile matches normalized focused owner, and helper closure updates the button', async()=>{
  let helper=true;const calls=[]
  const h=await setup({rest:async path=>{if(!path.startsWith('/companion/'))return {bots:[]};calls.push(path);return path.endsWith('/claim')?{token:'fixture',generation:'fixture'}:path.endsWith('/launch')?{running:true}:{helper,commands:[]}}})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> ''};h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    const pet=h.pet();await h.flush();const button=pet.querySelector('[data-talk-pet-popout]')
    await h.flush(()=>button.click());assert.equal(button.title,'Close pop-out pet')
    helper=false;await h.flush();await new Promise(r=>setTimeout(r,240));await h.flush()
    assert.equal(button.title,'Pop out pet');assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})

test('pop-out failures are readable beside the pet and foreign or unknown owners never claim',async()=>{
  const h=await setup();const notices=[];h.host.notify=n=>notices.push(n)
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'};h.state.focusedSessionOwner={get:()=>null}
    const pet=h.pet();await h.flush();const button=pet.querySelector('[data-talk-pet-popout]')
    await h.flush(()=>button.click())
    assert.match(pet.querySelector('[data-talk-pet-status]').textContent,/focused.*owner/i)
    assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(notices.length,1);assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})

test('disposal while initial presentation is pending cannot launch a late native helper',async()=>{
  const calls=[];let finishPulse
  const h=await setup({rest:async path=>{if(!path.startsWith('/companion/'))return {bots:[]};calls.push(path);if(path.endsWith('/claim'))return {token:'fixture',generation:'fixture'};if(path.endsWith('/pulse'))return new Promise(resolve=>finishPulse=()=>resolve({helper:false,commands:[]}));return {}}})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'};h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    const pet=h.pet();await h.flush();await h.flush(()=>pet.querySelector('[data-talk-pet-popout]').click())
    h.dispose();await h.flush(()=>finishPulse())
    assert.equal(calls.filter(p=>p.endsWith('/launch')).length,0,'disposed transport must not launch a native helper')
    assert.equal(calls.filter(p=>p.endsWith('/release')).length,1);assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})

test('remote, cross-profile, cross-source and unresolved owners fail closed without REST claims',async()=>{
  for(const [connection,profile,focused] of [
    ['remote','default',{connectionId:'remote',profile:'default'}],
    ['local','default',{connectionId:'local',profile:'worker'}],
    ['local','default',{connectionId:'remote',profile:'default'}],
    [null,'default',{connectionId:'local',profile:'default'}],
    ['local','default',null]
  ]) {
    let claims=0;const h=await setup({rest:async p=>{if(p.endsWith('/claim'))claims++;return {bots:[]}}})
    try {
      h.state.connectionId={get:()=>connection};h.state.profile={get:()=>profile};h.state.focusedSessionOwner={get:()=>focused}
      const pet=h.pet();await h.flush();await h.flush(()=>pet.querySelector('[data-talk-pet-popout]').click())
      assert.equal(claims,0);assert.equal(h.captures(),0);assert.ok(pet.querySelector('[data-talk-pet-status]').textContent)
    } finally {await h.cleanup()}
  }
})

test('native runtime launch failure releases the lease and leaves a readable retry state',async()=>{
  const calls=[];const h=await setup({rest:async p=>{if(!p.startsWith('/companion/'))return {bots:[]};calls.push(p);if(p.endsWith('/claim'))return {token:'fixture',generation:'fixture'};if(p.endsWith('/launch'))throw Error('Missing native runtime: GTK');return {helper:false,commands:[]}}})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'};h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    const pet=h.pet();await h.flush();await h.flush(()=>pet.querySelector('[data-talk-pet-popout]').click())
    const button=pet.querySelector('[data-talk-pet-popout]');assert.equal(button.title,'Pop out pet');assert.equal(button.disabled,false)
    assert.match(pet.querySelector('[data-talk-pet-status]').textContent,/Missing native runtime/);assert.equal(calls.filter(p=>p.endsWith('/release')).length,1);assert.equal(h.captures(),0)
  }finally{await h.cleanup()}
})

test('idle in-app rail hides unavailable chat and mute while bot toggle stays available', async () => {
  const h=await setup()
  try {
    const pet=h.pet(); await h.flush()
    for(const selector of ['[data-talk-pet-chat]','[data-talk-pet-action="mute"]']) {
      const button=pet.querySelector(selector)
      assert.ok(button.hidden || h.w.getComputedStyle(button).display==='none', selector+' must be absent, not just disabled')
    }
    assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})

test('late voice work without an owner cannot fall back to the newly focused chat', async () => {
  const h=await setup()
  try {
    h.focus('new-runtime','new-stored','new-profile')
    let requests=0
    h.host.request=async()=>{requests++;h.emit('message.complete',{session_id:'new-runtime',text:'wrong chat'})}
    const result=await vm.runInContext('delegateToChat("late voice task")',h.context)
    assert.equal(requests,0,'no live owner means no prompt.submit, even when another chat is focused')
    assert.match(result,/No conversation/)
  } finally {await h.cleanup()}
})

test('completed pop-out actions acknowledge promptly without waiting for an idle poll', {timeout:10000}, async () => {
  const queued=[], receipts=new Map(), samples=[], lease={token:'fixture',generation:'fixture'}
  let completedAt=0, opened=0, pulseCount=0
  const h=await setup({rest:async(path,{body}={})=>{
    if(path.endsWith('/claim'))return lease
    if(path.endsWith('/launch'))return {running:true}
    if(!path.endsWith('/pulse'))return {bots:[]}
    pulseCount++
    for(const ack of body.acks) {
      receipts.set(ack.id,{ok:ack.ok,at:performance.now(),completedAt})
      const index=queued.findIndex(command=>command.id===ack.id)
      if(index>=0)queued.splice(index,1)
    }
    return {helper:true,commands:queued.slice()}
  }})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
    h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    await h.flush(()=>{h.focus('ack-runtime','ack-stored','default');h.state.busyBySession.set({'ack-runtime':true})})
    h.host.openSession=async id=>{assert.equal(id,'ack-stored');opened++;completedAt=performance.now()}
    await React.act(async()=>{
      await h.contributions.find(c=>c.id==='pet-pop-out').data.run()
      for(let i=0;i<10;i++) {
        const id='ack-sample-'+i, queuedAt=performance.now()
        queued.push({id,generation:lease.generation,action:'chat'})
        while(!receipts.has(id) && performance.now()-queuedAt<1000)await new Promise(resolve=>setTimeout(resolve,5))
        const receipt=receipts.get(id)
        assert.ok(receipt,'completed action must be acknowledged');assert.equal(receipt.ok,true)
        samples.push({queuedToAckMs:receipt.at-queuedAt,completedToAckMs:receipt.at-receipt.completedAt})
      }
      const idleStart=pulseCount
      await new Promise(resolve=>setTimeout(resolve,450))
      assert.ok(pulseCount-idleStart<=3,'idle polling must not accelerate')
    })
    console.log('PET_ACK_MEASUREMENT '+JSON.stringify({real:'renderer transport and controller',simulated:'broker REST and chat navigation',samples}))
    assert.equal(opened,10,'each command must execute once');assert.equal(h.captures(),0)
    assert.ok(Math.max(...samples.map(s=>s.completedToAckMs))<100,'completed actions must not wait for the 200ms idle poll')
  } finally {await h.cleanup()}
})

test('both pets share rendered controls across everyday states and composer absence',async()=>{
  const shared=source.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
  const nativeHtml=readFileSync(new URL('../companion/view.html',import.meta.url),'utf8').replace(/<script[\s\S]*?<\/script>/g,'')
  const nativeSource=readFileSync(new URL('../companion/view.js',import.meta.url),'utf8')
  const rows=[]
  for(const mode of ['no-chat','idle-chat','connecting','offering','live','muted','stopped','settings']) {
    const h=await setup(),n=new JSDOM(nativeHtml,{runScripts:'outside-only',pretendToBeVisual:true}),w=n.window
    const posted=[]
    let connecting
    try {
      w.HTMLCanvasElement.prototype.getContext=()=>({});w.Image=class{};w.webkit={messageHandlers:{companion:{postMessage:value=>posted.push(JSON.parse(value))}}}
      w.eval(shared+'\n'+nativeSource)
      const pet=h.pet();await h.flush()
      if(mode!=='no-chat')await h.flush(()=>h.focus('parity-runtime','parity-stored','default'))
      vm.runInContext('startLive=async()=>{bus.set({live:true,stage:"connected",bands:[.2,.5,.8,.5,.2]});return {setMuted:muted=>bus.set({muted}),close:()=>bus.set({live:false,stage:"idle",muted:false})}}',h.context)
      if(['connecting','offering'].includes(mode))vm.runInContext('startLive=()=>new Promise(resolve=>window.finish=()=>resolve({close(){}}))',h.context)
      if(!['no-chat','idle-chat'].includes(mode))await h.flush(()=>{connecting=h.companion().action({action:'start'})})
      if(mode==='offering')await h.flush(()=>vm.runInContext('bus.set({live:true,stage:"offering"})',h.context))
      if(mode==='muted')await h.flush(()=>h.companion().action({action:'setMuted',muted:true}))
      if(mode==='stopped'){await h.flush(()=>vm.runInContext('pushTranscript("user","fixture")',h.context));await h.flush(()=>h.companion().action({action:'stop'}))}
      if(mode==='settings')await React.act(async()=>h.root.render(jsx(React.Fragment,{children:h.contributions.filter(c=>c.render&&c.id!=='composer-live').map(c=>jsx(React.Fragment,{children:c.render()},c.id))})))
      if(mode==='settings')assert.equal(h.w.document.querySelector('[data-talk-live-toggle]'),null)
      await React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,130))})
      const state=JSON.parse(JSON.stringify({...h.companion().snapshot(),owner:vm.runInContext('petChat',h.context)}));w.petReceive({generation:'fixture',state,acks:{}})
      const inApp=[pet.querySelector('[data-talk-pet-mic]'),pet.querySelector('[data-talk-pet-action="mute"]'),pet.querySelector('[data-talk-pet-chat]'),pet.querySelector('[data-talk-pet-action="bots"]')]
      const native=[...w.document.querySelectorAll('button[data-action]')]
      const pick=(button,window,index)=>({action:button.dataset.action||state.descriptor.controls[index].action,visible:!button.hidden&&window.getComputedStyle(button).display!=='none'&&button.style.visibility!=='hidden',disabled:button.disabled,width:button.style.width,height:button.style.height,html:button.innerHTML,border:button.style.borderWidth,padding:button.style.padding,shadow:button.style.boxShadow,title:button.title,pressed:button.getAttribute('aria-pressed')})
      rows.push({mode,inApp:inApp.map((b,i)=>pick(b,h.w,i)),native:native.map((b,i)=>pick(b,w,i))})
      const expected=['no-chat','idle-chat'].includes(mode)?['start','bots']:mode==='connecting'?['stop','chat','bots']:mode==='stopped'?['start','chat','bots']:['stop','setMuted','chat','bots']
      assert.deepEqual(rows.at(-1).inApp.filter(b=>b.visible).map(b=>b.action),expected,mode)
      assert.equal(inApp[0].disabled,mode==='no-chat')
      const positions=(buttons,native)=>buttons.map(b=>({x:parseFloat(b.style.left),y:native?parseFloat(b.style.top):120-parseFloat(b.style.bottom)-parseFloat(b.style.height)})).map((p,i,a)=>({x:p.x-a[0].x,y:p.y-a[0].y}))
      assert.deepEqual(positions(native,true),positions(inApp,false),'shared relative placement: '+mode)
      if(mode==='offering') {
        assert.equal(inApp[3].disabled,false);assert.equal(native[3].disabled,false)
        native[3].click();const command=posted.findLast(p=>p.type==='command').command
        assert.equal(command.action,'bots')
      }
      if(['live','muted','settings'].includes(mode)) {
        await h.flush(()=>inApp[0].dispatchEvent(new h.w.MouseEvent('mouseover',{bubbles:true})));native[0].dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}))
        assert.equal(native[0].innerHTML,inApp[0].innerHTML);assert.ok(native[0].querySelector('svg[style*="133deg"]'))
        await h.flush(()=>inApp[0].dispatchEvent(new h.w.MouseEvent('mouseout',{bubbles:true})));native[0].dispatchEvent(new w.MouseEvent('mouseout',{bubbles:true}))
      }
      assert.equal(h.captures(),0)
      assert.deepEqual(h.errors,[])
    }finally{w.close();await h.flush(()=>{h.dispose();h.w.finish?.()});await connecting;await h.cleanup()}
  }
  assert.equal(rows.length,8)
  for(const row of rows)assert.deepEqual(row.native,row.inApp,row.mode)
  console.log('PET_PARITY_MATRIX '+JSON.stringify(rows.map(row=>({state:row.mode,pass:true,buttons:row.native.filter(b=>b.visible).map(({action,disabled})=>({action,disabled}))}))))
})

test('urgent acknowledgements retain retry backoff, serialization and disposal', {timeout:5000}, async () => {
  const lease={token:'fixture',generation:'fixture'}, command={id:'failed-chat',generation:'fixture',action:'chat'}
  const lateCommand={...command,id:'late-chat'}
  let launched=false, pending=true, finishAction, finishLateAction, completedAt=0, firstAckAt=0, retryAt=0, active=0, maxActive=0, pulses=0, opened=0
  const h=await setup({rest:async(path,{body}={})=>{
    if(path.endsWith('/claim'))return lease
    if(path.endsWith('/launch')){launched=true;return {running:true}}
    if(!path.endsWith('/pulse'))return {bots:[]}
    pulses++;maxActive=Math.max(maxActive,++active)
    try {
      if(body.acks.length) {
        assert.equal(body.acks[0].ok,false,'rejected actions must not be reported as successful')
        if(!firstAckAt){firstAckAt=performance.now();setTimeout(()=>finishLateAction(),20);throw Error('fixture network failure')}
        retryAt=performance.now();pending=false
      }
      if(finishAction){finishAction();finishAction=null;await new Promise(resolve=>setTimeout(resolve,20))}
      return {helper:true,commands:launched && pending ? [command,lateCommand] : []}
    } finally {active--}
  }})
  try {
    h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
    h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
    await h.flush(()=>{h.focus('retry-runtime','retry-stored','default');h.state.busyBySession.set({'retry-runtime':true})})
    h.host.openSession=()=>{opened++;return new Promise((resolve,reject)=>{
      if(opened===1)finishAction=()=>{completedAt=performance.now();reject(Error('fixture navigation unavailable'))}
      else finishLateAction=()=>reject(Error('fixture second navigation unavailable'))
    })}
    await React.act(async()=>{
      await h.contributions.find(c=>c.id==='pet-pop-out').data.run()
      const deadline=performance.now()+2000
      while(!retryAt && performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5))
      assert.ok(retryAt,'failed acknowledgement must be retried')
      assert.ok(firstAckAt-completedAt<100,'completion during an active pulse must flush after its reply')
      assert.ok(retryAt-firstAckAt>=180,`a later completion must retain retry backoff; observed ${retryAt-firstAckAt} ms`)
      assert.equal(opened,2,'each command must execute once despite repeats');assert.equal(maxActive,1)
      h.dispose();const stoppedAt=pulses
      await new Promise(resolve=>setTimeout(resolve,250));assert.equal(pulses,stoppedAt)
    })
    assert.equal(h.captures(),0)
  } finally {await h.cleanup()}
})
test('idle chat button retargets to the selected Hermes chat and opens it',async()=>{
  const h=await setup()
  try {
    await h.flush(()=>h.focus('ra','sa','owner'))
    assert.ok(h.companion().snapshot().capabilities.includes('chat'),'selected chat makes the button usable without a prior link')
    await h.companion().action({action:'chat'})
    await h.flush(()=>h.focus('rb','sb','owner'))
    await h.companion().action({action:'chat'})
    assert.deepEqual(h.opened.map(o=>o.id),['sa','sb'],'each idle press opens the chat selected at that moment')
    assert.equal(h.companion().startTarget().runtimeId,'rb','next call targets the retargeted chat')
    assert.equal(h.captures(),0)
  } finally { await h.cleanup() }
})
test('chat button keeps its link while the linked chat works or a call is live',async()=>{
  const h=await setup()
  try {
    await h.flush(()=>{h.focus('ra','sa','owner');h.state.busyBySession.set({ra:true})})
    await h.flush(()=>h.focus('rb','sb','owner'))
    await h.companion().action({action:'chat'})
    assert.equal(h.opened.at(-1).id,'sa','working link is not stolen')
    await h.flush(()=>{h.state.busyBySession.set({});vm.runInContext('bus.set({live:true,stage:"connected"})',h.context)})
    await h.companion().action({action:'chat'})
    assert.equal(h.opened.at(-1).id,'sa','live call keeps its chat')
    await h.flush(()=>vm.runInContext('bus.set({live:false,stage:"idle"})',h.context))
    await h.companion().action({action:'chat'})
    assert.equal(h.opened.at(-1).id,'sb','once idle, the press moves to the selected chat')
  } finally { await h.cleanup() }
})
test('a finished result keeps the chat button on that chat until the status clears',async()=>{
  const h=await setup()
  try {
    await h.flush(()=>{h.focus('ra','sa','owner');h.state.busyBySession.set({ra:true})})
    await h.flush(()=>{h.emit('message.complete',{session_id:'ra',profile:'owner'});h.state.busyBySession.set({})})
    await h.flush(()=>h.focus('rb','sb','owner'))
    await h.companion().action({action:'chat'})
    assert.equal(h.opened.at(-1).id,'sa','Finished bubble still opens its result')
  } finally { await h.cleanup() }
})
test('profile switch stops captured call; afterwards an idle press follows the selected chat',async()=>{
  const h=await setup()
  try {
    h.focus('ra','sa','a')
    vm.runInContext('startLive = async () => {bus.set({live:true,stage:"connected"});return {close:()=>{window.closes=(window.closes||0)+1;bus.set({live:false,stage:"idle"})}}}',h.context)
    await h.companion().action({action:'start'})
    h.focus('rb','sb','b')
    assert.equal(h.w.closes,1)
    await h.companion().action({action:'chat'})
    assert.equal(h.opened[0].id,'sb');assert.equal(h.opened[0].options.profile,'b')
  } finally { await h.cleanup() }
})
test('needs-you badge: pushed approval outranks Working on both pets and clears on resolve', async () => {
  const calls = []
  const h = await setup({ generic: false, rest: async path => { calls.push(path); return path === '/attention' ? { boot: 'b1', seq: 0, requests: [] } : { bots: [] } } })
  try {
    const pet = h.pet(); await h.flush()
    assert.ok(calls.includes('/attention'), 'snapshot fetched on load')
    await h.flush(() => { h.focus('r', 's', 'a'); h.state.busyBySession.set({ r: true }) })
    const status = () => pet.querySelector('[data-talk-pet-status]').textContent
    assert.equal(status(), 'Working')
    assert.equal(h.companion().snapshot().attention, undefined, 'no field while nothing waits')
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { type: 'plugin.talk-desktop.attention', payload: { boot: 'b1', seq: 1, requests: [{ id: 'q1', kind: 'approval', session_id: 'x', since: 5 }] } }))
    assert.equal(status(), 'Needs approval')
    assert.deepEqual({ ...h.companion().snapshot().attention }, { kind: 'approval', count: 1 })
    // an older frame cannot resurrect or override newer state
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { payload: { boot: 'b1', seq: 0, requests: [] } }))
    assert.equal(status(), 'Needs approval')
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { payload: { boot: 'b1', seq: 2, requests: [{ id: 'q1', kind: 'approval', since: 5 }, { id: 'q2', kind: 'clarify', since: 9 }] } }))
    assert.equal(status(), 'Needs approval', 'oldest wait leads')
    assert.equal(h.companion().snapshot().attention.count, 2)
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { payload: { boot: 'b1', seq: 3, requests: [{ id: 'q2', kind: 'clarify', since: 9 }] } }))
    assert.equal(status(), 'Question for you')
    // malformed kinds are ignored rather than shown
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { payload: { boot: 'b1', seq: 4, requests: [{ id: 'z', kind: 'secret' }] } }))
    assert.equal(status(), 'Working')
    assert.equal(h.companion().snapshot().attention, undefined)
    // a restarted backend (new boot) is accepted even with a lower seq
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { payload: { boot: 'b2', seq: 1, requests: [{ id: 's1', kind: 'sudo', since: 1 }] } }))
    assert.equal(status(), 'Needs password')
    await h.flush(() => h.emit('plugin.talk-desktop.attention', { payload: { boot: 'b2', seq: 2, requests: [] } }))
    assert.equal(status(), 'Working')
    assert.equal(h.captures(), 0)
  } finally { await h.cleanup() }
})
test('needs-you badge: reconnect re-syncs from the backend snapshot and disposal unsubscribes', async () => {
  let open = [{ id: 'q1', kind: 'approval', since: 1 }], seq = 0
  const h = await setup({ generic: false, rest: async path => path === '/attention' ? { boot: 'b', seq: ++seq, requests: open } : { bots: [] } })
  try {
    const pet = h.pet(); await h.flush()
    const status = () => pet.querySelector('[data-talk-pet-status]').textContent
    assert.equal(status(), 'Needs approval', 'a wait that opened before the renderer loaded is shown')
    open = []
    await h.flush(() => h.emit('gateway.ready', { type: 'gateway.ready' }))
    await h.flush()
    assert.notEqual(status(), 'Needs approval')
    h.dispose()
    assert.equal((h.events.get('plugin.talk-desktop.attention') || new Set()).size, 0)
  } finally { await h.cleanup() }
})

// Real installAttention with fake REST and manual timers, so retries can be stepped without waiting.
function attentionHarness(answers) {
  const body = source.slice(source.indexOf('const ATTENTION_EVENT ='), source.indexOf('// ── Bot pets:'))
  let serial = 0, calls = 0
  const timers = new Map()
  const context = vm.createContext({ console, petCompanion: { helper: false },
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type } },
    host: { onEvent: () => () => {} },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
    ctx: { rest: async () => { const answer = answers[Math.min(calls++, answers.length - 1)]; if (answer instanceof Error) throw answer; return answer } } })
  vm.runInContext(body + '\n globalThis.dispose = installAttention(ctx); globalThis.waits = () => petAttention.requests.length', context)
  const settle = () => new Promise(r => setImmediate(r))
  const fire = async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await settle() }
  return { timers, settle, fire, calls: () => calls, waits: () => context.waits(), dispose: () => context.dispose() }
}
const openWait = seq => ({ boot: 'b', seq, requests: [{ id: 'q', kind: 'clarify', profile: 'default', since: 100 }] })
test('needs-you badge: a failed refresh while a wait is open retries and clears the stale wait', async () => {
  const h = attentionHarness([openWait(1), Error('temporary connection failure'), { boot: 'b', seq: 2, requests: [] }])
  await h.settle()
  assert.equal(h.waits(), 1)
  await h.fire()
  assert.equal(h.calls(), 2)
  assert.equal(h.timers.size, 1, 'a failed refresh must schedule a retry while a wait is open')
  await h.fire()
  assert.equal(h.waits(), 0, 'the retry clears the resolved wait')
  assert.equal(h.timers.size, 0, 'nothing open, nothing to poll')
  h.dispose()
})
test('needs-you badge: a failed initial load retries until it sees existing waits', async () => {
  const h = attentionHarness([Error('backend not up yet'), openWait(1)])
  await h.settle()
  assert.equal(h.timers.size, 1, 'initial load failure schedules a retry')
  await h.fire()
  assert.equal(h.waits(), 1)
  h.dispose()
})
test('needs-you badge: retries after failures are bounded and back off', async () => {
  const h = attentionHarness([openWait(1), Error('down')])
  await h.settle()
  const delays = []
  for (let n = 0; n < 20 && h.timers.size; n++) { delays.push(h.timers.values().next().value.ms); await h.fire() }
  assert.equal(h.timers.size, 0, 'a backend that stays down is not polled forever')
  assert.ok(delays.length < 20)
  const retries = delays.slice(1)
  assert.ok(retries.length >= 3, 'more than one retry')
  for (let i = 1; i < retries.length; i++) assert.ok(retries[i] >= retries[i - 1], 'never faster than the previous retry')
  assert.ok(Math.max(...retries) <= 30000)
  h.dispose()
})
test('needs-you badge: disposal cancels a pending retry', async () => {
  const h = attentionHarness([Error('down')])
  await h.settle()
  assert.equal(h.timers.size, 1)
  h.dispose()
  assert.equal(h.timers.size, 0)
})

test('bot toggle replaces pet transcript and controller starts each registration off', async () => {
 const h=await setup()
 try {
  const pet=h.pet(); await h.flush()
  assert.equal(h.companion().snapshot().botsEnabled,false)
  assert.ok(h.companion().snapshot().capabilities.includes('bots'))
  assert.equal(pet.querySelector('[data-talk-pet-action="transcript"]'),null)
  const toggle=pet.querySelector('[data-talk-pet-action="bots"]'); assert.ok(toggle)
  await h.flush(()=>toggle.click())
  assert.equal(h.companion().snapshot().botsEnabled,true)
  assert.equal(toggle.getAttribute('aria-pressed'),'true')
  await h.companion().action({action:'bots'})
  assert.equal(h.companion().snapshot().botsEnabled,false)
  assert.equal(h.captures(),0)
 } finally {await h.cleanup()}
})

test('bot-only helper keeps the main pet in app and native pet close preserves bots', async () => {
 const calls=[]
 const h=await setup({rest:async(path,{body}={})=>{
  calls.push({path,body})
  if(path.endsWith('/claim'))return {token:'fixture',generation:'fixture'}
  if(path.endsWith('/launch'))return {running:true}
  return {helper:true,commands:[]}
 }})
 try {
  h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
  h.host.request=async()=>({profiles:[{name:'alpha',canonical_session:{id:'a'}}]})
  await h.flush(()=>h.companion().action({action:'bots'}))
  await new Promise(r=>setTimeout(r,180))
  assert.equal(calls.filter(c=>c.path.endsWith('/launch')).length,1)
  assert.equal(vm.runInContext('petCompanion.open',h.context),false)
  const published=calls.filter(c=>c.path.endsWith('/pulse')).at(-1).body.state
  assert.equal(published.petVisible,false)
  assert.equal(published.bots[0].id,'alpha')
  assert.equal('avatar' in published.bots[0],false)
  h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
  await h.contributions.find(c=>c.id==='pet-pop-out').data.run()
  assert.equal(vm.runInContext('petCompanion.open',h.context),true)
  await h.companion().action({action:'hidePet'})
  assert.equal(vm.runInContext('petCompanion.open',h.context),false)
  assert.equal(calls.some(c=>c.path.endsWith('/release')),false)
  assert.equal(h.companion().snapshot().bots[0].id,'alpha')
 } finally {await h.cleanup()}
})

test('bot commands route by validated bot identity and waits remain on the main pet until helper visible', async () => {
 const queued=[]
 const h=await setup({rest:async(path,{body}={})=>{
  if(path.endsWith('/claim'))return {token:'fixture',generation:'fixture'}
  if(path.endsWith('/launch'))return {running:true}
  if(path.endsWith('/pulse'))return {helper:true,commands:queued.splice(0)}
  return {requests:[],bots:[]}
 }})
 try {
  h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
  h.host.request=async()=>({profiles:[{name:'alpha',canonical_session:{id:'a'}},{name:'beta',canonical_session:{id:'b'}}]})
  await h.flush(()=>vm.runInContext('botTracker.setEnabled(true)',h.context))
  vm.runInContext("petAttention.requests=[{profile:'alpha',kind:'clarify'},{profile:'beta',kind:'sudo'}]",h.context)
  assert.equal(h.companion().snapshot().attention.count,2)
  await h.flush(()=>vm.runInContext('petCompanion.syncBots()',h.context))
  assert.equal(h.companion().snapshot().attention,undefined)
  queued.push({id:'alpha-chat',generation:'fixture',action:'botChat',bot:'alpha'})
  await new Promise(r=>setTimeout(r,240))
  assert.equal(h.opened[0].id,'a'); assert.equal(h.opened[0].options.profile,'alpha')
  await h.companion().action({action:'botDismiss',bot:'alpha'})
  assert.equal(h.companion().snapshot().attention.kind,'clarify')
  await assert.rejects(h.companion().action({action:'botChat',bot:'alpha'}),/unavailable/)
 } finally {await h.cleanup()}
})

for (const changed of ['connection', 'profile', 'close']) test(`bot-only promotion pending publication respects ${changed}`, async () => {
 let hold=false, finishPulse, connection='local', profile='default'; const calls=[]
 const h=await setup({rest:async(path)=>{
  calls.push({path,connection,profile})
  if(path.endsWith('/claim'))return {token:'fixture',generation:'fixture'}
  if(path.endsWith('/pulse') && hold)return new Promise(resolve=>finishPulse=()=>resolve({helper:true,commands:[]}))
  if(path.endsWith('/launch'))return {running:true}
  return {helper:true,commands:[]}
 }})
 try {
  h.state.connectionId={get:()=>connection};h.state.profile={get:()=>profile}
  h.state.focusedSessionOwner={get:()=>({connectionId:'local',profile:'default'})}
  h.host.request=async()=>({profiles:[{name:'alpha'}]})
  await h.companion().action({action:'bots'})
  hold=true
  const pending=h.contributions.find(c=>c.id==='pet-pop-out').data.run()
  assert.ok(finishPulse)
  if(changed==='connection')connection='remote'
  if(changed==='profile')profile='alpha'
  if(changed==='close')await h.companion().action({action:'hidePet'})
  hold=false; finishPulse(); await pending
  assert.equal(calls.filter(c=>c.path.endsWith('/launch')).length,1,'must not launch after cancellation or with a stale lease')
  assert.equal(vm.runInContext('petCompanion.open',h.context),false)
  if(changed!=='close')assert.equal(calls.some(c=>c.connection!=='local' || c.profile!=='default'),false,'must never send the lease to another route')
 } finally {hold=false;finishPulse?.();await h.cleanup()}
})

test('disabling bots during initial publication prevents a late bot-only launch', async () => {
 let releasePulse; const calls=[]
 const h=await setup({rest:async(path)=>{
  calls.push(path)
  if(path.endsWith('/claim'))return {token:'fixture',generation:'fixture'}
  if(path.endsWith('/pulse'))return new Promise(resolve=>releasePulse=()=>resolve({helper:false,commands:[]}))
  if(path.endsWith('/launch'))return {running:true}
  return {}
 }})
 try {
  h.state.connectionId={get:()=> 'local'};h.state.profile={get:()=> 'default'}
  h.host.request=async()=>({profiles:[{name:'alpha'}]})
  let pending; await h.flush(()=>{pending=h.companion().action({action:'bots'})})
  await h.companion().action({action:'bots'});releasePulse();await pending
  assert.equal(calls.some(p=>p.endsWith('/launch')),false)
  assert.equal(vm.runInContext('petCompanion.helper',h.context),false)
 } finally {await h.cleanup()}
})
