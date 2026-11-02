"""Real production GTK/WebKit clipping regression; fake loopback owner, no audio.
Run with an isolated HOME/HERMES_HOME and PET_CLIP_EVIDENCE directory.
PET_CLIP_SHEET optionally supplies a private local sprite (never copied into git).
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
import cairo

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'companion'))
evidence = Path(os.environ['PET_CLIP_EVIDENCE'])
evidence.mkdir(parents=True, exist_ok=True)
if os.environ.get('PET_CLIP_SHEET'):
    sprite = 'data:image/webp;base64,' + base64.b64encode(Path(os.environ['PET_CLIP_SHEET']).read_bytes()).decode()
else:
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, 192, 208 * 9)
    context = cairo.Context(surface)
    for row in range(9):
        context.set_source_rgba(1, .5, .7, 1)
        context.rectangle(8, row * 208 + 20, 176, 180)
        context.fill()
    data = io.BytesIO()
    surface.write_to_png(data)
    sprite = 'data:image/png;base64,' + base64.b64encode(data.getvalue()).decode()
lifecycle = os.environ.get('PET_CLIP_LIFECYCLE', 'idle')
capabilities = ['stop', 'setMuted', 'chat', 'bots'] if lifecycle == 'connected' else ['start', 'chat', 'bots']
state = {'lifecycle': lifecycle, 'status': os.environ.get('PET_CLIP_STATUS', ''), 'petSize': int(os.environ.get('PET_CLIP_SIZE', '90')), 'capabilities': capabilities, 'pet': {'spriteId': 'a' * 64},
         # Opaque fixture colors distinguish a missing control from dark apps behind it.
         'theme': {'surface': '#126f83', 'ink': '#ffffff', 'border': '#ffd400', 'accent': '#d040ff'}}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        body = json.dumps({'sprite': sprite} if self.path == '/sprite' else {'generation': 'clipping-fixture', 'state': state, 'acks': {}}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
sys.stdin = io.StringIO(json.dumps({'root': str(root), 'url': f'http://127.0.0.1:{server.server_port}', 'token': 'fixture-only'}) + '\n')
original = Gtk.main
results = {}
def main():
    g = inspect.currentframe().f_back.f_globals
    web, win = g['web'], g['win']
    display = g['Gdk'].Display.get_default()
    monitor_name = os.environ.get('PET_CLIP_MONITOR', 'eDP-1')
    screen = display.get_default_screen()
    monitor = next((display.get_monitor(i) for i in range(display.get_n_monitors()) if screen.get_monitor_plug_name(i) == monitor_name), None)
    assert monitor is not None, f'fixture monitor unavailable: {monitor_name}'
    g['GtkLayerShell'].set_monitor(win, monitor)
    g['GtkLayerShell'].set_margin(win, g['GtkLayerShell'].Edge.LEFT, 700)
    g['GtkLayerShell'].set_margin(win, g['GtkLayerShell'].Edge.BOTTOM, 400)
    def collect():
        def done(view, result, *args):
            try:
                results.update(json.loads(view.evaluate_javascript_finish(result).to_string()))
                results['gtkSize'] = list(win.get_size())
                results['webAllocation'] = [web.get_allocated_width(), web.get_allocated_height()]
                results['gdkScale'] = win.get_scale_factor()
                (evidence / 'geometry.json').write_text(json.dumps(results, indent=2))
                def snapshot(view, result, *args):
                    try:
                        import subprocess
                        import glob
                        env = dict(os.environ)
                        sockets = glob.glob('/run/user/1000/hypr/*/.socket.sock')
                        assert len(sockets) == 1
                        env['HYPRLAND_INSTANCE_SIGNATURE'] = Path(sockets[0]).parent.name
                        layers = json.loads(subprocess.check_output(['hyprctl', '-j', 'layers'], env=env))
                        layer = next(layer for output in layers.values() for level in output['levels'].values() for layer in level if layer['pid'] == os.getpid())
                        (evidence / 'layer.json').write_text(json.dumps(layer, indent=2))
                        subprocess.run(['grim', '-g', f"{layer['x']},{layer['y']} {layer['w']}x{layer['h']}", str(evidence / 'compositor.png')], check=True)
                        view.get_snapshot_finish(result).write_to_png(str(evidence / 'native.png'))
                    finally:
                        g['stop']()
                web.get_snapshot(g['WebKit2'].SnapshotRegion.VISIBLE, g['WebKit2'].SnapshotOptions.TRANSPARENT_BACKGROUND, None, snapshot, None)
            except Exception as error:
                results['error'] = str(error)
                g['stop']()
        web.evaluate_javascript("JSON.stringify({viewport:[innerWidth,innerHeight],client:[document.documentElement.clientWidth,document.documentElement.clientHeight],dpr:devicePixelRatio,buttons:[...document.querySelectorAll('button')].map(b=>({action:b.dataset.action||'close',visible:getComputedStyle(b).display!=='none'&&getComputedStyle(b).visibility!=='hidden',rect:(()=>{const r=b.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()}))})", -1, None, None, None, done, None)
        return False
    GLib.timeout_add(2200, collect)
    GLib.timeout_add(8000, g['stop'])
    original()
Gtk.main = main
try:
    runpy.run_path(str(root / 'companion/native_helper.py'), run_name='__main__')
finally:
    server.shutdown()
print(json.dumps(results, indent=2))
assert 'error' not in results, results
assert results.get('buttons'), 'fixture must load the real view'
visible = [b for b in results['buttons'] if b['visible']]
assert any(b['action'] == ('stop' if lifecycle == 'connected' else 'start') for b in visible), 'the primary control must remain accessible'
if lifecycle == 'connected':
    assert any(b['action'] == 'setMuted' for b in visible), 'live mute must remain visible'
for button in visible:
    x, y, w, h = button['rect']
    assert x >= 0 and y >= 0 and x + w <= results['webAllocation'][0] and y + h <= results['webAllocation'][1], f'painted control clipped by native allocation: {button}'
assert any(b['action'] == 'close' for b in visible), 'native Close must fit beside the artwork'
# WebKit snapshots can be intact while the Wayland buffer is clipped. Compare
# opaque button interiors with the actual compositor pixels, not just DOM boxes.
expected = cairo.ImageSurface.create_from_png(str(evidence / 'native.png'))
actual = cairo.ImageSurface.create_from_png(str(evidence / 'compositor.png'))
def pixel(surface, x, y):
    offset = int(y) * surface.get_stride() + int(x) * 4
    return tuple(surface.get_data()[offset:offset + 4])
ratios = {}
for button in visible:
    x, y, w, h = button['rect']
    matches = samples = 0
    for dx in range(-9, 10):
        for dy in range(-9, 10):
            px, py = x + w / 2 + dx, y + h / 2 + dy
            ex, ey = px * expected.get_width() / results['viewport'][0], py * expected.get_height() / results['viewport'][1]
            e = pixel(expected, ex, ey)
            # Compare flat opaque interiors, not resampled glyph edges or glow.
            if e[3] < 250 or any(max(abs(n[i] - e[i]) for i in range(3)) > 3
                                for n in [pixel(expected, ex + ox, ey + oy) for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1))]):
                continue
            ax, ay = px * actual.get_width() / results['viewport'][0], py * actual.get_height() / results['viewport'][1]
            nearby = [pixel(actual, ax + ox, ay + oy) for ox in (-1, 0, 1) for oy in (-1, 0, 1)]
            matches += any(max(abs(a[i] - e[i]) for i in range(3)) < 30 for a in nearby)
            samples += 1
    assert samples >= 10, f'not enough opaque control pixels for a meaningful check: {button}'
    ratios[button['action']] = matches / samples
(evidence / 'paint-ratios.json').write_text(json.dumps(ratios, indent=2))
assert all(ratio > .7 for ratio in ratios.values()), f'native compositor clips painted controls despite intact DOM/snapshot: {ratios}'
