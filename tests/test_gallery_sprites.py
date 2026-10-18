"""Automatic gallery sprite resolution: any regular Petdex grid, verified by avatar pixels."""
import hashlib
import importlib.util
import io
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gallery_sprites_under_test', ROOT/'dashboard/gallery_sprites.py')
gallery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gallery)


def make_sheet(columns, rows, counts=None, first='red', fmt='WEBP', size=None):
    """Regular 192x208 grid; first cell is `first`, other nonblank cells blue."""
    counts = counts or [columns] * 9
    sheet = Image.new('RGBA', size or (columns*192, rows*208))
    for row, count in enumerate(counts):
        for col in range(count):
            sheet.paste(first if (row, col) == (0, 0) else 'blue', (col*192, row*208, (col+1)*192, (row+1)*208))
    buf = io.BytesIO()
    sheet.save(buf, format=fmt, **({'lossless': True} if fmt == 'WEBP' else {}))
    return buf.getvalue()


def avatar_pixels(color='red'):
    return Image.new('RGBA', (96, 104), color).tobytes()


@pytest.mark.parametrize('columns,rows,counts', [
    (8, 9, [6, 8, 8, 4, 5, 8, 6, 6, 6]),   # s0uthpaw layout, 1536x1872
    (8, 11, [7, 8, 8, 4, 5, 8, 6, 6, 6]),  # 8x11 layout, 1536x2288
    (6, 9, [6] * 9),                       # Codex layout, 1152x1872
    (12, 10, [12, 3, 3, 3, 3, 3, 3, 3, 3]),
])
def test_describe_sheet_accepts_any_regular_grid(columns, rows, counts):
    pet = gallery.describe_sheet(make_sheet(columns, rows, counts), avatar_pixels())
    assert pet['frameWidth'] == 192 and pet['frameHeight'] == 208
    assert pet['counts'] == counts
    assert pet['sprite'].startswith('data:image/webp;base64,')


def test_describe_sheet_accepts_png_gallery_sheet():
    pet = gallery.describe_sheet(make_sheet(8, 9, fmt='PNG'), avatar_pixels())
    assert pet['sprite'].startswith('data:image/png;base64,')


@pytest.mark.parametrize('damage', ['first-cell', 'misaligned-width', 'misaligned-height', 'too-few-rows',
                                    'too-many-columns', 'blank-row', 'not-an-image', 'jpeg'])
def test_describe_sheet_rejects_unverifiable_sheets(damage):
    data = {
        'first-cell': lambda: make_sheet(8, 9, first='green'),
        'misaligned-width': lambda: make_sheet(8, 9, size=(1537, 1872)),
        'misaligned-height': lambda: make_sheet(8, 9, size=(1536, 1873)),
        'too-few-rows': lambda: make_sheet(8, 8, counts=[8]*8),
        'too-many-columns': lambda: make_sheet(17, 9),
        'blank-row': lambda: make_sheet(8, 9, counts=[8, 8, 8, 0, 8, 8, 8, 8, 8]),
        'not-an-image': lambda: b'RIFF0000WEBPjunk',
        'jpeg': _jpeg,
    }[damage]()
    assert gallery.describe_sheet(data, avatar_pixels()) is None


def _jpeg():
    buf = io.BytesIO()
    Image.new('RGB', (1536, 1872), 'red').save(buf, format='JPEG')
    return buf.getvalue()


def test_describe_sheet_reports_the_highest_visible_pixel_for_bubble_placement():
    sheet = Image.new('RGBA', (8*192, 9*208))
    for row in range(9):
        for col in range(4):
            top = 31 if (row, col) == (6, 2) else 2 if row in (1, 2, 4) else 60   # waiting frame higher; jump/run rows ignored
            sheet.paste('blue', (col*192 + 40, row*208 + top, col*192 + 150, row*208 + 200))
    first = sheet.crop((0, 0, 192, 208)).resize((96, 104), Image.Resampling.NEAREST).tobytes()
    buf = io.BytesIO(); sheet.save(buf, format='WEBP', lossless=True)
    pet = gallery.describe_sheet(buf.getvalue(), first)
    assert pet['top'] == 31 and pet['counts'] == [4] * 9
