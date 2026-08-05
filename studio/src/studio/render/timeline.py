"""timeline.json — o EDL, contrato central do sistema (ARCHITECTURE §5.2).

Tudo a montante produz-o; render, revisor e fixes consomem-no. Alterações ao
vídeo são sempre patches à timeline, nunca edição direta de media.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from studio.matching.assigner import SegmentAssignment

SCHEMA_VERSION = "1.0"
XFADE_S = 0.4


class Narration(BaseModel):
    t_in: float
    t_out: float
    text: str


class Transition(BaseModel):
    type: str = "cut"          # cut | xfade | dip_black | whip
    duration: float = 0.0


class KenBurns(BaseModel):
    mode: str = "none"         # none | push_in | drift_lateral
    zoom_max: float = 1.06


class TimelineEntry(BaseModel):
    scene_id: str
    beat: str
    narration: Narration
    shot_ref: str
    media_path: str
    source: dict               # {"in_s": float, "out_s": float}
    transition_in: Transition = Field(default_factory=Transition)
    kenburns: KenBurns = Field(default_factory=KenBurns)
    overlay: dict | None = None
    attribution_text: str = ""


class Timeline(BaseModel):
    schema_version: str = SCHEMA_VERSION
    video_id: str
    audio: dict                # {"narration": path, "music_track": path|None}
    entries: list[TimelineEntry]


def _kenburns_for(seg: SegmentAssignment) -> KenBurns:
    # push-in em close-ups estáticos; nada quando o shot já tem movimento
    if seg.camera_motion not in ("", "static"):
        return KenBurns(mode="none")
    if seg.shot_type in ("close-up", "macro"):
        return KenBurns(mode="push_in", zoom_max=1.06)
    if seg.shot_type in ("wide", "aerial"):
        return KenBurns(mode="drift_lateral", zoom_max=1.04)
    return KenBurns(mode="none")


def build_timeline(video_id: str, narration_path: str,
                   segments: list[SegmentAssignment],
                   scene_texts: dict[str, str],
                   music_track: str | None = None) -> Timeline:
    entries: list[TimelineEntry] = []
    prev_scene = None
    for seg in sorted(segments, key=lambda s: (s.t_in, s.seg_index)):
        # taxonomia com disciplina: corte seco por defeito; xfade só na
        # mudança de cena/capítulo (ARCHITECTURE §8)
        transition = Transition()
        if prev_scene is not None and seg.scene_id != prev_scene and seg.seg_index == 0:
            transition = Transition(type="xfade", duration=XFADE_S)
        entries.append(TimelineEntry(
            scene_id=seg.scene_id, beat=seg.beat,
            narration=Narration(t_in=seg.t_in, t_out=seg.t_out,
                                text=scene_texts.get(seg.scene_id, "")),
            shot_ref=seg.shot_id, media_path=seg.media_path,
            source={"in_s": seg.source_in, "out_s": seg.source_out},
            transition_in=transition,
            kenburns=_kenburns_for(seg),
            attribution_text=seg.attribution_text,
        ))
        prev_scene = seg.scene_id
    return Timeline(video_id=video_id,
                    audio={"narration": narration_path, "music_track": music_track},
                    entries=entries)
