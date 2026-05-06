# Visual Truth Validation Report

## 1. Contradições encontradas
- Deve comparar `state.output_resolution` com `ffprobe_width/ffprobe_height` do arquivo final.
- Deve registrar hash SHA256 do render e do arquivo usado no upload.

## 2. Correções feitas
- `pipeline/src/services/syncValidator.js`
- `pipeline/src/services/assetQueryPlanner.js`
- `pipeline/reports/canonical-production-flow.md`

## 3. Contact sheet
- Caminho esperado: `pipeline/test_reports/<video_id>-contact-sheet.jpg`

## 4. Boundary visual audit
- Usar `visual_alignment.boundary_visual_audit` no `render_validation`.

## 5. Clip audit
- Usar tabela derivada de `render_timeline.clips` + classificação visual por frame.

## 6. Resolução real
- Usar `ffprobe_width`, `ffprobe_height`, `ffprobe_duration`.

## 7. Fluxo oficial único
- Workflow 1 -> Workflow 2 -> Workflow 3 -> QA visual real -> revisão -> upload.

## 8. Conclusão
- O vídeo só é aprovado se metadata e evidência visual em frame real passarem.
