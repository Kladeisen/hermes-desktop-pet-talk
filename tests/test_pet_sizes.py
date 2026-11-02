"""Pet sizes (group F): broker validation and native window geometry, without GTK windows."""
import ast
import importlib.util
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


@pytest.fixture
def broker():
    instance = load('sizes_broker', 'dashboard/companion_broker.py').Broker(ROOT)
    instance.claim({'profile': 'default', 'connection': 'local'})
    yield instance
    instance.close()


def state(**fields):
    return dict(lifecycle='idle', status='', bands=[], muted=False, capabilities=[], **fields)


@pytest.mark.parametrize('field', ['petSize', 'botSize'])
@pytest.mark.parametrize('value', [50, 100, 155, 200])
def test_broker_accepts_sizes_within_bounds(broker, field, value):
    assert broker.sanitize(state(**{field: value}))[field] == value


@pytest.mark.parametrize('field', ['petSize', 'botSize'])
@pytest.mark.parametrize('value', [49, 201, 0, -100, 1e9, 100.5, '100', None, True, [], float('nan')])
def test_broker_rejects_out_of_range_or_odd_sizes(broker, field, value):
    with pytest.raises(HTTPException):
        broker.sanitize(state(**{field: value}))


def test_broker_validates_the_bot_reset_counter_and_still_rejects_unknown_fields(broker):
    assert broker.sanitize(state(botReset=3))['botReset'] == 3
    for value in (-1, 1.5, '1', True, 2**40):
        with pytest.raises(HTTPException):
            broker.sanitize(state(botReset=value))
    with pytest.raises(HTTPException):
        broker.sanitize(state(petScale=100))


@pytest.mark.parametrize('size,window', [(50, (307, 237)), (100, (384, 320)), (200, (538, 486))])
def test_pop_out_window_grows_with_the_pet_and_keeps_drag_clamps(size, window):
    platform = load('sizes_platform', 'companion/native_platform.py')
    width, height, pet = platform.scaled_window(size)
    assert (width, height) == window
    f = size / 100
    assert pet == pytest.approx((140, 80, 140 + 153.6 * f, 80 + 166.4 * f))
    assert width - pet[2] == pytest.approx(384 - 293.6, abs=0.5), 'the same room for the rail at every size'
    assert height - pet[3] == pytest.approx(320 - 246.4, abs=0.5), 'the same room for the bubble at every size'
    monitor = (1920, 1080)
    for cursor in ((10000, -10000), (-10000, 10000)):
        left, bottom = platform.drag_margins((80, 80), (0, 0), cursor, monitor, (width, height), pet)
        x0, x1 = left + pet[0], left + pet[2]
        y1, y0 = monitor[1] - bottom - (height - pet[3]), monitor[1] - bottom - (height - pet[1])
        assert min(x1, monitor[0]) - max(x0, 0) >= 39.5 and min(y1, monitor[1]) - max(y0, 0) >= 39.5


def bot_fixture():
    module = load('sizes_bots', 'companion/native_bots.py')
    margins, sizes, zooms = [], [], []
    class Widget:
        def __init__(self, **kwargs): self.kwargs = kwargs
        def set_size_request(self, w, h): sizes.append((w, h))
        def set_zoom_level(self, f): zooms.append(f)
        def get_screen(self): return self
        def get_settings(self): return self
        def get_rgba_visual(self): return None
        def __getattr__(self, name): return lambda *args, **kwargs: None
    layer = Widget(); layer.Layer = SimpleNamespace(OVERLAY=1); layer.Edge = SimpleNamespace(LEFT=1, BOTTOM=2); layer.KeyboardMode = SimpleNamespace(NONE=0)
    layer.set_margin = lambda win, edge, value: margins.append((edge, value))
    webkit = SimpleNamespace(UserContentManager=Widget, WebView=Widget, HardwareAccelerationPolicy=SimpleNamespace(NEVER=0), PolicyDecisionType=SimpleNamespace(NAVIGATION_ACTION=0))
    runtime = dict(Gtk=SimpleNamespace(Window=Widget), GtkLayerShell=layer, WebKit2=webkit, Gdk=SimpleNamespace(RGBA=Widget), root=ROOT, shared='', web=Widget(),
                   keep_reachable=load('sizes_platform_kr', 'companion/native_platform.py').keep_reachable)
    return module, runtime, margins, sizes, zooms


