"""Render the 180x180 storefront icon PNG for the plugin market listing.

Mirrors icon.svg: dark rounded tile, purple inner frame, magenta X mark.
"""
from PIL import Image, ImageDraw

S = 720
im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle([34, 34, 686, 686], radius=136, fill=(30, 30, 30, 255))
d.rounded_rectangle([102, 102, 618, 618], radius=90, fill=(44, 11, 79, 255), outline=(255, 97, 246, 255), width=23)

# Magenta X: two thick diagonals.
d.line([(232, 232), (488, 488)], fill=(255, 97, 246, 255), width=56)
d.line([(488, 232), (232, 488)], fill=(255, 97, 246, 255), width=56)

im = im.resize((180, 180), Image.LANCZOS)
im.save("assets/icon-180.png")

check = Image.open("assets/icon-180.png").convert("RGB")
print(check.size, "center", check.getpixel((90, 90)), "corner", check.getpixel((2, 2)))
