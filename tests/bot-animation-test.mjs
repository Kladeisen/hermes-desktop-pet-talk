import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
// botview.js is a thin shell; the bot pet itself is the shared petBotView in desktop/plugin.js.
const plugin=fs.readFileSync(process.env.TALK_TEST_PLUGIN||new URL('../desktop/plugin.js',import.meta.url),'utf8')
const shared=plugin.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
function harness(size=[1536,2288]) {
  const draws=[], timers=new Map(), events={}, elements={}, loads=[]
  for(const id of ['avatar','sprite','status','title','detail','time','chat','close']) elements[id]={style:{},dataset:{},addEventListener(){},setAttribute(){},removeAttribute(){},getContext(){return {clearRect(){},drawImage(...args){draws.push(args)}}}}
  let serial=0
  class Image { set src(value){loads.push(value);this.naturalWidth=size[0];this.naturalHeight=size[1];this.onload?.()} }
  const window={webkit:{messageHandlers:{companion:{postMessage(){}}}},addEventListener(name,fn){events[name]=fn}}
  const context={window,document:{getElementById:id=>elements[id]},Image,setTimeout:()=>0,clearTimeout(){},setInterval:fn=>{timers.set(++serial,fn);return serial},clearInterval:id=>timers.delete(id),Date,Map}
  vm.runInNewContext(shared+'\n'+fs.readFileSync(new URL('../companion/botview.js',import.meta.url),'utf8'),context)
  return {window,draws,timers,elements,events,loads}
}
// What the bubble says: line 1 (title) | line 2 (detail) | timer, empty parts left out.
const said=h=>['title','detail','time'].map(id=>h.elements[id].hidden?'':h.elements[id].textContent).filter(Boolean).join(' | ')
test('status selects real sprite rows and frames advance, not CSS motion',()=>{
 const h=harness(), bot={id:'bot',label:'Bot',status:'Working',chat:true,pet:{spriteId:'c'.repeat(64),sprite:'data:image/webp;base64,fixture',frameWidth:192,frameHeight:208,counts:[7,8,8,4,5,8,6,6,6]}}
 h.window.botReceive({generation:'g',bot})
 assert.equal(h.draws.at(-1)?.[2],7*208)
 const first=h.draws.at(-1)[1]; [...h.timers.values()].forEach(fn=>fn())
 assert.notEqual(h.draws.at(-1)[1],first)
 for(const [status,row] of [['Finished',3],['Error',5],['',0]]){h.window.botReceive({generation:'g',bot:{...bot,status}});assert.equal(h.draws.at(-1)[2],row*208)}
 h.window.botReceive({generation:'g',bot:{...bot,attention:{kind:'clarify'}}});assert.equal(h.draws.at(-1)[2],6*208)
 h.window.botReceive({generation:'g',bot:null});assert.equal(h.timers.size,0)
})
test('page teardown clears animation; unmatched avatar remains static',()=>{
 const h=harness(), bot={id:'bot',label:'Bot',status:'Working',chat:true,avatar:'data:image/png;base64,fixture'}
 h.window.botReceive({generation:'g',bot});assert.equal(h.draws.length,0);assert.equal(h.timers.size,0)
 assert.equal(h.elements.sprite.style.display,'none')
 bot.pet={spriteId:'c'.repeat(64),sprite:'data:image/webp;base64,fixture',frameWidth:192,frameHeight:208,counts:[7,8,8,4,5,8,6,6,6]}
 h.window.botReceive({generation:'g',bot});assert.equal(h.timers.size,1)
 const timer=[...h.timers.keys()][0]
 h.window.botReceive({generation:'g',bot});assert.equal([...h.timers.keys()][0],timer,'unchanged snapshots must not starve the frame clock')
 for(let n=0;n<30;n++){[...h.timers.values()].forEach(fn=>fn());assert.ok(h.draws.at(-1)[1]<6*192)}
 h.events.pagehide();assert.equal(h.timers.size,0)
})

