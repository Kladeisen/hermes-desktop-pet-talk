"""Production broker tests: no provider/microphone access."""
import importlib.util
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]

def load():
    path = ROOT / 'dashboard' / 'companion_broker.py'
    assert path.is_file(), 'plugin-owned companion broker is missing'
    spec = importlib.util.spec_from_file_location('companion_broker_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def test_packaged_native_runtime_detects_dependencies_without_source_checkout():
    import subprocess, os
    helper = ROOT / 'companion' / 'native_helper.py'
    assert helper.is_file(), 'self-contained native helper missing'
    env = {k:v for k,v in os.environ.items() if k not in {'PYTHONPATH','PYTHONHOME'}}
    result = subprocess.run(['/usr/bin/python',str(helper),'--check'],capture_output=True,text=True,env=env)
    assert result.returncode == 0, result.stderr
    assert 'GTK3' in result.stdout


def test_real_descriptor_bot_toggle_keeps_four_controls():
    m=load(); broker=m.Broker(ROOT);owner=broker.claim({'profile':'default','connection':'local'})
    import subprocess,json
    source=(ROOT/'desktop'/'plugin.js').read_text().split('// COMPANION_SHARED_BEGIN',1)[1].split('\n',1)[1].split('// COMPANION_SHARED_END',1)[0]
    result=subprocess.run(['node','-e',source+'console.log(JSON.stringify(petDescriptor(true,false)))'],capture_output=True,text=True,check=True)
    descriptor=json.loads(result.stdout)
    reply=broker.pulse({**owner,'state':{'descriptor':descriptor,'lifecycle':'connected','capabilities':['setMuted','chat','bots'],'botsEnabled':True,'status':'','muted':False,'bands':[.5]}})
    assert reply['commands']==[]
    broker.close()


def test_native_launch_requires_a_real_page_ready_handshake():
    import os
    if not os.environ.get('WAYLAND_DISPLAY'):
        import pytest;pytest.skip('native compositor unavailable')
    m=load();broker=m.Broker(ROOT)
    owner=broker.claim({'profile':'default','connection':'local'})
    broker.pulse({**owner,'state':{'lifecycle':'idle','capabilities':[],'status':'','bands':[],'muted':False}})
    try:
        reply=broker.launch(owner)
        assert reply.get('ready') is True, 'native JS view never completed the ready handshake'
        import subprocess,json,time
        time.sleep(.8)
        layers=json.loads(subprocess.check_output(['hyprctl','-j','layers']))
        own=[item for monitor in layers.values() for level in monitor['levels'].values() for item in level if item.get('pid')==broker.child.pid]
        assert own and own[0]['alpha']>0, 'compositor hid the newly mapped overlay'
    finally: broker.close()


def fixture_broker(clock=None):
    m=load();broker=m.Broker(ROOT,clock=clock) if clock else m.Broker(ROOT)
    owner=broker.claim({'profile':'default','connection':'local'})
    state={'lifecycle':'connected','capabilities':['setMuted','chat','stop','transcript'],'status':'','bands':[],'muted':False}
    broker.pulse({**owner,'state':state})
    return broker,owner,state


def test_command_deduplication_is_bounded_without_lifetime_exhaustion():
    broker,owner,state=fixture_broker()
    command={'id':'request-000','generation':owner['generation'],'action':'setMuted','muted':True}
    assert broker.command(command)['pending']
    assert broker.command(command)['pending']
    assert len(broker.pending)==1
    broker.pulse({**owner,'state':state,'acks':[{'id':command['id'],'ok':True}]})
    assert broker.command(command)['duplicate']
    for i in range(600):
        command['id']='request-'+str(i+1)
        broker.command(command)
        broker.pulse({**owner,'state':state,'acks':[{'id':command['id'],'ok':True}]})
    assert len(broker.done)==256 and len(broker.pending)==0
    broker.close()


def test_lease_expiry_and_new_generation_reject_stale_commands():
    from fastapi import HTTPException
    import pytest
    now=[100.0]
    broker,owner,state=fixture_broker(lambda:now[0])
    now[0]=109.0
    with pytest.raises(HTTPException) as error:broker.command({'id':'request-expired','generation':owner['generation'],'action':'chat'})
    assert error.value.status_code==410
    fresh=broker.claim({'profile':'default','connection':'local'})
    broker.pulse({**fresh,'state':state})
    with pytest.raises(HTTPException) as error:broker.command({'id':'request-stale','generation':owner['generation'],'action':'chat'})
    assert error.value.status_code==409
    broker.close()


def test_security_rejects_remote_peers_origins_secrets_and_bad_commands():
    import pytest
    from fastapi import HTTPException
    broker,owner,state=fixture_broker()
    for field in ['sdp','pcm','transcript','credentials']:
        with pytest.raises(HTTPException) as error:broker.pulse({**owner,'state':{**state,field:'private'}})
        assert error.value.status_code==400
    for command in [
        {'id':'request-bad','generation':owner['generation'],'action':'eval','code':'bad'},
        {'id':'request-bad','generation':owner['generation'],'action':'setMuted'},
        {'id':'request-bad','generation':'stale','action':'chat'},
    ]:
        with pytest.raises(HTTPException):broker.command(command)
    app=FastAPI();app.include_router(load().make_router(broker))
    with TestClient(app,client=('192.0.2.20',1234)) as client:
        assert client.post('/companion/claim',json={'profile':'default','connection':'local'}).status_code==403
    with TestClient(app,client=('127.0.0.1',1234)) as client:
        assert client.post('/companion/pulse',json={**owner,'state':state},headers={'Origin':'null'}).status_code==403
        assert client.post('/companion/pulse',content='x'*17000).status_code==413
    broker.close()


def test_native_input_regions_are_bounded_and_transparent_padding_is_excluded():
    path=ROOT/'companion'/'input_regions.py'
    assert path.is_file(), 'native input-region validator missing'
    spec=importlib.util.spec_from_file_location('companion_regions_test',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    assert m.normalize_regions([[140,160,100,80],[278,180,36,36]])==[(140,160,100,80),(278,180,36,36)]
    assert m.normalize_regions([[350,310,40,40]])==[(350,310,10,10)]
    assert m.normalize_regions([[0,0,float('nan'),10]])==[]
    assert m.normalize_regions([[0,0,1,1]]*20)==[]


def test_native_child_environment_does_not_inherit_provider_credentials(monkeypatch):
    broker,owner,state=fixture_broker()
    monkeypatch.setenv('OPENAI_API_KEY','fixture-secret-not-for-helper')
    monkeypatch.setenv('HERMES_TOKEN','fixture-secret-not-for-helper')
    monkeypatch.setenv('HYPRLAND_INSTANCE_SIGNATURE','fixture-compositor')
    env=broker.runtime()
    assert 'OPENAI_API_KEY' not in env and 'HERMES_TOKEN' not in env
    assert 'PYTHONPATH' not in env
    assert env.get('HYPRLAND_INSTANCE_SIGNATURE') == 'fixture-compositor'
    broker.close()


def test_native_reveal_failure_reports_a_warning_without_disconnecting():
    # Exercise the actual message handler without starting GTK or an owner.
    import ast, json
    from types import SimpleNamespace
    path=ROOT/'companion'/'native_helper.py'
    handler=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='message')
    messages=[]
    def fail_reveal():
        raise RuntimeError('fixture compositor unavailable')
    scope={'json':json,'evaluate':messages.append,'reveal_owner':fail_reveal}
    exec(compile(ast.Module(body=[handler],type_ignores=[]),str(path),'exec'),scope)
    result=SimpleNamespace(get_js_value=lambda:SimpleNamespace(to_string=lambda:'{"type":"reveal"}'))
    scope['message'](None,result)
    assert messages == [{'warning':'Could not reveal owning Hermes window'}]


def test_owner_lease_is_authenticated_local_and_singleton():
    m = load()
    broker = m.Broker(ROOT)
    app = FastAPI()
    app.include_router(m.make_router(broker))
    with TestClient(app, client=('127.0.0.1', 31000)) as client:
        response = client.post('/companion/claim', json={'profile':'default','connection':'local'})
        assert response.status_code == 200
        owner = response.json()
        assert client.post('/companion/claim', json={'profile':'default','connection':'local'}).status_code == 409
        assert client.post('/companion/pulse', json={'generation':owner['generation'],'token':'bad','state':{}}).status_code == 401
        assert client.post('/companion/pulse', json={**owner,'state':{'lifecycle':'idle','capabilities':[],'status':'','bands':[],'muted':False}}).status_code == 200
        assert client.post('/companion/release', json=owner).status_code == 200
    broker.close()


def test_reply_command_requires_bounded_text_and_reply_capability():
    import pytest
    from fastapi import HTTPException
    broker,owner,state=fixture_broker()
    g=owner['generation']
    with pytest.raises(HTTPException) as error:broker.command({'id':'reply-nocap','generation':g,'action':'reply','text':'hi'})
    assert error.value.status_code==409
    broker.pulse({**owner,'state':{**state,'capabilities':state['capabilities']+['reply']}})
    assert broker.command({'id':'reply-ok-1','generation':g,'action':'reply','text':'ship it'})['pending']
    assert broker.pulse({**owner,'state':{**state,'capabilities':state['capabilities']+['reply']}})['commands'][0]['text']=='ship it'
    for bad in [{'action':'reply'},{'action':'reply','text':'   '},{'action':'reply','text':'x'*501},{'action':'reply','text':7},{'action':'chat','text':'smuggled'}]:
        with pytest.raises(HTTPException) as error:broker.command({'id':'reply-bad-1','generation':g,**bad})
        assert error.value.status_code==400
    broker.close()


def test_native_keyboard_is_only_taken_while_reply_field_is_open():
    import ast, json
    from types import SimpleNamespace
    path=ROOT/'companion'/'native_helper.py'
    handler=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='message')
    modes=[];focus=[]
    layer=SimpleNamespace(KeyboardMode=SimpleNamespace(EXCLUSIVE='exclusive',NONE='none'),set_keyboard_mode=lambda win,mode:modes.append(mode))
    scope={'json':json,'GtkLayerShell':layer,'win':object(),'web':SimpleNamespace(grab_focus=lambda:focus.append(1))}
    exec(compile(ast.Module(body=[handler],type_ignores=[]),str(path),'exec'),scope)
    for payload in ['{"type":"keyboard","on":true}','{"type":"keyboard","on":false}','{"type":"keyboard","on":"yes"}']:
        scope['message'](None,SimpleNamespace(get_js_value=lambda p=payload:SimpleNamespace(to_string=lambda:p)))
    assert modes==['exclusive','none','none'] and focus==[1]



