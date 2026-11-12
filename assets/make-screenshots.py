"""Build storefront screenshots for the plugin listing from verified QA captures."""
from pathlib import Path

from PIL import Image

SRC = Path(r"E:\iboomto_tools\xdtohtml\output\playwright")
DST = Path(r"E:\iboomto_tools\xdtohtml\adobe-xd-mcp-harness\assets")

SHOTS = [
    ("dom-page-4-full.png", "screenshot-1.png", 1440),
    ("dom-home-hover.png", "screenshot-2.png", 1440),
    ("mobile-home-390.png", "screenshot-3.png", 780),
]

for src_name, dst_name, width in SHOTS:
    im = Image.open(SRC / src_name).convert("RGB")
    height = round(im.height * width / im.width)
    im = im.resize((width, height), Image.LANCZOS)
    # Storefront tiles are landscape-ish; cap extreme full-page heights.
    if height > 2400:
        im = im.crop((0, 0, width, 2400))
    out = DST / dst_name
    im.save(out, optimize=True)
    print(dst_name, im.size, out.stat().st_size)
