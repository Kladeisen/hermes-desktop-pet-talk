"""Run ONLY from a disposable copy, with HOME and HERMES_HOME in scratch.
Example: HOME=<scratch>/user HERMES_HOME=<scratch>/home /usr/bin/python <copy>/tools/native-bots-test.py
"""
import io
import inspect
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib
root = Path(__file__).resolve().parents[1]
default_scratch = Path(os.environ.get('TMPDIR') or tempfile.gettempdir()) / 'talk-desktop-isolated'
scratch = Path(os.environ.get('TALK_TEST_ISOLATED_ROOT') or default_scratch).resolve()
assert root.is_relative_to(scratch) and Path.home().is_relative_to(scratch)
assert Path(os.environ['HERMES_HOME']).is_relative_to(scratch)
sys.path.insert(0, str(root/'companion'))
commands, failures, results = [], [], {}
state = dict(lifecycle='idle',status='',muted=False,bands=[],capabilities=['hidePet'],petVisible=False,bots=[
    dict(id='alpha',label='Alpha',status='Working',chat=True),
    dict(id='beta',label='Beta',status='Finished',chat=True)])
import base64
import cairo
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
# Actual PNG fixtures, generated locally; no profile assets or private files used.
def avatar(red, green, blue):
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, 96, 104)
    context = cairo.Context(surface)
    context.set_source_rgb(red, green, blue)
    context.arc(48, 52, 40, 0, 6.283185307179586); context.fill()
    output = io.BytesIO(); surface.write_to_png(output)
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()
state['bots'][0]['avatar'] = avatar(.3, .6, .9)
state['bots'][1]['avatar'] = avatar(.8, .4, .6)
# Private loopback fixture owner exercises the real helper HTTP client.
class Owner(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        assert self.headers.get('Authorization') == 'Bearer fixture'
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/command':
            commands.append(payload)
            if payload['action'] == 'botDismiss': state['bots'] = [b for b in state['bots'] if b['id'] != payload['bot']]
            if payload['action'] == 'hidePet': state['petVisible'] = False
        body = json.dumps(dict(generation='fixture',state=state,acks={})).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
owner = ThreadingHTTPServer(('127.0.0.1', 0), Owner)
threading.Thread(target=owner.serve_forever, daemon=True).start()
sys.stdin=io.StringIO(json.dumps(dict(root=str(root),url=f'http://127.0.0.1:{owner.server_port}',token='fixture'))+'\n')
original=Gtk.main

def main():
    g=inspect.currentframe().f_back.f_globals
    def check():
        try:
            bots=g.get('bot_windows',{})
            assert set(bots)=={'alpha','beta'}, f'Expected two native bot windows, got {list(bots)}'
            assert not g['win'].get_visible(), 'the main pet must remain in-app'
            assert bots['alpha'].win != bots['beta'].win
            assert all(b.win.get_visible() for b in bots.values())
            assert bots['alpha'].manager != bots['beta'].manager
            results['windows']=len(bots)
            # Related WebViews must share one actual WebKit web process.
            parents={}
            for entry in Path('/proc').iterdir():
                if not entry.name.isdigit(): continue
                try:
                    status=(entry/'status').read_text()
                    parent=int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
                    parents[int(entry.name)]=parent
                except (OSError,StopIteration,ValueError): pass
            descendants={os.getpid()}
            while True:
                expanded=descendants | {pid for pid,parent in parents.items() if parent in descendants}
                if expanded==descendants: break
                descendants=expanded
            web_processes=[]
            for pid in descendants:
                try:
                    if b'WebKitWebProcess' in Path(f'/proc/{pid}/cmdline').read_bytes(): web_processes.append(pid)
                except OSError: pass
            results['webProcesses']=web_processes
            assert len(web_processes)==1, results

            for name, surface in bots.items():
                def received(view,result,*_,name=name):
                    try:
                        text=view.evaluate_javascript_finish(result).to_string()
                        result = json.loads(text)
                        assert result['avatarWidth'] == 96 and result['avatarHeight'] == 104, result
                        results[name]=result['status']
                        results[name+'Avatar']=[result['avatarWidth'],result['avatarHeight']]
                        def snapshot_done(web, result, *_):
                            try: web.get_snapshot_finish(result).write_to_png(str(scratch/('bot-native-'+name+'.png')))
                            except Exception as error: failures.append(str(error))
                        view.get_snapshot(g['WebKit2'].SnapshotRegion.VISIBLE,g['WebKit2'].SnapshotOptions.TRANSPARENT_BACKGROUND,None,snapshot_done,None)
                    except Exception as error: failures.append(str(error))
                surface.web.evaluate_javascript("JSON.stringify({status:document.getElementById('status').textContent,avatarWidth:document.getElementById('avatar').naturalWidth,avatarHeight:document.getElementById('avatar').naturalHeight})",-1,None,None,None,received)
            bots['alpha'].web.evaluate_javascript("document.getElementById('chat').click()",-1,None,None,None,None,None)
            bots['beta'].web.evaluate_javascript("document.getElementById('close').click()",-1,None,None,None,None,None)
        except Exception as error: failures.append(str(error))
        return False
    def show_main_pet():
        state['petVisible']=True
        return False
    def close_main_pet():
        try:
            assert g['win'].get_visible()
            g['web'].evaluate_javascript("document.getElementById('close').click()",-1,None,None,None,None,None)
        except Exception as error: failures.append(str(error))
        return False
    def finish():
        try:
            assert results.get('alpha')=='Working', results
            assert results.get('beta')=='Finished', results
            assert {(c['action'],c.get('bot')) for c in commands}=={('botChat','alpha'),('botDismiss','beta'),('hidePet',None)}, commands
            assert set(g['bot_windows'])=={'alpha'}
            assert not g['stopping'].is_set()
            assert not g['win'].get_visible()
        except Exception as error: failures.append(str(error))
        print(json.dumps(dict(results=results,commands=commands,failures=failures)))
        g['stop']();return False
    GLib.timeout_add(1800,check);GLib.timeout_add(2400,show_main_pet);GLib.timeout_add(3000,close_main_pet);GLib.timeout_add(3800,finish)
    original()
Gtk.main=main
try: runpy.run_path(str(root/'companion/native_helper.py'),run_name='__main__')
finally: owner.shutdown(); owner.server_close()
assert not failures, failures
