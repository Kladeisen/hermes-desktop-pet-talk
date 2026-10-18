"""Bounded isolated verifier: real plugin API/native child, no user app restart.
Owner/profile/auth are explicitly FIXTURES. Never imports Hermes's desktop/core.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

root=Path(__file__).resolve().parents[1]
path=root/'dashboard'/'plugin_api.py'
spec=importlib.util.spec_from_file_location('talk_desktop_production_verifier',path)
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
app=FastAPI();token=secrets.token_urlsafe(32)
@app.middleware('http')
async def fixture_auth(request:Request, call_next):
    if request.headers.get('authorization') != 'Bearer '+token:
        return JSONResponse({'error':'Fixture authentication required'},status_code=401)
    return await call_next(request)
app.include_router(module.router,prefix='/api/plugins/talk-desktop')
@app.get('/verify')
def verify():
    broker=module.companion_broker
    with broker.lock:
        return {'fixture':True,'child':broker.child.pid if broker.child else None,'running':bool(broker.child and broker.child.poll() is None),'state':broker.state,'pending':len(broker.pending),'acks':dict(broker.done)}
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
bootstrap=Path(os.environ['PET_VERIFY_BOOTSTRAP']);bootstrap.parent.mkdir(parents=True,exist_ok=True)
bootstrap.write_text(json.dumps({'url':f'http://127.0.0.1:{port}','token':token}));bootstrap.chmod(0o600)
server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=port,log_level='warning'))
def end():
    time.sleep(float(os.environ.get('PET_VERIFY_SERVER_SECONDS','140')));module.companion_broker.close();server.should_exit=True
threading.Thread(target=end,daemon=True).start()
try: server.run()
finally: module.companion_broker.close();bootstrap.unlink(missing_ok=True)
