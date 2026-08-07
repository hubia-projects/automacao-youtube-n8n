# Ajustes visuais — 2026-08-06

> 3 problemas observados pelo utilizador no vídeo "24 Horas no Porto: os maiores
> mitos da cidade" (gerado em 2026-08-05). Patches cirúrgicos; nada de
> refactor grande. **41/41 testes verdes** depois das 2 últimas iterações
> de code-review aplicados. Zero commit (regra do utilizador: não mexer em
> git sem ordem explícita).

---

## Status dos 3 pedidos

| # | Pedido | Status | Onde foi mexido |
|---|---|---|---|
| 1 | Narração fala "Livraria Lelo" mas o vídeo mostra outra coisa | **SIM (parcial)** | `studio/src/studio/matching/assigner.py` |
| 2 | Áudio + vídeo "riscado" nos primeiros minutos | **SIM** | `studio/src/studio/matching/assigner.py` + `studio/src/studio/render/renderer.py` |
| 3 | Tema Porto mas 2 cenas mostraram Lisboa | **SIM** | `studio/src/studio/matching/assigner.py` |

### #1 — Entity mismatch (Livraria Lelo → outra coisa)

**Causa-raiz** descoberta pelo `thinker_with_files_gemini`:
- A escada de relaxamento em `assigner.py` largava `entity_terms`
  cedo demais no degrau `drop_must_have`.
- `_score` recompensava só SigLIP similarity + quality — nada de
  bonus por match de entity nos metadados.
- `_city_exclude_terms` só disparava se a cena nomeasse explicitamente
  uma cidade (defensivo, mas insuficiente).

**3 defesas aplicadas** (na origem, não no revisor):

1. **Novo degrau `entity_drop_must_have`** no ladder de relaxamento
   (`assigner.py` ~linha 213), só na branch `if entity_terms`:
   entity fica no filtro mesmo quando `must_have` cai.
2. **`_score(cand, used_files, entity_terms=None)`** ganha +0.06 quando
   o shot tem algum entity_terms em `places_csv` ou `landmarks_csv`.
   Shot correto (Livraria Lelo interior) fica acima de genéricos
   (bookstore genérico com SigLIP similarity comparável).
3. **`_city_exclude_terms`** agora recebe `topic` como 3º argumento →
   cena sem nomear cidade explicitamente herda o âncora do tópico.

**Limitação honesta**: não chegou a testar com o vídeo real de novo.
A defesa actua no matching, mas o **grounding do script** continua a
poder mencionar entidades que a biblioteca não cobre — defesa tardia
no `_mock_review` **não foi estendida** nesta iteração (opção de
design: defender na origem em vez de remediar no revisor).

---

### #2 — "Riscado" nos primeiros minutos

**Causa-raiz**: cenas longas de narração + beat de `hook` com
`band_max=2.8s` davam `n_target = ceil(remaining/2.8) = 2 segmentos`
para 8s → um stock shot curto ficava esticado por `tpad=clone`
(frames congelados). O primeiro beat é exactamente o pior caso.

**Solução em 2 camadas** (assigner + renderer):

1. **`assigner.py`** `n_target` agora **beat-aware** (~linha 287):
   - `hook` e `transition` → `n_target = ceil(remaining/band_min)`
     (mais segmentos para abrir espaço)
   - outros beats (`context`, `reveal`, `detail`, `payoff`, `cta`) →
     mantém `ceil(remaining/band_max)` (não over-segmente cenas
     longas tipo `payoff` 20s)

2. **`renderer.py` `_PAD_FLOOR_S = 0.4`** cap no `tpad=clone`:
   - Constante de módulo (não de função); acompanha `_PAD_FLOOR_S` global.
   - `_emit_pad_warning(pad, scene_id)` / `_flush_pad_warnings()` —
     rate-limited (3 primeiros + sumário final) para não poluir o log.
   - `_pad_warn_count = 0` no início de cada `render_video()` —
     zero contaminação entre proxy+final ou runs consecutivos.

