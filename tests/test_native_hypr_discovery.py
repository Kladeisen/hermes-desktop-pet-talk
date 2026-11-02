"""A gateway-launched helper finds only the compositor serving its Wayland display."""
import importlib.util
import json
import os
import pytest
from pathlib import Path
from types import SimpleNamespace


def platform():
    path = Path(__file__).resolve().parents[1] / 'companion' / 'native_platform.py'
    spec = importlib.util.spec_from_file_location('drag_discovery', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_drag_discovers_its_wayland_compositor_without_inherited_signature(monkeypatch):
    m = platform()
    monkeypatch.delenv('HYPRLAND_INSTANCE_SIGNATURE', raising=False)
    monkeypatch.setenv('WAYLAND_DISPLAY', 'wayland-fixture')
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        if argv == ['hyprctl', '-j', 'instances']:
            return SimpleNamespace(stdout=json.dumps([
                {'instance': 'other_instance', 'wl_socket': 'other-display', 'pid': os.getpid()},
                {'instance': 'our_instance', 'wl_socket': 'wayland-fixture', 'pid': os.getpid()},
            ]))
        assert kwargs.get('env', {}).get('HYPRLAND_INSTANCE_SIGNATURE') == 'our_instance', 'drag still has no compositor connection'
        return SimpleNamespace(stdout='{"x": 160, "y": 225}')

    monkeypatch.setattr(m.subprocess, 'run', run)
    assert m.cursor_position() == (160, 225)
    assert len(calls) == 2


@pytest.mark.parametrize('records', [
    [],
    [{'instance': 'other', 'wl_socket': 'different', 'pid': os.getpid()}],
    [{'instance': 'one', 'wl_socket': 'wayland-fixture', 'pid': os.getpid()},
     {'instance': 'two', 'wl_socket': 'wayland-fixture', 'pid': os.getpid()}],
    [{'instance': '../unsafe', 'wl_socket': 'wayland-fixture', 'pid': os.getpid()}],
    [{'instance': 'dead', 'wl_socket': 'wayland-fixture', 'pid': 999999999}],
    [{'instance': 'bad', 'wl_socket': 'wayland-fixture', 'pid': True}],
    {'instance': 'not-a-list'},
    ['not-a-record'],
])
def test_drag_refuses_unknown_ambiguous_or_unsafe_compositor(monkeypatch, records):
    m = platform()
    monkeypatch.delenv('HYPRLAND_INSTANCE_SIGNATURE', raising=False)
    monkeypatch.setenv('WAYLAND_DISPLAY', 'wayland-fixture')
    def run(argv, **kwargs):
        assert argv == ['hyprctl', '-j', 'instances'], 'must not send a command to an unbound compositor'
        return SimpleNamespace(stdout=json.dumps(records))
    monkeypatch.setattr(m.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='owning Wayland compositor'):
        m.cursor_position()


def test_inherited_compositor_signature_is_preserved(monkeypatch):
    m = platform()
    monkeypatch.setenv('HYPRLAND_INSTANCE_SIGNATURE', 'explicit-instance')
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        assert kwargs['env']['HYPRLAND_INSTANCE_SIGNATURE'] == 'explicit-instance'
        return SimpleNamespace(stdout='{"x": 10, "y": 20}')
    monkeypatch.setattr(m.subprocess, 'run', run)
    assert m.cursor_position() == (10, 20)
    assert calls == [['hyprctl', '-j', 'cursorpos']]


def test_missing_display_never_selects_an_arbitrary_compositor(monkeypatch):
    m = platform()
    monkeypatch.delenv('HYPRLAND_INSTANCE_SIGNATURE', raising=False)
    monkeypatch.delenv('WAYLAND_DISPLAY', raising=False)
    monkeypatch.setattr(m.subprocess, 'run', lambda *a, **k: pytest.fail('must fail before discovery'))
    with pytest.raises(RuntimeError, match='Wayland display unavailable'):
        m.cursor_position()
