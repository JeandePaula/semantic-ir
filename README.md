# Semantic IR

Camada local para analisar prompts, testar codecs declarativos e encaminhar chamadas controladas a LLMs. O objetivo comercial é reduzir **custo por tarefa bem-sucedida**, medido contra o prompt original. Sem evidência de sucesso e custo, o runtime usa o original e não anuncia economia.

## Estado do produto

O MVP executável inclui schema `sir/0.1`, detecção conservadora de dados literais e constraints, Codec DSL sem código dinâmico, adapters OpenAI e OpenRouter, benchmark com orçamento para OpenAI, otimizador evolutivo, profiles SQLite, fallback, servidor MCP, gateway local, CLI e pacotes de plugin para Codex e Claude Code.

O benchmark embutido só pontua quatro tarefas sintéticas de **extração exata**. Outras categorias aparecem como probes sem oracle e não são usadas para promover codecs. Não há economia verificada em um modelo real neste repositório. Um plugin instalado também não tem acesso comprovado ao prompt primário do Codex ou Claude Code antes da inferência; o scope `host_primary_prompt` é `unavailable`. A otimização controlada é de chamadas da aplicação ou downstream.

## Requisitos e teste local

Use Node.js 24 ou superior e npm. `node:sqlite` ainda emite aviso experimental no Node 24.

```sh
npm install
npm run build
npm run check
node apps/cli/bundle/main.js init
node apps/cli/bundle/main.js doctor
node apps/cli/bundle/main.js integrations status
node apps/cli/bundle/main.js analyze "Nunca altere 7500 nem /api/v1/users/{id}."
```

Os testes usam providers simulados e não gastam créditos. `npm run check` roda typecheck, lint e Vitest. `npm run build` gera JSON Schemas, bundle da CLI e pacotes em `apps/cli/assets/integrations/`.

## CLI instalável

```sh
npm pack --workspace apps/cli
npm install -g ./semantic-ir-cli-0.1.0.tgz
semantic-ir doctor
semantic-ir integrations build --out ./dist
semantic-ir install codex
semantic-ir install claude
```

`install` e `uninstall` apresentam os comandos oficiais do host; não alteram configurações privadas nem afirmam instalação automática. Instale a CLI antes do plugin: ambos os manifests MCP chamam `semantic-ir mcp` no `PATH`. Os profiles ficam em `~/.semantic-ir/semantic-ir.sqlite`, ou no caminho definido por `SEMANTIC_IR_DB`, e sobrevivem a atualizações do plugin.

## Gateway local

```sh
export OPENAI_API_KEY=...
semantic-ir configure --model SEU_MODELO
semantic-ir proxy --port 8787
curl http://127.0.0.1:8787/health
```

O gateway escuta somente em `127.0.0.1`. Aceita `POST /v1/chat/completions` com um único texto de usuário; recursos Chat Completions não suportados são encaminhados ao provider sem compilação. `GET /metrics` e `/dashboard` mostram contagens observadas e distinguem economia verificada como indisponível. Opcionalmente defina `SEMANTIC_IR_GATEWAY_KEY` para exigir `Authorization: Bearer ...`. O gateway não é um serviço público multiusuário.

Para testar com OpenRouter, configure `semantic-ir configure --provider openrouter --model z-ai/glm-5.3-flash`. Forneça a chave por `OPENROUTER_API_KEY` ou importe-a com `semantic-ir credentials import --provider openrouter`; a entrada interativa é oculta e o arquivo privado fica em `~/.config/semantic-ir/openrouter.key` com permissão `0600`, fora do repositório. Execute `semantic-ir invoke --allow-spend --max-output-tokens 256 --prompt "Responda apenas OK."`. O adapter OpenRouter usa Chat Completions, registra usage e custo reportados pelo provider e não oferece calibração automática porque não há endpoint de pré-contagem verificado neste produto.

## Calibração paga, opcional

Para testar um modelo real, configure preços atuais da sua conta em USD por milhão de tokens e defina `OPENAI_API_KEY` no ambiente. Os valores abaixo são **marcadores**, não preços atuais:

```sh
semantic-ir configure --model SEU_MODELO \
  --input-price PRECO --cached-price PRECO --output-price PRECO --price-version DATA_OU_TABELA
semantic-ir benchmark --model SEU_MODELO --task extraction --allow-spend \
  --max-requests 40 --max-tokens 8000 --max-cost-usd 0.10 --max-duration-ms 120000
```

`benchmark` não promove profile; `calibrate` ou `optimize` só promovem se calibration, validation e holdout passarem. Os limites monetários são calculados com os preços fornecidos pelo usuário e a contagem do provider; confira esses preços antes de autorizar gasto. Sem chave, preço, oracle ou evidência suficiente, o sistema não promove um codec. Para outras tarefas, forneça uma suite JSON com casos pontuados em cada split (`--suite caminho.json`).

Veja [arquitetura](docs/architecture.md), [integrações](docs/integrations.md), [testes e publicação](docs/testing-and-release.md), [decisão sobre hosts](docs/decisions/0002-host-integrations.md) e [status por fase](docs/phases.md).
