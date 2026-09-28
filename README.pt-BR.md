# Semantic IR

**Correção da falha de formato:** chamadas OpenRouter podem declarar `outputShape: {"type":"string"}` (CLI `--output-shape`). O adapter envia um schema estrito ao provedor, valida a estrutura devolvida e confere a resposta completa com o gabarito local, sem enviar o gabarito ao modelo. O schema e as instruções entram no orçamento e no fingerprint. Se uma resposta compactada falhar no contrato, o perfil passa a exigir reverificação, sem retry pago automático. **155 testes offline passaram**; o novo protocolo ainda não foi avaliado em teste pago. [Uso e limites](docs/native-output-contracts.md).

**Novo teste pago em 28/09/2026:** o original respondeu `"CORAL"` corretamente; o compactado retornou `{"launch":{"color":"CORAL"}}`, um objeto em vez da string solicitada. O compactado custou 47,55% menos, mas falhou na qualidade. O protocolo interrompeu o teste após duas chamadas, **US$ 0,000522050** e 3.352 tokens; os quatro pares restantes, incluindo o complexo, não foram executados. Nenhum perfil foi promovido. Veja o [relatório e as respostas](docs/experiments/openrouter-compression-2026-09-28/README.md).

**Revisão em 28/09/2026:** o aumento de 4,83% no caso complexo veio de US$ 0,000061290 economizados na entrada contra US$ 0,000114100 extras na saída. A resposta cresceu 815 tokens; cerca de 438 já eliminariam a economia. O novo compilador `json_query_v1` executa filtros, ordenação explícita, projeção, soma e contagem localmente. Os quatro casos recentes de extração e a alocação passaram contra os gabaritos existentes: **5/5, zero chamadas downstream**, sem novo teste pago. A calibração agora deixa de chamar o candidato se o original falhar; contratos JSON e normalização opcional de uma única cerca Markdown evitam confundir layout com valores. Veja [análise, estudos e limites](docs/semantic-compilation.md) e [Compression results](README.md#compression-results). A revisão não altera os resultados pagos históricos nem promove perfis.

[English](README.md). O README em inglês inclui também o [teste complexo](docs/experiments/complex-json/README.md): a compactação barateou as chamadas, mas nenhuma das versões passou na avaliação completa da qualidade. Os resultados positivos abaixo se limitam à extração simples.

**Atualização:** o fluxo agora prioriza operações locais explícitas e verificação de respostas, guiado por uma skill. O caso complexo foi resolvido integralmente conforme o gabarito anterior, e os seis casos de extração acertaram com **zero chamadas/tokens downstream**. Isso não inclui o consumo do agente/host. Veja o [novo relatório](docs/reports/local-execution.json), o [resultado correto](docs/experiments/complex-json/local-result.json) e a [decisão técnica](docs/quality-workflow.md). Os resultados de compactação abaixo são históricos.

**Reteste pago em 27/09/2026:** com o mesmo modelo OpenRouter, a extração ficou 33,35% mais barata, mas teve acerto estrito 3/4 em ambas as versões. O caso complexo permaneceu incorreto nas duas e a compactação ficou 4,83% mais cara. Gasto reportado: US$ 0,003130025; contabilizado com reservas: US$ 0,005625485. Consulte [Compression results](README.md#compression-results) e o [relatório completo](docs/experiments/openrouter-compression-2026-09-27/README.md).

Camada local para analisar prompts, testar codecs declarativos e encaminhar chamadas controladas a LLMs. O objetivo comercial é reduzir **custo por tarefa bem-sucedida**, medido contra o prompt original. Sem evidência de sucesso e custo, o runtime usa o original e não anuncia economia.

## Estado do produto

O MVP executável inclui schema `sir/0.1`, detecção conservadora de dados literais e constraints, Codec DSL sem código dinâmico, adapters OpenAI e OpenRouter, auditoria local de candidatos, benchmark com orçamento reconciliado, seleção por custo total, profiles SQLite, fallback, servidor MCP, gateway local, CLI e pacotes de plugin para Codex, Claude Code e Google Antigravity.

As suites embutidas pontuam casos sintéticos de **extração exata**: quatro na suite básica, seis na suite de contexto repetido e seis na suite JSON. Outras categorias aparecem como probes sem oracle e não são usadas para promover codecs. O repositório inclui comparação local de bytes e uma calibração real de extração JSON com economia medida na amostra. Um plugin instalado também não tem acesso comprovado ao prompt primário do Codex ou Claude Code antes da inferência; o scope `host_primary_prompt` é `unavailable`. A otimização controlada é de chamadas da aplicação ou downstream.

## Começar pelo repositório

Use Node.js 24 ou superior, npm e um terminal Bash (Linux, macOS ou WSL). `node:sqlite` ainda emite aviso experimental no Node 24. Estes comandos não precisam de chave de API nem fazem chamadas pagas:

```sh
git clone https://github.com/JeandePaula/semantic-ir.git
cd semantic-ir
npm ci
npm run build
node apps/cli/bundle/main.js init
node apps/cli/bundle/main.js doctor
node apps/cli/bundle/main.js integrations status
node apps/cli/bundle/main.js analyze "Nunca altere 7500 nem /api/v1/users/{id}."
```

`npm run build` gera JSON Schemas, bundle da CLI e pacotes em `apps/cli/assets/integrations/`. Para confirmar a integração com um modelo de verdade, siga a seção de chave de API e faça a chamada real abaixo.

## Auditar antes de gastar

```sh
node apps/cli/bundle/main.js audit --file meu-prompt.txt
node apps/cli/bundle/main.js audit --suite json-extraction
npm run audit:savings
```

A auditoria é local: compara bytes, rejeita candidatos que aumentam o texto, economizam menos de 128 bytes ou produzem a mesma saída de outro candidato. Não calcula tokens nem dólares por aproximação. O MCP oferece a mesma análise em `audit_prompt`.

O novo codec `json_compact` remove espaços e quebras de linha fora de strings em JSON válido, nas tarefas de extração e saída estruturada. Preserva a escrita dos números (inclusive inteiros grandes), escapes, ordem e chaves repetidas; não faz `JSON.parse` seguido de `JSON.stringify`. Pedidos de reprodução ou análise da formatação usam o original. A verificação reexecuta a transformação completa antes de aceitar um literal JSON compactado.

Na [comparação reproduzível](docs/reports/local-compression.json), a suite JSON cai de 18.636 para 7.185 bytes (61,45%); os codecs anteriores não reduziam esses casos. Isso é redução de payload, **não economia financeira comprovada**. Veja o [diagnóstico e limites](docs/improvements.md).

Em 26/09/2026, uma [calibração paga com `z-ai/glm-5.3-flash`](docs/reports/openrouter-json-calibration.json) aprovou `json_compact`: os seis pares acertaram, e o custo medido nos dois casos holdout caiu 33,47%. Os candidatos holdout tiveram cache de entrada. Uma [entrada nova, com ambos os lados sem cached input](docs/reports/openrouter-json-runtime.json), confirmou 29,90% de redução de custo e resposta correta com `decision.mode: compiled`. As 14 chamadas do experimento custaram US$ 0,000618. São resultados dessa amostra e modelo, não uma garantia para outros pedidos ou economia líquida já amortizada.

## Testar com sua própria chave de API

O projeto aceita OpenRouter e OpenAI. A instalação não pede uma chave; análise local, testes e ferramentas MCP de leitura funcionam sem ela. Para usar OpenRouter, importe sua chave pelo prompt oculto no terminal e configure o modelo:

```sh
node apps/cli/bundle/main.js credentials import --provider openrouter
node apps/cli/bundle/main.js configure --provider openrouter --model z-ai/glm-5.3-flash
node apps/cli/bundle/main.js doctor
node apps/cli/bundle/main.js invoke --allow-spend --max-output-tokens 256 --prompt "Responda apenas OK."
```

O último comando envia uma requisição paga para sua conta. Você também pode usar `OPENROUTER_API_KEY` como variável de ambiente. Para OpenAI, troque o provider para `openai`, importe sua chave e escolha um modelo disponível na sua conta. As chaves importadas ficam em `~/.config/semantic-ir/` com permissão `0600`, fora do repositório; não as coloque em arquivos versionados. `doctor` mostra se a chave está configurada, sem imprimi-la. O adapter OpenRouter registra os tokens e o custo medidos pelo provider.

## Calibrar e medir uma otimização real

O OpenRouter pode avaliar candidatos sem uma pré-contagem oficial: antes de cada chamada, o Semantic IR reserva um teto **conservador e estimado** a partir do tamanho em bytes, limite de saída e preço consultado no catálogo do OpenRouter. A requisição também limita o preço por token do provider. Depois de cada resposta, o sistema verifica tokens e custo efetivamente cobrados e interrompe a execução se o teto estimado for ultrapassado. **O limite local em USD não é uma garantia absoluta de cobrança**; para um teto externo, configure um limite de gasto na chave OpenRouter.

O padrão da calibração agora é `json-extraction`, com dados estruturados distintos nos três splits. A suite `redundant-extraction` continua disponível para contexto repetido: remove apenas linhas idênticas do bloco `CONTEXT`/`CONTEXTO`, quando a redução chega a 2 KiB. Execute somente se aceitar as chamadas pagas:

```sh
semantic-ir calibrate --model z-ai/glm-5.3-flash --task extraction \
  --suite redundant-extraction --allow-spend \
  --max-requests 36 --max-tokens 100000 --max-cost-usd 0.05 \
  --max-duration-ms 900000 --max-output-tokens 256
semantic-ir calibration report
semantic-ir profile
```

O relatório separa custo medido, reserva de orçamento e economia observada **somente nos casos holdout**. Um codec só é promovido se o original e o candidato acertarem todas as respostas exatas e o candidato custar menos em cada caso de calibração, validação e holdout. Se `promoted` for `false`, o runtime continua usando o prompt original. Mesmo quando promovido, a evidência não implica economia em outros tipos de tarefa. Para sua aplicação, forneça uma suite JSON própria com casos e respostas esperadas em cada split, usando `--suite arquivo.json`.

`screenedCandidates` explica descartes sem inferência. `diagnostics` identifica crescimento da saída, custo insuficiente e efeito do cache. `economics.breakEvenRequests` projeta quantas chamadas semelhantes ao holdout seriam necessárias para recuperar **todo o gasto desta execução**; não afirma que isso já aconteceu. `reservations` contém tetos cumulativos; `run.usedCostUsd` contém valores reconciliados mais reservas de chamadas com cobrança desconhecida. Cada resposta libera apenas a parte da reserva substituída por usage/custo válidos. Candidatos são interrompidos na primeira falha dos gates.

Para modelos OpenRouter que aceitam controlar reasoning, há uma opção explícita para tarefas simples:

```sh
semantic-ir configure --provider openrouter --model SEU_MODELO --reasoning none
```

Os valores são `default`, `none`, `minimal`, `low`, `medium` e `high`; a compatibilidade depende do modelo. A mesma configuração vale para original, candidato e runtime e participa do fingerprint: trocar reasoning exige nova calibração. O padrão mantém a escolha do provider. Ocultar reasoning não evita sua cobrança; veja a [documentação OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). A calibração desativa o cache de respostas do OpenRouter, enquanto chamadas normais preservam a política do provider.

Se `promoted` for `true`, experimente uma entrada nova da mesma classe. Esta chamada também é paga; `decision.mode` deve ser `compiled` e a resposta deve ser `MAGENTA`:

```sh
FACT='The launch label color is MAGENTA and the same label is used in every approved view.'
PROMPT="$(printf 'Extract the launch label color from CONTEXT. Reply with the uppercase color word and no other text.\nCONTEXT:\n'; for i in {1..32}; do printf '%s\n' "$FACT"; done; printf 'QUESTION:\nWhat is the launch label color?')"
semantic-ir invoke --allow-spend --max-output-tokens 256 --prompt "$PROMPT"
```

O perfil da calibração é específico para `extraction` e para o fingerprint do modelo. Um pedido como “Responda apenas OK.” pode continuar em modo `original` por pertencer a outra classe.

## Instalar a CLI e os plugins

```sh
npm pack --workspace apps/cli
npm install -g ./semantic-ir-cli-0.3.1.tgz
semantic-ir doctor
semantic-ir integrations build --out ./dist
semantic-ir install codex
semantic-ir install claude
semantic-ir install antigravity
```

Os três comandos `install` mostram os passos de instalação em cada host; siga o comando impresso para instalar o plugin. Veja o [passo a passo para Codex, Claude Code, Antigravity, WSL e ChatGPT](docs/integrations.md). A CLI precisa estar no `PATH` do mesmo ambiente em que o host executa o MCP. Se o host roda no Windows e a CLI/chave ficam no WSL, gere os pacotes de ponte com `node apps/cli/bundle/main.js integrations build --out /mnt/c/Users/SEU_USUARIO/.codex/semantic-ir-wsl --wsl-distro Ubuntu-24.04`. Os profiles ficam em `~/.semantic-ir/semantic-ir.sqlite`, ou no caminho definido por `SEMANTIC_IR_DB`, e sobrevivem a atualizações do plugin.

## Verificar o plugin com uma chamada real

Depois de configurar sua própria chave do OpenRouter e instalar o plugin, abra **uma nova sessão** no host e peça: “Use Semantic IR `doctor` e depois `invoke_prompt` com `allowSpend: true`, `maxOutputTokens: 32` e o prompt `Responda apenas OK.`. Mostre a resposta, o custo e `decision.mode`.” Isso chama o modelo `z-ai/glm-5.3-flash` configurado acima. Se `decision.mode` for `original` e `fallbackReason` for `no_stable_profile`, o plugin funcionou, mas ainda não há otimização comprovada para esse modelo. A instalação não troca automaticamente o modelo principal do agente pelo OpenRouter.

## Gateway local

```sh
semantic-ir proxy --port 8787
```

Em outro terminal:

```sh
curl http://127.0.0.1:8787/health
```

O gateway usa o provider e modelo configurados acima e escuta somente em `127.0.0.1`. Aceita `POST /v1/chat/completions` com um único texto de usuário; recursos Chat Completions não suportados são encaminhados ao provider sem compilação. `GET /metrics` e `/dashboard` mostram contagens observadas e distinguem economia verificada como indisponível. Opcionalmente defina `SEMANTIC_IR_GATEWAY_KEY` para exigir `Authorization: Bearer ...`. O gateway não é um serviço público multiusuário.

## Calibração paga, opcional

Para testar a calibração com OpenAI, importe sua chave com `semantic-ir credentials import --provider openai` e configure preços atuais da sua conta em USD por milhão de tokens. Os valores abaixo são **marcadores**, não preços atuais:

```sh
semantic-ir configure --model SEU_MODELO \
  --input-price PRECO --cached-price PRECO --output-price PRECO --price-version DATA_OU_TABELA
semantic-ir benchmark --model SEU_MODELO --task extraction --allow-spend \
  --max-requests 40 --max-tokens 8000 --max-cost-usd 0.10 --max-duration-ms 120000
```

`benchmark` não promove profile; `calibrate` ou `optimize` só promovem se calibration, validation e holdout passarem. Os limites monetários são calculados com os preços fornecidos pelo usuário e a contagem do provider; confira esses preços antes de autorizar gasto. Sem chave, preço, oracle ou evidência suficiente, o sistema não promove um codec. Para outras tarefas, forneça uma suite JSON com casos pontuados em cada split (`--suite caminho.json`).

Veja [arquitetura](docs/architecture.md), [integrações](docs/integrations.md), [testes e publicação](docs/testing-and-release.md), [decisão sobre hosts](docs/decisions/0002-host-integrations.md) e [status por fase](docs/phases.md).
