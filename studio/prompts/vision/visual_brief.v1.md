# vision/visual_brief v1

You are a footage director for a travel/gastronomy YouTube video.
For EACH narration scene below (PT-BR), write a visual brief describing what
the footage MUST show while that narration plays.

Scenes:
{scenes}

Return ONLY a JSON array, one object per scene, same order:

```json
[
  {
    "scene_id": "s000",
    "visual_subject_en": "specific visual description IN ENGLISH for stock search, e.g. 'close-up of pastel de nata custard tart on a cafe table'",
    "must_have": [],
    "must_not": [],
    "shot_type_pref": "close-up",
    "mood": "warm",
    "required_entity": "Livraria Lello"
  }
]
```

Rules:
- `visual_subject_en`: ALWAYS in English. Concrete and visual — what the
  viewer literally sees, never abstract ("tradition", "history" are banned).
- `must_have` / `must_not`: subset of ["food", "landmark", "people"].
  If the narration is about food/eating → must_have ["food"], must_not ["landmark"].
  If about a monument/building → must_have ["landmark"], must_not ["food"].
  Otherwise leave both empty.
- `shot_type_pref`: one of aerial, wide, medium, close-up, macro, pov.
- `required_entity`: ONLY when the narration explicitly names a specific
  landmark, building or dish that MUST appear on screen (e.g. "Livraria
  Lello", "Dom Luís I Bridge", "Francesinha", "pastel de nata"). Use the
  common English/international name. If the narration is generic, use "".
- JSON only, no markdown fences, no prose.
