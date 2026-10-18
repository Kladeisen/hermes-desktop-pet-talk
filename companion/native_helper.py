"""Native Linux companion; presentation only, never a microphone/provider owner."""
import sys
import gi
import cairo
from input_regions import normalize_regions
from native_platform import cursor_position, drag_margins, keep_reachable, reveal_owner, scaled_window
from native_bots import BotWindow

gi.require_foreign('cairo')

gi.require_version('Gtk','3.0')
gi.require_version('WebKit2','4.1')
gi.require_version('GtkLayerShell','0.1')
from gi.repository import Gtk, Gdk, GLib, WebKit2, GtkLayerShell

if '--check' in sys.argv:
    print('GTK3 WebKit2-4.1 GtkLayerShell available')
    raise SystemExit(0)

import base64
import json
import secrets
import signal
import threading
import time
import urllib.request
from pathlib import Path
from queue import Queue, Empty

root=Path(__file__).resolve().parent.parent
bootstrap=json.loads(sys.stdin.readline(4096))
if bootstrap.get('root') != str(root) or not bootstrap.get('url','').startswith('http://127.0.0.1:'):
    raise SystemExit('Invalid private bootstrap')
url=bootstrap['url'];token=bootstrap['token']
Gtk.init([])
if not GtkLayerShell.is_supported():
    raise SystemExit('Compositor does not support native Wayland layer-shell')
win=Gtk.Window();win.set_default_size(384,320);win.set_decorated(False);win.set_app_paintable(True)
visual=win.get_screen().get_rgba_visual()
if visual: win.set_visual(visual)
GtkLayerShell.init_for_window(win)
GtkLayerShell.set_namespace(win,'talk-desktop-pet')
GtkLayerShell.set_layer(win,GtkLayerShell.Layer.OVERLAY)
GtkLayerShell.set_anchor(win,GtkLayerShell.Edge.LEFT,True)
GtkLayerShell.set_anchor(win,GtkLayerShell.Edge.BOTTOM,True)
GtkLayerShell.set_margin(win,GtkLayerShell.Edge.LEFT,80)
GtkLayerShell.set_margin(win,GtkLayerShell.Edge.BOTTOM,80)
GtkLayerShell.set_keyboard_mode(win,GtkLayerShell.KeyboardMode.NONE)
# Ignore other bars' reserved space so drag limits match the full monitor.
GtkLayerShell.set_exclusive_zone(win,-1)
# The pet's canvas inside the window (view.html: left 140, top 80, 153.6x166.4).
PET_BOX=(140,80,293.6,246.4)
manager=WebKit2.UserContentManager();manager.register_script_message_handler('companion')
web=WebKit2.WebView.new_with_user_content_manager(manager)
# Layer-shell sizing follows child requisition, not Gtk.Window's default size.
# A WebView without a requisition can configure but never attach a buffer.
web.set_size_request(384,320)
settings=web.get_settings();settings.set_enable_media_stream(False);settings.set_enable_developer_extras(False)
settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
settings.set_enable_html5_local_storage(False)
web.connect('permission-request',lambda view,request:(request.deny(),True)[1])
web.connect('create',lambda *args:None)
# HTML is loaded once locally. No navigation or network content can replace it.
initial_navigation = True
def navigation(view,decision,kind):
    global initial_navigation
    if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
        uri=decision.get_navigation_action().get_request().get_uri()
        if initial_navigation and uri in {'about:blank','file://'+str(root/'companion')+'/'}:
            initial_navigation=False;decision.use()
        else: decision.ignore()
        return True
    return False
