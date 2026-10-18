import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {test} from 'node:test'
const require=createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const {JSDOM}=require('jsdom')
const source=readFileSync(new URL('../desktop/plugin.js',import.meta.url),'utf8')
const shared=source.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
function setup(){
 const dom=new JSDOM('<body><canvas id="pet"></canvas><div id="status"></div><button id="close"></button></body>',{runScripts:'outside-only',pretendToBeVisual:true})
 const w=dom.window,posted=[]
 w.HTMLCanvasElement.prototype.getContext=()=>({})
 w.Image=class{}
 w.webkit={messageHandlers:{companion:{postMessage:s=>posted.push(JSON.parse(s))}}}
 w.eval(shared+'\n'+readFileSync(new URL('../companion/view.js',import.meta.url),'utf8'))
 return {w,posted,dom}
}
test('drag protocol never uses Wayland-local screen coordinates and releases on cancellation',()=>{
 const h=setup()
 try{
  const pet=h.w.document.getElementById('pet');pet.setPointerCapture=()=>{}
  for(const type of ['pointerdown','pointermove','pointercancel']) {
   const e=new h.w.Event(type);Object.assign(e,{pointerId:7,button:0,screenX:999,screenY:999});pet.dispatchEvent(e)
  }
  assert.deepEqual(h.posted.filter(p=>p.type==='drag').map(p=>p.phase),['start','move','end'])
  assert.equal(h.posted.some(p=>p.type==='move'),false)
 }finally{h.dom.window.close()}
})
test('only successful explicit chat acknowledgements request owner-window reveal',()=>{
 const h=setup()
 try{
  for(const [action,ok,expected] of [['chat',true,1],['bots',true,0],['chat',false,0],['setMuted',true,0]]){
   h.w.petReceive({generation:'g',state:{lifecycle:'connected',capabilities:[action],bands:[]},acks:{}})
   h.w.document.querySelector(`[data-action="${action}"]`).click()
   const command=h.posted.filter(p=>p.type==='command').at(-1).command
   const before=h.posted.filter(p=>p.type==='reveal').length
   h.w.petReceive({generation:'g',state:{lifecycle:'connected',capabilities:[action],bands:[]},acks:{[command.id]:{ok}}})
   assert.equal(h.posted.filter(p=>p.type==='reveal').length-before,expected,action+' '+ok)
   h.w.petReceive({generation:'g',state:{lifecycle:'connected',capabilities:[action],bands:[]},acks:{[command.id]:{ok}}})
   assert.equal(h.posted.filter(p=>p.type==='reveal').length-before,expected,'no autofocus on state/ack replay')
  }
 }finally{h.dom.window.close()}
})

test('a reveal warning preserves valid controls and unrelated pending actions',()=>{
 const h=setup()
 try{
  const state={lifecycle:'idle',capabilities:['start','chat','bots'],bands:[],muted:false}
  h.w.petReceive({generation:'g',state,acks:{}})
  const start=h.w.document.querySelector('[data-action="start"]')
  const transcript=h.w.document.querySelector('[data-action="bots"]')
  start.click();transcript.click()
  const command=h.posted.filter(p=>p.type==='command').at(-1).command
  h.w.petReceive({generation:'g',state,acks:{[command.id]:{ok:true}}})
  h.w.petReceive({warning:'Could not reveal owning Hermes window'})
  assert.deepEqual([...h.w.document.querySelectorAll('button[data-action]')].filter(b=>!b.hidden).map(b=>b.dataset.action),state.capabilities)
  assert.equal(start.disabled,true,'an unrelated pending action must stay pending')
  assert.equal(transcript.disabled,false)
  assert.equal(h.w.document.querySelector('#status').textContent,'Could not reveal owning Hermes window')
  assert.equal(h.posted.filter(p=>p.type==='reveal').length,0,'warnings do not retry window focusing')
 }finally{h.dom.window.close()}
})

