// Desktop bot window: a thin shell around the shared petBotView (desktop/plugin.js).
// The helper supplies the avatar and sheet; no renderer paths.
(() => {
  const post = value => window.webkit.messageHandlers.companion.postMessage(JSON.stringify(value))
  if (document.head && document.createElement) {
    const style = document.createElement('style'); style.textContent = petBotCSS(''); document.head.append(style)
  }
  const view = petBotView({ el: part => document.getElementById(part), post })
  // No native drag-and-drop source anywhere in this window (see petBotView).
  window.addEventListener('dragstart', event => event.preventDefault())
  window.botReceive = view.receive
  window.addEventListener('pagehide', view.dispose)
  post({type:'ready'})
})()
