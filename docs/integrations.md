# Integrações com agentes

## Limite de controle

Codex e Claude Code recebem um plugin com skill e servidor MCP compartilhado. Essas superfícies permitem pedir análise, consultar profiles, executar benchmark consentido e usar um gateway para chamadas controladas. As documentações atuais não garantem substituição do prompt primário antes da inferência do próprio agente. Portanto `host_primary_prompt_optimization = unavailable` nos dois hosts. O gateway controla `application_request` e `downstream_llm_call`; as demais mensagens só são compiladas quando enviadas explicitamente pela aplicação ou skill.

A matriz conservadora está em `apps/cli/src/hosts.ts`. `semantic-ir integrations status` mostra versão detectada do executável, capacidades documentadas, pacote disponível e estratégia por scope. `installed: "unverified"` significa que a CLI não vasculha configurações privadas para inferir se o plugin está habilitado. O campo de versão não prova compatibilidade de uma versão nova; valide novamente após atualização do host.

## Instalação local

1. Execute `npm install && npm run build` no repositório.
2. Instale a CLI no mesmo ambiente em que o host executa seu MCP: `npm pack --workspace apps/cli` e `npm install -g ./semantic-ir-cli-0.1.0.tgz`.
3. Verifique `semantic-ir doctor` e `semantic-ir integrations status`.
4. Gere artefatos com `semantic-ir integrations build --out ./dist`.

### Codex

O pacote portátil está em `dist/codex/plugins/semantic-ir`; o marketplace local está em `dist/codex/.agents/plugins/marketplace.json`. Use `semantic-ir install codex` para imprimir o comando com o caminho exato. No host Codex, execute `codex plugin marketplace add CAMINHO_ABSOLUTO/dist/codex` e `codex plugin add semantic-ir@semantic-ir-local`. Confirme no host que a skill aparece e que a ferramenta MCP `doctor` responde. A instalação do marketplace não é executada automaticamente pela CLI.

### Claude Code

Para desenvolvimento, carregue `dist/claude-code/plugins/semantic-ir` com `claude --plugin-dir CAMINHO_ABSOLUTO/dist/claude-code/plugins/semantic-ir`. Para instalação pelo marketplace local:

```sh
claude plugin validate CAMINHO_ABSOLUTO/dist/claude-code/plugins/semantic-ir
claude plugin marketplace add CAMINHO_ABSOLUTO/dist/claude-code
claude plugin install semantic-ir@semantic-ir-local
```

O pacote contém `.claude-plugin/plugin.json`, skill e `.mcp.json`. Não há hook: nenhum uso documentado ofereceu substituição segura do prompt primário. `semantic-ir uninstall claude` imprime o comando oficial de remoção. A base SQLite permanece fora do pacote.

### Cliente MCP genérico

Configure um servidor stdio com `command: "semantic-ir"`, `args: ["mcp"]`. A configuração pronta fica em `dist/generic-mcp/mcp.json`. O processo MCP é testado por handshake real no conjunto de testes; não exige `OPENAI_API_KEY` para ferramentas de análise e diagnóstico.

## Ferramentas e custo

Ferramentas de leitura: `analyze_prompt`, `compile_prompt`, `validate_semantics`, `list_profiles`, `get_active_profile`, `get_metrics`, `get_runtime_decision`, `explain_fallback` e `doctor`. `calibrate_model` e `benchmark_codec` exigem `allowSpend: true` e limites explícitos de requisições, tokens, USD e tempo. Nenhuma instalação inicia calibração paga.

O codec e os profiles são únicos para CLI, MCP e gateway. Os plugins contêm somente manifests e instruções; não há cópia do algoritmo em cada host.

## Fontes dos formatos

- [OpenAI: construir plugins](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: servidores MCP em plugins](https://developers.openai.com/plugins/build/mcp-server)
- [Agent Plugins: especificação portátil](https://agent-plugins.org/specification)
- [Claude Code: plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code: criar e validar plugins](https://code.claude.com/docs/en/plugins/create)
- [Claude Code: marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
