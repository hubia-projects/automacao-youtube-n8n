#!/usr/bin/env python3
import argparse
import json
import math
import os
import subprocess
import sys
from typing import Any, Dict, List


def safe_json(value: str) -> Dict[str, Any]:
    try:
        return json.loads(value) if value else {}
    except Exception:
        return {}


def probe_duration(input_path: str) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                input_path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return float((result.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def build_windows(duration: float, window_seconds: int, max_windows: int, asset_metadata: Dict[str, Any], scene_context: Dict[str, Any]) -> List[Dict[str, Any]]:
    duration = max(float(window_seconds), float(duration or 0))
    query = str(asset_metadata.get("semantic_text") or asset_metadata.get("query") or scene_context.get("narration_excerpt") or scene_context.get("title") or "travel footage")
    tags = []
    for source in [asset_metadata.get("provider_tags", []), scene_context.get("keywords", [])]:
        if isinstance(source, list):
            for item in source:
                if item and item not in tags:
                    tags.append(item)
    windows: List[Dict[str, Any]] = []
    step = max(1, int(window_seconds))
    cursor = 0
    while cursor < duration and len(windows) < max_windows:
        end = min(duration, cursor + window_seconds)
        windows.append(
            {
                "window_index": len(windows) + 1,
                "start_seconds": round(cursor, 3),
                "end_seconds": round(max(cursor + 1, end), 3),
                "summary": query,
                "tags": tags[:10],
                "confidence": 0.4,
                "method": "local_video_understanding_stub",
                "location": {"city": "", "country": "", "confidence": 0.0},
                "landmarks": [],
                "location_type": scene_context.get("subtheme") or "general",
                "quality": {"sharpness": 0.65, "stability": 0.65, "brightness": 0.65, "usable": True},
            }
        )
        if end >= duration:
            break
        cursor += step
    return windows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--window-seconds", type=int, default=8)
    parser.add_argument("--max-windows", type=int, default=20)
    parser.add_argument("--mode", default="frames")
    parser.add_argument("--asset-metadata", default="{}")
    parser.add_argument("--scene-context", default="{}")
    args = parser.parse_args()

    asset_metadata = safe_json(args.asset_metadata)
    scene_context = safe_json(args.scene_context)
    duration = probe_duration(args.input)
    windows = build_windows(duration, args.window_seconds, args.max_windows, asset_metadata, scene_context)

    payload = {
        "analysis_provider": "local_video_understanding",
        "analysis_window_seconds": args.window_seconds,
        "analysis_summary": windows[0]["summary"] if windows else "travel footage",
        "analysis_tags": list(dict.fromkeys([tag for window in windows for tag in window.get("tags", [])]))[:16],
        "analysis_windows": windows,
        "mode": args.mode,
        "input_exists": os.path.exists(args.input),
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
