// Native view owns presentation and typed actions only. No network/audio APIs.
(() => {
  const post = value => window.webkit.messageHandlers.companion.postMessage(JSON.stringify(value))
  const pet = document.getElementById('pet'), ctx = pet.getContext('2d'), bubble = document.getElementById('status')
  const sheet = new Image(), buttons = new Map(), pending = new Map()
  let state = null, generation = '', frame = 0, scale = .8, bounds = {left:0,top:0,right:1,bottom:1}, requestSerial=0, shapeKey=''
  const visibleBounds = petBoundsReader()
  let controlBounds = null
  const replies = new Map()
  let notice = '', noticeTimer = null
  const narration = () => state?.narration && state.narration.until > Date.now() ? state.narration : null
  const attention = () => state?.attention?.kind ? state.attention : null
  const bubbleText = () => notice || (state ? ((attention() && petAttentionLabel(attention().kind)) || (t=>t&&(t=t.split(' — ')[0].replace(/\s*\([^)]*\)\s*$/,''),t.length>18?t.slice(0,17).trimEnd()+'…':t))(narration()?.text) || state.status || (state.lifecycle==='connected'?(state.muted?'Microphone muted':'Live Voice'):state.lifecycle==='connecting'?'Connecting':state.lifecycle==='error'?'Voice unavailable':petReplyHint)) : (bubble.dataset.offline || 'Owner connecting'))
  const paintBubble = () => petSetBubbleText(bubble, bubbleText())
  const flash = text => { notice = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ''; paintBubble(); layout() }, 3000); paintBubble(); layout() }
  const style = document.createElement('style'); style.textContent = petButtonCSS; document.head.append(style)
  const descriptor = () => state?.descriptor || petDescriptor(state?.lifecycle==='connected'||state?.lifecycle==='connecting',!!state?.muted)
  const layout = () => {
    const d=descriptor(), box=d.statusBox
    Object.assign(bubble.style,petBubbleStyle(box))
    const artwork=b=>({left:140+192*b.left*scale,top:80+208*b.top*scale,width:192*(b.right-b.left)*scale,height:208*(b.bottom-b.top)*scale})
    const art=artwork(bounds)
    // Bubble sits under the stable all-frames envelope so animation never moves it.
    const geometry=petLayout(art,{width:innerWidth,height:innerHeight},{width:bubble.offsetWidth||100.8,height:bubble.offsetHeight||40.8},d)
    // Keep the status box/input envelope unchanged; only buttons adopt in-app placement.
    const controlGeometry=controlBounds?petLayout(artwork(controlBounds),{width:innerWidth,height:innerHeight},{width:0,height:0},d):geometry
    for(const [controlIndex,control] of petButtons(state).entries()) {
      let button=buttons.get(control.feedback || control.action)
      if(!button) {
        button=document.createElement('button');button.type='button';buttons.set(control.feedback||control.action,button);document.body.append(button)
        petBindFeedback(button, layout)
        button.addEventListener('click',()=>{
          if(!state || button.disabled || pending.size>=32)return
          const action=button.dataset.action
          const id='pet-'+Date.now().toString(36)+'-'+(++requestSerial).toString(36)
          pending.set(id,{button,action,time:Date.now()});layout()
          // State delivery is deduplicated; expiry cannot depend on a new poll.
          setTimeout(()=>{if(pending.delete(id)){layout();flash('Action timed out')}},16000)
          post({type:'command',command:{id,generation,action,...(action==='setMuted'?{muted:!state.muted}:{})}})
        })
      }
      petPaintButton(button,control,state,[...pending.values()].some(p=>p.button===button&&p.action===control.action))
      const position=controlGeometry.controls[controlIndex]
      Object.assign(button.style,{left:position.left+'px',top:position.top+'px',width:position.size+'px',height:position.size+'px',visibility:position.visible?'visible':'hidden'})
    }
    const close=document.getElementById('close')
    const utility=controlGeometry.utility
    Object.assign(close.style,{right:'auto',left:utility.left+'px',top:utility.top+'px',width:utility.size+'px',height:utility.size+'px',visibility:utility.visible?'visible':'hidden'})
    Object.assign(bubble.style,{left:geometry.left+'px',top:geometry.top+'px',visibility:geometry.bubbleVisible?'visible':'hidden'})
    const rectangles=[[art.left,art.top,art.width,art.height]]
    for(const button of [...buttons.values(),close,bubble])if(!button.hidden&&button.style.visibility!=='hidden') {
      const rect=button.getBoundingClientRect();rectangles.push([rect.x,rect.y,rect.width,rect.height])
    }
    const key=JSON.stringify(rectangles)
    if(key!==shapeKey){shapeKey=key;post({type:'shape',rectangles})}
  }
  window.petReceive = message => {
    if(message.error) {state=null;pending.clear();replies.clear();bubble.dataset.offline=message.error;paintBubble();layout();return}
    if(message.warning) {flash(message.warning);return}
    if(generation && generation!==message.generation){pending.clear();replies.clear()}
    generation=message.generation;state=message.state
    // The Pets panel's main-pet size (100% = .8, the old default); the helper sizes the window to match.
    scale=.8*(state?.petSize||100)/100;pet.style.width=192*scale+'px';pet.style.height=208*scale+'px'
    loadSheet(state?.pet)
    for(const [id,p] of pending) {
      const ack=message.acks?.[id]
      if(ack || Date.now()-p.time>16000) {pending.delete(id);if(ack?.ok===false)bubble.textContent='Action unavailable';if(ack?.ok===true && ['chat','transcript'].includes(p.action))post({type:'reveal'})}
    }
    for(const [id,time] of replies) {
      const ack=message.acks?.[id]
      if(ack || Date.now()-time>16000) {replies.delete(id);if(ack?.ok!==true)flash('Could not send')}
    }
    for(const [key,value] of Object.entries(state?.theme||{}))document.documentElement.style.setProperty('--'+key,value)
    paintBubble()
    layout()
  }
  let counts=[],activeRow=-1,drawing=false,sheetSource=''
  sheet.onload=()=>{
    // Petdex v2 taxonomy, identical to Hermes PetSprite's named rows.
    // The manifest does not override geometry/counts: trim each row at its
    // first blank cell, as pet.info does, rather than assuming six frames.
    const rows=['idle','running-right','running-left','waving','jumping','failed','waiting','running','review']
    const found=[], sample=document.createElement('canvas');sample.width=192;sample.height=208
    const scan=sample.getContext('2d',{willReadFrequently:true})
    let left=192,top=208,right=0,bottom=0
    for(let row=0;row<rows.length;row++) {
      let count=0
      for(let col=0;col<sheet.naturalWidth/192;col++) {
        scan.clearRect(0,0,192,208);scan.drawImage(sheet,col*192,row*208,192,208,0,0,192,208)
        const pixels=scan.getImageData(0,0,192,208).data
        let opaque=false
        for(let y=0;y<208;y++)for(let x=0;x<192;x++)if(pixels[(y*192+x)*4+3]>=32){opaque=true;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1)}
        if(!opaque)break
        count++
      }
      found.push(count)
    }
    counts=found;activeRow=-1;frame=0
    if(right>left&&bottom>top)bounds={left:left/192,top:top/208,right:right/192,bottom:bottom/208}
    if(drawing)return
    drawing=true
    const draw=()=>{
      const name=attention()?'waiting':narration()?.tone==='error'?'failed':narration()?.tone==='info'?'waving':state?.status==='Working'||state?.status==='Sending'?'running':state?.status==='Error'?'failed':state?.status==='Finished'?'waving':narration()?.tone==='error'?'failed':narration()?.tone==='info'?'waving':'idle'
      let row=rows.indexOf(name);if(!counts[row])row=0
      const count=Math.max(1,counts[row])
      if(row!==activeRow){activeRow=row;frame=0}
      ctx.clearRect(0,0,192,208);ctx.drawImage(sheet,frame*192,row*208,192,208,0,0,192,208)
      const next=visibleBounds(pet)
      if(next && next!==controlBounds){controlBounds=next;layout()}
      frame=(frame+1)%count
      setTimeout(draw,1100/count)
    }
    draw()
  }
  // The broker sends the user's selected Hermes pet once per sheet; swap when it changes.
  const loadSheet=pet=>{
    const source=typeof pet?.sprite==='string'&&/^data:image\/(webp|png);base64,/.test(pet.sprite)?pet.sprite:''
    if(source&&source!==sheetSource){sheetSource=source;sheet.src=source}
  }
  let drag=null
  // Pointer events move the window; a native drag would offer data to other apps and can block GTK.
  window.addEventListener('dragstart',event=>event.preventDefault())
  pet.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag=event.pointerId;pet.setPointerCapture(event.pointerId);post({type:'drag',phase:'start'})})
  pet.addEventListener('pointermove',event=>{if(drag!==event.pointerId)return;post({type:'drag',phase:'move'})})
  const endDrag=()=>{if(drag===null)return;drag=null;post({type:'drag',phase:'end'})}
  pet.addEventListener('pointerup',endDrag)
  pet.addEventListener('pointercancel',endDrag)
  pet.addEventListener('lostpointercapture',endDrag)
  document.getElementById('close').onclick=()=>{if(generation)post({type:'command',command:{id:'pet-close-'+Date.now().toString(36)+'-'+(++requestSerial),generation,action:'hidePet'}})}
  petQuickReply(bubble,{
    send:text=>{
      if(!state?.capabilities?.includes('reply')){flash(state?'Open a chat first':'Pet is disconnected');return}
      const id='pet-'+Date.now().toString(36)+'-'+(++requestSerial).toString(36)
      replies.set(id,Date.now())
      post({type:'command',command:{id,generation,action:'reply',text}})
    },
    keyboard:on=>post({type:'keyboard',on}),
    repaint:()=>{paintBubble();layout()}
  })
  window.addEventListener('resize',layout)
  paintBubble();layout();post({type:'ready'})
})()
