# Integrações com agentes

## Limite de controle

Codex, Claude Code e Google Antigravity recebem plugins com skill e servidor MCP compartilhado. Essas superfícies permitem pedir análise, consultar profiles, fazer uma chamada real consentida ao provider e usar um gateway para chamadas controladas. As documentações atuais não garantem substituição do prompt primário antes da inferência do próprio agente. Portanto `host_primary_prompt_optimization = unavailable` nos três hosts. O gateway controla `application_request` e a ferramenta MCP `invoke_prompt` controla `downstream_llm_call`; as demais mensagens só são compiladas quando enviadas explicitamente pela aplicação ou skill.

A matriz conservadora está em `apps/cli/src/hosts.ts`. `semantic-ir integrations status` mostra versão detectada do executável, capacidades documentadas, pacote disponível e estratégia por scope. `installed: "unverified"` significa que a CLI não vasculha configurações privadas para inferir se o plugin está habilitado. O campo de versão não prova compatibilidade de uma versão nova; valide novamente após atualização do host.

## Instalação local

1. Execute `npm ci && npm run build` no repositório com Node.js 24 ou superior.
2. Instale a CLI no mesmo sistema operacional em que o host executa seu MCP: `npm pack --workspace apps/cli` e `npm install -g ./semantic-ir-cli-0.2.0.tgz`.
3. Verifique `semantic-ir doctor` e `semantic-ir integrations status`.
4. Gere artefatos com `semantic-ir integrations build --out ./dist`.
5. Configure o provider e sua chave no terminal do mesmo ambiente: `semantic-ir credentials import --provider openrouter` e `semantic-ir configure --provider openrouter --model z-ai/glm-5.3-flash`. A chave é digitada sem eco e fica fora do plugin.

### Codex

Para instalar a partir do repositório público, execute no mesmo sistema operacional da CLI:

```sh
codex plugin marketplace add JeandePaula/semantic-ir
codex plugin add semantic-ir@semantic-ir-community
```

O pacote local gerado está em `dist/codex/plugins/semantic-ir`. Para usá-lo, execute `codex plugin marketplace add CAMINHO_ABSOLUTO/dist/codex` e `codex plugin add semantic-ir@semantic-ir-local`. Confirme com `codex mcp list` que `semantic-ir` aparece habilitado. Abra uma nova tarefa para carregar a skill e as ferramentas.

### Claude Code

Para instalar a partir do repositório público:

```sh
claude plugin marketplace add JeandePaula/semantic-ir
claude plugin install semantic-ir@semantic-ir-community
```

Para desenvolvimento, carregue `dist/claude-code/plugins/semantic-ir` com `claude --plugin-dir CAMINHO_ABSOLUTO/dist/claude-code/plugins/semantic-ir`. Para instalação pelo marketplace local:

```sh
claude plugin validate CAMINHO_ABSOLUTO/dist/claude-code/plugins/semantic-ir
claude plugin marketplace add CAMINHO_ABSOLUTO/dist/claude-code
claude plugin install semantic-ir@semantic-ir-local
```

O pacote contém `.claude-plugin/plugin.json`, skill e `.mcp.json`. Não há hook: nenhum uso documentado ofereceu substituição segura do prompt primário. `semantic-ir uninstall claude` imprime o comando oficial de remoção. A base SQLite permanece fora do pacote.

### Google Antigravity

O plugin tem `plugin.json`, `mcp_config.json` e skill no formato documentado pelo Google. Para Antigravity CLI, execute `agy plugin install CAMINHO_ABSOLUTO/dist/antigravity/plugins/semantic-ir` e confirme com `agy plugin list` e `/mcp`. Para Antigravity IDE, copie a pasta `dist/antigravity/plugins/semantic-ir` para `~/.gemini/config/plugins/semantic-ir` e confira em **Customizations**. Faça a cópia no sistema operacional em que o Antigravity roda; a CLI `semantic-ir` precisa estar no `PATH` desse sistema.

### Hosts Windows com runtime no WSL

Se Codex, Claude Code ou Antigravity rodam no Windows, mas Node, CLI e chave do OpenRouter ficam no WSL, gere versões que chamam o servidor MCP pelo `wsl.exe`:

