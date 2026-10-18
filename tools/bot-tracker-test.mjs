import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const source = fs.readFileSync(process.env.TALK_TEST_PLUGIN || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const contract = JSON.parse(fs.readFileSync(new URL('./fixtures/bot-gateway-contract.json', import.meta.url), 'utf8'))

test('real start frame arriving during roster discovery survives to Working and Finished', async () => {
  let resolve
  const f=fixture(() => new Promise(r => { resolve=r }))
  try {
    f.tracker.setEnabled(true)
    f.wire(contract.events[0]) // _event_frame has no payload on message.start
    resolve(contract.cliRoster)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(f.tracker.bots()[0].status, 'Working')
    f.wire(contract.events[1])
    assert.equal(f.tracker.bots()[0].status, 'Finished')
  } finally { f.tracker.dispose() }
})

test('persisted human chat is navigable but is not a worker activity signal', async () => {
  const f=fixture(async () => contract.cliRoster)
  try {
    f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
    assert.equal(f.tracker.bots()[0].chat, true)
    assert.equal(f.tracker.bots()[0].status, '')
    f.wire(contract.events[0]); assert.equal(f.tracker.bots()[0].status, 'Working')
    f.wire(contract.events[1]); assert.equal(f.tracker.bots()[0].status, 'Finished')
  } finally { f.tracker.dispose() }
})

test('discovery retains terminal beats but never promotes unknown or remote identities', async () => {
  let resolve, roster = {profiles:[]}
  const f=fixture(() => new Promise(r => { resolve=r }))
  try {
    f.tracker.setEnabled(true)
    f.wire(contract.events[0]); f.wire(contract.events[1])
    assert.deepEqual(f.tracker.bots(), [])
    resolve(contract.cliRoster); await Promise.resolve(); await Promise.resolve()
    assert.equal(f.tracker.bots()[0].status, 'Finished')
    f.advance(5000)
    f.tracker.setEnabled(false); f.tracker.setEnabled(true)
    f.wire(contract.events[0]); resolve(roster); await Promise.resolve(); await Promise.resolve()
    const refresh=f.tracker.refresh(); resolve(contract.cliRoster); await refresh
    assert.equal(f.tracker.bots()[0].status, '', 'unconfirmed start was discarded')
    f.tracker.setEnabled(false); f.tracker.setEnabled(true)
    f.emit('message.start','remote',null,'remote')
    f.emit('message.start','unstamped',null,null)
    resolve(contract.cliRoster); await Promise.resolve(); await Promise.resolve()
    assert.equal(f.tracker.bots()[0].status, '')
  } finally { f.tracker.dispose() }
})

test('gateway tracker status reaches the real bot view without changing chat ownership', async () => {
  const f=fixture(async () => contract.cliRoster)
  const nodes=Object.fromEntries(['avatar','sprite','status','title','detail','time','chat','close'].map(id=>[id,{style:{},dataset:{},getContext(){return {}},addEventListener(){},setAttribute(){},removeAttribute(){}}]))
  const window={addEventListener(){},webkit:{messageHandlers:{companion:{postMessage(){}}}}}
  // botview.js is a thin shell over the shared petBotView, so load the shared section first.
  const shared=source.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
  new Function('window','document', shared+'\n'+fs.readFileSync(new URL('../companion/botview.js', import.meta.url),'utf8'))(window,{getElementById:id=>nodes[id]})
  try {
    f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
    for (const [frame,status] of [[contract.events[0],'Working'],[contract.events[1],'Finished']]) {
      f.wire(frame)
      const {avatar,...bot}=f.tracker.bots()[0]
      // Broker preserves these validated fields; helper passes each bot to botReceive.
      window.botReceive({generation:'fixture',bot,acks:{}})
      assert.equal(nodes.detail.textContent,status)
      assert.equal(nodes.chat.disabled,false)
      assert.equal(bot.id,'alpha')
    }
  } finally { f.tracker.dispose() }
})

const owned = (runtime='runtime-alpha', stored='a', profile='alpha') => ({
  focusedSessionId:runtime, focusedStoredSessionId:stored,
  focusedSessionOwner:{connectionId:'local',profile}, busyBySession:{[runtime]:true}
})
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
test('SDK owned busy hydrates an already running human turn after discovery; idle is not Finished', async () => {
  let resolve
  const f=fixture(()=>new Promise(r=>resolve=r), owned())
  try {
    f.tracker.setEnabled(true)
    assert.deepEqual(f.tracker.bots(), [])
    resolve({profiles:[{name:'alpha',canonical_session:{id:'a'}}]}); await flush()
    assert.equal(f.tracker.bots()[0].status,'Working')
    f.state.busyBySession.set({}); await flush()
    assert.equal(f.tracker.bots()[0].status,'')
  } finally { f.tracker.dispose() }
})

test('profile-only secondary frames require a captured owner and can finish after the SDK clears busy', async () => {
  const f=fixture(undefined, owned())
  try {
    f.tracker.setEnabled(true); await flush()
    // Real secondary forwarder adds profile but conditionally omits connectionId.
    const secondary = frame => f.event(frame.params.type,{...frame.params, session_id:'runtime-alpha', profile:'alpha'})
    secondary(contract.events[0])
    assert.equal(f.tracker.diagnostics().events['start:accepted'],1)
    f.state.busyBySession.set({}); await flush()
    assert.equal(f.tracker.bots()[0].status,'')
    secondary(contract.events[1])
    assert.equal(f.tracker.bots()[0].status,'Finished')
    f.advance(5000)
    secondary(contract.events[1])
    assert.equal(f.tracker.bots()[0].status,'', 'duplicate terminal does not replay Finished')
  } finally { f.tracker.dispose() }
})

test('conflicting runtime ownership revokes hydration and unstamped event authority', async () => {
  for (const owner of [{connectionId:'remote',profile:'alpha'},{connectionId:'local',profile:'beta'}]) {
    const f=fixture(undefined, owned())
    try {
      f.tracker.setEnabled(true); await flush()
      assert.equal(f.tracker.bots()[0].status,'Working')
      f.state.focusedSessionOwner.set(owner); await flush()
      assert.equal(f.tracker.bots()[0].status,'')
      f.emit('message.start','runtime-alpha',null,null)
      f.emit('message.complete','runtime-alpha','complete',null)
      assert.equal(f.tracker.bots()[0].status,'')
      f.state.focusedSessionOwner.set({connectionId:'local',profile:'alpha'}); await flush()
      assert.equal(f.tracker.bots()[0].status,'', 'ambiguous runtime stays rejected until route reset')
    } finally { f.tracker.dispose() }
  }
})

test('terminal wins over queued SDK busy and stale roster responses without polling profiles for activity', async () => {
  let resolve, requests=[]
  const f=fixture((method)=>{requests.push(method);return new Promise(r=>resolve=r)}, {...owned(),busyBySession:{}})
  try {
    f.tracker.setEnabled(true); resolve({profiles:[{name:'alpha'}]}); await flush()
    const refresh=f.tracker.refresh()
    f.state.busyBySession.set({'runtime-alpha':true})
    f.emit('message.complete','runtime-alpha','complete',null) // start was missed
    await flush()
    assert.equal(f.tracker.bots()[0].status,'Finished')
    resolve({profiles:[{name:'alpha'}]}); await refresh
    assert.equal(f.tracker.bots()[0].status,'Finished')
    f.state.focusedStoredSessionId.set('a'); await flush()
    assert.equal(f.tracker.bots()[0].status,'Finished')
    f.state.busyBySession.set({}); await flush()
    f.state.busyBySession.set({'runtime-alpha':true}); await flush()
    assert.equal(f.tracker.bots()[0].status,'Working')
    assert.deepEqual(requests,['profiles.list','profiles.list'])
  } finally { f.tracker.dispose() }
})

test('owner and focus changes hydrate in either update order and preserve multiple sessions across focus switches', async () => {
  for (const order of [['focusedSessionOwner','focusedSessionId','focusedStoredSessionId'],['focusedStoredSessionId','focusedSessionId','focusedSessionOwner']]) {
    const f=fixture(undefined,{busyBySession:{one:true,two:true,stranger:true}})
    try {
      f.tracker.setEnabled(true); await flush()
      for (const key of order) { f.state[key].set(owned('one','a')[key]); await flush() }
      assert.equal(f.tracker.bots()[0].status,'Working')
      // All derived atoms of a focus transaction settle before capturing it.
      f.state.focusedSessionOwner.set({connectionId:'local',profile:'beta'})
      f.state.focusedSessionId.set('two'); f.state.focusedStoredSessionId.set('b'); await flush()
      assert.deepEqual(f.tracker.bots().map(b=>b.status),['Working','Working'])
      f.event('message.complete',{profile:'beta',session_id:'two',payload:{status:'complete'}})
      assert.deepEqual(f.tracker.bots().map(b=>b.status),['Working','Finished'])
      f.emit('message.complete','one','complete',null)
      assert.equal(f.tracker.bots()[0].status,'Finished')
      f.state.busyBySession.set({stranger:true}); await flush()
      f.advance(5000)
      assert.deepEqual(f.tracker.bots().map(b=>b.status),['',''])
    } finally { f.tracker.dispose() }
  }
})
test('two captured sessions of the same bot aggregate until both stop', async () => {
  const f=fixture(undefined, owned('one'))
  try {
    f.tracker.setEnabled(true); await flush()
    f.state.focusedSessionId.set('two'); f.state.focusedStoredSessionId.set('second')
    f.state.busyBySession.set({one:true,two:true}); await flush()
    f.emit('message.complete','one','complete',null)
    assert.equal(f.tracker.bots()[0].status,'Working')
    f.state.busyBySession.set({}); await flush()
    assert.equal(f.tracker.bots()[0].status,'')
    f.emit('message.complete','two','interrupted',null)
    assert.equal(f.tracker.bots()[0].status,'')
  } finally { f.tracker.dispose() }
})
test('missing owner, missing durable ID, remote owner and unrelated busy never establish local activity', async () => {
  for (const initial of [{...owned(),focusedSessionOwner:null},{...owned(),focusedStoredSessionId:null},{...owned(),focusedSessionOwner:{connectionId:'remote',profile:'alpha'}},{...owned(),busyBySession:{unknown:true}}]) {
    const f=fixture(undefined,initial)
    try {
      f.tracker.setEnabled(true); await flush()
      assert.equal(f.tracker.bots()[0].status,'')
      f.emit('message.start','unknown',null,null)
      f.emit('message.complete','unknown','complete',null)
      assert.equal(f.tracker.bots()[0].status,'')
    } finally { f.tracker.dispose() }
  }
})
test('proven ownership never overrides explicit remote stamps, wrong profiles or missing event identity', async () => {
  const f=fixture(undefined,owned())
  try {
    f.tracker.setEnabled(true); await flush()
    for (const event of [
      {profile:'alpha',session_id:'runtime-alpha',connectionId:'remote'},
      {profile:'beta',session_id:'runtime-alpha'}, {session_id:'runtime-alpha'}, {profile:'alpha'},
      {profile:'alpha',session_id:'unknown'}
    ]) f.event('message.complete',{...event,payload:{status:'complete'}})
    assert.equal(f.tracker.bots()[0].status,'Working')
    f.emit('error','runtime-alpha',null,null)
    assert.equal(f.tracker.bots()[0].status,'Error')
    f.connect('remote'); f.connect('local')
    f.state.focusedSessionOwner.set(null); await flush()
    f.emit('message.complete','runtime-alpha','complete',null)
    assert.equal(f.tracker.bots()[0].status,'')
  } finally { f.tracker.dispose() }
})

test('unknown completion outcomes cannot claim success for an owned session', async () => {
  const f=fixture(undefined,owned())
  try {
    f.tracker.setEnabled(true); await flush()
    for (const status of [undefined,'starting','unexpected']) f.emit('message.complete','runtime-alpha',status,null)
    assert.equal(f.tracker.bots()[0].status,'Working')
    f.emit('message.complete','runtime-alpha','failed',null)
    assert.equal(f.tracker.bots()[0].status,'Error')
  } finally { f.tracker.dispose() }
})

test('roster removal and disable discard captured owners and pending SDK reconciliation', async () => {
  let profiles=[{name:'alpha'}]
  const f=fixture(async()=>({profiles}),owned())
  try {
    f.tracker.setEnabled(true); await flush()
    assert.equal(f.tracker.bots()[0].status,'Working')
    profiles=[]; await f.tracker.refresh()
    f.state.focusedSessionId.set(null); f.state.focusedSessionOwner.set(null); await flush()
    profiles=[{name:'alpha'}]; await f.tracker.refresh()
    f.emit('message.complete','runtime-alpha','complete',null)
    assert.equal(f.tracker.bots()[0].status,'')
    f.state.focusedSessionId.set('runtime-alpha'); f.state.focusedSessionOwner.set({connectionId:'local',profile:'alpha'})
    f.tracker.setEnabled(false); await flush()
    assert.deepEqual(f.tracker.bots(),[])
    f.state.busyBySession.set({}); f.tracker.dispose(); await flush()
    assert.deepEqual(f.tracker.all(),[])
  } finally { f.tracker.dispose() }
})

test('an unstamped terminal cannot race a contradictory focused owner update', async () => {
  const f=fixture(undefined,owned())
  try {
    f.tracker.setEnabled(true); await flush()
    f.state.focusedSessionOwner.set({connectionId:'remote',profile:'alpha'})
    f.emit('message.complete','runtime-alpha','complete',null)
    assert.notEqual(f.tracker.bots()[0].status,'Finished')
    await flush()
    assert.equal(f.tracker.bots()[0].status,'')
  } finally { f.tracker.dispose() }
})

test('gateway profile route changes clear captured associations without treating focus switches as route changes', async () => {
  const f=fixture(undefined,{...owned(),profile:'default'})
  try {
    f.tracker.setEnabled(true); await flush()
    f.state.focusedSessionId.set(null); f.state.focusedStoredSessionId.set(null); f.state.focusedSessionOwner.set(null); await flush()
    assert.equal(f.tracker.bots()[0].status,'Working')
    f.state.profile.set('beta'); await flush()
    f.emit('message.complete','runtime-alpha','complete',null)
    assert.equal(f.tracker.bots()[0].status,'')
  } finally { f.tracker.dispose() }
})

function fixture(request, initial = {}, ctx = {}) {
  const atom = initial => { let value=initial; const listeners=new Set(); return {get:()=>value, listen:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}, set:next=>{value=next;for(const fn of listeners) fn(next)}} }
  const state = Object.fromEntries(Object.entries({busyBySession:{},focusedSessionId:null,focusedStoredSessionId:null,focusedSessionOwner:null,...initial}).map(([key,value])=>[key,atom(value)]))
  const events = {}, timers = new Map(), notes = []; let tick = 1000000, serial = 0, connection = 'local', connectionChanged = () => {}
  const host = { state: { ...state, connectionId: { get: () => connection, listen: fn => { connectionChanged = fn; return () => {} } } }, request: request || (async () => ({profiles: [{name:'alpha', canonical_session:{id:'a'}}, {name:'beta',canonical_session:{id:'b'}}]})), onEvent: (name, fn) => { events[name] = fn; return () => delete events[name] }, openSession: async (...args) => args, notify: note => notes.push(note) }
  const create = new Function('host','window','CustomEvent','attentionSummary','petAttentionLabel','setTimeout','clearTimeout', source.slice(source.indexOf('const BOT_POLL_MS'), source.indexOf('\nfunction trackPetChat')) + ';return createBotTracker')
  const tracker = create(host,{dispatchEvent(){}},class {},() => null,x=>x,(fn,ms)=>{timers.set(++serial,{fn,ms});return serial},id=>timers.delete(id))(ctx, {now:()=>tick})
  const emit = (type,session,status, connectionId='local') => events[type]({profile:'alpha',connectionId,session_id:session,payload:{status}})
  return {tracker,emit,timers,state,notes, event: (type, event) => events[type]?.(event), wire: frame => events[frame.params.type]?.({...frame.params, profile:'alpha', connectionId:'local'}), connect: value => { connection = value; connectionChanged() }, advance:ms=>{tick+=ms; for(const [id,t] of [...timers]) if(t.ms<=ms){timers.delete(id);t.fn()} }}
}
test('simultaneous sessions do not finish each other; foreign connection ignored', async () => {
  const f=fixture(); f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  f.emit('message.start','one'); f.emit('message.start','two'); f.emit('message.complete','one','completed')
  assert.equal(f.tracker.bots()[0].status,'Working')
  f.emit('message.complete','two','completed','remote'); assert.equal(f.tracker.bots()[0].status,'Working')
  f.emit('message.complete','two','completed'); assert.equal(f.tracker.bots()[0].status,'Finished')
  f.advance(5000); assert.equal(f.tracker.bots()[0].status,''); f.tracker.dispose()
})
test('activity diagnostics distinguish absent, rejected and accepted events without content', async () => {
  const f=fixture(); f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  try {
    assert.deepEqual(f.tracker.diagnostics().events, {})
    f.emit('message.start','private-session',null,null)
    f.emit('message.complete','private-session','complete')
    f.emit('message.start','private-session')
    f.emit('message.complete','private-session','complete')
    const d=f.tracker.diagnostics()
    assert.equal(d.events['start:missing-connection'],1)
    assert.equal(d.events['terminal:no-observed-start'],1)
    assert.equal(d.events['start:accepted'],1)
    assert.equal(d.events['terminal:accepted'],1)
    assert.equal(JSON.stringify(d).includes('private-session'),false)
    d.events['start:accepted']=900
    assert.equal(f.tracker.diagnostics().events['start:accepted'],1)
    f.tracker.setEnabled(false); f.tracker.setEnabled(true)
    assert.deepEqual(f.tracker.diagnostics().events,{})
  } finally { f.tracker.dispose() }
})

