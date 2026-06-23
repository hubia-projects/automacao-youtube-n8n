# Regras do projeto para agente de IA

Este é um projeto real da Hubia. Trabalhar com cuidado.

## Idioma

- Responder sempre em português de Portugal.
- Explicar planos, alterações e resumos em português.
- Manter nomes técnicos do código em inglês:
  - variables
  - functions
  - components
  - files
  - types
  - hooks
  - routes

## Segurança

- Não alterar ficheiros `.env`, `.env.local`, `.env.production` ou similares.
- Não expor tokens, passwords, chaves privadas ou credenciais.
- Não mexer em credenciais, autenticação, permissões, faturação, cobranças ou integrações sem explicar primeiro.
- Não apagar dados, tabelas, migrations, backups, uploads, exports ou ficheiros importantes.
- Não executar comandos destrutivos como `rm -rf`, reset de base de dados, `drop`, `truncate` ou limpeza de storage sem confirmação explícita.
- Não instalar dependências sem explicar primeiro o motivo.

## Forma de trabalhar

Antes de alterar ficheiros:
1. Analisa a estrutura do projeto.
2. Identifica a área afetada.
3. Explica o plano.
4. Lista os ficheiros que vais alterar.
5. Diz se existe algum risco.

Durante a implementação:
- Fazer alterações pequenas e controladas.
- Preservar o padrão visual e técnico existente.
- Evitar refactors grandes se a tarefa for pontual.
- Reutilizar componentes, helpers e estilos já existentes.
- Manter código limpo, organizado e fácil de rever.

Depois de alterar:
1. Resumir o que foi feito.
2. Listar ficheiros alterados.
3. Explicar como testar.
4. Correr lint, build ou testes quando fizer sentido.