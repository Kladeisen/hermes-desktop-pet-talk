"""Real GTK/WebKit pixel regression; disposable copy only, system Python.
Synthetic sheets only: the plugin ships no character artwork.
"""
import base64
import inspect
import io
import json
import os
from pathlib import Path
import runpy
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib
root=Path(__file__).resolve().parents[1]
scratch=Path(os.environ['TALK_TEST_ISOLATED_ROOT']).resolve()
assert root.is_relative_to(scratch) and Path.home().is_relative_to(scratch)
sys.path.insert(0,str(root/'companion'))
import hashlib
bots=[]; sprites={}
def add_bot(identity, data_uri, counts):
    ident=hashlib.sha256(data_uri.encode()).hexdigest()
    sprites[ident]=data_uri  # served once via /sprite, like the broker
    pet=dict(spriteId=ident,frameWidth=192,frameHeight=208,counts=counts)
    bots.append(dict(id=identity,label=identity,status='Working',chat=True,pet=pet))

def synthetic_sheet(counts, columns=8):
    """Data URI of a 192x208-grid sheet with a distinct colour per cell (no real artwork)."""
    import base64 as _b64, io as _io, cairo as _cairo
    surface=_cairo.ImageSurface(_cairo.FORMAT_ARGB32,columns*192,len(counts)*208);paint=_cairo.Context(surface)
    for row,count in enumerate(counts):
        for col in range(count):
            paint.set_source_rgba((col+1)/(columns+1),(row+1)/(len(counts)+1),.5,1);paint.rectangle(col*192+40,row*208+30,112,160);paint.fill()
    out=_io.BytesIO();surface.write_to_png(out)
    return 'data:image/png;base64,'+_b64.b64encode(out.getvalue()).decode()
# The two real-world layouts the bots used: 6x9 and 8x11 grids.
add_bot('six-by-nine', synthetic_sheet([6]*9, 6), [6]*9)
add_bot('eight-by-eleven', synthetic_sheet([7,8,8,4,5,8,6,6,6,1,1], 8), [7,8,8,4,5,8,6,6,6])
# A 1536x1872 (8x9) gallery-style grid: the layout the old fixed-size guard rejected.
import cairo
grid=cairo.ImageSurface(cairo.FORMAT_ARGB32,1536,1872); paint=cairo.Context(grid)
for row in range(9):
    for col in range(8):
        paint.set_source_rgba((col+1)/9,(row+1)/10,.5,1); paint.rectangle(col*192+20,row*208+20,152,168); paint.fill()
png=io.BytesIO(); grid.write_to_png(png)
add_bot('gallery-grid', 'data:image/png;base64,'+base64.b64encode(png.getvalue()).decode(), [8]*9)
state=dict(lifecycle='idle',status='',muted=False,bands=[],capabilities=[],petVisible=False,bots=bots)
results, failures=[],[]
class Owner(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        assert self.headers.get('Authorization')=='Bearer fixture'
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])) or b'{}')
        if self.path=='/sprite': body=json.dumps(dict(sprite=sprites[payload['id']])).encode()
        else: body=json.dumps(dict(generation='fixture',state=state,acks={})).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
owner=ThreadingHTTPServer(('127.0.0.1',0),Owner)
threading.Thread(target=owner.serve_forever,daemon=True).start()
sys.stdin=io.StringIO(json.dumps(dict(root=str(root),url=f'http://127.0.0.1:{owner.server_port}',token='fixture'))+'\n')
original=Gtk.main

def main():
    g=inspect.currentframe().f_back.f_globals
    def publish(status,attention=False):
        for bot in bots:
            bot['status']=status
            if attention: bot['attention']={'kind':'clarify','count':1}
            else: bot.pop('attention',None)
        return False
    def sample_one(expected, bot_id):
        def received(view,result,*_):
            try:
                value=json.loads(view.evaluate_javascript_finish(result).to_string())
                assert value['row']==expected,value
                assert value['visible'] and value['alpha']>0,value
                value['bot']=bot_id
                results.append(value)
            except Exception as error: failures.append(str(error))
        try:
            g['bot_windows'][bot_id].web.evaluate_javascript("""JSON.stringify((()=>{const c=document.getElementById('sprite'),p=c.getContext('2d').getImageData(0,0,192,208).data;let hash=2166136261,alpha=0;for(let i=0;i<p.length;i++){hash=Math.imul(hash^p[i],16777619);if(i%4===3)alpha+=p[i]}return {row:Number(c.dataset.row),frame:Number(c.dataset.frame),hash:hash>>>0,alpha,visible:getComputedStyle(c).display==='block'}})())""",-1,None,None,None,received)
        except Exception as error: failures.append(str(error))
        return False
    def sample(expected):
        for bot in bots: sample_one(expected, bot['id'])
        return False
    def finish():
        try:
            assert len(results)==6*len(bots),results
            for bot in bots:
                samples=[r for r in results if r['bot']==bot['id']]
                assert [r['row'] for r in samples]==[7,7,3,5,6,0],samples
                assert samples[0]['hash']!=samples[1]['hash'],('Canvas pixels did not change',bot['id'])
                assert samples[0]['frame']!=samples[1]['frame'],samples
        except Exception as error: failures.append(str(error))
        print(json.dumps(dict(samples=results,failures=failures)))
        g['stop']();return False
    GLib.timeout_add(1500,lambda:sample(7))
    GLib.timeout_add(1830,lambda:sample(7))
    GLib.timeout_add(2000,lambda:publish('Finished'))
    GLib.timeout_add(2500,lambda:sample(3))
    GLib.timeout_add(2700,lambda:publish('Error'))
    GLib.timeout_add(3200,lambda:sample(5))
    GLib.timeout_add(3400,lambda:publish('Working',True))
    GLib.timeout_add(3900,lambda:sample(6))
    GLib.timeout_add(4100,lambda:publish(''))
    GLib.timeout_add(4600,lambda:sample(0))
    GLib.timeout_add(4900,finish)
    original()
Gtk.main=main
try: runpy.run_path(str(root/'companion/native_helper.py'),run_name='__main__')
finally: owner.shutdown();owner.server_close()
assert not failures, failures
