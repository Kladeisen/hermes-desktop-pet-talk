"""Bounded end-to-end production plugin verifier. Only audio/provider is fake.
Run with uv --with aiortc --with fastapi --with httpx --with uvicorn.
TALK_TEST_DEPS must point at isolated react/jsdom dependencies.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
evidence=Path(os.environ.get('PET_VERIFY_EVIDENCE',str(Path.home()/'.hermes/cache/scratch/pet-production/final')))
evidence.mkdir(parents=True,exist_ok=True)
boot=evidence/'bootstrap.json';receipt=evidence/'owner.json'
env={k:v for k,v in os.environ.items() if k not in {'PYTHONPATH','PYTHONHOME'}}
env.update({'PET_VERIFY_BOOTSTRAP':str(boot),'PET_VERIFY_RECEIPT':str(receipt),'PET_VERIFY_DURATION_MS':'14000','PET_VERIFY_SERVER_SECONDS':'22','HERMES_HOME':str(evidence/'isolated-home')})
node=shutil.which('node')
assert node and env.get('TALK_TEST_DEPS'), 'node and isolated TALK_TEST_DEPS are required'
server=owner=None
server_log=(evidence/'server.log').open('w');owner_log=(evidence/'owner.log').open('w')
def wait_for(fn, seconds=8):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            result=fn()
            if result:return result
        except (OSError,ValueError,KeyError):pass
        time.sleep(.1)
    raise AssertionError('Verification deadline exceeded')
def verify():
    b=json.loads(boot.read_text())
    request=urllib.request.Request(b['url']+'/verify',headers={'Authorization':'Bearer '+b['token']})
    return json.load(urllib.request.urlopen(request,timeout=2))
def own_layer(pid):
    layers=json.loads(subprocess.check_output(['hyprctl','-j','layers']))
    return next((item for monitor in layers.values() for level in monitor['levels'].values() for item in level if item.get('pid')==pid),None)
def click(pid,label):
    script="""import gi,sys
 gi.require_version('Atspi','2.0')
 from gi.repository import Atspi
 d=Atspi.get_desktop(0)
 root=next(d.get_child_at_index(i) for i in range(d.get_child_count()) if d.get_child_at_index(i).get_process_id()==int(sys.argv[1]))
 stack=[root]
 while stack:
  item=stack.pop()
  if item.get_name()==sys.argv[2]:
   assert item.get_action_iface().do_action(0);print('native action',sys.argv[2]);break
  stack.extend(item.get_child_at_index(i) for i in range(item.get_child_count()))
 else:raise AssertionError('native control missing')
"""
    import textwrap
    script=script.split('\n',1)[0]+'\n'+textwrap.dedent(script.split('\n',1)[1])
    subprocess.run(['/usr/bin/python','-c',script,str(pid),label],env=env,check=True,timeout=5)
try:
    boot.unlink(missing_ok=True)
    server=subprocess.Popen([sys.executable,str(root/'tools/companion-integration-server.py')],env=env,stdout=server_log,stderr=server_log)
    wait_for(lambda:boot.is_file() and verify())
    owner=subprocess.Popen([node,str(root/'tools/companion-integration-owner.mjs')],env=env,stdout=owner_log,stderr=owner_log)
    state=wait_for(lambda:(d if (d:=verify())['running'] else None))
    pid=state['child'];layer=wait_for(lambda:(l if (l:=own_layer(pid)) and l['alpha']>0 else None))
    print('real native overlay visible',pid)
    (evidence/'compositor.json').write_text(json.dumps(layer,indent=2))
    geometry=f"{layer['x']},{layer['y']} {layer['w']}x{layer['h']}"
    subprocess.run(['grim','-g',geometry,str(evidence/'native-before.png')],check=True)
    click(pid,'Mute microphone');click(pid,'Open associated chat');click(pid,'Open live transcript in Hermes')
    def muted():
        d=json.loads(receipt.read_text())
        return d if d['trackEnabled'] is False and d['opened'] and d['transcriptMounted'] else None
    result=wait_for(muted)
    assert result['captures']==0 and result['starts']==1 and result['videoEnabled'] is True
    assert result['opened']==[{'id':'fixture-durable','options':{'profile':'default','intent':'in-place','route':{'connectionId':'local','profile':'default','mode':'local'}}}]
    backend=wait_for(lambda:(d if len((d:=verify())['acks'])>=3 else None))
    assert all(ack['ok'] for ack in backend['acks'].values())
    (evidence/'backend.json').write_text(json.dumps(backend,indent=2))
    (evidence/'owner-after-actions.json').write_text(json.dumps(result,indent=2))
    subprocess.run(['grim','-g',geometry,str(evidence/'native-muted.png')],check=True)
    click(pid,'Close pop-out pet')
    wait_for(lambda:not verify()['running'])
    assert own_layer(pid) is None
    owner.wait(timeout=18);assert owner.returncode==0
    server.wait(timeout=25);assert server.returncode==0
    (evidence/'summary.json').write_text(json.dumps({'fixture':True,'realProductionAPI':True,'nativeGTK':True,'visibleOverlay':True,'audioCaptures':0,'voiceStartsAtFakeBoundary':1,'muteTrackEnabled':False,'videoTrackEnabled':True,'exactDurableProfileConnection':True,'transcriptDOMMounted':True,'dialogSDK':'fixture','acknowledgedActions':len(backend['acks']),'cleanup':True},indent=2))
    print('PASS actual plugin routes + actual single controller + actual native UI; mute/chat/transcript acknowledgements; no audio; children/server exited 0')
finally:
    for process in [owner,server]:
        if process and process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
    server_log.close();owner_log.close();boot.unlink(missing_ok=True)
