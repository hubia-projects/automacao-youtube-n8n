# script/extract_entities v1

Lê o ROTEIRO abaixo e devolve APENAS JSON — `mentions` com UMA entrada por
entidade visual distinta (não duplicar menções equivalentes).

SCRIPT PT-PT/PT-BR (onde procurar entidades — NÃO inventes nada que não
esteja aqui):

```
{script}
```

CONTEXTO (research pack — pode ter factos suplementares, mas entidades
só contam se aparecem no script acima):

```
{research}
```

O que interessa:

- **Pontos de referência visuais identificáveis**: Livraria Lello, Torre
  dos Clérigos, Ponte Dom Luís I, Mosteiro dos Jerónimos, etc.
- **Comida/bebida específica**: Francesinha, Pastéis de Belém, Bacalhau
  à Brás, Vinho do Porto, etc.
- **Locais visitáveis** que mereceriam B-roll dedicado: Alfama, Ribeira,
  Bairro Alto, etc.

O que NÃO interessa (não incluir como entity):

- cidades genéricas quando o tema já é sobre elas ("Porto" é só contexto);
- referências vag tipo "as ruas", "a vista", "o rio" sem nome específico;
- tempo verbal ou conceito abstracto ("curiosidade", "memória").

Para cada mention devolve ESTES campos EXACTOS:

| campo | tipo | descrição |
|---|---|---|
| `canonical_name` | string | nome canónico da entidade ("Livraria Lello", "Francesinha") |
| `aliases` | array string | variantes no roteiro ("a Lello", "lello", "Lello Bookshop") |
| `entity_type` | string | "landmark" / "building" / "food" / "place" / "attraction" / "other_visual" |
| `mention_text` | string | excerto EXACTO onde aparece no script (verbatim). Será usado para alinhar com timestamps. |
| `context_text` | string | a frase/parágrafo em redor (até 120 chars) — para relatório |
| `narrative_importance` | float 0..1 | 0.95+ quando é a estrela do vídeo, 0.5–0.8 quando é coadjuvante, <0.5 quando é detalhe |
| `location_context` | string | cidade/região a associar ("Porto", "Lisboa", "Algarve", "" se não claro) |
| `strict_visual` | bool | true quando a narração **nomeia explicitamente** ou é visualmente identificável (landmark/comida específica). False só para contexto geográfico |

REGRA DURA: `mention_text` TEM de aparecer literalmente em `script`. Não
generizes, não parafraseies. O alignment usa esse trecho para procurar nos
word timestamps.

Devolve APENAS este JSON:

```json
{{
  "mentions": [
    {{
      "canonical_name": "...",
      "aliases": ["..."],
      "entity_type": "...",
      "mention_text": "...",
      "context_text": "...",
      "narrative_importance": 0.0,
      "location_context": "...",
      "strict_visual": true
    }}
  ]
}}
```
