#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account
from urllib import error as urllib_error
from urllib import request as urllib_request


FRAME_COUNT = 3
FRAME_TIMEOUT_SECONDS = 15
DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
PROMPT = (
    "Analyze this video frame and return ONLY a valid JSON object with this exact schema:\n"
    "{\n"
    '"summary": "one sentence describing the scene",\n'
    '"confidence": 0.0-1.0 based on image clarity,\n'
    '"visual_intent": one of [generic, specific, landmark, gastronomy, nature, urban, people],\n'
    '"location": {\n'
    '"city": "city name or empty string",\n'
    '"country": "country name or empty string",\n'
    '"confidence": 0.0-1.0\n'
    "},\n"
    '"quality": {\n'
    '"sharpness": 0.0-1.0,\n'
    '"brightness": 0.0-1.0\n'
    "},\n"
    '"tags": ["tag1", "tag2", "tag3"]\n'
    "}\n"
    "Return ONLY the JSON. No markdown, no explanation."
)
ALLOWED_VISUAL_INTENTS = {"generic", "specific", "landmark", "gastronomy", "nature", "urban", "people"}
SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_ROOT = SCRIPT_DIR.parent.parent
IS_WINDOWS = os.name == "nt"


def get_linux_arch_name() -> str:
    machine = os.uname().machine.lower()
    mapping = {
        "x86_64": "x64",
        "amd64": "x64",
        "i386": "ia32",
        "i686": "ia32",
        "aarch64": "arm64",
        "arm64": "arm64",
        "armv7l": "arm",
        "armv6l": "arm",
    }
    return mapping.get(machine, machine)


def resolve_binary_path(binary_name: str, env_var_name: str, extra_candidates=None) -> str:
    explicit_path = str(os.environ.get(env_var_name) or "").strip()
    if explicit_path and os.path.exists(explicit_path):
        return explicit_path

    system_binary = shutil.which(binary_name)
    if system_binary:
        return system_binary

    for candidate in extra_candidates or []:
        candidate_path = str(candidate or "").strip()
        if candidate_path and os.path.exists(candidate_path):
            return candidate_path

    return binary_name


def build_gemini_model_candidates():
    models = []
    for value in [
        os.environ.get("GEMINI_VISION_MODEL_LITE"),
        os.environ.get("GEMINI_VISION_MODEL_FULL"),
        os.environ.get("GEMINI_TEXT_MODEL"),
        os.environ.get("GEMINI_IMAGE_MODEL"),
        *DEFAULT_GEMINI_MODELS,
    ]:
        model_name = str(value or "").strip()
        if model_name and model_name not in models:
            models.append(model_name)
    return models


