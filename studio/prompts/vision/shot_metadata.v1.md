# vision/shot_metadata v1

You are indexing stock footage for a travel/gastronomy YouTube channel.
You will receive N keyframes sampled from ONE video shot (start → end).
Describe what the SHOT actually shows — never guess beyond visual evidence.

Return ONLY a JSON object with exactly these fields:

```json
{
  "summary": "one factual sentence describing the shot, in English",
  "places": ["city or region ONLY if visually identifiable, else empty"],
  "landmarks": ["named monuments/buildings ONLY if clearly recognizable"],
  "food_items": ["specific dishes/foods visible, in English"],
  "objects": ["3-8 salient objects"],
  "ocr_text": "any readable text in the frames, else empty string",
  "shot_type": "aerial|wide|medium|close-up|macro|pov",
  "camera_motion": "static|pan|tilt|zoom|handheld|tracking",
  "time_of_day": "day|golden-hour|night|indoor-unclear",
  "indoor_outdoor": "indoor|outdoor",
  "people_present": true,
  "quality": 7,
  "defects": ["blur|overexposed|watermark|shaky|low-light", "…or empty"]
}
```

Rules:
- `quality` 0-10: technical + aesthetic usability for a professional video.
- Empty arrays are correct when nothing qualifies. Do NOT invent landmarks.
- If frames show a watermark or logo overlay, add "watermark" to defects.
- English only. JSON only — no prose, no markdown fences.
