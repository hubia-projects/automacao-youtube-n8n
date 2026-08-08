"""Roteiro multi-pass (ARCHITECTURE.md §1.6) — Fase 2 consolidada.

research (Flash+grounding) → outline+draft merged (Flash 1.5, 1 call) →
critique+revisão (Pro) → humanize (GPT-4o) → lint determinístico.

Fase 2: as 2 chamadas Pro (build_outline + write_draft) foram consolidadas em
UMA única chamada Flash (build_mega_script). Heurísticas de fallback para
Pro multi-pass quando:
  1. JSON inválido (Flash escapou mal aspas em prosa longa).
  2. Draft com <80% de target_words (Flash apressou-se).
  3. Pydantic validation erro em Outline (schema violado).

Mock mode: textos canned determinísticos — pipeline corre sem APIs.
"""

from __future__ import annotations

import json
import logging
import re

from pydantic import BaseModel, Field

from studio.config import Settings
from studio.llm.gemini import generate
from studio.llm.openai import chat

log = logging.getLogger("studio.writer")

_VALID_BEATS = {"hook", "context", "reveal", "detail", "transition", "payoff", "cta"}

# Fase 2: limiar mínimo de qualidade do draft Flash. Se <80% do target,
# fallback para Pro multi-pass (qualidade mais alta, compensa遅い).
_MEGA_MIN_WORD_RATIO = 0.80


# Fase 2: métricas em-memória de sucesso vs fallback para auditoria pós-deploy.
# Lidos por /studio status / dashboards. Reset por run em set_sprint_metrics().
_mega_total_success = 0
_mega_total_fallback = 0


def get_mega_metrics() -> tuple[int, int]:
    """(success_count, fallback_count) para observability do Sprint Optimização."""
    return _mega_total_success, _mega_total_fallback


def reset_mega_metrics() -> None:
    """Reset dos counters (chamado pelo orchestrator no início de cada run)."""
    global _mega_total_success, _mega_total_fallback
    _mega_total_success = 0
    _mega_total_fallback = 0


class Chapter(BaseModel):
    title: str
    beat: str = "detail"
    goal: str = ""
    emotion: str = ""
    target_seconds: int = 60
    key_facts: list[str] = Field(default_factory=list)

    def model_post_init(self, _ctx) -> None:
        # LLMs por vezes devolvem "hook|context" (cópia do formato) — normalizar
        first = self.beat.split("|")[0].strip().lower()
        self.beat = first if first in _VALID_BEATS else "detail"


class Outline(BaseModel):
    hook: str
    open_loops: list[str] = Field(default_factory=list)
    chapters: list[Chapter]


def _prompt(settings: Settings, name: str, **kw) -> str:
    raw = (settings.prompts_root / "script" / f"{name}.v1.md").read_text("utf-8")
    # placeholders {x} coexistem com JSON literal {{...}} nos prompts
    return raw.replace("{{", "\x00").replace("}}", "\x01").format(**kw) \
              .replace("\x00", "{").replace("\x01", "}")


def _strip_fences(text: str) -> str:
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    return (m.group(1) if m else text).strip()


def _generate_json(prompt: str, settings: Settings, *, model: str, tag: str,
                   temperature: float) -> tuple[dict, float]:
    """generate() em json_mode com retry único a temp 0 se o JSON vier partido
    (mesma classe de falha que os briefs visuais — ver matching/briefs.py).
    Fase 2: aceita também enormous JSON (draft >5000 chars dentro do objeto).
    """
    total_cost = 0.0
    last_err: json.JSONDecodeError | None = None
    for t in (temperature, 0.0):
        text, cost = generate(prompt, settings, model=model, json_mode=True,
                              temperature=t, tag=tag)
        total_cost += cost
        try:
            return json.loads(_strip_fences(text)), total_cost
        except json.JSONDecodeError as exc:
            last_err = exc
            log.warning("%s: JSON inválido (temp=%s): %s", tag, t, exc)
    raise ValueError(f"{tag}: JSON inválido após retry: {last_err}")


# ---------------------------------------------------------------- mock canned
_MOCK_SCRIPT = (
    "Existe um pastel que fez uma cidade inteira guardar segredo por duzentos anos. "
    "Em Lisboa, atrás dos muros do Mosteiro dos Jerónimos, monges criaram uma receita "
    "que até hoje só três pessoas conhecem. Pois é: três. E o mais curioso é que você "
    "consegue provar o resultado por pouco mais de um euro. Mas antes de chegar lá, "
    "tem uma coisa que quase todo turista erra. A maioria compra o doce no lugar errado. "
    "O pastel de Belém original só existe numa única casa, aberta em 1837. O resto da "
    "cidade vende pastel de nata — parecido, sim. Igual, nunca. No fim, eu conto onde "
    "os lisboetas de verdade compram os deles. E não é onde você imagina."
)


def _mock_outline(topic: str) -> Outline:
    return Outline(
        hook="Existe um pastel que fez uma cidade inteira guardar segredo por duzentos anos.",
        open_loops=["onde os lisboetas compram", "o erro que todo turista comete"],
        chapters=[
            Chapter(title="O segredo", beat="hook", target_seconds=25),
            Chapter(title="A história", beat="context", target_seconds=60),
            Chapter(title="O erro dos turistas", beat="reveal", target_seconds=45),
            Chapter(title="Onde comprar", beat="payoff", target_seconds=40),
        ],
    )


def _mock_mega(topic: str) -> tuple[Outline, str]:
    return _mock_outline(topic), _MOCK_SCRIPT


