#!/usr/bin/env python3
"""Generate deterministic PNG app icons from the HS ETF radar brand geometry."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in ("arialbd.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def lerp(left: int, right: int, position: float) -> int:
    return round(left + (right - left) * position)


def render(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size), "#050609")
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (size * 2)
            pixels[x, y] = (lerp(17, 5, t), lerp(20, 6, t), lerp(27, 9, t))
    draw = ImageDraw.Draw(image)
    scale = size / 512
    radius = round(112 * scale)
    draw.rounded_rectangle((18 * scale, 18 * scale, 494 * scale, 494 * scale), radius=radius, outline="#292e3a", width=max(2, round(4 * scale)))
    draw.arc((104 * scale, 152 * scale, 408 * scale, 456 * scale), 180, 360, fill="#252b38", width=max(4, round(18 * scale)))
    draw.arc((146 * scale, 194 * scale, 366 * scale, 414 * scale), 180, 360, fill="#303746", width=max(3, round(12 * scale)))
    draw.line((256 * scale, 304 * scale, 388 * scale, 184 * scale), fill="#6f7cff", width=max(3, round(13 * scale)))
    draw.ellipse((236 * scale, 284 * scale, 276 * scale, 324 * scale), fill="#090b10", outline="#35d6ff", width=max(3, round(9 * scale)))
    draw.line((116 * scale, 352 * scale, 396 * scale, 352 * scale), fill="#363e4f", width=max(2, round(6 * scale)))
    for x, top, bottom in ((158, 289, 337), (224, 261, 339), (290, 235, 339), (356, 271, 339)):
        draw.line((x * scale, top * scale, x * scale, bottom * scale), fill="#35d6ff", width=max(3, round(10 * scale)))
    label_font = font(round(86 * scale))
    draw.text((size / 2, 424 * scale), "HS", fill="#f6f8ff", font=label_font, anchor="mm", stroke_width=max(0, round(scale)), stroke_fill="#11141b")
    return image


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    for size, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
        render(size).save(ASSETS / name, "PNG", optimize=True)
        print(f"generated {name}")


if __name__ == "__main__":
    main()
