# Canonical Production Flow

Fluxo oficial de produção:

1. Workflow 1 (n8n): ideias, aprovação, roteiro.
2. Workflow 2 (n8n): áudio, captions, assets.
3. Workflow 3 (n8n): render, QA, revisão humana, upload.
4. QA visual real obrigatório em `syncValidator.validateRender` antes de upload.

## Scripts de teste (não oficiais para produção)
- `pipeline/tests/*` (inclui cenários de regressão e mocks).
- `complete-flow-test.js` e `final-validation-flow-test.js` são testes de validação; não substituem o fluxo oficial via n8n.

## Bypass audit
- Qualquer caminho que invoque upload sem `render_validation.is_publishable=true` + `hard_boundary_status=pass` deve ser considerado inválido.
- Upload real é executado por `pipeline/src/services/youtubeService.js` via rota `/api/videos/youtube/upload`.

## Resolução e QA
- O QA agora usa ffprobe do arquivo real renderizado.
- Se `state.output_resolution` divergir do arquivo final, o vídeo é bloqueado.
