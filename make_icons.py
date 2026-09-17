#!/usr/bin/env python3
"""Generate Quiz Atelier logo assets from the source image."""
from PIL import Image
import os

SRC = r"C:\Users\khana\Downloads\Gemini_Generated_Image_td5ycutd5ycutd5y.png"
WEB = "quiz-manager"
APK = os.path.join("android", "app", "src", "main", "res")

im = Image.open(SRC).convert("RGBA")

# Trim to content bbox then pad to square on transparent background
bbox = im.getbbox()
im = im.crop(bbox)
side = max(im.size)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
im = sq

os.makedirs(WEB, exist_ok=True)
# PWA icons
for size, name in [(192, "icon-192.png"), (512, "icon-512.png")]:
    im.resize((size, size), Image.LANCZOS).save(os.path.join(WEB, name), optimize=True)
# Apple touch icon
im.resize((180, 180), Image.LANCZOS).save(os.path.join(WEB, "apple-touch-icon.png"), optimize=True)
# Favicon ico (multi-size)
im.resize((64, 64), Image.LANCZOS).save(os.path.join(WEB, "favicon.ico"),
    sizes=[(16, 16), (32, 32), (48, 48)])

# Android launcher icons (adaptive fg on transparent bg; legacy round)
mips = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
for d, size in mips.items():
    p = os.path.join(APK, d)
    os.makedirs(p, exist_ok=True)
    im.resize((size, size), Image.LANCZOS).save(os.path.join(p, "ic_launcher.png"), optimize=True)
    im.resize((size, size), Image.LANCZOS).save(os.path.join(p, "ic_launcher_round.png"), optimize=True)

print("done:", os.listdir(WEB))