web.connect('decide-policy',navigation)
rgba=Gdk.RGBA();rgba.parse('rgba(0,0,0,0)');web.set_background_color(rgba)
source=(root/'desktop'/'plugin.js').read_text()
shared=source.split('// COMPANION_SHARED_BEGIN',1)[1].split('\n',1)[1].split('// COMPANION_SHARED_END',1)[0]
view=(root/'companion'/'view.js').read_text()
nonce=secrets.token_urlsafe(24)
# The sheet is the user's selected Hermes pet, delivered by the broker like bot sheets.
html=(root/'companion'/'view.html').read_text().replace('PET_NONCE',nonce).replace('PET_SCRIPT',shared+'\n'+view)
web.load_html(html,'file://'+str(root/'companion')+'/')
win.add(web)
queue=Queue(maxsize=32);stopping=threading.Event();wake=threading.Event();ready=False;drag=None
bot_windows={}
sprites={}  # sheet id -> data URI, fetched once from the broker's /sprite endpoint
main_sprite=None  # sheet id the main view already holds; sheets travel once

def send_bot(command):
    queue.put_nowait(command);wake.set()

main_size=None;bot_reset=None  # Pets panel: pop-out size applied, last bot-position reset seen

def resize_main(state):
    """Pets panel sizes: the pop-out window grows with its pet; every bot window follows one size."""
    global main_size,bot_reset,PET_BOX
    if state.get('petSize',100)!=main_size:
        main_size=state.get('petSize',100);width,height,PET_BOX=scaled_window(main_size)
        web.set_size_request(width,height);win.resize(width,height)
        keep_reachable(GtkLayerShell,Gdk,win,(width,height),PET_BOX)
    for surface in bot_windows.values():
        if surface.size!=state.get('botSize',100): surface.resize(state.get('botSize',100))
    if bot_reset is not None and state.get('botReset',0)!=bot_reset:
        for surface in bot_windows.values(): surface.place()
    bot_reset=state.get('botReset',0)

def evaluate(value):
    if not stopping.is_set():
        if value.get('warning'):
            web.evaluate_javascript('window.petReceive('+json.dumps(value)+')',-1,None,None,None,None,None)
            return False
        state=value.get('state',{})
        bots=state.get('bots',[])
        wanted={bot['id'] for bot in bots}
        for identity in list(bot_windows):
            if identity not in wanted:
                bot_windows.pop(identity).win.destroy()
        for bot in bots:
            identity=bot['id']
            if identity not in bot_windows:
                used={surface.slot for surface in bot_windows.values()}
                index=next(slot for slot in range(12) if slot not in used)
                bot_windows[identity]=BotWindow(globals(),identity,index,send_bot,state.get('botSize',100))
                bot_windows[identity].slot=index
            bot_windows[identity].receive({'generation':value['generation'],'bot':bot,'acks':value.get('acks',{})})
        if {'petSize','botSize','botReset'}&set(state): resize_main(state)
        if 'state' in value:
            if state.get('petVisible',True): win.show_all()
            else: win.hide()
        global main_sprite
        pet=state.get('pet')
        if ready and isinstance(pet,dict) and pet.get('spriteId')!=main_sprite and sprites.get(pet.get('spriteId')):
            value={**value,'state':{**state,'pet':{**pet,'sprite':sprites[pet['spriteId']]}}}
            main_sprite=pet['spriteId']
        web.evaluate_javascript('window.petReceive('+json.dumps(value,separators=(',',':'))+')',-1,None,None,None,None,None)
    return False

def stop(*args):
    if stopping.is_set(): return False
    stopping.set()
    for surface in bot_windows.values(): surface.win.destroy()
    bot_windows.clear();win.destroy();Gtk.main_quit();return False

