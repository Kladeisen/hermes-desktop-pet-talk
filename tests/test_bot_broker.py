"""Bot presentation is untrusted renderer input; all profiles are synthetic."""
import importlib.util
from pathlib import Path
import pytest
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]

@pytest.fixture
def broker(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('bot_broker', ROOT / 'dashboard/companion_broker.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    monkeypatch.setenv('HOME', str(tmp_path / 'user'))
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    (tmp_path / 'profiles/alpha/assets').mkdir(parents=True)
    instance = module.Broker(ROOT)
    instance.claim({'profile':'default','connection':'local'})
    yield instance, tmp_path
    instance.close()

def state(bots):
    return dict(lifecycle='idle', status='', bands=[], muted=False, capabilities=[], bots=bots)

def bot(**fields):
    return dict(id='alpha', label='Alpha', status='Working', chat=True, **fields)

def test_real_profile_bot_presentation(broker):
    instance, _ = broker
    assert instance.sanitize(state([bot()]))['bots'] == [bot()]

@pytest.mark.parametrize('change', [
    {'id':'../alpha'}, {'id':'missing'}, {'id':'default'}, {'status':'script'}, {'status':[]}, {'status':{}}, {'attention':{'kind':[], 'count':1}}, {'chat':1}, {'avatar':'/etc/passwd'},
    {'avatar':'data:image/png;base64,AA=='}, {'attention':{'kind':'secret','count':1}},
    {'attention':{'kind':'clarify','count':True}}, {'attention':{'kind':'sudo','count':17}},
])
def test_hostile_bot_fields_rejected(broker, change):
    instance, _ = broker
    with pytest.raises(HTTPException):
        instance.sanitize(state([{**bot(), **change}]))

@pytest.mark.parametrize('label,clean', [('x'*41, 'x'*40), ('bad\nlabel', 'badlabel'), ('', 'alpha'), (None, 'alpha')])
def test_unsuitable_labels_are_cleaned_not_rejected(broker, label, clean):
    instance, _ = broker
    assert instance.sanitize(state([{**bot(), 'label':label}]))['bots'][0]['label'] == clean

def test_symlink_profile_does_not_leak(broker):
    instance, home = broker
    outside = home / 'outside'; outside.mkdir()
    (home / 'profiles/evil').symlink_to(outside, target_is_directory=True)
    with pytest.raises(HTTPException):
        instance.sanitize(state([{**bot(), 'id':'evil'}]))

@pytest.mark.parametrize('extension,magic,mime', [('png',b'\x89PNG\r\n\x1a\n','image/png'),('webp',b'RIFF\x00\x00\x00\x00WEBP','image/webp'),('jpg',b'\xff\xd8\xff','image/jpeg')])
def test_avatar_loaded_only_by_backend(broker, extension, magic, mime):
    import base64
    instance, home = broker
    (home / f'profiles/alpha/assets/avatar.{extension}').write_bytes(magic + b'fixture')
    assert instance.bot_avatar('alpha') == 'data:' + mime + ';base64,' + base64.b64encode(magic+b'fixture').decode()
    assert 'avatar' not in instance.sanitize(state([bot()]))['bots'][0]

@pytest.mark.parametrize('kind', ['profile','assets','file','bad-magic','oversize'])
def test_avatar_hostile_files_are_ignored(broker, kind):
    instance, home = broker
    assets = home / 'profiles/alpha/assets'
    outside = home / 'outside'; outside.mkdir()
    (outside / 'avatar.png').write_bytes(b'\x89PNG\r\n\x1a\nsecret')
    if kind == 'profile':
        assets.rmdir(); assets.parent.rmdir(); (home/'profiles/alpha').symlink_to(outside, target_is_directory=True)
    elif kind == 'assets':
        assets.rmdir(); assets.symlink_to(outside, target_is_directory=True)
    elif kind == 'file':
        (assets/'avatar.png').symlink_to(outside/'avatar.png')
    else:
        (assets/'avatar.png').write_bytes(b'bad' if kind == 'bad-magic' else b'\x89PNG\r\n\x1a\n'+b'x'*1048576)
    assert instance.bot_avatar('alpha') is None

@pytest.mark.parametrize('action', ['botChat','botDismiss'])
def test_bot_commands_validate_identity_and_capability(broker, action):
    instance, _ = broker
    instance.state = instance.sanitize(state([bot()]))
    command = dict(id='bot-command-1',generation=instance.owner['generation'],action=action,bot='alpha')
    assert instance.command(command)['pending']
    assert instance.pending[command['id']]['command']['bot'] == 'alpha'
    for fields in ({'bot':'missing'}, {'bot':'../alpha'}, {'bot':None}, {'action':'chat'}):
        with pytest.raises(HTTPException):
            instance.command({**command, 'id':'other-request', **fields})
    instance.state = instance.sanitize(state([]))
    with pytest.raises(HTTPException):
        instance.command({**command, 'id':'removed-request'})

def test_helper_state_enriches_avatars_without_exposing_to_owner(broker):
    instance, home = broker
    (home/'profiles/alpha/assets/avatar.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
    published={**state([bot()]),'petVisible':False,'botsEnabled':True,'capabilities':['bots','hidePet']}
    instance.state=instance.sanitize(published)
    view=instance.helper_state()
    assert view['state']['petVisible'] is False
    assert view['state']['bots'][0]['avatar'].startswith('data:image/png;')
    assert 'avatar' not in instance.state['bots'][0]
    assert instance.command(dict(id='hide-pet-1',generation=instance.owner['generation'],action='hidePet'))['pending']

@pytest.mark.parametrize('mode', ['unset','default','named','custom','custom-named'])
def test_profile_discovery_matches_hermes_default_root(broker, monkeypatch, mode):
    instance, home = broker
    native=home/'user/.hermes'
    expected=native if mode in {'unset','default','named'} else home/'custom'
    if mode=='unset': monkeypatch.delenv('HERMES_HOME',raising=False)
    else:
        selected={'default':native,'named':native/'profiles/owner','custom':home/'custom','custom-named':home/'custom/profiles/owner'}[mode]
        monkeypatch.setenv('HERMES_HOME',str(selected))
    assert instance.profiles_root()==expected/'profiles'

@pytest.mark.parametrize('bots', [None,{},[bot()]*2,[bot()]*13])
def test_invalid_rosters_are_rejected(broker, bots):
    instance,_=broker
    with pytest.raises(HTTPException): instance.sanitize(state(bots))

def test_bot_chat_requires_chat_capability(broker):
    instance,_=broker
    instance.state=instance.sanitize(state([{**bot(),'chat':False}]))
    with pytest.raises(HTTPException):
        instance.command(dict(id='no-chat-target',generation=instance.owner['generation'],action='botChat',bot='alpha'))