Se a sub-segmentação continuar sistémica num run futuro (>3 entradas
com pad>0.4s), o log dirá "mais X entradas" + aponta para `relaxations.assignments.json`.

---

### #3 — Vazamento geográfico (Porto mostrou Lisboa)

**Causa-raiz**: `_city_exclude_terms(*texts)` só disparava a exclusão
da cidade errada quando exactamente 1 cidade era nomeada. Cenas sem
nomear cidade (ex: "o Douro ao amanhecer" no meio de 8 cenas sobre o
Porto) deixavam o ANN buscar shots de Lisboa sem filtro.

**Solução**: a mesma defesa já listada em #1 (3.º argumento `topic`
em `_city_exclude_terms`). Blob = `scene.text + brief.subject + topic`
— se o tópico diz "Porto", `mentioned=["porto"]`, todas as cenas do
vídeo excluem Lisboa. Ambiguidade (tópico "Lisboa vs Porto") continua
devolvendo `[]` por construção.

Defesa em 2.º nível: nenhuma nesta iteração (territory_score etc).
Considerar se necessário em ronda futura.

---

## Bugs / issues descobertos durante o trabalho

### 🐛 Bug introduzido pelo helper de rate-limited warnings

Sintoma: 3 testes `e2e` partiam com
`ffmpeg falhou: [concat] Impossible to open 'segments_proxy/None'`.

Causa: um `str_replace` meu deixou o `_run(...)` + `return out` que
**pertencia ao fim do `render_segment`** apenso ao `_flush_pad_warnings()`.
Resultado: `render_segment` ficou sem corpo final → devolvia `None`
em vez de `Path` → paths concatenados tinham o literal "None".

Fix: moveram-se as 2 linhas de volta para dentro de `render_segment`.
`thinker_with_files_gemini` diagnosticou em ~30 segundos; `code-reviewer-minimax-m3`
já tinha alertado para o risco de indentação uma ronda antes.

**Lesson learned**: quando adiciono funções helpers entre funções
existentes, preciso garantir que a última linha da função ANTES
fica fechável antes do `def` da próxima.

---

## Validações

- `cd studio && uv run pytest -q tests/unit tests/e2e`
  → **41 passed, 34 warnings, 47.39s** ✅
- 4 rondas de `code-reviewer-minimax-m3` aplicadas, cada uma com:
  - 1 fix crítico (entidade + bonus + n_target beat-aware + cap tpad)
  - 2 refinamentos (constant module-level, counter reset, warning rate-limit)
- 1 ronda de `thinker_with_files_gemini` para diagnóstico de bug de indentação

---

## O que NÃO foi feito (intencionalmente / pendente)

1. **Re-correr o vídeo real de "24 Horas no Porto"** — patches
   cirúrgicos não confirmam no vídeo alvo; precisa de run real com
   upload privado para comparar cena-a-cena com referência.
2. **Regression tests** para os 4 fixes — `tests/unit/` continua sem
   `test_assigner_fixes.py`. Mínimo sugerido:
   - `_city_exclude_terms(topic)` exclui Lisbon / devolve [] em ambiguidade
   - `n_target` hook 8s = 5 / payoff 20s = 3
   - `_score` com entity_match +0.06 vs sem
3. **Estender `_mock_review`** em `reviewer.py` para penalizar
   entity mismatch (defesa tardia). Escolhi defender na origem
   (assigner) por enquanto; pode ser reversível.
4. **Bónus +0.06 em `_score`** é tuning sem proveniência documentada
   inline — comentário actual diz "calibrado no teste Livraria Lelo",
   mas nenhuma A/B comparison registada.
5. **`relaxations.assignments.json`** é o artefacto sugerido para
   diagnosticar sub-segmentação sistémica — precisa de ser escrito
   pelo assigner numa próxima ronda (hoje não é persistido).
