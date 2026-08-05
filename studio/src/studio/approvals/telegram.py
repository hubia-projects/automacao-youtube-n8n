"""Cliente Telegram para gates humanos (ARCHITECTURE.md §11).

Modo mock (settings.mock_mode ou token em falta): não contacta a API;
regista o pedido e devolve a primeira opção — permite testes e runs locais
sem bot configurado.
"""

from __future__ import annotations

import logging
import time

import httpx

from studio.config import Settings

log = logging.getLogger("studio.telegram")

API = "https://api.telegram.org/bot{token}/{method}"


class TelegramClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.mock = settings.mock_mode or not settings.telegram_bot_token

    def _call(self, method: str, **payload) -> dict:
        url = API.format(token=self.settings.telegram_bot_token, method=method)
        resp = httpx.post(url, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"Telegram {method} falhou: {data}")
        return data["result"]

    def send_text(self, text: str) -> None:
        if self.mock:
            log.info("[mock telegram] %s", text)
            return
        self._call("sendMessage", chat_id=self.settings.telegram_chat_id, text=text)

    def ask(self, question: str, options: list[str]) -> str:
        """Envia pergunta com botões inline; bloqueia até resposta ou timeout.
        Em mock devolve a primeira opção. (Usado só em contexto interativo;
        o pipeline usa send_question + poll_answer — não-bloqueante.)"""
        if self.mock:
            log.info("[mock telegram] pergunta: %s → auto: %s", question, options[0])
            return options[0]
        message_id = self.send_question(question, options)
        deadline = time.monotonic() + self.settings.telegram_gate_timeout_s
        while time.monotonic() < deadline:
            choice = self.poll_answer(message_id, options)
            if choice:
                return choice
            time.sleep(self.settings.telegram_poll_interval_s)
        raise TimeoutError(f"gate sem resposta em {self.settings.telegram_gate_timeout_s}s")

    def send_question(self, question: str, options: list[str]) -> int:
        """Envia a pergunta e devolve message_id — NÃO espera resposta."""
        if self.mock:
            log.info("[mock telegram] pergunta enviada: %s", question)
            return 0
        keyboard = [[{"text": o, "callback_data": o}] for o in options]
        msg = self._call(
            "sendMessage",
            chat_id=self.settings.telegram_chat_id,
            text=question,
            reply_markup={"inline_keyboard": keyboard},
        )
        return msg["message_id"]

    def poll_answer(self, message_id: int, options: list[str]) -> str | None:
        """Uma passagem por getUpdates; devolve a escolha ou None.

        O offset TEM de avançar sempre até ao update mais recente visto,
        independente de ter havido match ou de o ack ao Telegram falhar —
        senão o mesmo clique fica no backlog e é reprocessado (e re-responder
        um callback_query já respondido dá 400 e mata o stage para sempre)."""
        if self.mock:
            return options[0]
        url = API.format(token=self.settings.telegram_bot_token, method="getUpdates")
        resp = httpx.get(url, params={"allowed_updates": ["callback_query"]}, timeout=15)
        resp.raise_for_status()
        updates = resp.json().get("result", [])

        choice = None
        max_update_id = None
        for update in updates:
            max_update_id = update["update_id"] if max_update_id is None \
                else max(max_update_id, update["update_id"])
            cq = update.get("callback_query")
            if not cq or cq.get("message", {}).get("message_id") != message_id:
                continue
            data = cq.get("data", "")
            if data in options and choice is None:
                choice = data
                try:  # cortesia de UI (tira o spinner do botão) — nunca fatal
                    self._call("answerCallbackQuery", callback_query_id=cq["id"])
                except Exception as exc:
                    log.warning("answerCallbackQuery falhou (não fatal): %s", exc)

        if max_update_id is not None:
            try:  # consumir SEMPRE os updates vistos, haja match ou não
                httpx.get(url, params={"offset": max_update_id + 1}, timeout=15)
            except Exception as exc:
                log.warning("avanço de offset getUpdates falhou (não fatal): %s", exc)
        return choice