@pytest.mark.parametrize('size', [50, 100, 200])
def test_bot_window_scales_page_window_shape_and_drag_box(size):
    module, runtime, margins, sizes, zooms = bot_fixture()
    surface = module.BotWindow(runtime, 'alpha', 1, lambda command: None)
    surface.resize(size)
    f = size / 100
    if size != 100:
        assert zooms[-1] == f and sizes[-1] == (round(280 * f), round(240 * f))
    seen = {}
    runtime['normalize_regions'] = lambda rects, **bounds: seen.update(rects=rects, **bounds) or []
    surface.dispatch({'type': 'shape', 'rectangles': [[90, 90, 96, 104]]})
    assert seen['rects'] == [[90 * f, 90 * f, 96 * f, 104 * f]]
    assert (seen['width'], seen['height']) == (round(280 * f), round(240 * f))
    boxes = []
    runtime['Gdk'].Display = SimpleNamespace(get_default=lambda: SimpleNamespace(get_monitor_at_window=lambda win: SimpleNamespace(get_geometry=lambda: SimpleNamespace(width=1920, height=1080))))
    runtime['GtkLayerShell'].get_margin = lambda win, edge: 80
    runtime['cursor_position'] = lambda: (0, 0)
    runtime['drag_margins'] = lambda *args: boxes.append(args[5]) or (0, 0)
    surface.win.get_allocated_width = lambda: round(280 * f); surface.win.get_allocated_height = lambda: round(240 * f)
    surface.dispatch({'type': 'drag', 'phase': 'start'}); surface.dispatch({'type': 'drag', 'phase': 'move'})
    assert boxes[-1] == pytest.approx((90 * f, 90 * f, 186 * f, 194 * f))
    del margins[:]
    surface.place()
    assert margins == [(1, 300 + round(220 * f)), (2, 80)], 'default spot keeps windows apart at every size'


def helper_evaluate(namespace):
    source = ast.parse((ROOT / 'companion/native_helper.py').read_text())
    picked = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {'evaluate', 'resize_main'}]
    exec(compile(ast.Module(body=picked, type_ignores=[]), '<helper-sizes>', 'exec'), namespace)
    return namespace['evaluate']


def test_helper_resizes_the_pop_out_and_every_bot_window_and_resets_bot_spots_on_request():
    platform = load('sizes_platform2', 'companion/native_platform.py')
    calls = []
    class Surface:
        def __init__(self, *args): self.win = SimpleNamespace(destroy=lambda: None); self.size = args[4]
        def receive(self, value): pass
        def resize(self, size): calls.append(('bot', size))
        def place(self): calls.append(('place',))
    web = SimpleNamespace(evaluate_javascript=lambda *args: None, set_size_request=lambda w, h: calls.append(('main', w, h)))
    namespace = dict(stopping=threading.Event(), web=web, win=SimpleNamespace(show_all=lambda: None, hide=lambda: None, resize=lambda w, h: None, get_window=lambda: None), bot_windows={}, BotWindow=Surface,
                     json=json, send_bot=lambda value: None, ready=True, sprites={}, main_sprite=None, main_size=None, bot_reset=None,
                     scaled_window=platform.scaled_window, PET_BOX=(140, 80, 293.6, 246.4), keep_reachable=platform.keep_reachable, GtkLayerShell=None, Gdk=None)
    evaluate = helper_evaluate(namespace)
    value = lambda **fields: dict(generation='g', state=dict(petVisible=True, bots=[dict(id='alpha', status='')], **fields), acks={})
    evaluate(value(petSize=200, botSize=50, botReset=0))
    assert ('main', 538, 486) in calls and ('place',) not in calls
    assert namespace['bot_windows']['alpha'].size == 50, 'a new bot window opens at the shared size'
    assert namespace['PET_BOX'] == pytest.approx((140, 80, 140 + 307.2, 80 + 332.8)), 'drag clamps follow the pet'
    calls.clear(); evaluate(value(petSize=200, botSize=50, botReset=0))
    assert calls == [], 'no resize when nothing changed'
    evaluate(value(petSize=200, botSize=150, botReset=0))
    assert calls == [('bot', 150)], 'open bot windows follow the slider'
    evaluate(value(petSize=200, botSize=150, botReset=1))
    assert ('place',) in calls
    calls.clear(); evaluate({'error': 'Owner disconnected'})
    assert not [c for c in calls if c[0] == 'main']