```sh
node apps/cli/bundle/main.js integrations build \
  --out /mnt/c/Users/SEU_USUARIO/.codex/semantic-ir-wsl \
  --wsl-distro Ubuntu-24.04
```

No PowerShell, instale o host desejado apontando para as pastas geradas:

```powershell
codex plugin marketplace add "$HOME\.codex\semantic-ir-wsl\codex-wsl"
codex plugin add semantic-ir@semantic-ir-wsl

claude plugin marketplace add "$HOME\.codex\semantic-ir-wsl\claude-code-wsl"
claude plugin install semantic-ir@semantic-ir-wsl

agy plugin install "$HOME\.codex\semantic-ir-wsl\antigravity-wsl\plugins\semantic-ir"
```

Execute somente os comandos do host que você tem instalado. Para o Antigravity IDE, copie a pasta `antigravity-wsl/plugins/semantic-ir` gerada para `$HOME\.gemini\config\plugins\semantic-ir`. Essa ponte mantém a chave no WSL e não a grava nos manifests do Windows. Não apague nem mova a pasta do repositório no WSL enquanto a integração estiver ativa, pois o manifest aponta para o bundle local.

### Verificação real

Abra uma nova sessão no host, confirme que o servidor MCP `semantic-ir` está conectado e peça:

> Use `semantic-ir doctor`. Depois chame `semantic-ir invoke_prompt` com `prompt: "Responda apenas OK."`, `allowSpend: true` e `maxOutputTokens: 32`. Mostre a resposta, `usage`, `cost` e `decision`.

`doctor.providerKeyConfigured: true` só confirma a presença de uma chave, não que ela ainda seja válida. A confirmação vem da resposta real do provider. O custo pode ser `null` se o provider não o informar. Com `decision.mode: "original"` e `fallbackReason: "no_stable_profile"`, a chamada funcionou sem afirmar economia ainda não demonstrada.

### ChatGPT

O MCP local `stdio` também pode ser ligado ao ChatGPT por [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), sem abrir uma porta pública. Isso exige acesso a **Developer mode** no ChatGPT, um `tunnel_id` criado no OpenAI Platform e uma chave de runtime **OpenAI Platform** para `tunnel-client`; a chave OpenRouter continua sendo usada somente pelo Semantic IR para chamar o modelo. Configure o tunnel-client no mesmo ambiente da CLI com `--mcp-command "semantic-ir mcp"`, rode `tunnel-client doctor` e `tunnel-client run`, então crie uma conexão **Tunnel** em ChatGPT Plugins. Abra um novo chat e habilite a conexão. Sem esse túnel ou um MCP remoto HTTPS, o plugin local do Codex não aparece automaticamente em uma conversa comum do ChatGPT. Publicação no diretório universal requer um endpoint HTTPS estável e revisão própria.

### Cliente MCP genérico

Configure um servidor stdio com `command: "semantic-ir"`, `args: ["mcp"]`. A configuração pronta fica em `dist/generic-mcp/mcp.json`. O processo MCP não exige `OPENAI_API_KEY` para ferramentas de análise e diagnóstico. Para validar o provider, execute `invoke_prompt` com sua chave e autorização de gasto.

## Ferramentas e custo

Ferramentas de leitura: `analyze_prompt`, `compile_prompt`, `validate_semantics`, `list_profiles`, `get_active_profile`, `get_metrics`, `get_runtime_decision`, `explain_fallback` e `doctor`. `invoke_prompt` exige `allowSpend: true` e `maxOutputTokens`, faz uma chamada paga e devolve resposta e métricas reais. `calibrate_model` e `benchmark_codec` exigem `allowSpend: true` e limites explícitos de requisições, tokens, USD e tempo. Nenhuma instalação inicia chamadas pagas por si só.

O codec e os profiles são únicos para CLI, MCP e gateway. Os plugins contêm somente manifests e instruções; não há cópia do algoritmo em cada host.

## Fontes dos formatos

- [OpenAI: construir plugins](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: servidores MCP em plugins](https://developers.openai.com/plugins/build/mcp-server)
- [Agent Plugins: especificação portátil](https://agent-plugins.org/specification)
- [Claude Code: plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code: criar e validar plugins](https://code.claude.com/docs/en/plugins/create)
- [Claude Code: marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Google Antigravity: plugins](https://www.antigravity.google/docs/plugins)
- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