def message(manager,result):
    try:
        data=json.loads(result.get_js_value().to_string())
        kind=data.get('type')
        if kind=='ready':
            global ready,main_sprite
            ready=True
            main_sprite=None  # a (re)loaded page has no sheet yet
            threading.Thread(target=lambda:request('/ready',{}),daemon=True).start()
        elif kind=='close': stop()
        elif kind=='keyboard':
            # Keyboard only while the quick-reply field is open; never steal focus otherwise.
            mode=GtkLayerShell.KeyboardMode.EXCLUSIVE if data.get('on') is True else GtkLayerShell.KeyboardMode.NONE
            GtkLayerShell.set_keyboard_mode(win,mode)
            if data.get('on') is True: web.grab_focus()
        elif kind=='shape':
            # Clip to this window (384x320), not the normalizer's 360 px default.
            width,height=win.get_size()
            rectangles=normalize_regions(data.get('rectangles'),width=width,height=height)
            if rectangles and win.get_window():
                region=cairo.Region()
                for rect in rectangles:region.union(cairo.RectangleInt(*rect))
                win.get_window().input_shape_combine_region(region,0,0)
        elif kind=='reveal':
            try: reveal_owner()
            except Exception: evaluate({'warning':'Could not reveal owning Hermes window'})
        elif kind=='drag':
            global drag
            phase=data.get('phase')
            if phase=='start':
                monitor=Gdk.Display.get_default().get_monitor_at_window(win.get_window())
                geometry=monitor.get_geometry()
                drag=((GtkLayerShell.get_margin(win,GtkLayerShell.Edge.LEFT),GtkLayerShell.get_margin(win,GtkLayerShell.Edge.BOTTOM)),cursor_position(),(geometry.width,geometry.height),(win.get_allocated_width(),win.get_allocated_height()))
            elif phase=='move' and drag:
                left,bottom=drag_margins(drag[0],drag[1],cursor_position(),drag[2],drag[3],PET_BOX)
                GtkLayerShell.set_margin(win,GtkLayerShell.Edge.LEFT,left)
                GtkLayerShell.set_margin(win,GtkLayerShell.Edge.BOTTOM,bottom)
            elif phase=='end': drag=None
        elif kind=='command' and isinstance(data.get('command'),dict):
            queue.put_nowait(data['command']);wake.set()
    except (ValueError,TypeError,OverflowError): pass
    except Exception: pass
manager.connect('script-message-received::companion',message)

def request(path,payload):
    req=urllib.request.Request(url+path,json.dumps(payload).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=2) as response:
        # Twelve bounded 1 MiB avatars expand by 4/3 in base64.
        return json.loads(response.read(18 * 1048576))

def fetch_sprites(result):
    """Fetch each newly referenced bot sheet once by id; True when every sheet is present."""
    wanted=set()
    state=result.get('state') or {}
    for owner in [state,*(state.get('bots') or [])]:
        ident=(owner.get('pet') or {}).get('spriteId')
        if isinstance(ident,str) and len(ident)==64: wanted.add(ident)
    for ident in list(sprites):
        if ident not in wanted: del sprites[ident]
    complete=True
    for ident in sorted(wanted-set(sprites)):
        try: data=request('/sprite',{'id':ident}).get('sprite')
        except Exception: data=None
        if isinstance(data,str) and data.startswith(('data:image/webp;base64,','data:image/png;base64,')):
            sprites[ident]=data
        else: complete=False
    return complete

def worker():
    last=time.monotonic()
    previous=None;previous_complete=True
    while not stopping.is_set():
        wake.wait(.2);wake.clear()
        if stopping.is_set(): return
        try:
            while True:
                try: command=queue.get_nowait()
                except Empty: break
                try: request('/command',command)
                except Exception: GLib.idle_add(evaluate,{'warning':'Action unavailable'})
            result=request('/state',{})
            last=time.monotonic()
            complete=fetch_sprites(result)
            # Repaint on change, and once more when a missing sheet finally arrives.
            if ready and (result != previous or complete != previous_complete):
                GLib.idle_add(evaluate,result);previous=result;previous_complete=complete
        except Exception:
            previous=None  # a recovered identical state must repaint after error
            if ready: GLib.idle_add(evaluate,{'error':'Owner disconnected'})
            if time.monotonic()-last>5: GLib.idle_add(stop);return
threading.Thread(target=worker,daemon=True).start()
win.connect('destroy',stop)
signal.signal(signal.SIGTERM,lambda *args:GLib.idle_add(stop))
signal.signal(signal.SIGINT,lambda *args:GLib.idle_add(stop))
Gtk.main()
