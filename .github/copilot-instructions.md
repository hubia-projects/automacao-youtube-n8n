# Regras permanentes do editor automático de vídeo
> ⚠️ **Telegram desactivado desde 2026-08-10** — ver `studio/OPERATIONS.md` §TEMPORARILY OFF (use `STUDIO_AUTO_APPROVE_GATES=true` para approves automáticos).


## Regra principal
Nunca confiar apenas em `state`, metadata, query ou `render_timeline.clips` para aprovar vídeo.
Frame final renderizado é a fonte de verdade visual.

## Fluxo canônico
Workflow 1 -> Workflow 2 -> Workflow 3 -> QA visual real -> revisão humana -> upload.

## QA visual
Separar sempre:
- metadata_boundary_status
- visual_frame_boundary_status
- final_hard_boundary_status

Status final = pior status.

## Hard boundary
- Sem crossing de boundary.
- Primeiro clip após boundary deve pertencer ao novo bloco.
- Neutral fallback proibido no primeiro slot.
- max visual lag 0.5s.
- overlay chapter no início do bloco.

## Frames obrigatórios
Gerar evidência com frames:
- a cada 5s
- em cada boundary
- boundary + 0.1s, +0.5s, +1.0s
- início de overlay
- meio de bloco
- meio de clip principal

Gerar sempre:
- `pipeline/test_reports/<video_id>-contact-sheet.jpg`
- `pipeline/test_reports/<video_id>-visual-audit.json`

## Overlay
Se `state.overlays` existe mas não aparece no frame real:
- issue: `overlay_not_rendered`
- severity: high
- não aprovar automaticamente.

## Resolução
Sempre conferir ffprobe no arquivo final.
Se divergir de `state.output_resolution`:
- issue: `render_file_state_mismatch`
- severity: critical
- `is_publishable=false`.

## Upload gate
Upload apenas quando:
- `approved===true`
- `render_validation.is_publishable===true`
- `render_validation.final_hard_boundary_status==='pass'`
- `render_validation.needs_regeneration!==true`
- `needs_manual_review!==true`
