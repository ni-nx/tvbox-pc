from PIL import Image

src = Image.open("build/icon.png").convert("RGBA")
# 非白/非透明内容包围盒（人工扫描：x/y 56..876）
bbox = (56, 56, 876, 876)
print("crop bbox", bbox)
crop = src.crop(bbox)
w, h = crop.size
canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
canvas.paste(crop, ((1024 - w) // 2, (1024 - h) // 2), crop)
canvas.save("src/renderer/assets/icon.png")

# 校验新图内容居中
nb = canvas.getbbox()
print("new bbox", nb, "center", ((nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2))
