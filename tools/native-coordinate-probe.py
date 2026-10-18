"""Read real Wayland PointerEvent coordinates on an isolated helper. No clicks/audio."""
import io,json,runpy,inspect,sys,threading,subprocess
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'companion'))
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']));b=json.dumps({'generation':'probe','state':{'status':'','lifecycle':'idle','capabilities':[]},'acks':{}}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
s=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=s.serve_forever,daemon=True).start()
sys.stdin=io.StringIO(json.dumps({'root':str(root),'url':f'http://127.0.0.1:{s.server_port}','token':'fixture'})+'\n')
original=Gtk.main
cursor=json.loads(subprocess.check_output(['hyprctl','-j','cursorpos']))
def main():
 g=inspect.currentframe().f_back.f_globals;web=g['web'];win=g['win'];L=g['GtkLayerShell'];E=L.Edge
 L.set_margin(win,E.LEFT,800);L.set_margin(win,E.BOTTOM,300)
 def move(x,y):
  print(subprocess.check_output(['hyprctl','dispatch',f'hl.dsp.cursor.move({{x={x},y={y}}})']).decode().strip(), subprocess.check_output(['hyprctl','-j','cursorpos']).decode().strip());return False
 def install():
  win.get_window().input_shape_combine_region(g['cairo'].Region(g['cairo'].RectangleInt(0,0,384,320)),0,0)
  web.evaluate_javascript("window.coords=[];document.addEventListener('mousemove',e=>coords.push({screenX:e.screenX,screenY:e.screenY,clientX:e.clientX,clientY:e.clientY}));",-1,None,None,None,None,None);return False
 def phase(value):
  web.evaluate_javascript('window.webkit.messageHandlers.companion.postMessage('+json.dumps(json.dumps({'type':'drag','phase':value}))+')',-1,None,None,None,None,None);return False
 def done():
  def cb(v,r,*a):
   value=json.loads(v.evaluate_javascript_finish(r).to_string());geom=g['Gdk'].Display.get_default().get_monitor_at_window(win.get_window()).get_geometry();margins=[L.get_margin(win,E.LEFT),L.get_margin(win,E.BOTTOM)];print(json.dumps({'events':value,'gdkGeometry':[geom.width,geom.height],'gdkScale':win.get_scale_factor(),'margins':margins}));assert margins==[830,280],margins;g['stop']()
  web.evaluate_javascript('JSON.stringify(coords)',-1,None,None,None,cb,None);return False
 GLib.timeout_add(500,install);GLib.timeout_add(700,lambda:(print(subprocess.check_output(['hyprctl','-j','layers']).decode()),False)[1]);GLib.timeout_add(800,lambda:move(1040,445));GLib.timeout_add(900,lambda:phase('start'));GLib.timeout_add(1000,lambda:move(1070,465));GLib.timeout_add(1100,lambda:phase('move'));GLib.timeout_add(1200,lambda:phase('end'));GLib.timeout_add(1400,done);original()
Gtk.main=main
try:runpy.run_path(str(root/'companion/native_helper.py'),run_name='__main__')
finally:subprocess.run(['hyprctl','dispatch',f"hl.dsp.cursor.move({{x={cursor['x']},y={cursor['y']}}})"],stdout=subprocess.DEVNULL);s.shutdown()
