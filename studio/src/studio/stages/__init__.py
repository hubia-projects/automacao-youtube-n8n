"""Stages do pipeline de produção.

Fase 1: só o pipeline dummy (validação do orquestrador).
Fases 3-7 adicionam s01_topic … s14_upload — um ficheiro por stage,
lógica pesada nos módulos de domínio (library/, matching/, render/…).
"""
