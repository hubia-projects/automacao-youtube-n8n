"""Legendas ASS a partir dos word timestamps (ARCHITECTURE §8).

Linhas ≤42 chars, 1-2 linhas, quebra preferida em pausa. Ficheiro .ass
sempre gerado; burn-in é decisão do render (config).
"""

from __future__ import annotations

from pathlib import Path

MAX_CHARS = 42
MAX_CUE_S = 4.0
MIN_CUE_S = 1.0

_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00101010,&H88000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _ts(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int(seconds % 3600 // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _build_cues(words: list[dict]) -> list[tuple[float, float, str]]:
    cues: list[tuple[float, float, str]] = []
    cur_words: list[dict] = []

    def flush():
        if not cur_words:
            return
        text = " ".join(w["word"] for w in cur_words).strip()
        start, end = cur_words[0]["start"], cur_words[-1]["end"]
        cues.append((start, max(end, start + MIN_CUE_S), text))
        cur_words.clear()

    for w in words:
        tentative = " ".join(x["word"] for x in cur_words) + " " + w["word"]
        if (len(tentative.strip()) > MAX_CHARS
                or (cur_words and (w["end"] - cur_words[0]["start"]) > MAX_CUE_S)):
            flush()
        cur_words.append(w)
    flush()
    return cues


def build_srt(words: list[dict], out_path: Path) -> Path:
    def ts(s: float) -> str:
        h, m = int(s // 3600), int(s % 3600 // 60)
        return f"{h:02d}:{m:02d}:{int(s % 60):02d},{int(s * 1000 % 1000):03d}"

    cues = _build_cues(words)
    blocks = []
    for i, (start, end, text) in enumerate(cues, 1):
        if i < len(cues):
            end = min(end, cues[i][0] - 0.01)
        blocks.append(f"{i}\n{ts(start)} --> {ts(end)}\n{text}\n")
    out_path.write_text("\n".join(blocks), "utf-8")
    return out_path


def build_ass(words: list[dict], out_path: Path) -> Path:
    cues: list[tuple[float, float, str]] = []
    cur_words: list[dict] = []

    def flush():
        if not cur_words:
            return
        text = " ".join(w["word"] for w in cur_words).strip()
        start, end = cur_words[0]["start"], cur_words[-1]["end"]
        end = max(end, start + MIN_CUE_S)
        cues.append((start, end, text))
        cur_words.clear()

    for w in words:
        tentative = " ".join(x["word"] for x in cur_words) + " " + w["word"]
        too_long = len(tentative.strip()) > MAX_CHARS
        too_slow = cur_words and (w["end"] - cur_words[0]["start"]) > MAX_CUE_S
        if too_long or too_slow:
            flush()
        cur_words.append(w)
    flush()

    # evitar sobreposição entre cues consecutivos
    lines = []
    for i, (start, end, text) in enumerate(cues):
        if i + 1 < len(cues):
            end = min(end, cues[i + 1][0] - 0.01)
        text = text.replace("{", "").replace("}", "")
        lines.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Default,,0,0,0,,{text}")

    out_path.write_text(_HEADER + "\n".join(lines) + "\n", "utf-8")
    return out_path
