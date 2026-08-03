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
    image = Image.new("RGB", (size, size), "#030407")
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (size * 2)
            glow = max(0.0, 1 - (((x-size*.5)**2 + (y-size*.38)**2) ** .5) / (size*.7))
            pixels[x, y] = (lerp(3, 14, glow), lerp(4, 24, glow), lerp(7, 42, glow))
    draw = ImageDraw.Draw(image)
    scale = size / 512
    radius = round(112 * scale)
    draw.rounded_rectangle((18 * scale, 18 * scale, 494 * scale, 494 * scale), radius=radius, outline="#26334a", width=max(2, round(4 * scale)))
    draw.ellipse((90 * scale, 86 * scale, 422 * scale, 418 * scale), outline="#1e2b40", width=max(2, round(3 * scale)))
    draw.ellipse((140 * scale, 136 * scale, 372 * scale, 368 * scale), outline="#263750", width=max(2, round(3 * scale)))
    draw.line((256 * scale, 252 * scale, 398 * scale, 112 * scale), fill="#3b82f6", width=max(3, round(8 * scale)))
    draw.ellipse((390 * scale, 104 * scale, 406 * scale, 120 * scale), fill="#67e8f9")
    accent = "#22d3ee"
    width = max(4, round(18 * scale))
    draw.line((120 * scale, 177 * scale, 120 * scale, 331 * scale), fill=accent, width=width)
    draw.line((218 * scale, 177 * scale, 218 * scale, 331 * scale), fill="#3b82f6", width=width)
    draw.line((120 * scale, 252 * scale, 218 * scale, 252 * scale), fill="#2f9ff4", width=width)
    s_font = font(round(178 * scale))
    draw.text((313 * scale, 254 * scale), "S", fill="#6284f5", font=s_font, anchor="mm", stroke_width=max(1, round(2 * scale)), stroke_fill="#17243a")
    draw.line((91 * scale, 388 * scale, 421 * scale, 388 * scale), fill="#27364e", width=max(2, round(4 * scale)))
    points=[(102,409),(160,382),(207,397),(268,359),(319,375),(410,318)]
    draw.line([(x*scale,y*scale) for x,y in points],fill="#22d3ee",width=max(3,round(7*scale)),joint="curve")
    draw.ellipse((403*scale,311*scale,417*scale,325*scale),fill="#67e8f9")
    return image


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    outputs=((180,"apple-touch-icon.png"),(192,"icon-192.png"),(512,"icon-512.png"),(180,"apple-touch-icon-v2.png"),(192,"icon-192-v2.png"),(512,"icon-512-v2.png"))
    for size, name in outputs:
        render(size).save(ASSETS / name, "PNG", optimize=True)
        print(f"generated {name}")


if __name__ == "__main__":
    main()