test('a pending start leaves Stop usable while the provider is still connecting',()=>{
 const h=setup()
 try{
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:['start'],bands:[]},acks:{}})
  const voice=h.w.document.querySelector('[data-action="start"]');voice.click();voice.click()
  assert.equal(h.posted.filter(p=>p.type==='command').length,1,'deduplicate the pending start')
  assert.equal(voice.disabled,true);assert.equal(voice.getAttribute('aria-busy'),'true')
  h.w.petReceive({generation:'g',state:{lifecycle:'connecting',capabilities:['stop','chat'],bands:[]},acks:{}})
  assert.equal(voice.dataset.action,'stop');assert.equal(voice.disabled,false)
  assert.ok(voice.querySelector('.pet-spinner'))
  voice.click()
  assert.deepEqual(h.posted.filter(p=>p.type==='command').map(p=>p.command.action),['start','stop'])
  assert.equal(voice.disabled,true,'deduplicate Stop independently')
 }finally{h.dom.window.close()}
})
test('a genuine owner disconnect still hides controls and warnings cannot restore them',()=>{
 const h=setup()
 try{
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:['start','chat'],bands:[],muted:false},acks:{}})
  h.w.petReceive({error:'Owner disconnected'})
  assert.equal([...h.w.document.querySelectorAll('button[data-action]')].filter(b=>!b.hidden).length,0)
  h.w.petReceive({warning:'Could not reveal owning Hermes window'})
  assert.equal([...h.w.document.querySelectorAll('button[data-action]')].filter(b=>!b.hidden).length,0)
  assert.ok(h.w.document.querySelector('#close'))
 }finally{h.dom.window.close()}
})

test('pop-out bubble: click opens a reply field with keyboard, Enter sends one reply command and releases keyboard',()=>{
 const h=setup()
 try{
  const state={lifecycle:'idle',capabilities:['start','chat','reply'],bands:[],muted:false,status:''}
  h.w.petReceive({generation:'g',state,acks:{}})
  const bubble=h.w.document.getElementById('status')
  assert.equal(bubble.textContent,'Reply to Hermes…')
  bubble.click()
  const input=bubble.querySelector('input[data-pet-reply]');assert.ok(input)
  assert.deepEqual(h.posted.filter(p=>p.type==='keyboard').map(p=>p.on),[true])
  h.w.petReceive({generation:'g',state:{...state,status:'Working'},acks:{}})
  assert.ok(bubble.querySelector('input'),'state updates keep the field open')
  input.value='looks good';input.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter'}))
  const commands=h.posted.filter(p=>p.type==='command').map(p=>p.command)
  assert.equal(commands.length,1);assert.equal(commands[0].action,'reply');assert.equal(commands[0].text,'looks good');assert.equal(commands[0].generation,'g')
  assert.deepEqual(h.posted.filter(p=>p.type==='keyboard').map(p=>p.on),[true,false])
  h.w.petReceive({generation:'g',state:{...state,status:'Working'},acks:{[commands[0].id]:{ok:false}}})
  assert.equal(bubble.textContent,'Could not send')
 }finally{h.dom.window.close()}
})
test('pop-out bubble: Escape releases keyboard and no reply capability means nothing is sent',()=>{
 const h=setup()
 try{
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:['start'],bands:[],muted:false,status:''},acks:{}})
  const bubble=h.w.document.getElementById('status')
  bubble.click();let input=bubble.querySelector('input')
  input.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape'}))
  assert.equal(bubble.querySelector('input'),null)
  bubble.click();input=bubble.querySelector('input');input.value='hi'
  input.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter'}))
  assert.equal(h.posted.filter(p=>p.type==='command').length,0)
  assert.equal(bubble.textContent,'Open a chat first')
  assert.deepEqual(h.posted.filter(p=>p.type==='keyboard').map(p=>p.on),[true,false,true,false])
 }finally{h.dom.window.close()}
})


