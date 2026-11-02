"""Bot labels: the roster parser (desktop/plugin.js) and the broker share one rule.

A joined emoji or an odd space in one bot name must never reject the whole
presentation (that expires the lease and closes every pet). Profiles are synthetic.
"""
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# Runs the real createBotTracker parse() on a synthetic profiles.list reply.
PARSE = r'''
const source = require('fs').readFileSync(process.argv[1], 'utf8')
const body = source.slice(source.indexOf('const BOT_POLL_MS'), source.indexOf('\nfunction trackPetChat'))
const labels = JSON.parse(process.argv[2])
const host = { state: { connectionId: { get: () => 'local' } },
  request: async () => ({ profiles: labels.map((label, i) => ({ name: 'bot' + i, display_name: label })) }) }
const create = new Function('host','window','CustomEvent','attentionSummary','petAttentionLabel','setTimeout','clearTimeout', body + ';return createBotTracker')
const tracker = create(host, { dispatchEvent() {} }, class {}, () => null, x => x, () => 0, () => {})({})
tracker.setEnabled(true)
setImmediate(() => { console.log(JSON.stringify(tracker.bots().map(({ avatar, ...bot }) => bot))); tracker.dispose() })
'''


def parse(labels):
    assert len(labels) <= 12
    out = subprocess.run(['node', '-e', PARSE, str(ROOT / 'desktop/plugin.js'), json.dumps(labels)],
                         capture_output=True, text=True, check=True).stdout
    bots = json.loads(out)
    assert [bot['id'] for bot in bots] == [f'bot{i}' for i in range(len(labels))]
    return bots


@pytest.fixture
def broker(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('label_broker', ROOT / 'dashboard/companion_broker.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    monkeypatch.setenv('HOME', str(tmp_path / 'user'))
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    for i in range(12):
        (tmp_path / f'profiles/bot{i}').mkdir(parents=True)
    instance = module.Broker(ROOT)
    owner = instance.claim({'profile': 'default', 'connection': 'local'})
    yield instance, owner
    instance.close()


def state(bots):
    return dict(lifecycle='idle', status='', bands=[], muted=False, capabilities=['bots'], botsEnabled=True, bots=bots)


def test_emoji_and_nbsp_bot_names_survive_parser_and_broker(broker):
    instance, owner = broker
    bots = parse(['Research', 'Research \U0001f916', 'Developer \U0001f469\u200d\U0001f4bb', 'Research\u00a0Bot'])
    instance.pulse({**owner, 'state': state(bots)})  # the whole presentation is accepted
    assert [bot['label'] for bot in instance.state['bots']] == \
        ['Research', 'Research \U0001f916', 'Developer \U0001f469\u200d\U0001f4bb', 'Research Bot']


TRICKY = ['bad\nlabel', 'x' * 41, '\u202eevil', 'zero\u200bwidth', 'line\u2028break', '\u0000\u0001',
          '  padded\u3000', '\U0001f9d1\u200d\U0001f52c' * 15, 'ok\u2764\ufe0f', 'thin\u2009space', 'lone\ud83d', '\t']


def test_parser_and_broker_apply_one_label_rule_and_never_reject(broker):
    instance, owner = broker
    parsed = parse(TRICKY)
    for i, (raw, bot) in enumerate(zip(TRICKY, parsed)):
        # Untrusted raw label straight to the broker: cleaned the same way, never rejected.
        direct = instance.sanitize(state([{**bot, 'label': raw}]))['bots'][0]['label']
        assert direct == bot['label'], (raw, direct, bot['label'])
        assert 1 <= len(direct) <= 40
        assert all(ch.isprintable() or ch in '\u200d\ufe0f' for ch in direct), repr(direct)
        # The parser's output is already clean: accepted unchanged.
        assert instance.sanitize(state([bot]))['bots'][0]['label'] == bot['label']
    instance.pulse({**owner, 'state': state(parsed)})
    assert len(instance.state['bots']) == len(TRICKY)
    assert parsed[5]['label'] == 'bot5', 'a label with nothing printable falls back to the bot id'
