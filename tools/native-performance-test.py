"""Actual GTK/WebKit production view probe; isolated HTTP owner, no audio.
Runs the real helper unchanged via runpy. Only the owner boundary is a fixture.
"""
import io, json, runpy, sys, threading, time, inspect, os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'companion'))
commands=[]
status=sys.argv[1] if len(sys.argv)>1 else 'Working'
cycling=status=='Cycle'
timeout_test=status=='Timeout'
case_name=status or 'Idle'
if cycling or timeout_test: status='Working'
expected_row={'Working':7,'Finished':3,'Error':5,'':0}[status]
expected_count={'Working':6,'Finished':4,'Error':8,'':6}[status]

def synthetic_sheet(counts, columns=8):
    """Data URI of a 192x208-grid sheet with a distinct colour per cell (no real artwork)."""
    import base64 as _b64, io as _io, cairo as _cairo
    surface=_cairo.ImageSurface(_cairo.FORMAT_ARGB32,columns*192,len(counts)*208);paint=_cairo.Context(surface)
    for row,count in enumerate(counts):
        for col in range(count):
            paint.set_source_rgba((col+1)/(columns+1),(row+1)/(len(counts)+1),.5,1);paint.rectangle(col*192+40,row*208+30,112,160);paint.fill()
    out=_io.BytesIO();surface.write_to_png(out)
    return 'data:image/png;base64,'+_b64.b64encode(out.getvalue()).decode()
import hashlib
sheet=synthetic_sheet([6,8,8,4,5,8,6,6,6])
sheet_id=hashlib.sha256(sheet.encode()).hexdigest()
state={'lifecycle':'idle','status':status,'muted':False,'bands':[],'capabilities':['chat'],'pet':{'spriteId':sheet_id}}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path=='/command': commands.append(time.monotonic())
        body=json.dumps({'sprite':sheet} if self.path=='/sprite' else {'generation':'fixture-generation','state':state,'acks':{}}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
sys.stdin=io.StringIO(json.dumps({'root':str(root),'url':f'http://127.0.0.1:{server.server_port}','token':'fixture-only'})+'\n')
original=Gtk.main
results={};click_time=None
def main():
    g=inspect.currentframe().f_back.f_globals
    web=g['web']
    def evaluate(script,callback):
        def done(view,result,*args):
            try: callback(json.loads(view.evaluate_javascript_finish(result).to_string()))
            except Exception as e: results['error']=str(e);g['stop']()
        web.evaluate_javascript(script,-1,None,None,None,done,None)
    def instrument():
        evaluate("JSON.stringify((()=>{window.probe={cells:[],centers:[],receives:0,status:document.getElementById('status').textContent==='Pet'?'':document.getElementById('status').textContent};const receive=window.petReceive;window.petReceive=value=>{probe.receives++;probe.status=value.state?.status||'';receive(value)};const c=document.getElementById('pet').getContext('2d');const draw=c.drawImage.bind(c);c.drawImage=(...args)=>{probe.cells.push([performance.now(),args[1]/192,args[2]/208,probe.status]);draw(...args);const b=document.querySelector('[data-action=chat]');if(b){const r=b.getBoundingClientRect();probe.centers.push([r.x,r.y])}};return true})())",lambda _:None)
        return False
    def click():
        global click_time
        click_time=time.monotonic()
        evaluate("JSON.stringify((()=>{document.querySelector('[data-action=chat]').click();return true})())",lambda _:None)
        return False
    def collect():
        def finish(value):
            results.update(value);results['commandLatencyMs']=(commands[0]-click_time)*1000 if commands else None
            evidence=Path(os.environ.get('PET_PERF_EVIDENCE',str(Path.home()/'.hermes/cache/scratch/pet-performance')))
            evidence.mkdir(parents=True,exist_ok=True)
            (evidence/case_name).with_suffix('.json').write_text(json.dumps(results,indent=2))
            def snapshot(view,result,*args):
                view.get_snapshot_finish(result).write_to_png(str(evidence/(case_name+'.png')))
                print(json.dumps(results));g['stop']()
            web.get_snapshot(g['WebKit2'].SnapshotRegion.VISIBLE,g['WebKit2'].SnapshotOptions.TRANSPARENT_BACKGROUND,None,snapshot,None)
        evaluate("JSON.stringify({cells:probe.cells,centers:probe.centers,receives:probe.receives,chatDisabled:document.querySelector('[data-action=chat]').disabled,status:document.getElementById('status').textContent,buttonLabels:[...document.querySelectorAll('button')].filter(b=>getComputedStyle(b).display!=='none'&&getComputedStyle(b).visibility!=='hidden').map(b=>b.getAttribute('aria-label')),chatIcon:{viewBox:document.querySelector('[data-action=chat] svg').getAttribute('viewBox'),width:getComputedStyle(document.querySelector('[data-action=chat] svg')).width}})",finish)
        return False
    GLib.timeout_add(700,instrument);GLib.timeout_add(1090,click)
    if cycling:
        GLib.timeout_add(1250,lambda:(state.update(status='Finished'),False)[1])
        GLib.timeout_add(1850,lambda:(state.update(status=''),False)[1])
    GLib.timeout_add(17500 if timeout_test else 2900 if cycling else 2300,collect)
    original()
Gtk.main=main
try: runpy.run_path(str(root/'companion/native_helper.py'),run_name='__main__')
finally: server.shutdown()
assert results.get('cells'), results
assert results['receives']<=2 if cycling else results['receives']<=1, 'unchanged owner snapshots must not rebuild the native view'
if timeout_test:
    assert not results['chatDisabled'] and results['status']=='Action timed out', 'deduplicated state must not leave pending controls stuck forever'
if cycling:
    assert {c[3] for c in results['cells']}=={'Working','Finished',''}, 'working/finished/idle transitions must reach the view'
assert all(c[2]==({'Working':7,'Finished':3,'':0}[c[3]] if cycling else expected_row) for c in results['cells']), 'status must select the Hermes named clip, not questioning/waiting'
assert all(0<=c[1]<({'Working':6,'Finished':4,'':6}[c[3]] if cycling else expected_count) for c in results['cells']), 'never draw blank padding beyond the real clip frame count'
assert len({c[1] for c in results['cells']})>1, 'working frames must advance'
assert len({tuple(c) for c in results['centers']})==1, 'controls must not chase sprite cells while clicking'
assert results['buttonLabels']==['Close pop-out pet','Open associated chat'], 'irrelevant controls must be hidden, not disabled'
assert results['chatIcon']=={'viewBox':'0 0 24 24','width':'16px'}, 'chat icon must match the in-app pet control'
assert results['commandLatencyMs']<50, 'command dispatch must wake immediately, not wait for poll'
