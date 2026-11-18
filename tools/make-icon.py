"""把新图标 PNG 裁边 -> 生成多尺寸 ICO（16~256），供 Windows 应用/打包使用。"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build', 'icon-light.png')
PNG_OUT = os.path.join(ROOT, 'build', 'icon.png')
ICO_OUT = os.path.join(ROOT, 'build', 'icon.ico')

im = Image.open(SRC).convert('RGBA')
bbox = im.getbbox()
if bbox:
    im = im.crop(bbox)

# 方形补白 + 一圈留白，避免圆角贴边
side = max(im.size)
pad = int(side * 0.06)
canvas = Image.new('RGBA', (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
canvas.paste(im, ((canvas.width - im.width) // 2, (canvas.height - im.height) // 2))
canvas.resize((1024, 1024), Image.LANCZOS).save(PNG_OUT)

sizes = [16, 24, 32, 48, 64, 128, 256]
base = canvas.resize((256, 256), Image.LANCZOS)
base.save(ICO_OUT, format='ICO', sizes=[(s, s) for s in sizes])
print('PNG', PNG_OUT, os.path.getsize(PNG_OUT))
print('ICO', ICO_OUT, os.path.getsize(ICO_OUT))