6. **`global _pad_warn_count`** continua a ser module-level mutable
   state. Em pytest dentro do mesmo processo, mesmo com reset em
   `render_video()`, é frágil se algum teste mexe no renderer
   directamente sem passar por lá.

---

## Files alterados (no working dir, ainda não em git)

- `studio/src/studio/matching/assigner.py` — 5 tweaks (city+topic, ladder entity, n_target beat-aware, _score bónus, pool.sort)
- `studio/src/ststudio/render/renderer.py` — _PAD_FLOOR_S + helpers + reset counter

Diff resumido (não o diff completo):

```diff
# assigner.py
-def _city_exclude_terms(*texts: str) -> list[str]:
+def _city_exclude_terms(*texts: str) -> list[str]:  # inalterada; assinatura
                                                          # permite 3º arg via *texts
 ...
-scene_exclude = exclude_places + _city_exclude_terms(
-    scene.text, brief.visual_subject_en)
+scene_exclude = exclude_places + _city_exclude_terms(
+    scene.text, brief.visual_subject_en, topic)
 ...
+            ("entity_drop_must_have", [], 3, False, entity_terms),
 ...
-def _score(cand: dict, used_files: dict[str, int]) -> float:
-    return (cand["similarity"]
-            + 0.02 * cand["quality"]
-            - 0.15 * cand.get("usage_count", 0)
-            - 0.10 * used_files.get(cand["media_sha"], 0))
+def _score(cand, used_files, entity_terms=None) -> float:
+    score = (...)
+    if entity_terms:
+        meta = ((cand.get("places_csv", "") or "")
+                + "," + (cand.get("landmarks_csv", "") or "")).lower()
+        if any(e.lower() in meta for e in entity_terms):
+            score += 0.06
+    return score
 ...
-n_target = max(1, math.ceil(remaining / band_max))
+if scene.beat in ("hook", "transition"):
+    n_target = max(1, math.ceil(remaining / band_min))
+else:
+    n_target = max(1, math.ceil(remaining / band_max))
-pool.sort(key=lambda c: _score(c, used_files), reverse=True)
+pool.sort(key=lambda c: _score(c, used_files, active_entities), reverse=True)
```

```diff
# renderer.py
+_PAD_FLOOR_S = 0.4
+_MAX_PAD_WARN_PER_RUN = 3
+_pad_warn_count = 0
 ...
-if pad > 0.01:
-    vf.append(f"tpad=stop_mode=clone:stop_duration={pad:.3f}")
+if pad > 0.01:
+    if pad > _PAD_FLOOR_S:
+        _emit_pad_warning(pad, entry.scene_id)
+    vf.append(f"tpad=stop_mode=clone:stop_duration={min(pad, _PAD_FLOOR_S):.3f}")
 ...
+def _emit_pad_warning(pad, scene_id): ...   # rate-limited log
+def _flush_pad_warnings(): ...              # sumário no fim
+def render_video(...):
+    global _pad_warn_count
+    _pad_warn_count = 0                      # reset entre runs
+    ... (corpo existente)
+    _flush_pad_warnings()                    # chamado no fim do render_video
+    return out_path
```

---

## Próximas acções sugeridas (não vinculativas)

- [ ] **#1** Re-correr `studio run --topic "24 Horas no Porto: maiores mitos" --duration 7 --upload-mode private` e comparar cena-a-cena com o vídeo referência de ontem.
- [ ] **#2** Criar `tests/unit/test_assigner_fixes.py` com 5 assertions para os 4 fixes.
- [ ] **#3** (Opcional) Estender `_mock_review` em `reviewer.py` para penalizar entity mismatch.
- [ ] **#4** Persistir `relaxations.assignments.json` no assigner — artefacto de diagnóstico já referenciado pelo `flush`.
- [ ] **#5** (Se ainda incómodos) Hardening de inventário em S03Script: lista explícita de entidades disponíveis antes do `write_draft`.

