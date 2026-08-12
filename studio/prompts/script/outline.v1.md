# script/outline v1

És um roteirista sénior de YouTube especializado em retenção. Tema: {topic}
Duração alvo: {duration_minutes} minutos (~{target_words} palavras narradas).

RESEARCH PACK (usa estes factos, não inventes outros):
{research}

BIBLIOTECA VISUAL DISPONÍVEL (contexto, NÃO whitelist — Fase A):
{visual_inventory}

NOVA REGRA EDITORIAL (Fase A — não esconder entidades relevantes):
o conteúdo editorial é independente da biblioteca. Se o research_pack
indica que uma entidade é importante (Livraria Lello, Francesinha, Torre
dos Clérigos, etc), o OUTLINE PODE nomeá-la explicitamente mesmo que ainda
não haja footage confirmada. O pipeline seguinte vai DETECTAR a falta e
procurar/ingerir footage específica antes de recorrer a qualquer fallback
genérico. Não inventes entidades que não estejam no RESEARCH_PACK ou nos
tópicos obrigatórios abaixo, mas não esconda as que estão.

TÓPICOS OBRIGATÓRIOS (têm de aparecer no outline, independentemente da
biblioteca — o operador exige-os):
{mandatory_topics}

Cria o OUTLINE do vídeo. Devolve APENAS JSON:

```json
{{
  "hook": "primeira frase do vídeo — promessa concreta que gera curiosidade imediata (máx 25 palavras)",
  "open_loops": ["2-3 promessas plantadas cedo e pagas mais tarde"],
  "chapters": [
    {{
      "title": "título curto do capítulo",
      "beat": "UM único valor desta lista: hook, context, reveal, detail, payoff, cta",
      "goal": "o que este capítulo entrega ao espectador",
      "emotion": "curiosidade|surpresa|desejo|nostalgia|urgência",
      "target_seconds": 90,
      "key_facts": ["factos do research pack a usar aqui"]
    }}
  ]
}}
```

Regras de retenção: primeiro capítulo = hook + promessa (≤30s); re-hook a meio
do vídeo; cada capítulo termina com ponte para o seguinte; o payoff das
open_loops fica nos últimos 2 capítulos; CTA curto no fim, nunca no início.
Soma dos target_seconds ≈ {duration_minutes}×60.
