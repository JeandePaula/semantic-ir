# ADR 0002: plugins por host e limite do prompt primário

**Status:** aceito em 2026-09-25.

## Contexto

O produto precisa ser instalável em Codex e Claude Code e distinguir acesso a ferramentas de controle efetivo da chamada do próprio agente. Os formatos e comandos foram conferidos na documentação oficial em 2026-09-25: [OpenAI Plugins](https://developers.openai.com/plugins/build/plugins), [OpenAI MCP](https://developers.openai.com/plugins/build/mcp-server), [Claude plugins](https://code.claude.com/docs/en/plugins), [Claude criação](https://code.claude.com/docs/en/plugins/create) e [marketplaces Claude](https://code.claude.com/docs/en/plugin-marketplaces). O formato portátil de `plugin.json` e `mcp.json` também foi validado contra os [schemas Agent Plugins](https://agent-plugins.org/specification).

## Decisão

O Codex usa `integrations/codex/plugin.json` no formato portátil, `mcp.json` stdio e uma skill. O Claude Code usa `.claude-plugin/plugin.json`, `.mcp.json` e uma skill. Os dois apontam para `semantic-ir mcp`; o core fica em `packages/`. Marketplaces locais e de repositório são separados da implementação. A CLI gera artefatos por host e imprime os passos de instalação que dependem do aplicativo.

Nenhum dos formatos documentados é tratado como prova de que um plugin substitui o prompt principal antes da inferência. A matriz marca `promptPreprocessing` e `promptReplacement` como falsos; `host_primary_prompt` é indisponível. Codex não recebe hook especulativo; Claude Code tem suporte documentado a hooks, mas este pacote não instala nenhum. Pedidos explícitos via skill/MCP e chamadas por gateway continuam disponíveis. Instalação e habilitação são `unverified` até checagem dentro do host.

## Consequências

- Métricas são atribuídas ao `OptimizationScope` controlado; o dashboard não anuncia economia do prompt primário.
- A CLI deve estar no `PATH` do processo do agente para que o MCP stdio funcione.
- Os pacotes devem ser conferidos em cada host real após instalação ou atualização; o MCP compartilhado e a validação de estrutura não comprovam por si só o carregamento da skill no host.
- A versão detectada do host é informativa; mudança de host exige novo teste, não inferência de suporte por semelhança de manifest.
- Um diretório público universal de plugins pode exigir MCP remoto HTTPS; o pacote stdio é distribuível por repositório/marketplace local, sem alegação de aprovação em diretório oficial.