test('pop-out bubble uses the same shared style as the in-app bubble',()=>{
 const h=setup()
 try{
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:[],bands:[],muted:false,status:'Working'},acks:{}})
  const bubble=h.w.document.getElementById('status'),box=h.w.eval('petDescriptor(false,false).statusBox')
  for(const [key,value] of Object.entries(h.w.eval('petBubbleStyle')(box)))if(!value.includes('color-mix'))assert.equal(bubble.style[key],value,key)
 }finally{h.dom.window.close()}
})

test('pop-out shows the needs-you label and waiting pose ahead of Working and narration',()=>{
 const h=setup()
 try{
  const bubble=h.w.document.getElementById('status')
  const base={lifecycle:'idle',capabilities:[],bands:[],muted:false,status:'Working'}
  h.w.petReceive({generation:'g',state:base,acks:{}})
  assert.equal(bubble.textContent,'Working')
  h.w.petReceive({generation:'g',state:{...base,narration:{text:'On it: something',tone:'wait',until:Date.now()+9e6},attention:{kind:'approval',count:1}},acks:{}})
  assert.equal(bubble.textContent,'Needs approval')
  h.w.petReceive({generation:'g',state:{...base,attention:{kind:'clarify',count:2}},acks:{}})
  assert.equal(bubble.textContent,'Question for you')
  h.w.petReceive({generation:'g',state:base,acks:{}})
  assert.equal(bubble.textContent,'Working')
  const view=readFileSync(new URL('../companion/view.js',import.meta.url),'utf8')
  assert.match(view,/const name=attention\(\)\?'waiting':/,'waiting row outranks every other pose')
 }finally{h.dom.window.close()}
})

test('four controls include bot toggle with pressed state instead of pet transcript',()=>{
 const h=setup()
 try {
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:['bots'],botsEnabled:false,bands:[]},acks:{}})
  const buttons=[...h.w.document.querySelectorAll('[data-pet-button]')]
  assert.equal(buttons.length,4)
  const toggle=h.w.document.querySelector('[data-action="bots"]')
  assert.ok(toggle)
  assert.equal(toggle.getAttribute('aria-pressed'),'false')
  assert.equal(h.w.document.querySelector('[data-action="transcript"]'),null)
  toggle.click()
  assert.equal(h.posted.filter(p=>p.type==='command').at(-1).command.action,'bots')
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:['bots'],botsEnabled:true,bands:[]},acks:{}})
  assert.equal(toggle.getAttribute('aria-pressed'),'true')
 } finally {h.dom.window.close()}
})

test('bot view is visual-only with identity-scoped chat, dismiss and attention',()=>{
 const dom=new JSDOM(readFileSync(new URL('../companion/botview.html',import.meta.url),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true})
 const w=dom.window, posted=[]
 w.webkit={messageHandlers:{companion:{postMessage:s=>posted.push(JSON.parse(s))}}}
 try {
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}})
  w.eval(shared+'\n'+readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'))
  w.botReceive({generation:'g',bot:{id:'alpha',label:'Alpha',status:'Working',chat:true,avatar:null},acks:{}})
  assert.equal(w.document.querySelector('#status').textContent,'Working')
  w.document.querySelector('#chat').click();w.document.querySelector('#close').click()
  assert.deepEqual(posted.filter(p=>p.type==='command').map(p=>[p.command.action,p.command.bot]),[['botChat','alpha'],['botDismiss','alpha']])
  w.botReceive({generation:'g',bot:{id:'alpha',label:'Alpha',status:'Finished',chat:true,attention:{kind:'clarify',count:1}},acks:{}})
  assert.equal(w.document.querySelector('#status').textContent,'Question for you')
  assert.equal(w.document.querySelector('input,textarea,[data-action="start"],[data-action="setMuted"]'),null)
 } finally {w.close()}
})

test('native pet X sends hide command instead of terminating helper',()=>{
 const h=setup()
 try {
  h.w.petReceive({generation:'g',state:{lifecycle:'idle',capabilities:['hidePet'],bands:[]},acks:{}})
  h.w.document.querySelector('#close').click()
  assert.equal(h.posted.some(p=>p.type==='close'),false)
  assert.equal(h.posted.findLast(p=>p.type==='command').command.action,'hidePet')
 } finally {h.dom.window.close()}
})