const gridPet=(counts,extra={})=>({spriteId:'a'.repeat(64),sprite:'data:image/webp;base64,fixture',frameWidth:192,frameHeight:208,counts,...extra})
test('any regular Petdex grid animates: 8x9 s0uthpaw, 6x9 Codex, 12-column and PNG sheets',()=>{
 for(const [size,counts,sprite] of [[[1536,1872],[6,8,8,4,5,8,6,6,6]],[[1152,1872],[6,6,6,6,6,6,6,6,6]],[[2304,2080],[12,3,3,3,3,3,3,3,3]],[[1536,1872],[8,8,8,8,8,8,8,8,8],'data:image/png;base64,fixture']]){
  const h=harness(size)
  h.window.botReceive({generation:'g',bot:{id:'bot',label:'Bot',status:'Working',chat:true,pet:gridPet(counts,sprite?{sprite}:{})}})
  assert.equal(h.elements.sprite.style.display,'block',String(size))
  assert.equal(h.draws.at(-1)[2],7*208)
  for(let n=0;n<40;n++){[...h.timers.values()].forEach(fn=>fn());assert.ok(h.draws.at(-1)[1]<counts[7]*192)}
 }
})
test('misaligned, short or too-narrow sheets stay static',()=>{
 for(const [size,counts] of [[[1537,1872],[6,8,8,4,5,8,6,6,6]],[[1536,1873],[6,8,8,4,5,8,6,6,6]],[[1536,1664],[6,8,8,4,5,8,6,6,6]],[[1152,1872],[6,8,8,4,5,8,6,6,6]],[[3264,1872],[6,8,8,4,5,8,6,6,6]]]){
  const h=harness(size)
  h.window.botReceive({generation:'g',bot:{id:'bot',label:'Bot',status:'Working',chat:true,pet:gridPet(counts)}})
  assert.notEqual(h.elements.sprite.style.display,'block',String(size));assert.equal(h.timers.size,0)
 }
})
test('later snapshots carry only spriteId; the loaded sheet is kept and never reloaded',()=>{
 const h=harness([1536,1872]), counts=[6,8,8,4,5,8,6,6,6], bot={id:'bot',label:'Bot',status:'Working',chat:true,pet:gridPet(counts)}
 h.window.botReceive({generation:'g',bot})
 const {sprite,...light}=bot.pet
 for(const status of ['Finished','Working','']) h.window.botReceive({generation:'g',bot:{...bot,status,pet:light}})
 assert.equal(h.loads.length,1);assert.equal(h.elements.sprite.style.display,'block');assert.equal(h.draws.at(-1)[2],0)
 h.window.botReceive({generation:'g',bot:{...bot,pet:{...light,spriteId:'b'.repeat(64)}}})
 assert.equal(h.elements.sprite.style.display,'none','unknown id without data falls back to the static avatar');assert.equal(h.timers.size,0)
})

