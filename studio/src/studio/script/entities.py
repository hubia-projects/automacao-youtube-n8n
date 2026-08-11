"""Extracção alinhada de entidades do roteiro + timestamps do áudio.

Substitui a heurística "o que o LLM inventa como required_entity no brief"
por um contrato explícito:

ROTEIRO  ──►  Gemini Flash (1 chamada)  ──►  EntityMention  ──►
ALINHAR ──►  words.json (Whisper)  ──►    EntitySpan (com t_in/t_out)

Decisões:
* O extractor recebe APENAS o script final (research é só contexto no prompt
  mas o modelo NUNCA inventa entidades que não estejam no texto).
* Os timestamps vêm do alinhamento DETERMINÍSTICO com o áudio — o LLM não
  pode inventar; só indica qual é a mention_text exacta, e nós mapeamos
  para o t_in/t_out via words.json.
* Mock mode: listas hardcoded por `topic` determinístico — testes
  reproduzíveis sem API.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from pydantic import BaseModel, Field

from studio.config import Settings
from studio.llm.gemini import generate

log = logging.getLogger("studio.entities")

_VALID_TYPES = ("landmark", "food", "place", "building", "attraction",
                "other_visual")


# Cidades PT-PT mencionadas pela narração viram entity_type="place" com
# strict_visual=False: servem de contexto geográfico no coverage plan mas
# NUNCA como anchor (a cena pode usar B-roll genérico compatível, sem
# precisar de footage tagged-específico).
_MOCK_CITIES = (
    "Porto", "Lisboa", "Faro", "Sintra", "Coimbra", "Braga", "Aveiro",
    "Évora", "Tavira", "Óbidos", "Monsaraz", "Mértola", "Mafra",
    "Tomar", "Cascais", "Setúbal", "Viseu", "Guimarães", "Matosinhos",
    "Ribeira", "Belém", "Alfama", "Douro", "Algarve",
)


class EntityMention(BaseModel):
    """Uma entidade visual presente no roteiro. Não inclui timestamps —
    isso é derivado deterministicamente em EntitySpan."""

    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    entity_type: str = "other_visual"
    # O trecho EXACTO do roteiro onde a entidade aparece (sem cortar).
    # Usado para alinhar com words.json.
    mention_text: str
    # O contexto (frase/parágrafo inteiro em volta) — aparece em relatórios.
    context_text: str = ""
    narrative_importance: float = 0.5  # 0..1; LLM decide em escala editorial.
    location_context: str = ""        # cidade/região associada, PT-PT
    # True quando o narrador NOMEIA explicitamente a entidade OU quando o
    # tipo é visualmente identificável (landmark, food). False para
    # menções genéricas ("a cidade", "as ruas").
    strict_visual: bool = True

    def model_post_init(self, _ctx) -> None:
        if self.entity_type not in _VALID_TYPES:
            self.entity_type = "other_visual"
        # importance clamped; tipos 0..1
        if self.narrative_importance < 0.0:
            self.narrative_importance = 0.0
        if self.narrative_importance > 1.0:
            self.narrative_importance = 1.0


class EntitySpan(BaseModel):
    """EntityMention + intervalo exacto na narração (determinístico a partir
    do áudio via words.json)."""

    entity_id: str                    # 'livraria_lello:0001' etc (slug)
    canonical_name: str
    entity_type: str
    t_in: float                       # segundos na narração
    t_out: float
    text: str                         # trecho exacto das palavras alinhadas
    aliases: list[str] = Field(default_factory=list)
    importance: float
    strict_visual: bool = True
    location_context: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# EXTRACTOR (single Flash call)
# ─────────────────────────────────────────────────────────────────────────────


_PROMPT_NAME = "extract_entities"


def _prompt(settings: Settings, name: str, **kw) -> str:
    raw = (settings.prompts_root / "script" / f"{name}.v1.md").read_text("utf-8")
    # placeholders {x} coexistem com JSON literal {{...}} nos prompts
    return raw.replace("{{", "\x00").replace("}}", "\x01").format(**kw) \
              .replace("\x00", "{").replace("\x01", "}")


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", s.lower()).strip("_")
    return s or "entity"


def _mock_extract(script_text: str, research_text: str, settings: Settings
                  ) -> tuple[list[EntityMention], float]:
    """Mock determinístico: extrai entidades a partir de regras PT-PT simples.
    Mantém a cobertura suficiente para testes sem API.
    Regras:
      - "A Francesinha" / "francesinha" → entity_type=food, strict
      - "Livraria Lello" / "Livraria Lello" → entity_type=landmark, strict
      - "Pastéis de Belém" → entity_type=food, strict
      - Menção de cidade → entity_type=place, NÃO strict (contexto geográfico)
    """
    mentions: list[EntityMention] = []
    t = script_text

    def _hit(pat_text: str, canonical: str, *, etype: str,
             aliases: list[str], importance: float = 0.8,
             strict: bool = True, loc: str = "") -> EntityMention | None:
        # encontra a primeira occurrence case-insensitive
        idx = t.lower().find(pat_text.lower())
        if idx < 0:
            return None
        # tentamos pegar um pouco de contexto em volta
        start_ctx = max(0, idx - 60)
        end_ctx = min(len(t), idx + len(pat_text) + 60)
        return EntityMention(
            canonical_name=canonical,
            aliases=aliases,
            entity_type=etype,
            mention_text=t[idx:idx + len(pat_text)],
            context_text=t[start_ctx:end_ctx].strip(),
            narrative_importance=importance,
            location_context=loc,
            strict_visual=strict,
        )

    for m in (
        _hit("Livraria Lello", "Livraria Lello", etype="landmark",
             aliases=["Lello", "LivrariaLello"], importance=0.95,
             strict=True, loc="Porto"),
        _hit("Francesinha", "Francesinha", etype="food",
             aliases=["a francesinha", "francesinha Porto"], importance=0.95,
             strict=True, loc="Porto"),
        _hit("Pastéis de Belém", "Pastéis de Belém", etype="food",
             aliases=["pasteis de belem", "pastel de belém"], importance=0.85,
             strict=True, loc="Lisboa"),
        _hit("Torre dos Clérigos", "Torre dos Clérigos", etype="landmark",
             aliases=["Clérigos", "torre dos clerigos"], importance=0.85,
             strict=True, loc="Porto"),
    ):
        if m is not None:
            mentions.append(m)

    # menção genérica de cidades PT-PT — strict_visual=False (contexto,
    # não anchor). Cobre qualquer cidade da lista _MOCK_CITIES
    # encontrada na primeira posição. Os aliases podem ser "a cidade"
    # porque a simples menção da cidade não é visualmente única.
    seen_cities = {m.canonical_name for m in mentions}
    for c in _MOCK_CITIES:
        if c in seen_cities:
            continue
        hit = _hit(c, c, etype="place", aliases=["a cidade"],
                   importance=0.4, strict=False, loc=c)
        if hit is not None:
            mentions.append(hit)
            break  # só uma menção de cidade (a que aparece primeiro)

    return mentions, 0.0


def _strip_fences(text: str) -> str:
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    return (m.group(1) if m else text).strip()


def extract_entities(script_text: str, research: str,
                     settings: Settings) -> tuple[list[EntityMention], float]:
    """Lê o script final e devolve lista de menções estruturadas.
    Em mock_mode ou se o texto é vazio, devolve lista vazia."""
    if not script_text.strip():
        return [], 0.0
    if settings.mock_mode:
        return _mock_extract(script_text, research, settings)

    prompt = _prompt(settings, _PROMPT_NAME, script=script_text,
                     research=research or "(sem research)")

    total_cost, last_err = 0.0, None
    data = None
    for temperature in (0.3, 0.0):
        text, cost = generate(prompt, settings, model=settings.model_flash,
                             json_mode=True, temperature=temperature,
                             tag="script_extract_entities")
        total_cost += cost
        try:
            data = json.loads(_strip_fences(text))
            break
        except json.JSONDecodeError as exc:
            last_err = exc
            log.warning("extract_entities JSON inválido (temp=%s): %s",
                        temperature, exc)
    if data is None:
        # fail-closed: extractor falhou ⇒ sem entidades (cenas existentes
        # continuam funcionando, só não ganham o anchor strict). Melhora a
        # diagnoses se o modelo devolve lixo em vez de cair em alucinações.
        log.warning("extract_entities JSON inválido após retry (%s) — "
                    "0 entidades", last_err)
        return [], total_cost

    raw_mentions = data.get("mentions", []) if isinstance(data, dict) else []
    out: list[EntityMention] = []
    for m in raw_mentions:
        if not isinstance(m, dict):
            continue
        if not m.get("mention_text") or not m.get("canonical_name"):
            continue
        try:
            out.append(EntityMention.model_validate(m))
        except Exception as exc:
            log.warning("extract: drop menção inválida %r — %s", m.get("canonical_name"), exc)
    log.info("extract_entities: %d menções (de %d recebidas)", len(out), len(raw_mentions))
    return out, total_cost


# ─────────────────────────────────────────────────────────────────────────────
# ALIGN (determinístico — usa words do áudio Whisper)
# ─────────────────────────────────────────────────────────────────────────────


_WORD_NORM = str.maketrans({
    "á": "a", "à": "a", "â": "a", "ã": "a", "ä": "a",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "í": "i", "ì": "i", "î": "i", "ï": "i",
    "ó": "o", "ò": "o", "ô": "o", "õ": "o", "ö": "o",
    "ú": "u", "ù": "u", "û": "u", "ü": "u",
    "ç": "c",
    "Á": "a", "À": "a", "Â": "a", "Ã": "a",
    "É": "e", "È": "e", "Ê": "e",
    "Í": "i", "Ì": "i", "Î": "i",
    "Ó": "o", "Ò": "o", "Ô": "o", "Õ": "o",
    "Ú": "u", "Ù": "u", "Û": "u",
    "Ç": "c",
})


def _norm_word(w: str) -> str:
    """lower + sem acentos + só [a-z0-9]."""
    s = w.lower().translate(_WORD_NORM)
    return re.sub(r"[^a-z0-9]", "", s)


def _norm_phrase(s: str) -> str:
    return " ".join(_norm_word(w) for w in re.split(r"\s+", s.strip()) if w)


def _find_span(phrase: str, words: list[dict]) -> tuple[float, float, str] | None:
    """Encontra a primeira janela (contígua) de N palavras em `words` cuja
    sequência normalizada casa com `phrase` normalizada.

    Devolve (t_in, t_out, texto_origem_das_palavras) ou None se não casa.
    Tolerância:
      * caixa / acentos
      * pontuação dentro e entre palavras da phrase (strip)
      * pequenas variações de tokenização (`Francesinha` vs `francesinha`)

    ANCHOR: a janela tem de bater a sequência inteira da phrase
    consecutivamente. Não há partial-match nem overlap parcial — se o
    usuario mencionou "Francesinha" e a janela candidata encontrou dentro
    de "Francesinha House", NUNCA vai alinhar (window estritamente 1-ou-N
    tokens não contém-nos).
    """
    target = _norm_phrase(phrase)
    if not target:
        return None
    n = len(target.split())
    if n == 0:
        return None

    valid = [w for w in words if "word" in w and "start" in w and "end" in w]
    if not valid:
        return None

    for i in range(len(valid) - n + 1):
        chunk = valid[i: i + n]
        cand = " ".join(_norm_word(c["word"]) for c in chunk)
        if cand == target:
            t_in = chunk[0]["start"]
            t_out = chunk[-1]["end"]
            src_text = " ".join(c["word"].strip() for c in chunk)
            return (t_in, t_out, src_text)
    return None


def _try_phrases(phrases: list[str], words: list[dict]) -> tuple[float, float, str, str] | None:
    """Tenta alinhar uma lista de phrases (canonical primeiro, aliases depois)
    à primeira janela em `words`. Devolve (t_in, t_out, src_text, matched_phrase)
    ou None se NENHUMA bate. Code-reviewer item A."""

    match_by_length = None  # (t_in, t_out, src_text, phrase, length) — preferido longer
    for phrase in phrases:
        hit = _find_span(phrase, words)
        if hit is None:
            continue
        t_in, t_out, src_text = hit
        # Preferência: span mais comprido bate match mais rico (`Livraria Lello`
        # ganha sobre `Lello` se ambos casarem); util quando o LLM devolveu
        # alias como canonical e vice-versa.
        if match_by_length is None or (t_out - t_in) > (match_by_length[1] - match_by_length[0]):
            match_by_length = (t_in, t_out, src_text, phrase)
    if match_by_length is None:
        return None
    return match_by_length[0], match_by_length[1], match_by_length[2], match_by_length[3]



def align_timestamps(mentions: list[EntityMention],
                     words: list[dict]) -> list[EntitySpan]:
    """Para cada EntityMention, encontra o início/fim exactos na narração.
    Algoritmo DETERMINÍSTICO (sem LLM). Se não houver match, a menção é
    DESCARTADA — não inventamos timestamps. Caller pode usar o que sobrou."""
    if not words:
        return []
    if not mentions:
        return []

    # Pre-filtrar mentions SEM phrases válidas (mention_text+aliases todos
    # vazios/whitespace-only). Code-reviewer (A)+(B): alinhar 1 phrase vazia
    # dá sempre None silenciosamente — pré-filtrar evita spurious logs.
    valid_only: list[EntityMention] = []
    for m in mentions:
        if any(p and p.strip() for p in [m.mention_text] + (m.aliases or [])):
            valid_only.append(m)
        else:
            log.warning("align_timestamps: '%s' drop — mention_text+aliases vazios",
                        m.canonical_name)

    # (D) dedupe in-place por canonical_name normalizado: 2 menções com
    # mesma canonical viram UMA entrada (a de maior importance); evita
    # spans duplicadas no coverage_plan posterior. Como já filtrámos
    # vazias, empate em importance favorece prev mas ambas têm texto válido.
    canonical_seen: dict[str, EntityMention] = {}
    for m in valid_only:
        key = m.canonical_name.strip().lower()
        prev = canonical_seen.get(key)
        if prev is None or m.narrative_importance > prev.narrative_importance:
            canonical_seen[key] = m
    mentions = list(canonical_seen.values())  # deduped
    out: list[EntitySpan] = []
    seen_keys: set[tuple[str, float]] = set()
    for idx, m in enumerate(mentions):
        # Filtra phrases vazias/whitespace-only ANTES de tentar alinhar —
        # Code-reviewer (A)+(B): sem isto drop silencioso + log misleading.
        phrases = [p for p in [m.mention_text] + (m.aliases or [])
                   if p and p.strip()]
        if not phrases:
            log.warning("align_timestamps: '%s' tem mention_text e aliases todos vazios — drop",
                        m.canonical_name)
            continue
        hit = _try_phrases(phrases, words)
        if hit is None:
            log.warning("align_timestamps: '%s' sem match em words "
                        "(%d palavras; tentei %d phrases) — drop",
                        m.canonical_name, len(words), len(phrases))
            continue
        t_in, t_out, src_text, matched_phrase = hit
        if matched_phrase != m.mention_text:
            log.info("align_timestamps: '%s' matchou via alias '%s' "
                     "(canonical '%s' não bateu).",
                     m.canonical_name, matched_phrase, m.mention_text)
        # dedupe (mesma janela é tratada como um único span)
        key = (m.canonical_name.lower(), round(t_in, 3))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        out.append(EntitySpan(
            entity_id=f"{_slug(m.canonical_name)}:{len(out):04d}",
            canonical_name=m.canonical_name,
            entity_type=m.entity_type,
            t_in=round(t_in, 3), t_out=round(t_out, 3),
            text=src_text,
            aliases=m.aliases,
            importance=m.narrative_importance,
            strict_visual=m.strict_visual,
            location_context=m.location_context,
        ))
    log.info("align_timestamps: %d/%d entidades alinhadas a janelas de áudio",
             len(out), len(mentions))
    return out


def write_artifacts(out_dir: Path, mentions: list[EntityMention],
                    spans: list[EntitySpan]) -> tuple[Path, Path]:
    """Escreve os artefactos pedidos na Fase A. Caller passa out_dir=
    06_scenes/ (que é onde o nosso pipeline os espera)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    p_mentions = out_dir / "entity_mentions.json"
    p_spans = out_dir / "entity_spans.json"
    p_mentions.write_text(json.dumps(
        {"mentions": [m.model_dump() for m in mentions]},
        ensure_ascii=False, indent=2), "utf-8")
    p_spans.write_text(json.dumps(
        {"spans": [s.model_dump() for s in spans]},
        ensure_ascii=False, indent=2), "utf-8")
    return p_mentions, p_spans