def test_attention_is_a_bounded_kind_and_count_only():
    import pytest
    from fastapi import HTTPException
    broker,owner,state=fixture_broker()
    broker.pulse({**owner,'state':{**state,'attention':{'kind':'approval','count':2}}})
    assert broker.state['attention']=={'kind':'approval','count':2}
    broker.pulse({**owner,'state':state})
    assert 'attention' not in broker.state
    for bad in [{'kind':'secret','count':1},{'kind':'approval','count':0},{'kind':'approval','count':17},
                {'kind':'approval','count':True},{'kind':'clarify','count':1,'prompt':'rm -rf /'},'approval']:
        with pytest.raises(HTTPException) as error:broker.pulse({**owner,'state':{**state,'attention':bad}})
        assert error.value.status_code==400
    broker.close()


# ── Renderer-hosted windows: a chat on another connection, windows on this machine ──────────

def hosted_fixture():
    m = load()
    broker = m.Broker(ROOT)
    owner = broker.claim({'profile': 'deepseek-thinkpad', 'connection': 'hermes-thinkpad', 'host': 'renderer'})
    return m, broker, owner


def hosted_state(bots, **extra):
    state = {'lifecycle': 'idle', 'capabilities': [], 'status': '', 'bands': [], 'muted': False,
             'petVisible': False, 'botsEnabled': True, 'bots': bots}
    state.update(extra)
    return state