test('backend progress drives the pose and the bubble: card title, step and elapsed time',()=>{
 const h=harness([1536,1872]), counts=[6,8,8,4,5,8,6,6,6]
 const bot={id:'bot',label:'Bot',status:'',chat:true,pet:gridPet(counts),progress:{row:8,title:'Broad review',detail:'Thinking',since:Date.now()/1000-75,tone:'info'}}
 h.window.botReceive({generation:'g',bot})
 assert.equal(h.draws.at(-1)[2],8*208,'review row while thinking')
 assert.equal(said(h),'Broad review | Thinking | · 1m')
 h.window.botReceive({generation:'g',bot:{...bot,progress:{row:6,title:'',detail:'No reply from model (2 retries)',since:Date.now()/1000-400,tone:'wait'}}})
 assert.equal(h.draws.at(-1)[2],6*208); assert.equal(said(h),'No reply from model (2 retries) | · 6m'); assert.equal(h.elements.title.hidden,true)
 h.window.botReceive({generation:'g',bot:{...bot,attention:{kind:'clarify'}}})
 assert.equal(said(h),'Question for you','needs-you still outranks progress');assert.equal(h.draws.at(-1)[2],6*208)
 h.window.botReceive({generation:'g',bot:{...bot,progress:undefined,status:'Working'}})
 assert.equal(said(h),'Working');assert.equal(h.draws.at(-1)[2],7*208)
})
test('the elapsed clock ticks only while progress has a start time, and stops on teardown',()=>{
 const h=harness([1536,1872]), bot={id:'bot',label:'Bot',status:'',chat:true,progress:{row:7,title:'',detail:'terminal',since:Date.now()/1000-5,tone:'info'}}
 h.window.botReceive({generation:'g',bot}); assert.equal(h.timers.size,1)
 h.window.botReceive({generation:'g',bot}); assert.equal(h.timers.size,1,'no duplicate clocks')
 h.window.botReceive({generation:'g',bot:{...bot,progress:{row:3,title:'Done: Ship it',detail:'Shipped.',since:null,tone:'info'}}})
 assert.equal(h.timers.size,0); assert.equal(said(h),'Done: Ship it | Shipped.')
 h.window.botReceive({generation:'g',bot}); h.events.pagehide(); assert.equal(h.timers.size,0)
})
test('malformed progress is ignored rather than shown',()=>{
 const h=harness(), base={id:'bot',label:'Bot',status:'Working',chat:true}
 for(const progress of [{row:99,title:'x',detail:'',since:null},{row:7,title:'x'.repeat(500),detail:'',since:null},{row:7,title:{},detail:'',since:null},{row:7,title:'',detail:'',since:'soon'}]){
  h.window.botReceive({generation:'g',bot:{...base,progress}}); assert.equal(said(h),'Working')
 }
})

test('an explicit idle from the backend outranks the renderer\'s coarse Working guess',()=>{
 const h=harness([1536,1872]), counts=[6,8,8,4,5,8,6,6,6]
 h.window.botReceive({generation:'g',bot:{id:'bot',label:'Claude',status:'Working',chat:true,pet:gridPet(counts),progress:{row:0,title:'',detail:'',since:null,tone:'info'}}})
 assert.equal(h.draws.at(-1)[2],0,'idle pose, not running'); assert.equal(said(h),'Claude')
})
test('the tone border resets when progress ends',()=>{
 const h=harness(), bot={id:'bot',label:'Bot',status:'',chat:true,progress:{row:6,title:'Blocked: needs you',detail:'Approve?',since:null,tone:'wait'}}
 h.window.botReceive({generation:'g',bot}); assert.equal(h.elements.status.dataset.tone,'wait')
 h.window.botReceive({generation:'g',bot:{...bot,progress:undefined}}); assert.notEqual(h.elements.status.dataset.tone,'wait')
 h.window.botReceive({generation:'g',bot:{...bot,progress:undefined,attention:{kind:'clarify'}}}); assert.equal(h.elements.status.dataset.tone,'wait','needs-you uses the same amber as a blocked card')
})
test('the bubble sits just above the highest visible pixel of the sheet',()=>{
 const h=harness([1536,1872]), counts=[6,8,8,4,5,8,6,6,6]
 h.window.botReceive({generation:'g',bot:{id:'bot',label:'Bot',status:'',chat:true,pet:gridPet(counts,{top:24})}})
 assert.equal(h.elements.status.style.bottom,'142px','240 - (90 + 24/2) + 4')
 h.window.botReceive({generation:'g',bot:{id:'bot',label:'Bot',status:'',chat:true,pet:gridPet(counts,{top:'x'})}})
 assert.equal(h.elements.status.style.bottom,'154px','no usable top: anchor at the frame top')
 h.window.botReceive({generation:'g',bot:{id:'bot',label:'Bot',status:'',chat:true,avatar:'data:image/png;base64,x'}})
 assert.equal(h.elements.status.style.bottom,'154px')
})
