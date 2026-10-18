// Isolated real controller + real plugin REST/native helper verifier.
// The provider boundary alone is replaced; no audio capture is possible.
import {readFileSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const React=require('react'), {jsx,jsxs}=require('react/jsx-runtime'), {JSDOM}=require('jsdom')
const boot=JSON.parse(readFileSync(process.env.PET_VERIFY_BOOTSTRAP,'utf8'))
const dom=new JSDOM('<body><div id="fixture-root"></div></body>',{url:'https://pet-verifier.test',pretendToBeVisual:true}), w=dom.window
Object.assign(globalThis,{window:w,document:w.document});const {createRoot}=require('react-dom/client');const {createPortal}=require('react-dom');
const DialogContext=React.createContext(false);const dialogSdk={Dialog:({open,children})=>jsx(DialogContext.Provider,{value:open,children}),DialogContent:({children,...props})=>React.useContext(DialogContext)?createPortal(jsx('section',{role:'dialog',...props,children}),w.document.body):null,DialogTitle:({children})=>jsx('h2',{children}),Button:({children,onClick})=>jsx('button',{onClick,children})};
let captures=0,starts=0,closes=0
const atom=initial=>{let value=initial;const listeners=new Set();return{get:()=>value,set:v=>{value=v;listeners.forEach(fn=>fn(v))},listen:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}}
const state={focusedSessionId:atom('fixture-runtime'),focusedStoredSessionId:atom('fixture-durable'),focusedSessionProfile:atom('default'),focusedSessionOwner:atom({connectionId:'local',profile:'default'}),connectionId:atom('local'),profile:atom('default'),busyBySession:atom({})}
const opened=[],disposers=[],contributions=[], track={enabled:true},video={enabled:true}
const host={state,openSession:async(id,options)=>opened.push({id,options}),onEvent:()=>()=>{},notify:n=>console.log('fixture notice',n.message)}
const rest=async(path,opts={})=>{
 const response=await fetch(boot.url+'/api/plugins/talk-desktop'+path,{method:opts.method||'GET',headers:{Authorization:'Bearer '+boot.token,'Content-Type':'application/json'},body:opts.body?JSON.stringify(opts.body):undefined,signal:AbortSignal.timeout(4000)})
 const data=await response.json();if(!response.ok)throw Error(data.detail||data.error||String(response.status));return data
}
Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>{captures++;throw Error('No capture in verifier')}}})
const context=vm.createContext({window:w,document:w.document,navigator:w.navigator,CustomEvent:w.CustomEvent,MutationObserver:w.MutationObserver,MouseEvent:w.MouseEvent,jsx,jsxs,useState:React.useState,useEffect:React.useEffect,useRef:React.useRef,sdk:{...dialogSdk,host,PALETTE_AREA:'commandPalette',useValue:a=>a.get()},setInterval,clearInterval,setTimeout,clearTimeout,console,performance:w.performance,track,video})
const source=readFileSync(new URL('../desktop/plugin.js',import.meta.url),'utf8')
vm.runInContext(source.replace(/^import .*\n/gm,'').replace('export default {','globalThis.plugin = {'),context)
context.plugin.register({register:c=>contributions.push(c),onDispose:fn=>disposers.push(fn),storage:{get:()=>null},rest})
const ui=createRoot(w.document.getElementById('fixture-root'));ui.render(contributions.find(c=>c.id==='companion-transcript').render());
const muteBody=source.slice(source.indexOf('  ctl.setMuted = desired => {'),source.indexOf('  ctl.toggleMute ='))
context.muteBody=muteBody
vm.runInContext(`startLive=async()=>{
 window.fixtureStarts=(window.fixtureStarts||0)+1
 let mutedNow=false;const ctl={};const pc={getSenders:()=>[{track},{track:video}]};track.kind='audio';video.kind='video'
 eval(muteBody)
 bus.set({live:true,stage:'connected',bands:[.2,.4,.6,.3,.1,.5]})
 return {setMuted:desired=>ctl.setMuted(desired),close:()=>{window.fixtureCloses=(window.fixtureCloses||0)+1;bus.set({live:false,stage:'idle'})}}
}`,context)
await vm.runInContext('liveController.action({action:"start"})',context)
await contributions.find(c=>c.id==='pet-pop-out').data.run()
console.log('FIXTURE native helper launched; no microphone/provider')
const receipt=()=>({fixture:true,transcriptMounted:!!w.document.querySelector('[data-talk-companion-transcript]'),captures,starts:w.fixtureStarts||0,closes:w.fixtureCloses||0,trackEnabled:track.enabled,videoEnabled:video.enabled,opened,snapshot:vm.runInContext('liveController.snapshot()',context)})
const timer=setInterval(()=>writeFileSync(process.env.PET_VERIFY_RECEIPT,JSON.stringify(receipt(),null,2)),300)
await new Promise(resolve=>setTimeout(resolve,Number(process.env.PET_VERIFY_DURATION_MS || 100000)))
clearInterval(timer);ui.unmount();disposers.forEach(fn=>fn());writeFileSync(process.env.PET_VERIFY_RECEIPT,JSON.stringify(receipt(),null,2));w.close()
console.log('FIXTURE verification owner disposed; child lease released')