AVATAR = 'data:image/png;base64,' + 'QVZBVEFS'
SHEET = 'data:image/webp;base64,' + 'U0hFRVQ'
AID, SID = 'a' * 64, 'b' * 64
PET = {'spriteId': SID, 'frameWidth': 192, 'frameHeight': 208, 'counts': [6, 8, 8, 4, 5, 8, 6, 6, 6], 'top': 20}


def upload(broker, owner, ident, data):
    return broker.host_image({**owner, 'id': ident, 'data': data})


def test_hosted_claim_needs_a_remote_connection_and_leaves_the_local_rule_intact():
    import pytest
    m = load(); broker = m.Broker(ROOT)
    with pytest.raises(Exception):
        broker.claim({'profile': 'default', 'connection': 'local', 'host': 'renderer'})
    with pytest.raises(Exception):
        broker.claim({'profile': 'default', 'host': 'renderer'})
    owner = broker.claim({'profile': 'deepseek-thinkpad', 'connection': 'hermes-thinkpad', 'host': 'renderer'})
    assert broker.hosted() is True
    assert broker.owner['connection'] == 'hermes-thinkpad' and broker.owner['profile'] == 'deepseek-thinkpad'
    broker.close()
    # The backend-owned path still refuses a remote route.
    other = m.Broker(ROOT)
    with pytest.raises(Exception):
        other.claim({'profile': 'default', 'connection': 'hermes-thinkpad'})
    other.close()


