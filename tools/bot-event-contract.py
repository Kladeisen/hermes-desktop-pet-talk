"""Replay installed Hermes producers without starting a server/model or reading profiles.

Usage: python tools/bot-event-contract.py /path/to/hermes-agent
AST extraction executes the actual frame/roster builders; only I/O dependencies
are substituted. Output is synthetic test identities, never user data.
"""
import ast
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from typing import Any

root = Path(sys.argv[1])

def load(relative: str, names: list[str], namespace: dict[str, Any]) -> dict[str, Any]:
    path = root / relative
    tree = ast.parse(path.read_text())
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in nodes} == set(names)
    exec(compile(ast.Module(body=list(nodes), type_ignores=[]), str(path), 'exec'), namespace)
    return namespace

frames = load('tui_gateway/server.py', ['_event_frame'], {
    '_contracts': SimpleNamespace(check_payload=lambda *args: None),
})
# Contract validation is not under test; the production wire-frame builder is.
events = [frames['_event_frame']('message.start', 'runtime-alpha'),
          frames['_event_frame']('message.complete', 'runtime-alpha', {'status': 'complete'})]
# The producer deliberately separates human chats from tool/kanban workers.
source = (root / 'tui_gateway/methods_profiles.py').read_text()
assert 'def _latest_profile_session_rows' in source
constants = ast.parse((root / 'hermes_state_sessions.py').read_text())
deny = next(ast.literal_eval(node.value) for node in constants.body
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'INTERNAL_LISTING_SOURCES' for t in node.targets))
predicate = load('tui_gateway/methods_session.py', ['_denied_source'], {'_LISTING_DENY_SOURCES': frozenset(deny)})
namespace = load('tui_gateway/methods_profiles.py', ['_latest_profile_session_rows'], {
    '_denied_source': predicate['_denied_source'],
    '_latest_message_preview': lambda *args: '', '_live_count_field': lambda *args: {},
})
rows = [{'id': 'cli-chat', 'source': 'cli', 'last_active': 999, 'started_at': 999}]
last, worker = namespace['_latest_profile_session_rows'](SimpleNamespace(list_sessions_rich=lambda **kwargs: rows))
print(json.dumps({'events': events, 'cliRoster': {'profiles': [
    {'name': 'alpha', 'last_session': last, 'worker_session': worker, 'canonical_session': {'id': 'cli-chat'}}
]}}))
