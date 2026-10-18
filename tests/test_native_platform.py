"""Platform seams do not accept arbitrary client addresses or physical scales."""
import importlib.util
from pathlib import Path
import sys
import pytest
path=Path(__file__).resolve().parents[1]/'companion'/'native_platform.py'
def module():
    assert path.exists(), 'native ownership/coordinate adapter is missing'
    spec=importlib.util.spec_from_file_location('native_platform',path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def test_reveal_selects_exact_desktop_ancestor_not_another_hermes():
    m=module()
    clients=[{'address':'0x123','pid':100,'class':'com.nousresearch.hermes','mapped':True}, {'address':'0x456','pid':200,'class':'com.nousresearch.hermes','mapped':True}]
    assert m.owner_window(clients,[300,200,50])=='0x456'
    assert m.owner_window(clients,[999,50]) is None
    assert m.owner_window(clients+[dict(clients[1],address='0x789')],[300,200,50]) is None
    assert m.owner_window([dict(clients[1],address='0x456;exec bad')],[200]) is None

@pytest.mark.parametrize('scale',[1,1.25,2])
def test_drag_uses_absolute_logical_displacement_without_double_scaling(scale):
    m=module()
    # Physical 1920x1080 outputs produce different logical monitor bounds.
    logical=(round(1920/scale),round(1080/scale))
    assert m.drag_margins((80,80),(100,200),(160,225),logical,(384,320))==(140,55)
    assert m.drag_margins((80,80),(100,200),(10000,-10000),logical,(384,320))==(logical[0]-384,logical[1]-320)
    # Free placement: the window may leave the screen on any side, but 40px of the pet stays visible.
    pet=(140,80,293.6,246.4)
    far=m.drag_margins((80,80),(100,200),(10000,-10000),logical,(384,320),pet)
    assert far==(round(logical[0]-40-140),round(logical[1]-40-(320-246.4)))
    near=m.drag_margins((80,80),(100,200),(-10000,10000),logical,(384,320),pet)
    assert near==(round(40-293.6),round(40-(320-80)))
    assert near[0]<0 and near[1]<0, 'past the left and bottom edges too'
    assert m.drag_margins((80,80),(100,200),(160,225),logical,(384,320),pet)==(140,55), 'normal drags unchanged'