def test_hosted_pulse_accepts_a_remote_roster_with_renderer_images():
    m, broker, owner = hosted_fixture()
    try:
        upload(broker, owner, AID, AVATAR)
        upload(broker, owner, SID, SHEET)
        bots = [{'id': 'deepseek-thinkpad', 'label': 'DeepSeek', 'status': 'Working', 'chat': True,
                 'avatarId': AID, 'pet': PET}]
        broker.pulse({**owner, 'state': hosted_state(bots)})
        state = broker.helper_state()
        [bot] = state['state']['bots']
        assert bot['id'] == 'deepseek-thinkpad' and bot['status'] == 'Working'
        assert bot['avatar'] == AVATAR, 'the renderer image is what the helper draws'
        assert bot['pet'] == PET, 'the sheet travels by id, fetched once through /sprite'
        assert 'pet' not in state['state'], 'no main pet for a remote chat'
        assert broker.sprite_data({'id': SID})['sprite'] == SHEET
    finally:
        broker.close()


def test_hosted_roster_rejects_unknown_images_and_unsafe_descriptors():
    import pytest
    m, broker, owner = hosted_fixture()
    try:
        with pytest.raises(Exception):
            broker.pulse({**owner, 'state': hosted_state([{'id': 'alpha', 'label': 'A', 'status': '', 'chat': False, 'avatarId': 'c' * 64}])})
        upload(broker, owner, SID, SHEET)
        with pytest.raises(Exception):
            broker.pulse({**owner, 'state': hosted_state([{'id': 'alpha', 'label': 'A', 'status': '', 'chat': False,
                                                           'pet': {**PET, 'counts': [0]}}])})
        with pytest.raises(Exception):
            broker.pulse({**owner, 'state': hosted_state([{'id': 'Bad Name', 'label': 'A', 'status': '', 'chat': False}])})
        with pytest.raises(Exception):
            broker.host_image({**owner, 'id': 'nothex', 'data': AVATAR})
        with pytest.raises(Exception):
            broker.host_image({**owner, 'id': AID, 'data': 'https://example.test/x.png'})
        with pytest.raises(Exception):
            broker.host_image({**owner, 'id': AID, 'data': 'data:image/png;base64,' + 'A' * 12_000_000})
        with pytest.raises(Exception):
            broker.host_image({'id': AID, 'data': AVATAR, 'token': 'wrong', 'generation': owner['generation']})
    finally:
        broker.close()


def test_hosted_bot_command_skips_the_local_profile_lookup():
    import pytest
    m, broker, owner = hosted_fixture()
    try:
        bots = [{'id': 'deepseek-thinkpad', 'label': 'DeepSeek', 'status': '', 'chat': True}]
        broker.pulse({**owner, 'state': hosted_state(bots)})
        # This bot profile exists only on the chat's backend, so a local profile lookup would raise.
        reply = broker.command({'generation': owner['generation'], 'id': 'bot-chat-0001', 'action': 'botChat', 'bot': 'deepseek-thinkpad'})
        assert reply.get('duplicate') is not True
        with pytest.raises(Exception):
            broker.command({'generation': owner['generation'], 'id': 'bot-chat-0002', 'action': 'botChat', 'bot': 'unknown-bot'})
    finally:
        broker.close()


