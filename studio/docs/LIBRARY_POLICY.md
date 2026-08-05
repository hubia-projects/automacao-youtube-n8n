# LIBRARY_POLICY — Fontes, Licenças e Compliance da Biblioteca

**Versão:** 1.0 · **Data:** 2026-07-12 · **Estado:** Em aprovação
Este documento é o artefacto de compliance da biblioteca de footage. O código de ingestão implementa-o **fail-closed**: asset sem registo de licença válido não entra na biblioteca. Não existe caminho de exceção no código.

---

## 1. Princípio

Todo o asset na biblioteca tem de ser **licenciável para uso comercial em vídeos monetizados de YouTube**, com prova registada. "Encontrei na Internet" não é licença. Na dúvida, o asset é rejeitado.

## 2. Fontes permitidas (allow-list)

| Fonte | Licença | Atribuição | Notas |
|---|---|---|---|
| Pexels (API) | Pexels License | Não exigida (registada mesmo assim) | Uso comercial OK; proibido revender o clip em si |
| Pixabay (API) | Pixabay Content License | Não exigida (registada mesmo assim) | Uso comercial OK |
| Wikimedia Commons | CC-BY / CC-BY-SA / CC0 / PD | **CC-BY(-SA): obrigatória** | Verificar licença por ficheiro via API; SA exige atenção (ver §4) |
| Internet Archive | PD / CC (varia por item) | Conforme item | Só itens com licença explícita legível por máquina |
| YouTube via yt-dlp | **Apenas** `creativeCommonLicense` **e** canal na allow-list manual | CC-BY: obrigatória | Dupla verificação: filtro de licença da API + canal vetado à mão |
| Watch folder (footage próprio/comprado) | `owned` / licença do vendedor | Conforme contrato | Utilizador declara origem no drop; ficheiro de sidecar exigido |
| Música | Só faixas com licença comprovada (biblioteca licenciada) | Conforme licença | Beat grids gerados localmente; a faixa em si nunca vem de scraping |

## 3. Fontes proibidas — sem exceções

- YouTube sem marca Creative Commons (a licença padrão do YouTube **não** permite download nem reutilização — violação de ToS e de direitos de autor).
- Redes sociais (Instagram, TikTok, X, Facebook) — direitos em cascata impossíveis de verificar.
- "Bancos gratuitos" sem licença explícita legível por máquina.
- Qualquer conteúdo com pessoas identificáveis em destaque sem release (risco de direitos de imagem) — o classificador de metadados marca `people_present`; shots com rostos em primeiro plano são despriorizados e nunca usados em thumbnails sem revisão humana.

## 4. Registo de licença (obrigatório por asset)

```jsonc
{
  "source": "pexels | pixabay | wikimedia | archive_org | youtube_cc | owned",
  "source_url": "https://...",
  "license": "pexels | pixabay | cc-by | cc-by-sa | cc0 | pd | owned | vendor:<nome>",
  "author": "...",
  "retrieved_at": "2026-07-12T03:00:00Z",
  "attribution_required": true,
  "attribution_text": "Video by X via Wikimedia Commons, CC-BY 4.0",
  "share_alike": false,
  "verified_by": "api | manual"
}
```

Regras mecânicas na ingestão:
1. Campo em falta → asset rejeitado, entrada no `ingest_log.jsonl` com motivo.
2. `attribution_required: true` → o texto de atribuição é **automaticamente anexado à descrição** do vídeo no YouTube (stage `s13_package` agrega as atribuições de todos os shots usados na timeline).
3. `share_alike: true` (CC-BY-SA) → asset marcado `restricted`; excluído por defeito do matching (interpretação conservadora de SA em obra composta). Só entra com override humano documentado.
4. `youtube_cc`: exige `verified_by: manual` na primeira ingestão de cada canal (canal entra na allow-list `sources/ytdlp_allowlist.yaml`).

## 5. Auditabilidade

- `ingest_log.jsonl`: linha por asset (aceite ou rejeitado, com motivo e licença).
- O `run.json` de cada vídeo lista os `shot_ref` usados → junção com a biblioteca reconstrói a proveniência completa de qualquer vídeo publicado em segundos.
- Comando `studio license-report <video_id>`: gera relatório de licenças/atribuições de um vídeo (para responder a claims).

## 6. Retenção e remoção

- Takedown/claim recebido → `studio library remove <media_sha>` marca o media como `revoked`: shots saem do índice de busca imediatamente; vídeos já publicados que o usaram ficam listados no relatório para decisão humana.
- Assets `revoked` nunca são reutilizados, mesmo se re-ingeridos (bloqueio por SHA-256).