MONITOR = (1920, 1080)
GDK = SimpleNamespace(Display=SimpleNamespace(get_default=lambda: SimpleNamespace(
    get_monitor_at_window=lambda window: SimpleNamespace(get_geometry=lambda: SimpleNamespace(width=MONITOR[0], height=MONITOR[1])))))


class Layer:
    """Layer-shell margins kept in a dict, so a test can read where a window really sits."""
    Edge = SimpleNamespace(LEFT=1, BOTTOM=2)
    Layer = SimpleNamespace(OVERLAY=1)
    KeyboardMode = SimpleNamespace(NONE=0)
    def __init__(self): self.margins = {}
    def get_margin(self, win, edge): return self.margins[edge]
    def set_margin(self, win, edge, value): self.margins[edge] = value
    def __getattr__(self, name): return lambda *args, **kwargs: None


def visible(margins, window, pet):
    """Pixels of the pet on screen along x and y for a LEFT/BOTTOM-anchored window."""
    top = MONITOR[1] - margins[2] - window[1]
    return (min(margins[1] + pet[2], MONITOR[0]) - max(margins[1] + pet[0], 0),
            min(top + pet[3], MONITOR[1]) - max(top + pet[1], 0))


EDGES = [(-10000, 0), (10000, 0), (0, -10000), (0, 10000)]


@pytest.mark.parametrize('cursor', EDGES)
@pytest.mark.parametrize('size', [50, 200])
def test_pop_out_dragged_to_an_edge_stays_reachable_after_a_resize(cursor, size):
    platform = load('sizes_platform3', 'companion/native_platform.py')
    width, height, pet = platform.scaled_window(100)
    layer = Layer()
    layer.margins[1], layer.margins[2] = platform.drag_margins((80, 80), (0, 0), cursor, MONITOR, (width, height), pet)
    assert min(visible(layer.margins, (width, height), pet)) >= 39.5
    namespace = dict(main_size=100, bot_reset=0, PET_BOX=pet, scaled_window=platform.scaled_window, keep_reachable=platform.keep_reachable, bot_windows={},
                     GtkLayerShell=layer, Gdk=GDK, web=SimpleNamespace(set_size_request=lambda *a: None), win=SimpleNamespace(resize=lambda *a: None, get_window=lambda: object()))
    source = ast.parse((ROOT / 'companion/native_helper.py').read_text())
    exec(compile(ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'resize_main'], type_ignores=[]), '<resize-main>', 'exec'), namespace)
    namespace['resize_main']({'petSize': size, 'botSize': 100, 'botReset': 0})
    width, height, pet = platform.scaled_window(size)
    assert min(visible(layer.margins, (width, height), pet)) >= 39.5, layer.margins


def shaped_bot(size_before=100):
    module, runtime, _, _, _ = bot_fixture()
    platform = load('sizes_platform4', 'companion/native_platform.py')
    regions, layer = [], Layer()
    class Region:
        def __init__(self): self.rectangles = []
        def union(self, rectangle): self.rectangles.append(rectangle)
    runtime.update(GtkLayerShell=layer, Gdk=SimpleNamespace(RGBA=runtime['Gdk'].RGBA, Display=GDK.Display), drag_margins=platform.drag_margins,
                   normalize_regions=load('sizes_regions', 'companion/input_regions.py').normalize_regions,
                   cairo=SimpleNamespace(Region=Region, RectangleInt=lambda *r: r))
    surface = module.BotWindow(runtime, 'alpha', 0, lambda command: None, size_before)
    surface.win.get_window = lambda: SimpleNamespace(input_shape_combine_region=lambda region, *a: regions.append(region.rectangles))
    return surface, layer, regions


@pytest.mark.parametrize('size', [50, 200])
def test_resizing_a_shown_idle_bot_moves_its_input_region_with_the_page(size):
    surface, _, regions = shaped_bot()
    # An idle bot's page posts its shape once (bubble, pet, chat button) and not again on a resize:
    # its CSS layout is the same at every zoom.
    surface.dispatch({'type': 'shape', 'rectangles': [[111, 57, 55, 30], [90, 90, 96, 104], [196, 150, 60, 30]]})
    surface.resize(size)
    f = size / 100
    assert len(regions) == 2, 'the region is reapplied at the new size'
    chat = (226 * f, 165 * f)
    assert any(x <= chat[0] < x + w and y <= chat[1] < y + h for x, y, w, h in regions[-1]), regions[-1]