def test_pet_sprite_serves_the_sheet_hermes_would_show_for_a_profile(monkeypatch, tmp_path):
    from PIL import Image
    import pytest
    home = tmp_path / 'home'
    (home / 'profiles').mkdir(parents=True)
    (home / 'pets' / 'demo').mkdir(parents=True)
    Image.new('RGBA', (192, 1872), (200, 30, 60, 255)).save(home / 'pets' / 'demo' / 'spritesheet.png')
    m = load()
    monkeypatch.setattr(m.portable, 'hermes_root', lambda: home)
    broker = m.Broker(ROOT)
    try:
        reply = broker.pet_sheet('default')
        assert reply['slug'] == 'demo'
        assert reply['sprite'].startswith('data:image/png;base64,')
        assert len(reply['spriteId']) == 64
        assert broker.sprite_data({'id': reply['spriteId']})['sprite'] == reply['sprite'], 'fetched once by id'
        with pytest.raises(Exception):
            broker.pet_sheet('Bad Name')
        with pytest.raises(Exception):
            broker.pet_sheet('nobody')
        (home / 'pets' / 'demo' / 'spritesheet.png').unlink()
        with pytest.raises(Exception):
            broker.pet_sheet('default')
    finally:
        broker.close()


def test_hosted_lease_may_publish_the_main_pet_sheet():
    import pytest
    m, broker, owner = hosted_fixture()
    try:
        upload(broker, owner, SID, SHEET)
        bots = [{'id': 'deepseek-thinkpad', 'label': 'DeepSeek', 'status': '', 'chat': False}]
        broker.pulse({**owner, 'state': hosted_state(bots, petVisible=True, pet={'spriteId': SID},
                                                     owner={'runtimeId': 'r1', 'storedId': 's1', 'profile': 'deepseek-thinkpad', 'connection': 'hermes-thinkpad'})})
        state = broker.helper_state()['state']
        assert state['pet'] == {'spriteId': SID}, 'the hosted pop-out draws the chat profile pet'
        assert state['petVisible'] is True
        assert state['owner']['connection'] == 'hermes-thinkpad'
        with pytest.raises(Exception):
            broker.pulse({**owner, 'state': hosted_state(bots, pet={'spriteId': 'd' * 64})})
        with pytest.raises(Exception):
            broker.pulse({**owner, 'state': hosted_state(bots, owner={'runtimeId': 'r1', 'storedId': 's1', 'profile': 'deepseek-thinkpad', 'connection': 'local'})})
    finally:
        broker.close()
    # A backend-owned local lease still refuses a transport-supplied sheet.
    local = m.Broker(ROOT)
    try:
        own = local.claim({'profile': 'default', 'connection': 'local'})
        with pytest.raises(Exception):
            local.pulse({**own, 'state': {'lifecycle': 'idle', 'capabilities': [], 'status': '', 'bands': [], 'muted': False, 'pet': {'spriteId': 'a' * 64}}})
    finally:
        local.close()


def test_hosted_image_cap_fits_a_full_sheet_and_still_refuses_oversize():
    import pytest
    m, broker, owner = hosted_fixture()
    try:
        big = 'data:image/webp;base64,' + 'B' * 3_000_000   # ~2.2 MiB sheet after inflation
        assert upload(broker, owner, SID, big)['ok'] is True
        assert broker.sprite_data({'id': SID})['sprite'] == big
        with pytest.raises(Exception) as denied:
            upload(broker, owner, AID, 'data:image/webp;base64,' + 'C' * 12_000_000)
        assert 'Image too large' in str(denied.value)
    finally:
        broker.close()


def test_capabilities_finds_the_session_socket_when_the_env_var_is_missing(monkeypatch, tmp_path):
    runtime_dir = tmp_path / 'run'
    runtime_dir.mkdir()
    (runtime_dir / 'wayland-1').write_text('')       # the socket's name is all we look for
    (runtime_dir / 'wayland-1.lock').write_text('')  # the lock must never be chosen
    m = load()
    monkeypatch.delenv('WAYLAND_DISPLAY', raising=False)
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(runtime_dir))
    assert m.wayland_display() == 'wayland-1'
    reply = m.Broker(ROOT).capabilities()
    assert reply['rendererHost'] is True
    import os.path
    assert reply['desktopWindows'] is os.path.exists('/usr/bin/python')
    monkeypatch.setenv('WAYLAND_DISPLAY', 'wayland-9')
    assert m.wayland_display() == 'wayland-9'
    empty = tmp_path / 'empty'
    empty.mkdir()
    monkeypatch.delenv('WAYLAND_DISPLAY', raising=False)
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(empty))
    assert m.wayland_display() == ''
    assert m.Broker(ROOT).capabilities()['desktopWindows'] is False