def has_vertex_config() -> bool:
    credentials_path = str(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    project = str(os.environ.get("GOOGLE_CLOUD_PROJECT") or "").strip()
    location = str(os.environ.get("GOOGLE_CLOUD_LOCATION") or "").strip()
    return bool(credentials_path and os.path.exists(credentials_path) and project and location)


def get_vertex_access_token() -> str:
    credentials_path = str(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    credentials = service_account.Credentials.from_service_account_file(
        credentials_path,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    credentials.refresh(GoogleAuthRequest())
    token = str(credentials.token or "").strip()
    if not token:
        raise RuntimeError("Nao foi possivel obter access token do Vertex AI")
    return token


def call_vertex_gemini_vision(frame_path: str):
    project = str(os.environ.get("GOOGLE_CLOUD_PROJECT") or "").strip()
    location = str(os.environ.get("GOOGLE_CLOUD_LOCATION") or "").strip() or "us-central1"
    access_token = get_vertex_access_token()

    with open(frame_path, "rb") as frame_file:
        encoded_image = base64.b64encode(frame_file.read()).decode("ascii")

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": PROMPT},
                    {
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": encoded_image,
                        }
                    },
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }

    last_error = None
    for model_name in build_gemini_model_candidates():
        request = urllib_request.Request(
            f"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model_name}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {access_token}",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=FRAME_TIMEOUT_SECONDS) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
            candidate_text = extract_candidate_text(response_payload)
            parsed = parse_json_text(candidate_text)
            if not isinstance(parsed, dict):
                raise RuntimeError(f"Vertex model {model_name} returned invalid JSON for frame analysis")
            return parsed
        except urllib_error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(body or str(error))
            continue
        except Exception as error:
            last_error = RuntimeError(str(error))
            continue

    raise last_error or RuntimeError("Nenhum modelo Vertex respondeu com sucesso para frame analysis")


FFPROBE_BIN = resolve_binary_path(
    binary_name="ffprobe",
    env_var_name="FFPROBE_BIN",
    extra_candidates=[
        PIPELINE_ROOT / "node_modules" / "ffprobe-static" / "bin" / "linux" / get_linux_arch_name() / "ffprobe",
    ],
)

FFMPEG_BIN = resolve_binary_path(
    binary_name="ffmpeg",
    env_var_name="FFMPEG_BIN",
    extra_candidates=[
        PIPELINE_ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg",
        PIPELINE_ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe" if IS_WINDOWS else "",
    ],
)


def log_progress(message: str) -> None:
    sys.stderr.write(f"[BUG01] {message}\n")
    sys.stderr.flush()


def log_error(message: str) -> None:
    sys.stderr.write(f"[BUG01] Erro: {message}\n")
    sys.stderr.flush()


def safe_json(value: str):
    try:
        return json.loads(value) if value else {}
    except Exception:
        return {}


def clamp(value, minimum=0.0, maximum=1.0) -> float:
    numeric = float(value or 0.0)
    if numeric < minimum:
        return minimum
    if numeric > maximum:
        return maximum
    return numeric


def round3(value: float) -> float:
    return round(float(value or 0.0), 3)


def unique(values):
    seen = []
    for item in values or []:
        token = str(item or "").strip()
        if token and token not in seen:
            seen.append(token)
    return seen


def probe_duration(input_path: str) -> float:
    try:
        result = subprocess.run(
            [
                FFPROBE_BIN,
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


def build_time_windows(duration: float, window_seconds: int, max_windows: int):
    safe_window_seconds = max(1, int(window_seconds or 8))
    safe_duration = max(float(safe_window_seconds), float(duration or 0.0))
    windows = []
    cursor = 0.0

    while cursor < safe_duration and len(windows) < max(1, int(max_windows or FRAME_COUNT)):
        end = min(safe_duration, cursor + safe_window_seconds)
        windows.append(
            {
                "window_index": len(windows) + 1,
                "start_seconds": round3(cursor),
                "end_seconds": round3(max(cursor + 1.0, end)),
            }
        )
        if end >= safe_duration:
            break
        cursor += float(safe_window_seconds)

    return windows


def build_sample_timestamps(duration: float):
    safe_duration = max(float(duration or 0.0), 0.0)
    if safe_duration <= 0.0:
        return [0.0, 0.5, 1.0]

    upper_bound = max(0.0, safe_duration - 0.05)
    raw_points = [safe_duration * 0.1, safe_duration * 0.5, safe_duration * 0.9]
    timestamps = []
    for point in raw_points:
        adjusted = min(max(0.0, point), upper_bound)
        if timestamps and adjusted <= timestamps[-1]:
            adjusted = min(upper_bound, timestamps[-1] + 0.05)
        timestamps.append(round3(adjusted))

    return timestamps[:FRAME_COUNT]


def get_frame_output_path(input_path: str, timestamp: float, frame_index: int) -> str:
    cache_key = hashlib.sha256(f"{input_path}:{timestamp}:{frame_index}".encode("utf-8")).hexdigest()
    cache_dir = "/tmp/frame_analysis_cache"
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, f"{cache_key}.jpg")


def extract_frame(input_path: str, timestamp: float, frame_index: int) -> str:
    output_path = get_frame_output_path(input_path, timestamp, frame_index)
    command = [
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{timestamp:.3f}",
        "-i",
        input_path,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        output_path,
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(output_path):
        raise RuntimeError((result.stderr or result.stdout or "ffmpeg frame extraction failed").strip())
    return output_path


def extract_candidate_text(response_payload):
    candidates = response_payload.get("candidates", []) if isinstance(response_payload, dict) else []
    parts = []
    for candidate in candidates:
        for part in (candidate.get("content") or {}).get("parts", []):
            text = str(part.get("text") or "").strip()
            if text:
                parts.append(text)
    return "\n".join(parts).strip()


def parse_json_text(raw_text: str):
    text = str(raw_text or "").strip()
    if not text:
        return None

    try:
        return json.loads(text)
    except Exception:
        first_brace = text.find("{")
        last_brace = text.rfind("}")
        if first_brace >= 0 and last_brace > first_brace:
            try:
                return json.loads(text[first_brace:last_brace + 1])
            except Exception:
                return None
    return None


def call_gemini_vision(api_key: str, frame_path: str):
    with open(frame_path, "rb") as frame_file:
        encoded_image = base64.b64encode(frame_file.read()).decode("ascii")

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": PROMPT},
                    {
                        "inline_data": {
                            "mime_type": "image/jpeg",
                            "data": encoded_image,
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }
    last_error = None
    ai_studio_errors = []

    for model_name in build_gemini_model_candidates():
        request = urllib_request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib_request.urlopen(request, timeout=FRAME_TIMEOUT_SECONDS) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
            candidate_text = extract_candidate_text(response_payload)
            parsed = parse_json_text(candidate_text)
            if not isinstance(parsed, dict):
                raise RuntimeError(f"Gemini model {model_name} returned invalid JSON for frame analysis")
            return parsed
        except urllib_error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(body or str(error))
            ai_studio_errors.append(f"{model_name}: {body or str(error)}")
            continue
        except Exception as error:
            last_error = RuntimeError(str(error))
            ai_studio_errors.append(f"{model_name}: {str(error)}")
            continue

    if has_vertex_config():
        log_progress("AI Studio indisponivel, tentando Vertex AI")
        try:
            return call_vertex_gemini_vision(frame_path)
        except Exception as error:
            last_error = RuntimeError(f"AI Studio e Vertex falharam. AI Studio: {' | '.join(ai_studio_errors[:3])} | Vertex: {error}")

    raise last_error or RuntimeError("Nenhum modelo Gemini respondeu com sucesso para frame analysis")


def normalize_frame_analysis(frame_payload):
    if not isinstance(frame_payload, dict):
        raise RuntimeError("Gemini frame payload is not a JSON object")

    summary = str(frame_payload.get("summary") or "").strip()
    visual_intent = str(frame_payload.get("visual_intent") or "").strip().lower()
    location_payload = frame_payload.get("location") or {}
    quality_payload = frame_payload.get("quality") or {}
    raw_tags = frame_payload.get("tags") or []
    tags = unique(raw_tags if isinstance(raw_tags, list) else [])[:12]

    if not summary:
        raise RuntimeError("Gemini frame payload missing summary")
    if visual_intent not in ALLOWED_VISUAL_INTENTS:
        raise RuntimeError("Gemini frame payload missing valid visual_intent")
    if not isinstance(location_payload, dict):
        raise RuntimeError("Gemini frame payload missing location object")
    if not isinstance(quality_payload, dict):
        raise RuntimeError("Gemini frame payload missing quality object")

    return {
        "summary": summary,
        "confidence": clamp(frame_payload.get("confidence"), 0.0, 1.0),
        "visual_intent": visual_intent,
        "location": {
            "city": str(location_payload.get("city") or "").strip(),
            "country": str(location_payload.get("country") or "").strip(),
            "confidence": clamp(location_payload.get("confidence"), 0.0, 1.0),
        },
        "quality": {
            "sharpness": clamp(quality_payload.get("sharpness"), 0.0, 1.0),
            "brightness": clamp(quality_payload.get("brightness"), 0.0, 1.0),
        },
        "tags": tags,
    }


def build_consolidated_analysis(frame_results):
    if not frame_results:
        return {
            "summary": "analysis_failed",
            "confidence": 0.0,
            "visual_intent": "generic",
            "location": {"city": "", "country": "", "confidence": 0.0},
            "quality": {"sharpness": 0.0, "brightness": 0.0},
            "tags": [],
        }

    best_summary = max(frame_results, key=lambda item: item["analysis"]["confidence"])
    best_location = max(frame_results, key=lambda item: item["analysis"]["location"]["confidence"])

    average_confidence = sum(item["analysis"]["confidence"] for item in frame_results) / float(len(frame_results))
    average_sharpness = sum(item["analysis"]["quality"]["sharpness"] for item in frame_results) / float(len(frame_results))
    average_brightness = sum(item["analysis"]["quality"]["brightness"] for item in frame_results) / float(len(frame_results))
    tags = unique(tag for item in frame_results for tag in item["analysis"]["tags"])[:16]

    return {
        "summary": best_summary["analysis"]["summary"],
        "confidence": round(clamp(average_confidence), 4),
        "visual_intent": best_summary["analysis"]["visual_intent"],
        "location": best_location["analysis"]["location"],
        "quality": {
            "sharpness": round(clamp(average_sharpness), 4),
            "brightness": round(clamp(average_brightness), 4),
        },
        "tags": tags,
    }


def build_windows_from_frames(duration: float, window_seconds: int, max_windows: int, frame_results, scene_context, provider: str):
    time_windows = build_time_windows(duration, window_seconds, max_windows)
    if not frame_results:
        return []

    windows = []
    for window in time_windows:
        midpoint = (window["start_seconds"] + window["end_seconds"]) / 2.0
        closest = min(frame_results, key=lambda item: abs(item["timestamp"] - midpoint))
        analysis = closest["analysis"]
        windows.append(
            {
                "window_index": window["window_index"],
                "start_seconds": window["start_seconds"],
                "end_seconds": window["end_seconds"],
                "summary": analysis["summary"],
                "tags": analysis["tags"][:10],
                "confidence": analysis["confidence"],
                "method": provider,
                "visual_evidence_source": provider,
                "visual_intent": analysis["visual_intent"],
                "location": analysis["location"],
                "landmarks": [],
                "location_type": str(scene_context.get("subtheme") or analysis["visual_intent"] or "general"),
                "quality": {
                    "sharpness": analysis["quality"]["sharpness"],
                    "stability": 0.0,
                    "brightness": analysis["quality"]["brightness"],
                    "usable": analysis["confidence"] > 0.0,
                },
                "sampled_frame_seconds": closest["timestamp"],
            }
        )

    return windows


def build_error_payload(duration: float, window_seconds: int, max_windows: int, mode: str, scene_context, input_path: str):
    fallback_analysis = {
        "summary": "analysis_failed",
        "confidence": 0.0,
        "visual_intent": "generic",
        "location": {"city": "", "country": "", "confidence": 0.0},
        "quality": {"sharpness": 0.0, "brightness": 0.0},
        "tags": [],
    }
    frame_results = [{"timestamp": timestamp, "analysis": fallback_analysis} for timestamp in build_sample_timestamps(duration)]
    windows = build_windows_from_frames(duration, window_seconds, max_windows, frame_results, scene_context, "error_fallback")

    return {
        "analysis_provider": "error_fallback",
        "analysis_window_seconds": int(window_seconds or 8),
        "analysis_summary": fallback_analysis["summary"],
        "analysis_tags": fallback_analysis["tags"],
        "analysis_windows": windows,
        "summary": fallback_analysis["summary"],
        "confidence": fallback_analysis["confidence"],
        "visual_intent": fallback_analysis["visual_intent"],
        "location": fallback_analysis["location"],
        "quality": fallback_analysis["quality"],
        "tags": fallback_analysis["tags"],
        "method": "error_fallback",
        "mode": mode,
        "input_exists": os.path.exists(input_path),
    }


def analyze_frames(input_path: str, duration: float, scene_context, api_key: str):
    frame_results = []
    timestamps = build_sample_timestamps(duration)

    for frame_index, timestamp in enumerate(timestamps, start=1):
        scene_label = scene_context.get("title") or scene_context.get("block_label") or "unknown"
        log_progress(f"Analisando frame {frame_index}/{len(timestamps)} para cena {scene_label}")
        frame_path = extract_frame(input_path, timestamp, frame_index)
        frame_payload = call_gemini_vision(api_key, frame_path)
        normalized = normalize_frame_analysis(frame_payload)
        frame_results.append(
            {
                "timestamp": timestamp,
                "frame_path": frame_path,
                "analysis": normalized,
            }
        )

    return frame_results


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
    api_key = str(os.environ.get("GEMINI_API_KEY") or "").strip()

    try:
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY ausente")
        if not os.path.exists(args.input):
            raise RuntimeError(f"arquivo nao encontrado: {args.input}")

        frame_results = analyze_frames(args.input, duration, scene_context, api_key)
        consolidated = build_consolidated_analysis(frame_results)
        windows = build_windows_from_frames(
            duration=duration,
            window_seconds=args.window_seconds,
            max_windows=args.max_windows,
            frame_results=frame_results,
            scene_context=scene_context,
            provider="gemini_vision",
        )

        payload = {
            "analysis_provider": "gemini_vision",
            "analysis_window_seconds": int(args.window_seconds or 8),
            "analysis_summary": consolidated["summary"],
            "analysis_tags": consolidated["tags"],
            "analysis_windows": windows,
            "summary": consolidated["summary"],
            "confidence": consolidated["confidence"],
            "visual_intent": consolidated["visual_intent"],
            "location": consolidated["location"],
            "quality": consolidated["quality"],
            "tags": consolidated["tags"],
            "method": "gemini_vision",
            "mode": args.mode,
            "input_exists": os.path.exists(args.input),
            "sampled_frame_count": len(frame_results),
            "sampled_frame_timestamps": [item["timestamp"] for item in frame_results],
            "semantic_text": consolidated["summary"],
            "asset_metadata": {
                "query": asset_metadata.get("query", ""),
                "semantic_text": asset_metadata.get("semantic_text", ""),
            },
        }
    except Exception as error:
        log_error(str(error))
        payload = build_error_payload(
            duration=duration,
            window_seconds=args.window_seconds,
            max_windows=args.max_windows,
            mode=args.mode,
            scene_context=scene_context,
            input_path=args.input,
        )

    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