class Layers(Layer):
    """Margins per window, for several bot windows sharing one layer-shell module."""
    def get_margin(self, win, edge): return self.margins[win, edge]
    def set_margin(self, win, edge, value): self.margins[win, edge] = value


def desktop_bots(monitor, size, count=4):
    """Real BotWindows on a fake monitor; like Gtk.Window, a window has a native window only once shown."""
    module, runtime, _, _, _ = bot_fixture()
    class Window(runtime['Gtk'].Window):
        shown = False
        def show_all(self): self.shown = True
        def get_window(self): return object() if self.shown else None
    geometry = SimpleNamespace(width=monitor[0], height=monitor[1])
    runtime.update(Gtk=SimpleNamespace(Window=Window), GtkLayerShell=Layers(), Gdk=SimpleNamespace(RGBA=runtime['Gdk'].RGBA, Display=SimpleNamespace(
        get_default=lambda: SimpleNamespace(get_monitor_at_window=lambda window: SimpleNamespace(get_geometry=lambda: geometry)))))
    return [module.BotWindow(runtime, 'bot%d' % i, i, lambda command: None, size) for i in range(count)], runtime['GtkLayerShell']


def assert_spots_fit(bots, layer, monitor, size):
    f = size / 100
    window, pet = (round(280 * f), round(240 * f)), tuple(v * f for v in (90, 90, 186, 194))
    spots = [(layer.margins[bot.win, 1], layer.margins[bot.win, 2]) for bot in bots]
    for left, bottom in spots:
        top = monitor[1] - bottom - window[1]
        seen = (min(left + pet[2], monitor[0]) - max(left + pet[0], 0), min(top + pet[3], monitor[1]) - max(top + pet[1], 0))
        assert min(seen) >= 39.5, ('pet off-screen', spots)
        assert 0 <= left and left + window[0] <= monitor[0], ('a default spot leaves the monitor side', spots)
    assert len(set(spots)) == len(bots), ('bots piled onto one spot', spots)
    if size == 100:
        assert spots == [(300, 80), (520, 80), (740, 80), (960, 80)], 'the 100% layout is unchanged'


MONITORS = [(1366, 768), (1536, 864), (1920, 1080)]


@pytest.mark.parametrize('monitor', MONITORS)
@pytest.mark.parametrize('size', [50, 100, 200])
def test_desktop_bots_launched_at_a_saved_size_open_on_screen(monitor, size):
    bots, layer = desktop_bots(monitor, size)
    assert_spots_fit(bots, layer, monitor, size)


@pytest.mark.parametrize('monitor', MONITORS)
@pytest.mark.parametrize('size', [50, 100, 200])
def test_reset_bot_positions_puts_resized_desktop_bots_on_screen(monitor, size):
    bots, layer = desktop_bots(monitor, 100)
    for bot in bots:  # dragged anywhere first
        layer.margins[bot.win, 1], layer.margins[bot.win, 2] = 5, 600
    platform = load('sizes_platform6', 'companion/native_platform.py')
    namespace = dict(main_size=100, bot_reset=0, PET_BOX=platform.scaled_window(100)[2], scaled_window=platform.scaled_window,
                     keep_reachable=platform.keep_reachable, bot_windows={'bot%d' % i: bot for i, bot in enumerate(bots)})
    source = ast.parse((ROOT / 'companion/native_helper.py').read_text())
    exec(compile(ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'resize_main'], type_ignores=[]), '<reset>', 'exec'), namespace)
    namespace['resize_main']({'petSize': 100, 'botSize': size, 'botReset': 1})
    assert_spots_fit(bots, layer, monitor, size)


@pytest.mark.parametrize('cursor', EDGES)
@pytest.mark.parametrize('size', [50, 200])
def test_bot_dragged_to_an_edge_stays_reachable_after_a_resize(cursor, size):
    platform = load('sizes_platform5', 'companion/native_platform.py')
    surface, layer, _ = shaped_bot()
    box = (90, 90, 186, 194)
    layer.margins[1], layer.margins[2] = platform.drag_margins((300, 80), (0, 0), cursor, MONITOR, (280, 240), box)
    surface.resize(size)
    f = size / 100
    assert min(visible(layer.margins, (280 * f, 240 * f), tuple(v * f for v in box))) >= 39.5, layer.margins
