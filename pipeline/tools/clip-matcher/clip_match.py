#!/usr/bin/env python3
"""
M1 — CLIP image-text cosine similarity scorer.
Usage: python3 clip_match.py --text "Lisboa tram street" --image-path /path/to/frame.jpg
Output: JSON to stdout: {"score": 0.87, "method": "clip_cosine"}
"""
import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="CLIP image-text similarity")
    parser.add_argument("--text", required=True, help="Narration text to match")
    parser.add_argument("--image-path", required=True, dest="image_path", help="Path to image file")
    parser.add_argument("--model", default="openai/clip-vit-base-patch32", help="HuggingFace CLIP model ID")
    args = parser.parse_args()

    if not os.path.exists(args.image_path):
        sys.stdout.write(json.dumps({"score": 0.0, "method": "clip_cosine", "error": "image_not_found"}))
        return 0

    if not args.text or not args.text.strip():
        sys.stdout.write(json.dumps({"score": 0.0, "method": "clip_cosine", "error": "empty_text"}))
        return 0

    try:
        from transformers import CLIPProcessor, CLIPModel
        from PIL import Image
        import torch

        model = CLIPModel.from_pretrained(args.model)
        processor = CLIPProcessor.from_pretrained(args.model)
        model.eval()

        image = Image.open(args.image_path).convert("RGB")
        text_input = args.text[:300]  # CLIP token limit safety
        inputs = processor(
            text=[text_input],
            images=image,
            return_tensors="pt",
            padding=True,
            truncation=True,
        )

        with torch.no_grad():
            outputs = model(**inputs)
            text_emb = outputs.text_embeds / outputs.text_embeds.norm(dim=-1, keepdim=True)
            img_emb = outputs.image_embeds / outputs.image_embeds.norm(dim=-1, keepdim=True)
            score = float((text_emb * img_emb).sum().item())

        sys.stdout.write(json.dumps({"score": round(score, 4), "method": "clip_cosine"}))
    except ImportError as e:
        sys.stdout.write(json.dumps({"score": 0.0, "method": "clip_cosine", "error": f"import_error: {e}"}))
    except Exception as e:
        sys.stdout.write(json.dumps({"score": 0.0, "method": "clip_cosine", "error": str(e)[:200]}))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
