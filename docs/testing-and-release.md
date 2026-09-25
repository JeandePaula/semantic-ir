# Testes e publicação

## Verificação sem gasto

```sh
npm install
npm run build
npm run check
npm audit
npm pack --workspace apps/cli
```

Depois, instale o tarball em um diretório vazio e execute `semantic-ir doctor` e `semantic-ir integrations build --out ./dist`. O teste automatizado MCP abre um processo stdio real; o gateway é testado com provider simulado. A suíte não chama a API OpenAI. Confira `GET /health`, `/metrics` e `/dashboard` ao iniciar `semantic-ir proxy --port 8787`.

Verifique nos hosts reais antes de uma release: instale o plugin, confirme a skill, execute as ferramentas MCP `doctor` e `invoke_prompt` com uma chave válida, e confira resposta, usage e custo do provider. Repita após mudança de versão do host. O usuário confirmou a chamada real dentro do Codex; Claude Code confirmou conexão MCP no WSL; o Antigravity tem o pacote copiado no Windows, mas ainda precisa da verificação no IDE.

## Experimento com modelo real

Para calibração OpenAI, defina `OPENAI_API_KEY` apenas no ambiente do processo. Configure um modelo e **os preços vigentes da sua conta** em USD por milhão de tokens. Execute `semantic-ir benchmark --task extraction --allow-spend` com `--max-requests`, `--max-tokens`, `--max-cost-usd` e `--max-duration-ms`. Revise baseline, candidato e resultado por split. Só então use `semantic-ir calibrate` para permitir promoção estável. O comando retorna falha sem casos com oracle nos três splits. O custo calculado usa usage do provider e tabela de preços configurada pelo usuário; é estimado, não uma fatura oficial. O orçamento em USD depende da correção dessa tabela.

Para OpenRouter, configure `z-ai/glm-5.3-flash` e importe a chave no prompt oculto. `semantic-ir benchmark --model z-ai/glm-5.3-flash --task extraction --suite redundant-extraction --allow-spend --max-requests 36 --max-tokens 60000 --max-cost-usd 0.05 --max-duration-ms 900000 --max-output-tokens 256` mede original e candidatos sem ativar um profile. Se o relatório mostrar custo medido e sucesso nos três splits, `semantic-ir calibrate` com os mesmos limites pode promover o vencedor. `semantic-ir calibration report` recupera o último relatório. O teto OpenRouter é estimado localmente; configure um limite de gasto na chave para um teto externo. `holdoutEvidence` se refere apenas à suite, não a produção.

## Tornar disponível à comunidade

1. Revise a licença [MIT](../LICENSE) incluída, inclusive a atribuição de copyright, antes de tornar o repositório público. Ela permite reutilização e distribuição mediante preservação do aviso de licença.
2. O repositório público [JeandePaula/semantic-ir](https://github.com/JeandePaula/semantic-ir) contém os marketplaces `.agents/plugins/marketplace.json` e `.claude-plugin/marketplace.json`, que apontam para os plugins incluídos no mesmo repositório.
3. Publique releases versionadas no GitHub com o tarball gerado por `npm pack --workspace apps/cli`. Para `npm publish --workspace apps/cli --access public`, primeiro confirme que você controla o escopo npm `@semantic-ir` ou renomeie o pacote para um escopo seu. A instalação global da CLI é necessária para os MCPs stdio dos plugins.
4. Use os comandos concretos do [guia de integrações](integrations.md) para Codex, Claude Code, Antigravity e WSL. Confira o MCP dentro de cada host e mantenha instruções separadas para ChatGPT via Secure MCP Tunnel.
5. Use Issues e Releases do GitHub para feedback e changelog. Não envie este gateway local diretamente à internet: antes de oferecer SaaS, ele precisa de autenticação multiusuário, limites, proteção operacional e hospedagem próprios.

Essas etapas publicam código e plugins distribuíveis por repositório. Entrada em diretórios oficiais de plugins é outro processo; não está implícita no manifest. Consulte [OpenAI Plugins](https://developers.openai.com/plugins/build/plugins) e [Claude marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) para os procedimentos atuais.
