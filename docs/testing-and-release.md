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

Teste manual nos hosts reais antes de uma release: adicione o marketplace, instale o plugin, confirme a skill, execute a ferramenta MCP `doctor`, desabilite/reative o plugin, atualize-o e confirme que o profile SQLite permanece. Repita após mudança de versão do host. No momento, o executável Codex está disponível via Windows e não há executável Claude Code neste ambiente; os testes automatizados não substituem essa verificação manual.

## Experimento com modelo real

Defina `OPENAI_API_KEY` apenas no ambiente do processo. Configure um modelo e **os preços vigentes da sua conta** em USD por milhão de tokens. Execute `semantic-ir benchmark --task extraction --allow-spend` com `--max-requests`, `--max-tokens`, `--max-cost-usd` e `--max-duration-ms`. Revise baseline, candidato e resultado por split. Só então use `semantic-ir calibrate` para permitir promoção estável. O comando retorna falha sem casos com oracle nos três splits. O custo mostrado usa usage de provider e tabela de preços configurada pelo usuário; é estimado, não uma fatura oficial. O orçamento em USD depende da correção dessa tabela.

## Tornar disponível à comunidade

1. Revise a licença [MIT](../LICENSE) incluída, inclusive a atribuição de copyright, antes de tornar o repositório público. Ela permite reutilização e distribuição mediante preservação do aviso de licença.
2. Crie um repositório público no GitHub e envie este monorepo. Os dois manifests de marketplace no root, `.agents/plugins/marketplace.json` e `.claude-plugin/marketplace.json`, apontam para os plugins incluídos no mesmo repositório.
3. Publique releases versionadas no GitHub com o tarball gerado por `npm pack --workspace apps/cli`. Para `npm publish --workspace apps/cli --access public`, primeiro confirme que você controla o escopo npm `@semantic-ir` ou renomeie o pacote para um escopo seu. A instalação global da CLI é necessária para os MCPs stdio dos plugins.
4. Documente para usuários Codex `codex plugin marketplace add DONO/REPOSITORIO` e `codex plugin add semantic-ir@semantic-ir-community`. Para Claude Code, documente `claude plugin marketplace add DONO/REPOSITORIO` e `claude plugin install semantic-ir@semantic-ir-community`. Teste os dois em uma conta separada após a publicação.
5. Use Issues e Releases do GitHub para feedback e changelog. Não envie este gateway local diretamente à internet: antes de oferecer SaaS, ele precisa de autenticação multiusuário, limites, proteção operacional e hospedagem próprios.

Essas etapas publicam código e plugins distribuíveis por repositório. Entrada em diretórios oficiais de plugins é outro processo; não está implícita no manifest. Consulte [OpenAI Plugins](https://developers.openai.com/plugins/build/plugins) e [Claude marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) para os procedimentos atuais.