test('bot avatar drag reports independent lifecycle without screen coordinates',()=>{
 const dom=new JSDOM(readFileSync(new URL('../companion/botview.html',import.meta.url),'utf8'),{runScripts:'outside-only'})
 const w=dom.window,posted=[];w.webkit={messageHandlers:{companion:{postMessage:s=>posted.push(JSON.parse(s))}}}
 try {
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}})
  w.eval(shared+'\n'+readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'))
  const avatar=w.document.querySelector('#avatar');avatar.setPointerCapture=()=>{}
  for(const type of ['pointerdown','pointermove','pointercancel']){const event=new w.Event(type);Object.assign(event,{pointerId:1,button:0});avatar.dispatchEvent(event)}
  assert.deepEqual(posted.filter(p=>p.type==='drag').map(p=>p.phase),['start','move','end'])
 } finally {w.close()}
})

// A native WebKit drag of the avatar offered a 256x256 PNG to other apps; when one never read
// it, the helper's GTK thread blocked in a pipe write and froze every pet (2026-10-17 15:52).
test('bot view never starts a native drag: the avatar is not draggable and dragstart is cancelled',()=>{
 const dom=new JSDOM(readFileSync(new URL('../companion/botview.html',import.meta.url),'utf8'),{runScripts:'outside-only'})
 const w=dom.window,posted=[];w.webkit={messageHandlers:{companion:{postMessage:s=>posted.push(JSON.parse(s))}}}
 try {
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}})
  w.eval(shared+'\n'+readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'))
  w.botReceive({generation:'g',bot:{id:'alpha',label:'Alpha',status:'',chat:true,avatar:'data:image/png;base64,QVZBVEFS'},acks:{}})
  const avatar=w.document.querySelector('#avatar')
  assert.equal(avatar.getAttribute('draggable'),'false')
  for(const target of [avatar,w.document.querySelector('#sprite'),w.document.querySelector('#status')]){
   const event=new w.Event('dragstart',{bubbles:true,cancelable:true})
   assert.equal(target.dispatchEvent(event),false,`dragstart on #${target.id} must be cancelled`)
  }
  const css=[...w.document.querySelectorAll('style')].map(s=>s.textContent).join('\n')
  assert.match(css,/\[data-bot-part=avatar\][^{]*\{[^}]*-webkit-user-drag:none/,'avatar CSS forbids image drags')
  assert.match(css,/\[data-bot-part=avatar\][^{]*\{[^}]*user-select:none/)
  avatar.setPointerCapture=()=>{}
  for(const type of ['pointerdown','pointermove','pointerup']){const event=new w.Event(type);Object.assign(event,{pointerId:1,button:0});avatar.dispatchEvent(event)}
  assert.deepEqual(posted.filter(p=>p.type==='drag').map(p=>p.phase),['start','move','end'],'pointer dragging still moves the pet')
 } finally {w.close()}
})
test('pop-out pet view never starts a native drag',()=>{
 const h=setup()
 try {
  const event=new h.w.Event('dragstart',{bubbles:true,cancelable:true})
  assert.equal(h.w.document.getElementById('pet').dispatchEvent(event),false)
 } finally {h.dom.window.close()}
})

test('bot chat reveals owner only after its successful acknowledgement',()=>{
 const dom=new JSDOM(readFileSync(new URL('../companion/botview.html',import.meta.url),'utf8'),{runScripts:'outside-only'})
 const w=dom.window,posted=[];w.webkit={messageHandlers:{companion:{postMessage:s=>posted.push(JSON.parse(s))}}}
 try {
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}})
  w.eval(shared+'\n'+readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'))
  const bot={id:'alpha',label:'Alpha',status:'Working',chat:true}
  w.botReceive({generation:'g',bot,acks:{}});w.document.querySelector('#chat').click()
  const command=posted.findLast(p=>p.type==='command').command
  assert.equal(posted.some(p=>p.type==='reveal'),false)
  w.botReceive({generation:'g',bot,acks:{[command.id]:{ok:true}}})
  w.botReceive({generation:'g',bot,acks:{[command.id]:{ok:true}}})
  assert.equal(posted.filter(p=>p.type==='reveal').length,1)
 } finally {w.close()}
})

