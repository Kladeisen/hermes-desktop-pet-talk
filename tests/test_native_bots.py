"""Native surface lifecycle contracts; real GTK coverage lives in tools/native-bots-test.py."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]

class Widget:
    def __init__(self, **kwargs):
        self.kwargs=kwargs; self.visible=False; self.signals={}; self.destroyed=False
    def connect(self, name, callback): self.signals[name]=callback
    def get_screen(self): return self
    def get_rgba_visual(self): return None
    def get_settings(self): return self
    def show_all(self): self.visible=True
    def destroy(self): self.destroyed=True
    def evaluate_javascript(self, script, *args): self.script=script
    def __getattr__(self, name): return lambda *args: None

def fixture():
    spec=importlib.util.spec_from_file_location('native_bots', ROOT/'companion/native_bots.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    margins=[];commands=[]
    layer=Widget();layer.Layer=SimpleNamespace(OVERLAY=1);layer.Edge=SimpleNamespace(LEFT=1,BOTTOM=2);layer.KeyboardMode=SimpleNamespace(NONE=0)
    layer.set_margin=lambda win,edge,value:margins.append((win,edge,value))
    webkit=SimpleNamespace(UserContentManager=Widget,WebView=Widget,HardwareAccelerationPolicy=SimpleNamespace(NEVER=0),PolicyDecisionType=SimpleNamespace(NAVIGATION_ACTION=0))
    runtime=dict(Gtk=SimpleNamespace(Window=Widget),GtkLayerShell=layer,WebKit2=webkit,Gdk=SimpleNamespace(RGBA=Widget),root=ROOT,shared='',web=Widget())
    return module, runtime, margins, commands

def test_related_bot_windows_have_own_managers_and_staggered_margins():
    module, runtime, margins, commands = fixture()
    alpha=module.BotWindow(runtime,'alpha',0,commands.append)
    beta=module.BotWindow(runtime,'beta',1,commands.append)
    assert alpha.web.kwargs['related_view'] is runtime['web']
    assert beta.web.kwargs['related_view'] is runtime['web']
    assert alpha.manager is not beta.manager
    assert [v for w,e,v in margins if e==1]==[300,520]
    alpha.receive(dict(generation='g',bot=dict(id='alpha',status='Working'),acks={}))
    beta.receive(dict(generation='g',bot=dict(id='beta',status='Finished'),acks={}))
    assert 'Working' in alpha.web.script and 'Finished' in beta.web.script
    alpha.dispatch({'type':'command','command':{'id':'test-command','generation':'g','action':'botChat','bot':'beta'}})
    assert commands==[]
    alpha.dispatch({'type':'command','command':{'id':'test-command','generation':'g','action':'botChat','bot':'alpha'}})
    assert commands[0]['bot']=='alpha'

def test_helper_reconciles_windows_without_closing_bots_when_main_pet_hides():
    import ast
    import threading
    source=ast.parse((ROOT/'companion/native_helper.py').read_text())
    evaluate=next(node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=='evaluate')
    class Surface:
        def __init__(self,*args): self.win=Widget(); self.values=[]; self.index=args[2]
        def receive(self,value): self.values.append(value)
    win=Widget();win.show_all()
    win.hide=lambda:setattr(win,'visible',False)
    namespace=dict(stopping=threading.Event(),web=Widget(),win=win,bot_windows={},BotWindow=Surface,json=__import__('json'),send_bot=lambda value:None,ready=True,sprites={},main_sprite=None)
    exec(compile(ast.Module(body=[evaluate],type_ignores=[]),'<helper-evaluate>','exec'),namespace)
    value=dict(generation='g',state=dict(petVisible=False,bots=[dict(id='alpha',status='Working'),dict(id='beta',status='Finished')]),acks={})
    namespace['evaluate'](value)
    assert set(namespace['bot_windows'])=={'alpha','beta'}
    assert not win.visible
    alpha=namespace['bot_windows']['alpha'];beta=namespace['bot_windows']['beta']
    value['state']['bots']=value['state']['bots'][:1]
    namespace['evaluate'](value)
    assert namespace['bot_windows']['alpha'] is alpha
    assert beta.win.destroyed and not alpha.win.destroyed
    value['state']['bots'].insert(0,dict(id='gamma',status=''))
    namespace['evaluate'](value)
    assert namespace['bot_windows']['gamma'].index==1, 'new bots need an unused position, not their roster index'
    namespace['evaluate']({'warning':'Could not reveal owner'})
    assert namespace['bot_windows'].get('alpha') is alpha
    namespace['evaluate']({'error':'Owner disconnected'})
    assert not win.visible, 'bot-only owner errors must not pop the main pet out'
    assert alpha.win.destroyed

def test_helper_sends_the_selected_pet_sheet_to_the_main_view_once():
    import ast
    import threading
    source=ast.parse((ROOT/'companion/native_helper.py').read_text())
    evaluate=next(node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=='evaluate')
    web=Widget();scripts=[]
    web.evaluate_javascript=lambda script,*args:scripts.append(script)
    sheet='data:image/webp;base64,AAAA'
    namespace=dict(stopping=threading.Event(),web=web,win=Widget(),bot_windows={},BotWindow=None,json=__import__('json'),send_bot=lambda value:None,ready=True,sprites={'a'*64:sheet},main_sprite=None)
    exec(compile(ast.Module(body=[evaluate],type_ignores=[]),'<helper-evaluate>','exec'),namespace)
    value=dict(generation='g',state=dict(petVisible=True,pet=dict(spriteId='a'*64)),acks={})
    namespace['evaluate'](value)
    namespace['evaluate'](value)
    assert sheet in scripts[0], 'first delivery carries the sheet'
    assert sheet not in scripts[1], 'an unchanged sheet must not ride every repaint'
    namespace['main_sprite']=None  # a reloaded page has no sheet yet
    namespace['evaluate'](value)
    assert sheet in scripts[2]

def test_bot_drag_and_shape_use_only_own_window():
    module, runtime, margins, commands = fixture()
    surface=module.BotWindow(runtime,'alpha',0,commands.append)
    other=module.BotWindow(runtime,'beta',1,commands.append)
    geometry=SimpleNamespace(width=1920,height=1080)
    runtime['Gdk'].Display=SimpleNamespace(get_default=lambda:SimpleNamespace(get_monitor_at_window=lambda win:SimpleNamespace(get_geometry=lambda:geometry)))
    runtime['GtkLayerShell'].get_margin=lambda win,edge:80
    runtime['cursor_position']=lambda:(100,100)
    runtime['drag_margins']=lambda *args:(120,140)
    surface.win.get_allocated_width=lambda:280
    surface.win.get_allocated_height=lambda:240
    surface.dispatch({'type':'drag','phase':'start'})
    surface.dispatch({'type':'drag','phase':'move'})
    assert margins[-2:]==[(surface.win,1,120),(surface.win,2,140)]
    surface.dispatch({'type':'drag','phase':'end'})
    count=len(margins);surface.dispatch({'type':'drag','phase':'move'})
    assert len(margins)==count
    shapes=[]
    runtime['normalize_regions']=lambda regions,**bounds:regions
    runtime['cairo']=SimpleNamespace(Region=lambda:SimpleNamespace(union=lambda rect:shapes.append(rect)),RectangleInt=lambda *rect:rect)
    surface.win.get_window=lambda:SimpleNamespace(input_shape_combine_region=lambda *args:shapes.append('applied'))
    surface.dispatch({'type':'shape','rectangles':[[1,2,3,4]]})
    assert shapes==[(1,2,3,4),'applied']

def test_input_regions_clip_to_the_given_window_size():
    spec=importlib.util.spec_from_file_location('input_regions', ROOT/'companion/input_regions.py')
    regions=importlib.util.module_from_spec(spec);spec.loader.exec_module(regions)
    mute,close=[328,206.4,36,36],[340,176.4,24,24]  # default-scale idle pose (audit B09)
    assert regions.normalize_regions([mute,close],width=384,height=320)==[(328,206,36,37),(340,176,24,25)]
    assert regions.normalize_regions([[370,300,40,40]],width=384,height=320)==[(370,300,14,20)]


def test_helper_shape_region_covers_mute_and_close_edges_in_the_384px_window():
    """B09: the pop-out is 384x320; its outer Mute/Close edges (x 360..364) must take clicks."""
    import ast, json
    spec=importlib.util.spec_from_file_location('input_regions', ROOT/'companion/input_regions.py')
    regions=importlib.util.module_from_spec(spec);spec.loader.exec_module(regions)
    source=(ROOT/'companion/native_helper.py').read_text()
    assert 'set_size_request(384,320)' in source, 'fixture size must match the helper window'
    message=next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=='message')
    applied=[]
    class Region:
        def __init__(self): self.rectangles=[]
        def union(self,rect): self.rectangles.append(rect)
    win=SimpleNamespace(get_window=lambda:SimpleNamespace(input_shape_combine_region=lambda region,*args:applied.append(region.rectangles)),
                        get_size=lambda:(384,320),get_allocated_width=lambda:384,get_allocated_height=lambda:320)
    namespace=dict(json=json,normalize_regions=regions.normalize_regions,win=win,cairo=SimpleNamespace(Region=Region,RectangleInt=lambda *rect:rect))
    exec(compile(ast.Module(body=[message],type_ignores=[]),'<helper-message>','exec'),namespace)
    shape={'type':'shape','rectangles':[[328,206.4,36,36],[340,176.4,24,24]]}
    namespace['message'](None,SimpleNamespace(get_js_value=lambda:SimpleNamespace(to_string=lambda:json.dumps(shape))))
    [rectangles]=applied
    inside=lambda x,y:any(left<=x<left+w and top<=y<top+h for left,top,w,h in rectangles)
    assert inside(362,224.4), 'outer edge of Mute'
    assert inside(362,188.4), 'outer edge of Close'


def test_helper_reads_bounded_multi_avatar_payload():
    import ast, json
    source=ast.parse((ROOT/'companion/native_helper.py').read_text())
    request=next(node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=='request')
    data=json.dumps({'state':{'bots':[{'id':'alpha','avatar':'x'*100000}]}}).encode()
    class Response:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def read(self,count): return data[:count]
    namespace=dict(json=json,url='http://127.0.0.1:1',token='fixture',urllib=SimpleNamespace(request=SimpleNamespace(Request=lambda *a,**k:None,urlopen=lambda *a,**k:Response())))
    exec(compile(ast.Module(body=[request],type_ignores=[]),'<helper-request>','exec'),namespace)
    assert len(namespace['request']('/state',{})['state']['bots'][0]['avatar'])==100000

def test_helper_does_not_map_main_pet_before_first_presentation():
    import ast
    source=ast.parse((ROOT/'companion/native_helper.py').read_text())
    calls=[node for node in source.body if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name) and (node.value.func.value.id,node.value.func.attr) in {('win','show_all'),('Gtk','main')}]
    win=Widget(); observed=[]
    exec(compile(ast.Module(body=calls,type_ignores=[]),'<helper-boot>','exec'),{'win':win,'Gtk':SimpleNamespace(main=lambda:observed.append(win.visible))})
    assert observed==[False]

def test_rejected_command_does_not_disconnect_all_bot_windows():
    import ast, threading, time
    from queue import Queue, Empty
    source = ast.parse((ROOT/'companion/native_helper.py').read_text())
    worker = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'worker')
    stopping = threading.Event(); queue = Queue(); delivered = []; reads = []
    state = {'generation':'g', 'state':{'bots':[{'id':'alpha'}]}}
    def request(path, payload):
        if path == '/command': raise RuntimeError('command rejected')
        reads.append(path)
        if len(reads) == 1: queue.put({'action':'botChat','bot':'alpha'})
        else: stopping.set()
        return state
    namespace = dict(time=time, stopping=stopping, wake=SimpleNamespace(wait=lambda _:None,clear=lambda:None),
        queue=queue, Empty=Empty, request=request, ready=True, GLib=SimpleNamespace(idle_add=lambda fn,value:fn(value)),
        evaluate=delivered.append, stop=lambda:None, fetch_sprites=lambda result: True)
    exec(compile(ast.Module(body=[worker],type_ignores=[]),'<helper-worker>','exec'),namespace)
    namespace['worker']()
    assert delivered == [state, {'warning':'Action unavailable'}]


def test_bot_reveal_uses_existing_owner_without_destroying_surface():
    module, runtime, margins, commands = fixture()
    revealed=[];runtime['reveal_owner']=lambda:revealed.append(True)
    surface=module.BotWindow(runtime,'alpha',0,commands.append)
    surface.dispatch({'type':'reveal'})
    assert revealed==[True]
    def fail(): raise RuntimeError('owner hidden')
    runtime['reveal_owner']=fail
    surface.dispatch({'type':'reveal'})
    assert not surface.win.destroyed

def test_bot_window_sends_each_sheet_once_and_again_after_reload():
    module, runtime, margins, commands = fixture()
    runtime['sprites']={'a'*64:'data:image/webp;base64,SHEET'}
    surface=module.BotWindow(runtime,'alpha',0,commands.append)
    scripts=[]
    surface.web.evaluate_javascript=lambda script,*args: scripts.append(script)
    bot=dict(id='alpha',status='Working',pet=dict(spriteId='a'*64,frameWidth=192,frameHeight=208,counts=[6]*9))
    surface.receive(dict(generation='g',bot=bot,acks={}))
    assert 'SHEET' not in scripts[-1], 'not ready yet: the page would drop it'
    surface.dispatch({'type':'ready'})
    assert 'SHEET' in scripts[-1]
    for status in ('Finished','Working'):
        surface.receive(dict(generation='g',bot={**bot,'status':status},acks={}))
        assert 'SHEET' not in scripts[-1], 'multi-MB sheet must not be re-sent on status changes'
    surface.dispatch({'type':'ready'})
    assert 'SHEET' in scripts[-1], 'a reloaded page needs the sheet again'
    runtime['sprites'].clear()
    surface.receive(dict(generation='g',bot={**bot,'pet':{**bot['pet'],'spriteId':'b'*64}},acks={}))
    assert 'SHEET' not in scripts[-1]

def test_bot_window_resends_the_sheet_after_a_static_avatar():
    """B06: animated -> static -> same animated again. The page dropped its sheet on the static
    avatar, so the helper must send the bytes again instead of only the id."""
    module, runtime, margins, commands = fixture()
    runtime['sprites']={'a'*64:'data:image/webp;base64,SHEET'}
    surface=module.BotWindow(runtime,'alpha',0,commands.append)
    scripts=[]
    surface.web.evaluate_javascript=lambda script,*args: scripts.append(script)
    surface.dispatch({'type':'ready'})
    animated=dict(id='alpha',status='Working',pet=dict(spriteId='a'*64,frameWidth=192,frameHeight=208,counts=[6]*9))
    surface.receive(dict(generation='g',bot=animated,acks={}))
    assert 'SHEET' in scripts[-1]
    static={k:v for k,v in animated.items() if k!='pet'}
    surface.receive(dict(generation='g',bot={**static,'avatar':'data:image/png;base64,PLAIN'},acks={}))
    assert 'SHEET' not in scripts[-1]
    surface.receive(dict(generation='g',bot=animated,acks={}))
    assert 'SHEET' in scripts[-1], 'the page discarded its sheet on the static avatar; send it again'
    surface.receive(dict(generation='g',bot={**animated,'status':'Finished'},acks={}))
    assert 'SHEET' not in scripts[-1], 'still sent only once per animated stretch'
    # A different sheet whose bytes are missing also makes the page drop what it held.
    surface.receive(dict(generation='g',bot={**animated,'pet':{**animated['pet'],'spriteId':'b'*64}},acks={}))
    surface.receive(dict(generation='g',bot=animated,acks={}))
    assert 'SHEET' in scripts[-1], 'back from an unavailable sheet: send the original again'

def test_helper_fetches_each_new_sprite_once_and_reports_missing():
    import ast, json
    source=ast.parse((ROOT/'companion/native_helper.py').read_text())
    fetch=next(node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=='fetch_sprites')
    calls=[]; answers={'a'*64:{'sprite':'data:image/webp;base64,A'},'b'*64:{'sprite':'javascript:alert(1)'}}
    def request(path,payload):
        calls.append((path,payload['id']))
        if payload['id'] not in answers: raise OSError('404')
        return answers[payload['id']]
    namespace=dict(request=request,sprites={})
    exec(compile(ast.Module(body=[fetch],type_ignores=[]),'<helper-fetch>','exec'),namespace)
    state=lambda *ids:{'state':{'bots':[{'id':str(n),'pet':{'spriteId':i}} for n,i in enumerate(ids)]+[{'id':'static'}]}}
    assert namespace['fetch_sprites'](state('a'*64,'a'*64)) is True
    assert calls==[('/sprite','a'*64)] and namespace['sprites']=={'a'*64:'data:image/webp;base64,A'}
    assert namespace['fetch_sprites'](state('a'*64)) is True and len(calls)==1
    assert namespace['fetch_sprites'](state('b'*64)) is False, 'non-image data is refused'
    assert namespace['fetch_sprites'](state('c'*64)) is False, 'failed fetch retries on a later poll'
    assert 'b'*64 not in namespace['sprites']

def test_sprite_fetch_failure_is_not_owner_loss_and_repaints_when_sheet_arrives():
    import ast, threading, time
    from queue import Queue, Empty
    source = ast.parse((ROOT/'companion/native_helper.py').read_text())
    picked = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {'worker','fetch_sprites'}]
    stopping = threading.Event(); delivered = []; polls = []
    state = {'generation':'g', 'state':{'bots':[{'id':'alpha','pet':{'spriteId':'a'*64}}]}}
    def request(path, payload):
        if path == '/sprite':
            if len(polls) < 2: raise OSError('broker busy')
            return {'sprite':'data:image/webp;base64,A'}
        polls.append(path)
        if len(polls) == 4: stopping.set()
        return state
    namespace = dict(time=time, stopping=stopping, wake=SimpleNamespace(wait=lambda _:None,clear=lambda:None),
        queue=Queue(), Empty=Empty, request=request, ready=True, GLib=SimpleNamespace(idle_add=lambda fn,value:fn(value)),
        evaluate=delivered.append, stop=lambda:None, sprites={})
    exec(compile(ast.Module(body=picked,type_ignores=[]),'<helper-worker>','exec'),namespace)
    namespace['worker']()
    assert {'error':'Owner disconnected'} not in delivered
    assert delivered == [state, state], 'first paint, then one repaint once the sheet arrived'
    assert namespace['sprites'] == {'a'*64:'data:image/webp;base64,A'}
