// Isolated Chromium fixture: real plugin DOM + supplied sprite, no native app or audio.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const directory = process.env.TALK_PREVIEW_DIR || join(tmpdir(), 'talk-desktop-pet-preview')
const framesDirectory = process.env.TALK_PREVIEW_FRAMES || directory
const runtimeDir = process.env.HOME || process.cwd()
mkdirSync(directory, { recursive: true })
const pluginPath = process.env.TALK_TEST_PLUGIN || fileURLToPath(new URL('../desktop/plugin.js', import.meta.url))
const sprite = readFileSync(process.env.TALK_PREVIEW_SPRITE || join(framesDirectory, 'pet-laptop.png')).toString('base64')
const shim = `import React from 'react'; import {createPortal} from 'react-dom';
export const PALETTE_AREA='commandPalette';
const atom = initial => {let value=initial; const listeners=new Set(); return {get:()=>value,set:v=>{value=v;listeners.forEach(f=>f())},listen:f=>{listeners.add(f);return()=>listeners.delete(f)}}};
export const state={focusedSessionId:atom('fixture-runtime'),focusedStoredSessionId:atom('fixture-stored'),focusedSessionProfile:atom('fixture-profile'),busyBySession:atom({})};
export const host={state,openSession:async(id,options)=>window.fixtureOpened={id,options},onEvent:()=>()=>{}};
export const useValue=x=>x?.get?React.useSyncExternalStore(x.listen,x.get):x;
const Context=React.createContext(null); export const Popover=({open,onOpenChange,children})=>React.createElement(Context.Provider,{value:{open,onOpenChange}},children);
export const PopoverTrigger=({children})=>{const s=React.useContext(Context);return React.cloneElement(children,{'aria-expanded':s.open,onClick:()=>s.onOpenChange(!s.open)})};
export const Dialog=Popover;export const DialogTitle=({children})=>React.createElement('h2',null,children);export const DialogContent=({children,style,...props})=>React.useContext(Context).open?createPortal(React.createElement('section',{role:'dialog',...props,style:{position:'fixed',right:24,bottom:40,zIndex:100,background:'var(--popover-surface)',border:'1px solid var(--ui-stroke-secondary)',borderRadius:8,padding:12,...style}},children),document.body):null;
export const PopoverContent=({children})=>React.useContext(Context).open?createPortal(React.createElement('div',null,children),document.body):null;
const Pass=({children})=>React.createElement('div',null,children);export const Select=Pass,SelectContent=Pass,SelectItem=Pass,SelectTrigger=Pass;
export const SelectValue=()=>null,Switch=()=>null;export const Button=({children,onClick})=>React.createElement('button',{onClick},children);`
const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import plugin from ${JSON.stringify(pluginPath)};import {state} from '@hermes/plugin-sdk';
window.fixtureCaptures=0;Object.defineProperty(navigator,'mediaDevices',{value:{enumerateDevices:async()=>[],getUserMedia:async()=>{window.fixtureCaptures++;throw Error('Fixture prohibits capture')}}});
window.fetch=async()=>{throw Error('Fixture prohibits network')};
const contributions=[];const store=new Map();plugin.register({register:c=>contributions.push(c),storage:{get:k=>store.get(k),set:(k,v)=>store.set(k,v)},rest:async()=>({bots:[]})});
const root=createRoot(document.getElementById('root'));root.render(React.createElement(React.Fragment,null,...contributions.filter(c=>typeof c.render==='function').map(c=>React.createElement(React.Fragment,{key:c.id},c.render()))));
const image=new Image();image.onload=()=>{const canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0,canvas.width,canvas.height);window.fixtureReady=true};image.src='data:image/png;base64,${sprite}';
window.fixtureWork=()=>state.busyBySession.set({'fixture-runtime':true});window.fixtureCleanup=()=>root.unmount();`, resolveDir: ${JSON.stringify(runtimeDir)}, loader: 'js' }, bundle: true, write: false, format: 'iife', nodePaths: [process.env.TALK_TEST_DEPS], define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture-sdk', setup(b) {
  b.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: shim, loader: 'js', resolveDir: runtimeDir }))
  b.onLoad({ filter: /plugin\.js$/ }, args => args.path === pluginPath ? ({ contents: readFileSync(args.path, 'utf8') + '\nwindow.fixtureSnapshot=()=>({...liveController.snapshot(),owner:petChat}); window.fixtureVoice = patch => bus.set(patch); window.fixtureTranscript = async () => { pushTranscript("user","Fixture transcript mount check"); await liveController.action({action:"transcript"}); };', loader: 'js' }) : undefined)
} }] })
writeFileSync(`${directory}/fixture.js`, result.outputFiles[0].text)
const html = `<!doctype html><meta charset="utf-8"><title>Pet comic control fixture</title><style>
*{box-sizing:border-box} body{margin:0;font:13px system-ui;background:var(--bg);color:var(--foreground)}
:root{--bg:#19171c;--popover-surface:#302830;--foreground:#f6e5eb;--ui-text-secondary:#e9d8de;--ui-stroke-secondary:#67505d;--ui-accent:#f0a9bd}
:root[data-theme=light]{--bg:#f8f1f3;--popover-surface:#fff9fb;--foreground:#392932;--ui-text-secondary:#59404d;--ui-stroke-secondary:#c3a4b1;--ui-accent:#96516b}
header{padding:22px 26px}header strong{font-size:14px}header p{font-size:11px;opacity:.7;margin-top:6px}
#root{position:fixed;left:-1000px;top:100px}canvas{width:144px;height:156px;image-rendering:pixelated}
footer{position:fixed;bottom:20px;left:26px;font-size:11px;opacity:.65}
</style><header><strong>Pet · attached controls</strong><p>Isolated fixture — real plugin + sprite. Injected Working state; no audio.</p></header><div id="root"></div><div id="pet" style="position:fixed;left:155px;top:135px"><div style="line-height:0;position:relative"><canvas width="144" height="156" aria-label="Buddy pet"></canvas></div></div><footer id="caption"></footer><script>${result.outputFiles[0].text}</script>`
writeFileSync(`${directory}/fixture.html`, html)
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 420 }, deviceScaleFactor: 2 })
  const errors=[]; page.on('pageerror', e=>errors.push(e.message))
  await page.goto(`file://${directory}/fixture.html`)
  await page.waitForFunction(()=>window.fixtureReady && document.querySelector('[data-talk-pet-mic]'))
  await page.evaluate(()=>window.fixtureWork())
  await page.evaluate(()=>window.fixtureTranscript())
  const panel=page.locator('[data-talk-companion-transcript]')
  assert.ok(await panel.isVisible(),'ack must follow an actually mounted visible dialog')
  const panelBox=await panel.boundingBox()
  assert.ok(panelBox.width>0 && panelBox.height>0 && panelBox.x>=0 && panelBox.y>=0)
  assert.match(await panel.textContent(),/Fixture transcript mount check/)
  await page.screenshot({path:`${directory}/transcript-mounted.png`})
  await page.getByRole('button',{name:'Close transcript',exact:true}).click()
  assert.equal(await panel.count(),0)
  // Exercise both production renderers in Chromium; this is not native WebKit hit-testing.
  const pluginSource=readFileSync(pluginPath,'utf8'),shared=pluginSource.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
  // The native view gets its sheet from the broker as state.pet; the fixture supplies one directly.
  const sheetPath=process.env.TALK_PREVIEW_SHEET
  assert.ok(sheetPath,'Set TALK_PREVIEW_SHEET to any 192x208-grid pet spritesheet')
  const fixtureSheet='data:image/'+(sheetPath.endsWith('.png')?'png':'webp')+';base64,'+readFileSync(sheetPath).toString('base64')
  const nativeScript='window.fixtureSheet='+JSON.stringify(fixtureSheet)+';window.webkit={messageHandlers:{companion:{postMessage:()=>{}}}};const nativeTimeout=window.setTimeout;window.setTimeout=(fn,...args)=>{if(fn.name==="draw"){window.fixtureDraw=fn;return 0}return nativeTimeout(fn,...args)};\n'+shared+'\n'+readFileSync(new URL('../companion/view.js',import.meta.url),'utf8')
  const nativeHtml=readFileSync(new URL('../companion/view.html',import.meta.url),'utf8').replaceAll('PET_NONCE','fixture').replace('PET_SCRIPT',()=>nativeScript)
  writeFileSync(`${directory}/native-fixture.html`,nativeHtml)
  const nativePage=await browser.newPage({viewport:{width:384,height:320},deviceScaleFactor:2})
  nativePage.on('pageerror',e=>errors.push(e.message))
  await nativePage.goto(`file://${directory}/native-fixture.html`)
  const parityCases=[]
  const measure=()=>[...document.querySelectorAll('button[data-action]')].filter(b=>['start','stop','setMuted','chat','transcript'].includes(b.dataset.action)&&!b.hidden).sort((a,b)=>a.dataset.action.localeCompare(b.dataset.action)).map(b=>{
    const s=getComputedStyle(b)
    return {action:b.dataset.action,disabled:b.disabled,html:b.innerHTML,title:b.title,styles:Object.fromEntries(['width','height','borderRadius','backgroundColor','color','borderTopWidth','paddingTop','boxShadow','opacity','display','cursor'].map(k=>[k,s[k]]))}
  })
  for(const theme of ['dark','light'])for(const mode of ['idle','connecting','live','muted','hover']){
    const state=await page.evaluate(({theme,mode})=>{
      document.documentElement.dataset.theme=theme
      window.fixtureVoice({live:mode!=='idle',stage:mode==='connecting'?'connecting':mode==='idle'?'idle':'connected',muted:mode==='muted',bands:[.6,.8,1,.7,.5]})
      document.querySelector('[data-talk-pet-mic]').dispatchEvent(new MouseEvent(mode==='hover'?'mouseover':'mouseout',{bubbles:true}))
      const css=getComputedStyle(document.documentElement)
      return {...window.fixtureSnapshot(),theme:Object.fromEntries([['surface','--popover-surface'],['ink','--foreground'],['border','--ui-stroke-secondary'],['accent','--ui-accent']].map(([k,token])=>[k,css.getPropertyValue(token).trim()]))}
    },{theme,mode})
    await nativePage.evaluate(({state,mode})=>{
      window.petReceive({generation:'fixture',state:{...state,pet:{sprite:window.fixtureSheet}},acks:{}})
      document.querySelector('button[data-action]').dispatchEvent(new MouseEvent(mode==='hover'?'mouseover':'mouseout',{bubbles:true}))
      document.body.style.background=state.theme.surface
    },{state,mode})
    await page.waitForTimeout(180)
    const inApp=await page.evaluate(measure),native=await nativePage.evaluate(measure)
    assert.deepEqual(native,inApp,theme+' '+mode+' rendered appearance')
    if(mode==='connecting')assert.equal(await nativePage.locator('.pet-spinner').evaluate(e=>getComputedStyle(e).animationName),'pet-spin')
    await page.screenshot({path:`${directory}/shared-${theme}-${mode}-inapp.png`})
    await nativePage.screenshot({path:`${directory}/shared-${theme}-${mode}-native.png`})
    parityCases.push({theme,mode,buttons:inApp,passed:true})
  }
  // Same rendered pose and CSS scale: compare coordinates, not just button styles.
  await nativePage.waitForFunction(()=>typeof window.fixtureDraw==='function')
  const placementCases=[]
  let placementTime=Date.now()+10000
  for(const surface of [page,nativePage])await surface.evaluate(now=>{window.fixtureRealNow=Date.now;window.fixtureNow=now;Date.now=()=>window.fixtureNow},placementTime)
  const placement=()=>{
    const canvas=document.querySelector('canvas'),origin=canvas.getBoundingClientRect()
    return [...document.querySelectorAll('button[data-action],#close,[data-talk-pet-action="popout"]')].filter(b=>!b.hidden&&getComputedStyle(b).display!=='none').map(b=>{
      const r=b.getBoundingClientRect(),utility=b.id==='close'||b.dataset.talkPetAction==='popout'
      return {action:utility?'utility':b.dataset.action,x:r.x-origin.x,y:r.y-origin.y,width:r.width,height:r.height,visible:getComputedStyle(b).visibility==='visible'}
    }).sort((a,b)=>a.action.localeCompare(b.action))
  }
  for(const size of [76.8,115.2,153.6,172.8])for(const status of ['Working','Finished','']) {
    const state=await page.evaluate(()=>{
      window.fixtureVoice({live:true,stage:'connected',muted:false,bands:[.6,.8,1,.7,.5]})
      document.querySelector('[data-talk-pet-mic]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))
      return window.fixtureSnapshot()
    })
    await nativePage.evaluate(({state,status,size})=>{
      window.petReceive({generation:'fixture',state:{...state,status,pet:{sprite:window.fixtureSheet}},acks:{}})
      document.querySelector('button[data-action]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))
      const pet=document.querySelector('canvas')
      // Exercise the production zoom listener, choosing a delta that reaches the target.
      for(let i=0;i<30&&Math.abs(pet.getBoundingClientRect().width-size)>0.6;i++)pet.dispatchEvent(new WheelEvent('wheel',{deltaY:pet.getBoundingClientRect().width>size?1:-1}))
    },{state,status,size})
    // Feed the same three-frame history at identical sample times; otherwise the
    // rolling envelopes legitimately differ even when the last frame matches.
    for(let frame=0;frame<3;frame++) {
      placementTime+=1000
      const spriteSample=await nativePage.evaluate(now=>{
        window.fixtureNow=now;window.fixtureDraw();const c=document.querySelector('canvas'),r=c.getBoundingClientRect()
        return {data:c.toDataURL(),width:r.width,height:r.height}
      },placementTime)
      await page.evaluate(async({sample,now,first})=>{
        const canvas=document.querySelector('canvas'),pet=document.querySelector('#pet'),image=new Image()
        image.src=sample.data;await image.decode()
        pet.style.left='140px';pet.style.top='80px';canvas.parentElement.style.transform='none'
        if(first){canvas.width=192;canvas.height=208}
        canvas.style.width=sample.width+'px';canvas.style.height=sample.height+'px'
        canvas.getContext('2d').clearRect(0,0,192,208);canvas.getContext('2d').drawImage(image,0,0)
        window.fixtureNow=now;window.dispatchEvent(new Event('resize'))
      },{sample:spriteSample,now:placementTime,first:frame===0})
    }
    await page.waitForTimeout(180)
    const sample={size,status,inApp:await page.evaluate(placement),native:await nativePage.evaluate(placement)}
    placementCases.push(sample);writeFileSync(`${directory}/placement-report.json`,JSON.stringify(placementCases,null,2))
    await page.screenshot({path:`${directory}/placement-inapp.png`});await nativePage.screenshot({path:`${directory}/placement-native.png`})
    assert.deepEqual(sample.native.map(b=>b.action),sample.inApp.map(b=>b.action),'Both pets expose the same placement slots')
    sample.inApp.forEach((b,i)=>{
      const n=sample.native[i]
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(b[key]-n[key])<=1,`${status||'Idle'} ${size}: ${b.action} ${key} differs between pets (${b[key]} vs ${n[key]})`)
      assert.equal(n.visible,b.visible,'Same slot visibility')
    })
    sample.passed=true
  }
  writeFileSync(`${directory}/placement-report.json`,JSON.stringify(placementCases,null,2))
  await page.evaluate(async data=>{
    Date.now=window.fixtureRealNow
    const canvas=document.querySelector('canvas'),image=new Image();image.src='data:image/png;base64,'+data;await image.decode()
    canvas.width=144;canvas.height=156;canvas.style.width='144px';canvas.style.height='156px';canvas.getContext('2d').drawImage(image,0,0,144,156)
    Object.assign(document.querySelector('#pet').style,{left:'155px',top:'135px'});window.dispatchEvent(new Event('resize'))
  },sprite)
  await page.waitForTimeout(400)
  await nativePage.close()
  await page.evaluate(()=>window.fixtureVoice({live:false,stage:'idle',muted:false}))
  for(const theme of ['dark','light']) {
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.querySelector('#caption').textContent=theme+' theme · idle voice · associated work';window.dispatchEvent(new Event('resize'))},theme)
    await page.waitForTimeout(100)
    await page.screenshot({ path: `${directory}/pet-comic-${theme}.png` })
  }
  await page.evaluate(()=>window.fixtureVoice({live:true,stage:'connected',muted:true,bands:[.6,.8,1,.7,.5],micLevel:.6}))
  await page.waitForTimeout(150)
  await page.evaluate(()=>document.querySelector('#caption').textContent='light theme · injected muted call state (fixture only)')
  await page.screenshot({path:`${directory}/pet-comic-light-muted.png`})
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.querySelector('#caption').textContent='dark theme · injected muted call state (fixture only)'})
  await page.waitForTimeout(400)
  await page.screenshot({path:`${directory}/pet-comic-dark-muted.png`})
  const checks=await page.evaluate(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
    return {captures:window.fixtureCaptures,status:document.querySelector('[data-talk-pet-status]').textContent,buttons:[...document.querySelector('#pet').querySelectorAll('button')].map(e=>({name:e.getAttribute('aria-label'),...rect(e)})),sprite:rect(document.querySelector('canvas'))}
  })
  if(errors.length || checks.captures) throw Error(JSON.stringify({errors,checks}))
  for(let i=0;i<checks.buttons.length;i++)for(const b of checks.buttons.slice(i+1)){const a=checks.buttons[i];if(!(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y))throw Error('Overlapping controls')}
  await page.waitForTimeout(400)
  const art = await page.evaluate(() => {
    window.fixtureArtwork=()=>{
    const canvas=document.querySelector('canvas'),r=canvas.getBoundingClientRect(),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let l=canvas.width,t=canvas.height,right=0,bottom=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(data[(y*canvas.width+x)*4+3]>=32){l=Math.min(l,x);t=Math.min(t,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1)}
    const mirror=getComputedStyle(canvas.parentElement).transform.startsWith('matrix(-');
    return {x:r.x+(mirror?canvas.width-right:l)*r.width/canvas.width,y:r.y+t*r.height/canvas.height,w:(right-l)*r.width/canvas.width,h:(bottom-t)*r.height/canvas.height};
    };return window.fixtureArtwork();
  })
  const primary=await page.locator('[data-talk-pet-mic]').boundingBox(),balloon=await page.locator('[data-talk-pet-status]').boundingBox()
  assert.ok(primary.x-art.x-art.w>=8 && primary.x-art.x-art.w<=12,'Rail must be 8–12px from actual opaque artwork, not transparent canvas')
  assert.ok(Math.abs(balloon.y+balloon.height-art.y+12)<=2,'Balloon must be just above actual ears')
  assert.ok(Math.abs(balloon.x+balloon.width-art.x-24)<=2,'Balloon must nest beside the head, not far upper-left')
  const geometryCases=[]
  for (const size of [19.2,48,96,192,288]) for (const edge of ['center','left','right','top-left','bottom']) {
    await page.evaluate(({size,edge})=>{
      const pet=document.querySelector('#pet'),canvas=pet.querySelector('canvas');
      canvas.style.width=size+'px';canvas.style.height=(size*208/192)+'px';
      pet.style.left=(edge==='left'||edge==='top-left'?0:edge==='right'?window.innerWidth-size-2:155)+'px';
      pet.style.top=(edge==='top-left'||edge==='right'?0:edge==='bottom'?window.innerHeight-size*208/192:100)+'px';
      window.dispatchEvent(new Event('resize'));
    },{size,edge})
    await page.waitForTimeout(40)
    const sample=await page.evaluate(({size,edge})=>{
      const pet=document.querySelector('#pet'),canvas=pet.querySelector('canvas');
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
      const r=canvas.getBoundingClientRect(),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let l=canvas.width,t=canvas.height,right=0,bottom=0;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(data[(y*canvas.width+x)*4+3]>=32){l=Math.min(l,x);t=Math.min(t,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1)}
      const artwork={x:r.x+l*r.width/canvas.width,y:r.y+t*r.height/canvas.height,w:(right-l)*r.width/canvas.width,h:(bottom-t)*r.height/canvas.height};
      const bubble=pet.querySelector('[data-talk-pet-status]');return {size,edge,artwork,petLeft:pet.style.left,petTop:pet.style.top,bubble:{...rect(bubble),visible:getComputedStyle(bubble).visibility==='visible'},tail:[getComputedStyle(bubble,'::before').content,getComputedStyle(bubble,'::after').content],sprite:rect(canvas),buttons:[...pet.querySelectorAll('button')].map(e=>({...rect(e),visible:getComputedStyle(e).visibility==='visible',action:e.dataset.talkPetAction|| (e.hasAttribute('data-talk-pet-mic')?'mic':'chat')}))};
    },{size,edge})
    const disjoint=(a,b)=>a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y
    for(const a of sample.buttons) {
      assert.ok(a.x>=sample.artwork.x+sample.artwork.w+9.99,'Every control must be RIGHT of visible artwork: '+JSON.stringify(sample))
      if(a.visible) assert.ok(a.x>=0&&a.x+a.w<=560&&a.y>=0&&a.y+a.h<=420,'Visible viewport overflow: '+JSON.stringify(sample))
      if(sample.bubble.visible && a.visible) assert.ok(disjoint(a,sample.bubble),'Balloon covers controls: '+JSON.stringify(sample))
    }
    for(let i=0;i<sample.buttons.length;i++)for(const b of sample.buttons.slice(i+1))assert.ok(disjoint(sample.buttons[i],b),'Control hit targets overlap')
    const mute=sample.buttons.find(b=>b.action==='mute'),mic=sample.buttons.find(b=>b.action==='mic')
    assert.ok(mute.y+mute.h<=mic.y-5.99,'Mute must be ABOVE mic with 6px gap')
    if(sample.bubble.visible) {
      const b=sample.bubble,s=sample.artwork
      assert.ok(b.x+b.w<=s.x-11.99||b.y+b.h<=s.y-11.99,'Balloon body covers artwork: '+JSON.stringify(sample))
      assert.ok(disjoint(b,s),'Bubble body enters artwork: '+JSON.stringify(sample))
      assert.ok(b.x>=0&&b.y>=0&&b.x+b.w<=560&&b.y+b.h<=420,'Balloon viewport overflow')
      assert.ok(s.y-b.y-b.h<=14 && b.x+b.w>=s.x-12,'No detached balloon: max 14px above visible silhouette')
    }
    assert.deepEqual(sample.tail,['none','none'],'No generated tail in either pseudo-element')
    assert.equal(mic.w,36);assert.equal(mic.h,36);assert.equal(mute.w,36);assert.equal(mute.h,36)
    for(const button of sample.buttons.filter(b=>['chat','transcript'].includes(b.action))){assert.equal(button.w,24);assert.equal(button.h,24)}
    assert.equal(mic.visible,sample.artwork.x+sample.artwork.w+10+36<=552,'Primary column uses available right-hand room without moving pet')
    const canPlaceAbove=sample.artwork.y>=sample.bubble.h+20
    if(canPlaceAbove && edge!=='right' && sample.artwork.w>40) assert.equal(sample.bubble.visible,true,'Available above-head room should be used')
    assert.equal(Number.parseFloat(sample.petLeft),edge==='left'||edge==='top-left'?0:edge==='right'?560-size-2:155,'Plugin must not move the core pet')
    assert.equal(Number.parseFloat(sample.petTop),edge==='top-left'||edge==='right'?0:edge==='bottom'?420-size*208/192:100,'Plugin must not move the core pet')
    geometryCases.push({...sample,minimumControlGap:Math.min(...sample.buttons.map(b=>b.x-sample.artwork.x-sample.artwork.w)),passed:true})
  }
  const animationCases=[]
  for(const frame of ['pet-frame.png','pet-laptop.png']) for(const mirrored of [false,true]) {
    const data=readFileSync(join(framesDirectory, frame)).toString('base64')
    await page.evaluate(async({data,mirrored})=>{
      const pet=document.querySelector('#pet'),canvas=pet.querySelector('canvas');
      pet.style.left='155px';pet.style.top='135px';canvas.style.width='144px';canvas.style.height='156px';
      canvas.parentElement.style.transform=mirrored?'scaleX(-1)':'none';
      const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
      const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
      // No resize or state DOM event: this emulates PetSprite's row switch.
    },{data,mirrored})
    await page.waitForTimeout(400)
    const a=await page.evaluate(()=>window.fixtureArtwork()),b=await page.locator('[data-talk-pet-status]').boundingBox(),mic=await page.locator('[data-talk-pet-mic]').boundingBox()
    assert.ok(mic.x-a.x-a.w>=8 && mic.x-a.x-a.w<=12,'Animated/mirrored rail remains tightly attached')
    assert.ok(b && a.y-b.y-b.height>=11.99 && a.y-b.y-b.height<=14,'Row switches must not leave a detached balloon in prior empty padding')
    animationCases.push({frame,mirrored,artwork:a,balloon:b,mic,passed:true})
  }
  // Backing DPI and replacement must not leave cached bounds on the old canvas.
  for(const replace of [false,true]) {
    await page.evaluate(async({data,replace})=>{
      let canvas=document.querySelector('canvas');
      if(replace){const next=canvas.cloneNode();canvas.replaceWith(next);canvas=next}
      canvas.width=288;canvas.height=312;canvas.parentElement.style.transform='none';
      const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
      canvas.getContext('2d').drawImage(image,0,0,288,312);
    },{data:sprite,replace})
    await page.waitForTimeout(400)
    const art=await page.evaluate(()=>window.fixtureArtwork()),mic=await page.locator('[data-talk-pet-mic]').boundingBox()
    assert.ok(mic.x-art.x-art.w>=8&&mic.x-art.x-art.w<=12,'Backing resize/replacement must refresh visible alpha bounds')
    animationCases.push({backingSize:'288x312',replace,passed:true})
  }
  await page.evaluate(()=>{
    window.fixtureReadbacks=0;window.fixtureReadbackOriginal=CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData=function(...args){window.fixtureReadbacks++;return window.fixtureReadbackOriginal.apply(this,args)};
  })
  await page.waitForTimeout(1100)
  const readbacks=await page.evaluate(()=>window.fixtureReadbacks)
  assert.ok(readbacks>=2&&readbacks<=4,'Alpha reads must be bounded to ~3Hz, not animation-frame readbacks')
  await page.evaluate(()=>window.fixtureCleanup())
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(()=>window.fixtureReadbacks),readbacks,'Unmount must stop alpha sampling')
  if(await page.locator('style[data-talk-pet-style], [data-talk-pet-mic], [data-talk-pet-chat], [data-talk-pet-status], [data-talk-pet-action]').count())throw Error('Fixture unmount left companions behind')
  const report={directory,errors,checks,parityCases,placementCases,geometryCases,animationCases,readbacks,cleanup:'passed'}
  writeFileSync(`${directory}/geometry-report.json`,JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2))
} finally {await browser.close()}