test('simultaneous bot windows generate distinct command identities',()=>{
 const ids=[]
 for(const id of ['alpha','beta']) {
  const dom=new JSDOM(readFileSync(new URL('../companion/botview.html',import.meta.url),'utf8'),{runScripts:'outside-only'})
  const w=dom.window;w.Date.now=()=>1000
  w.webkit={messageHandlers:{companion:{postMessage:s=>{const p=JSON.parse(s);if(p.command)ids.push(p.command.id)}}}}
  try {
   w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}})
  w.eval(shared+'\n'+readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'))
   w.botReceive({generation:'g',bot:{id,label:id,chat:true},acks:{}})
   w.document.querySelector('#chat').click()
  } finally {w.close()}
 }
 assert.equal(new Set(ids).size,2)
})

test('bot bubble keeps its two lines after an owner disconnect and reconnect',()=>{
 const dom=new JSDOM(readFileSync(new URL('../companion/botview.html',import.meta.url),'utf8'),{runScripts:'outside-only'})
 const w=dom.window;w.webkit={messageHandlers:{companion:{postMessage(){}}}}
 try {
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}})
  w.eval(shared+'\n'+readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'))
  w.botReceive({generation:'g',bot:null,acks:{}})
  assert.equal(w.document.querySelector('#detail').textContent,'Owner disconnected')
  w.botReceive({generation:'g',bot:{id:'alpha',label:'Alpha',status:'',chat:true,progress:{row:7,title:'Review',detail:'terminal',since:null,tone:'info'}},acks:{}})
  assert.equal(w.document.querySelector('#title').textContent,'Review')
  assert.equal(w.document.querySelector('#detail').textContent,'terminal')
 } finally {w.close()}
})
test('pop-out view takes its sheet from state.pet (the selected Hermes pet), once and only as image data',()=>{
 const dom=new JSDOM('<body><canvas id="pet"></canvas><div id="status"></div><button id="close"></button></body>',{runScripts:'outside-only',pretendToBeVisual:true})
 const w=dom.window,sources=[]
 w.HTMLCanvasElement.prototype.getContext=()=>({})
 w.Image=class{set src(value){sources.push(value)}}
 w.webkit={messageHandlers:{companion:{postMessage(){}}}}
 try{
  w.eval(shared+'\n'+readFileSync(new URL('../companion/view.js',import.meta.url),'utf8'))
  const base={lifecycle:'idle',capabilities:[],bands:[]}
  w.petReceive({generation:'g',state:base,acks:{}})
  assert.deepEqual(sources,[],'no sheet until the broker sends one')
  w.petReceive({generation:'g',state:{...base,pet:{sprite:'file:///etc/passwd'}},acks:{}})
  w.petReceive({generation:'g',state:{...base,pet:{sprite:'https://example.com/x.webp'}},acks:{}})
  assert.deepEqual(sources,[],'only inline image data is accepted')
  w.petReceive({generation:'g',state:{...base,pet:{sprite:'data:image/webp;base64,AAAA'}},acks:{}})
  w.petReceive({generation:'g',state:{...base,pet:{spriteId:'x'}},acks:{}})
  w.petReceive({generation:'g',state:{...base,pet:{sprite:'data:image/webp;base64,AAAA'}},acks:{}})
  assert.deepEqual(sources,['data:image/webp;base64,AAAA'],'same sheet loads once; later id-only states keep it')
  w.petReceive({generation:'g',state:{...base,pet:{sprite:'data:image/png;base64,BBBB'}},acks:{}})
  assert.deepEqual(sources.at(-1),'data:image/png;base64,BBBB','a newly selected pet replaces the sheet')
 }finally{dom.window.close()}
})