# ---------------------------------------------------------------- passes
def research_pack(topic: str, settings: Settings) -> tuple[str, float]:
    if settings.mock_mode:
        return f"# Research: {topic}\n- Facto mock 1\n- Facto mock 2\n", 0.0
    prompt = _prompt(settings, "research", topic=topic)
    return generate(prompt, settings, model=settings.model_flash,
                    search_grounding=True, temperature=0.3, tag="script_research")


# ---------------------------------------------------------------- Fase 2: mega
def build_mega_script(topic: str, research: str, duration_minutes: float,
                      settings: Settings, visual_inventory: str = ""
                      ) -> tuple[Outline, str, float]:
    """Fase 2: outline+draft numa única chamada Flash.

    Devolve (outline, draft, total_cost). Em caso de falha (JSON inválido,
    draft curto, schema violado), faz fallback transparente para o pipeline
    Pro multi-pass (build_outline + write_draft).
    """
    target_words = int(duration_minutes * settings.words_per_minute)
    if settings.mock_mode:
        outline, draft = _mock_mega(topic)
        return outline, draft, 0.0

    prompt = _prompt(settings, "mega_draft", topic=topic, research=research,
                     duration_minutes=duration_minutes, target_words=target_words,
                     visual_inventory=visual_inventory or "(indisponível)")

    total_cost = 0.0
    try:
        data, cost = _generate_json(prompt, settings, model=settings.model_flash,
                                    tag="script_mega", temperature=0.7)
        total_cost += cost
        outline = Outline.model_validate(data["outline"])
        draft = data["draft"]
        # Heurística 1: tamanho mínimo. Flash pode apressar-se em prosa longa.
        word_count = len(draft.split())
        if word_count < int(target_words * _MEGA_MIN_WORD_RATIO):
            log.warning("build_mega_script: draft curto (%d/%d palavras); "
                        "fallback Pro multi-pass", word_count, target_words)
            raise ValueError(f"short_draft:{word_count}/{target_words}")
        global _mega_total_success
        _mega_total_success += 1
        log.info("build_mega_script: sucesso Flash (%d palavras, $%.4f)",
                 word_count, total_cost)
        return outline, draft, total_cost
    except (json.JSONDecodeError, ValueError, KeyError) as exc:
        global _mega_total_fallback
        _mega_total_fallback += 1
        log.warning("build_mega_script: Flash falhou (%s); fallback Pro multi-pass",
                    type(exc).__name__)
        # FALLBACK: Pro multi-pass (mais lento mas Pro é mais robusto em
        # prosa longa + coerência narrativa).
        outline, c1 = build_outline(topic, research, duration_minutes, settings,
                                    visual_inventory)
        draft, c2 = write_draft(outline, research, duration_minutes, settings,
                               visual_inventory)
        total_cost += c1 + c2
        log.info("build_mega_script: fallback Pro (Pro multi-pass, "
                 "%d palavras, $%.4f)", len(draft.split()), total_cost)
        return outline, draft, total_cost


# ---------------------------------------------------------------- passes (kept)
def build_outline(topic: str, research: str, duration_minutes: float,
                  settings: Settings, visual_inventory: str = ""
                  ) -> tuple[Outline, float]:
    target_words = int(duration_minutes * settings.words_per_minute)
    if settings.mock_mode:
        return _mock_outline(topic), 0.0
    prompt = _prompt(settings, "outline", topic=topic, research=research,
                     duration_minutes=duration_minutes, target_words=target_words,
                     visual_inventory=visual_inventory or "(inventário indisponível)")
    data, cost = _generate_json(prompt, settings, model=settings.model_pro,
                                tag="script_outline", temperature=0.7)
    return Outline.model_validate(data), cost


def write_draft(outline: Outline, research: str, duration_minutes: float,
                settings: Settings, visual_inventory: str = ""
                ) -> tuple[str, float]:
    target_words = int(duration_minutes * settings.words_per_minute)
    if settings.mock_mode:
        return _MOCK_SCRIPT, 0.0
    prompt = _prompt(settings, "draft", outline=outline.model_dump_json(indent=2),
                     research=research, target_words=target_words,
                     visual_inventory=visual_inventory or "(inventário indisponível)")
    return generate(prompt, settings, model=settings.model_pro, temperature=0.8,
                    tag="script_draft")


def critique_and_revise(draft: str, settings: Settings) -> tuple[str, list[str], float]:
    """Devolve (texto revisto, notas do crítico, custo). Pro multi-step review
    — mantém-se em Pro porque a qualidade da revisão estrutural é melhor."""
    if settings.mock_mode:
        return draft, ["mock: sem problemas"], 0.0
    prompt = _prompt(settings, "critique", draft=draft)
    data, cost = _generate_json(prompt, settings, model=settings.model_pro,
                                tag="script_critique", temperature=0.4)
    revised = data.get("revised") or draft
    return revised, data.get("notes", []), cost


def humanize(text: str, settings: Settings) -> tuple[str, float]:
    if settings.mock_mode or not settings.openai_api_key:
        return text, 0.0
    prompt = _prompt(settings, "humanize", text=text)
    return chat(prompt, settings, model=settings.model_humanize, temperature=0.8)


def fix_lint_errors(text: str, errors: list[str], settings: Settings
                    ) -> tuple[str, float]:
    """Um passe corretivo barato (Flash) para erros de lint antes de falhar."""
    if settings.mock_mode:
        return text, 0.0
    prompt = _prompt(settings, "fix_lint", text=text,
                     errors="\n".join(f"- {e}" for e in errors))
    return generate(prompt, settings, model=settings.model_flash, temperature=0.3,
                    tag="script_lint_fix")