test('unstamped events cannot be promoted to the local connection', async () => {
  const f=fixture(); f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  f.emit('message.start','unknown',null,null)
  assert.equal(f.tracker.bots()[0].status,'')
  f.tracker.dispose()
})
test('disabled tracker rejects a pending roster reply', async () => {
  let resolve
  const f = fixture(() => new Promise(r => { resolve = r }))
  f.tracker.setEnabled(true)
  f.tracker.setEnabled(false)
  resolve({profiles:[{name:'late'}]})
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(f.tracker.all(), [])
  f.tracker.dispose()
})

test('connection changes invalidate pending discovery and active turns', async () => {
  let resolve
  const f = fixture(() => new Promise(r => { resolve = r }))
  f.tracker.setEnabled(true)
  f.connect('remote')
  resolve({profiles:[{name:'alpha'}]})
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(f.tracker.bots(), [])
  f.tracker.dispose()
})
test('toggle cycle starts fresh discovery while the old request is pending', async () => {
  const pending = []
  const f = fixture(() => new Promise(resolve => pending.push(resolve)))
  f.tracker.setEnabled(true); f.tracker.setEnabled(false); f.tracker.setEnabled(true)
  assert.equal(pending.length, 2)
  pending[1]({profiles:[{name:'fresh'}]}); await Promise.resolve()
  pending[0]({profiles:[{name:'stale'}]}); await Promise.resolve()
  assert.equal(f.tracker.bots()[0].id, 'fresh')
  f.tracker.dispose()
})
test('chat actions cannot route after disable or dismissal', async () => {
  const f=fixture(); f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  assert.deepEqual(await f.tracker.openChat('alpha'), ['a',{profile:'alpha',intent:'in-place',route:{connectionId:'local',profile:'alpha',mode:'local'}}])
  f.tracker.dismiss('alpha')
  await assert.rejects(f.tracker.openChat('alpha'), /unavailable/)
  f.tracker.setEnabled(false)
  await assert.rejects(f.tracker.openChat('beta'), /unavailable/)
  f.tracker.dispose()
})
test('worker fallback rejects future timestamps and expires', async () => {
  const f=fixture(async()=>({profiles:[{name:'alpha',worker_session:{last_active:1100}},{name:'beta',worker_session:{last_active:999}}]}))
  f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  assert.equal(f.tracker.bots()[0].status, '')
  assert.equal(f.tracker.bots()[1].status, 'Working')
  f.advance(151000)
  assert.equal(f.tracker.bots()[1].status, '')
  f.tracker.dispose()
})
test('starts off, discovers dynamic profiles and resets dismissed bots on cycle', async () => {
  let profiles=[{name:'alpha'},{name:'default',is_default:true},{name:'../bad'}]
  const f=fixture(async()=>({profiles}))
  assert.equal(f.tracker.enabled(),false); assert.deepEqual(f.tracker.bots(),[])
  f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  assert.deepEqual(f.tracker.bots().map(b=>b.id),['alpha'])
  f.tracker.dismiss('alpha'); assert.deepEqual(f.tracker.bots(),[])
  profiles=[{name:'alpha'},{name:'beta'}]; await f.tracker.refresh()
  assert.deepEqual(f.tracker.bots().map(b=>b.id),['beta'])
  f.tracker.setEnabled(false); f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  assert.deepEqual(f.tracker.bots().map(b=>b.id),['alpha','beta']); f.tracker.dispose()
})
test('interrupted and failed turns are profile scoped and dispose rejects discovery', async () => {
  const f=fixture(); f.tracker.setEnabled(true); await f.tracker.refresh(); await Promise.resolve()
  f.emit('message.start','one'); f.emit('message.complete','other','completed')
  assert.equal(f.tracker.bots()[0].status,'Working')
  f.emit('message.complete','one','interrupted'); assert.equal(f.tracker.bots()[0].status,'')
  f.emit('message.start','two'); f.emit('error','two'); assert.equal(f.tracker.bots()[0].status,'Error')
  assert.equal(f.tracker.bots()[1].status,''); f.advance(5000); assert.equal(f.tracker.bots()[0].status,'')
  f.tracker.dispose(); assert.deepEqual(f.tracker.bots(),[])
  let resolve; const g=fixture(()=>new Promise(r=>resolve=r)); g.tracker.setEnabled(true);g.tracker.dispose()
  resolve({profiles:[{name:'late'}]}); await Promise.resolve();assert.deepEqual(g.tracker.all(),[])
})

test('bot status report says why each pet is animated or static', async () => {
  const calls=[]
  const f=fixture(undefined, {}, {rest: async (path, options) => { calls.push([path, options.body]); return {bots:{alpha:'animated (s0uthpaw)', beta:'no gallery match'}} }})
  try {
    f.tracker.setEnabled(true); await f.tracker.report()
    assert.deepEqual(calls, [['/companion/sprites', {bots:['alpha','beta']}]])
    const message = f.notes.at(-1).message
    assert.match(message, /alpha: Idle, animated \(s0uthpaw\)/)
    assert.match(message, /beta: Idle, no gallery match/)
  } finally { f.tracker.dispose() }
})
test('bot status report still works when the sprite check fails', async () => {
  const f=fixture(undefined, {}, {rest: async () => { throw new Error('404') }})
  try {
    f.tracker.setEnabled(true); await f.tracker.report()
    assert.match(f.notes.at(-1).message, /alpha: Idle · beta: Idle/)
  } finally { f.tracker.dispose() }
})
