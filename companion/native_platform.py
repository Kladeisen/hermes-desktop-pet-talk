"""Hyprland adapter: logical cursor coordinates and ancestry-bound window focus."""
import json
import os
from pathlib import Path
import re
import subprocess


def hypr(*args):
    result = subprocess.run(['hyprctl', *args], capture_output=True, text=True, timeout=1, check=True)
    return result.stdout


def ancestors(pid=None):
    pid = os.getppid() if pid is None else pid
    result = []
    while pid > 1 and pid not in result and len(result) < 32:
        path = Path('/proc') / str(pid)
        if path.stat().st_uid != os.getuid():
            break
        result.append(pid)
        # comm can contain spaces/parentheses; parse after its final closing ')'.
        pid = int((path / 'stat').read_text().rsplit(')', 1)[1].split()[1])
    return result


def owner_window(clients, lineage):
    for pid in lineage:
        matches = [c for c in clients if c.get('pid') == pid and c.get('mapped') is True
                   and c.get('class') == 'com.nousresearch.hermes']
        if matches:
            address = matches[0].get('address', '')
            return address if len(matches) == 1 and re.fullmatch(r'0x[0-9a-fA-F]+', address) else None
    return None


def reveal_owner():
    lineage = ancestors()
    address = owner_window(json.loads(hypr('-j', 'clients')), lineage)
    if not address:
        raise RuntimeError('Owning Hermes window unavailable')
    # Match process ownership, not the title or first app window. The helper is
    # launched by the exact local desktop backend; its lease already pins profile.
    owner = next(c for c in json.loads(hypr('-j', 'clients')) if c.get('address') == address)
    if owner.get('pid') not in lineage or Path('/proc', str(owner['pid']), 'exe').resolve().name != 'Hermes':
        raise RuntimeError('Owning desktop process unavailable')
    provider = 'configProvider: lua' in hypr('systeminfo')
    args = ('dispatch', f'hl.dsp.focus({{window="address:{address}"}})') if provider else ('dispatch', 'focuswindow', 'address:' + address)
    hypr(*args)
    active = json.loads(hypr('-j', 'activewindow'))
    if active.get('address') != address:
        raise RuntimeError('Hermes window was not revealed')
    return {'address': address, 'workspace': active['workspace']['id'], 'pid': active['pid']}


def cursor_position():
    position = json.loads(hypr('-j', 'cursorpos'))
    return float(position['x']), float(position['y'])


def scaled_window(size):
    """Pop-out (width, height, pet box) for a main-pet size in percent; 100 = 384x320.
    The pet grows from its top-left; the room right of it (rail) and below it (bubble) stays."""
    f = max(50, min(200, size)) / 100
    pet = (140, 80, 140 + 153.6 * f, 80 + 166.4 * f)
    return round(pet[2] + 90.4), round(pet[3] + 73.6), pet


def keep_reachable(layer, gdk, win, window, pet):
    """After a resize, pull a LEFT/BOTTOM-anchored layer window back so the drag clamp's 40 px of its pet stay on screen."""
    if not win.get_window():
        return
    geometry = gdk.Display.get_default().get_monitor_at_window(win.get_window()).get_geometry()
    margins = (layer.get_margin(win, layer.Edge.LEFT), layer.get_margin(win, layer.Edge.BOTTOM))
    left, bottom = drag_margins(margins, (0, 0), (0, 0), (geometry.width, geometry.height), window, pet)
    layer.set_margin(win, layer.Edge.LEFT, left)
    layer.set_margin(win, layer.Edge.BOTTOM, bottom)


def drag_margins(initial, start, current, monitor, window, pet=None, keep=40):
    # Both frames are compositor logical pixels. Never apply GDK's integer buffer
    # scale or Hyprland's fractional output scale to this displacement again.
    # pet=(left, top, right, bottom) of the pet inside the window. When given, the
    # window may go anywhere, even past the screen edges, as long as `keep` px of
    # the pet stay on screen so it can always be grabbed again.
    left = initial[0] + current[0] - start[0]
    bottom = initial[1] - current[1] + start[1]
    if pet is None:
        return (round(max(0, min(max(0, monitor[0] - window[0]), left))),
                round(max(0, min(max(0, monitor[1] - window[1]), bottom))))
    px0, py0, px1, py1 = pet
    left = max(keep - px1, min(monitor[0] - keep - px0, left))
    bottom = max(keep - (window[1] - py0), min(monitor[1] - keep - (window[1] - py1), bottom))
    return (round(left), round(bottom))
