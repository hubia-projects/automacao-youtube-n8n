"""Thumbnail — frame real + template Pillow (ARCHITECTURE §1.10).

Hero frame = frame do vídeo final na cena de maior qualidade (payoff/hook);
texto = 2-4 palavras do hook. 1280x720 PNG.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]


def _font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def build_thumbnail(final_mp4: Path, hook_text: str, scenes: list[dict],
                    out_path: Path) -> Path:
    # frame da 1ª cena payoff (ou meio do vídeo)
    payoff = next((s for s in scenes if s["beat"] == "payoff"), None)
    t = (payoff["t_in"] + 1.0) if payoff else scenes[len(scenes) // 2]["t_in"]
    frame = out_path.with_suffix(".frame.png")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}",
                    "-i", str(final_mp4), "-frames:v", "1",
                    "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
                    str(frame)], check=True)

    img = Image.open(frame).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    # gradiente escuro em baixo para legibilidade
    for i in range(220):
        alpha = int(180 * i / 220)
        draw.line([(0, 500 + i), (1280, 500 + i)], fill=(0, 0, 0, alpha))

    words = hook_text.split()[:4]
    text = " ".join(words).upper()
    font = _font(92 if len(text) <= 22 else 72)
    x, y = 60, 560
    draw.text((x + 4, y + 4), text, font=font, fill=(0, 0, 0, 255))
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    img.save(out_path, "PNG")
    frame.unlink(missing_ok=True)
    return out_path
