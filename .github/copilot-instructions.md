# Instrucoes do Copilot para este repositorio

- Sempre que alterar a estrutura do fluxo do pipeline de videos, atualize tambem o arquivo fluxo.md na raiz do repositorio no mesmo trabalho.
- Sempre que a mudanca afetar a leitura visual do fluxo, atualize tambem fluxo-visual.md e fluxo-visual.html no mesmo trabalho.
- Considere como alteracao estrutural qualquer mudanca em workflows n8n, webhooks, triggers, services do backend, ordem entre W1/W2/W3, Telegram, providers de voz, OpenAI, render, metadata ou upload.
- Mantenha o diagrama Mermaid, a sequencia passo a passo e a tabela "Onde alterar cada parte no futuro" coerentes com a implementacao atual.
- Mantenha o HTML visual coerente com a implementacao atual, incluindo os blocos de n8n, backend local, Telegram, providers externos e pontos de aprovacao humana.
- Ao mudar agendamentos ou triggers do Workflow 1, atualize em fluxo.md a configuracao vigente de start manual e start agendado.
- Ao trocar providers externos, registre em fluxo.md qual provider e principal, quais sao os fallbacks e em quais arquivos isso e controlado.