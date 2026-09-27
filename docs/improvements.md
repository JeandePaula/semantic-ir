# Diagnóstico e melhorias

## Correção posterior: execução local e validação da resposta

O teste complexo mostrou que o defeito não estava apenas no compressor: o original também errava contas e alocação. Em 27/09/2026, o fluxo foi simplificado para **operação local explícita → resultado verificado → LLM quando necessário**. A skill orienta essa escolha; código testado aplica as regras. A comparação das técnicas pesquisadas, fontes e limites está em [quality-workflow.md](quality-workflow.md).

- `execute_local` / CLI `execute` resolvem seleção de JSON e alocação sob contratos versionados. O resultado completo do teste complexo corresponde ao gabarito independente anterior: 8 aprovados, 6 rejeitados, 1 cancelado e 4 eventos superados, com todos os valores e estoques corretos. Os seis casos de extração também acertaram, sem chamadas pagas.
- Cálculos monetários usam BigInt internamente. Dados ambíguos, referências inválidas, chaves repetidas no JSON textual, números imprecisos e regras não suportadas são rejeitados. O motor não tenta deduzir regras arbitrárias a partir de texto livre.
- CLI `--out` grava a resposta exata em arquivo novo e devolve um recibo curto, evitando devolver todo o payload ao contexto do agente. As skills de Codex, Claude Code e Antigravity incluem o passo a passo e os contratos.
- `invoke` / `invoke_prompt` / SDK aceitam `responseContract`; respostas divergentes ou incompletas não são entregues como sucesso. Usage e custo disponíveis são registrados antes da rejeição, sem retry pago automático. Sem referência independente, o status é `unverified`.
- O [relatório local](reports/local-execution.json) e a [resposta completa correta](experiments/complex-json/local-result.json) são reproduzíveis com `npm run verify:local`. O verificador rejeitou as quatro respostas históricas, preservando esses arquivos e o gabarito original.

Nessas operações formais, a execução evita **100% dos tokens de inferência downstream**. Isso não elimina os tokens do Codex/host, o esforço de implementação ou o custo da máquina. Não é uma promessa de compactação universal nem de qualidade garantida para perguntas abertas. Os resultados pagos abaixo permanecem como evidência histórica, incluindo as falhas.

A revisão identificou que reduzir a entrada, isoladamente, não resolve custo por tarefa. O relatório local de calibração de 25/09/2026 tinha dois casos corretos: ambos passaram de 586 para 59 tokens de entrada, mas as saídas cresceram de 34 para 62 e de 54 para 67 tokens. No primeiro, o custo subiu de US$ 0,000010970 para US$ 0,000011335. Não houve promoção nem holdout; as cinco chamadas registradas usaram fallback. Esses números pertencem à versão anterior. O relatório antigo não separava reasoning/cache por caso, portanto não é possível atribuir o crescimento especificamente a reasoning.

Outras causas observadas:

- Tags acrescentavam conteúdo; mutações alteravam parâmetros sem efeito ou recriavam a mesma saída, consumindo calibração sem uma redução útil.
- Espaçamento trazia reduções de apenas um byte nos casos básicos; JSON, embora frequente em dados de aplicação, permanecia intacto.
- A reserva conservadora era consumida integralmente mesmo quando a cobrança real era muito menor, esgotando o orçamento prematuramente.
- Variação de latência podia vetar um candidato correto e mais barato.
- Ter uma tabela de preço configurada desativava o cache de respostas OpenRouter inclusive no runtime.
- Nenhum relatório mostrava quanto uso seria necessário para recuperar o custo da calibração.

## Melhorias anteriores de compactação

1. Auditoria local na CLI (`audit`) e MCP (`audit_prompt`), sem inferências. O planejador descarta entradas maiores, reduções inferiores a 128 bytes e resultados duplicados antes da primeira chamada. A classe pública `EvolutionaryOptimizer` foi preservada por compatibilidade, mas a busca agora avalia candidatos úteis, sem as mutações redundantes anteriores.
2. Codec `json_compact`, com transformação lexical verificável. Remove somente whitespace JSON fora de strings; preserva números, escapes, chaves repetidas e ordem. A reprodução integral do transform é exigida para flexibilizar o checksum textual de um literal JSON. Casos que pedem o original, tamanho, posição, formatação, hash ou reprodução literal não são transformados.
3. Suite JSON com seis casos, dois por split. A seleção continua exigindo sucesso exato do original e candidato e redução de pelo menos 1% do custo total em cada caso. Prompts e IDs duplicados são rejeitados para evitar vazamento entre splits. Uma falha encerra o candidato, preservando o orçamento.
4. Reconciliação de tokens e custos após respostas válidas. Falhas com cobrança desconhecida retêm suas reservas. Valores cobrados são registrados antes de interromper um estouro de teto.
5. Diagnóstico de entrada, saída, reasoning, cached input e custo. A amortização inclui o gasto de toda a execução, não apenas do codec vencedor, e permanece uma projeção baseada no holdout.
6. Configuração explícita de reasoning OpenRouter, vinculada ao fingerprint. O cache de respostas é desativado apenas para a calibração. O runtime também rejeita codecs que aumentam o payload.
7. Falhas do provider no runtime não disparam automaticamente uma segunda inferência paga com o original. Fallback por perfil/compilação continua local, antes de enviar qualquer chamada.

## Comparação local reproduzível

```sh
npm run check
npm run build
npm run audit:savings -- --out docs/reports/local-compression.json
node apps/cli/bundle/main.js audit --suite json-extraction
```

| Suite | Original (bytes) | Melhor codec anterior (bytes) | Seleção atual (bytes) |
| --- | ---: | ---: | ---: |
| JSON, seis casos | 18.636 | 18.636 | 7.185 |
| Contexto repetido, seis casos | 16.836 | 1.398 | 1.398 |
| Prompts curtos, quatro casos | 187 | 183 | 187, sem calibração paga |

Os 61,45% são redução de bytes da suite JSON, não de tokens faturados. Os 93 testes usam adapters simulados para verificar orçamento, falhas, promoção, amortização e chamadas evitadas. Propriedades geradas verificam o roundtrip de valores JSON; casos dedicados verificam números grandes, chaves duplicadas e escapes.

## Teste pago autorizado em 26/09/2026

Provider OpenRouter, modelo `z-ai/glm-5.3-flash`, reasoning padrão, saída limitada a 256 tokens. O usuário autorizou até US$ 0,02 e 24 requisições; o experimento consumiu 14 chamadas, 8.546 tokens totais reportados e US$ 0,000618 medidos. A calibração usou os seis casos da suite JSON; a verificação adicional usou uma entrada nova com 22 registros e resposta esperada `MAGENTA`.

| Medição | Original | Compactado | Resultado |
| --- | ---: | ---: | --- |
| Custo dos dois casos holdout | US$ 0,00010912 | US$ 0,00007260 | 33,47% menor |
| Custo do par adicional | US$ 0,00006408 | US$ 0,00004492 | 29,90% menor |
| Tokens de entrada do par adicional | 1.002 | 548 | 45,31% menos |
| Tokens de saída do par adicional | 48 | 46 | Resposta `MAGENTA` em ambos |

Todos os seis pares da calibração e o par adicional acertaram. O codec foi promovido; a entrada nova foi roteada como `compiled` usando `json_compact@0.1.0`.

Os candidatos holdout tiveram 256 tokens de entrada em cache cada, enquanto os originais não tiveram cache. Portanto os 33,47% incluem esse efeito. No par adicional ambos reportaram zero cached input, confirmando uma redução observada também sem essa vantagem. O candidato adicional foi chamado antes do original; um único par adicional não estima variabilidade estatística. Nenhuma configuração de reasoning foi alterada.

A calibração isolada custou US$ 0,000509 e projeta amortização em 28 chamadas com os mesmos custos médios do holdout. Incluindo o par adicional, recuperar todo o gasto de US$ 0,000618 exigiria aproximadamente 34 chamadas sob essa mesma hipótese. Não é economia líquida já realizada em produção.

Evidências: [calibração completa](reports/openrouter-json-calibration.json), [verificação do runtime e par adicional](reports/openrouter-json-runtime.json). O comando de calibração usado foi:

```sh
node apps/cli/bundle/main.js calibrate --model z-ai/glm-5.3-flash \
  --task extraction --suite json-extraction --allow-spend \
  --max-requests 24 --max-tokens 100000 --max-cost-usd 0.02 \
  --max-duration-ms 240000 --max-output-tokens 256
```

Reexecutar esse comando gera novas cobranças e uma nova amostra; os limites acima pertencem a cada execução. O par adicional foi executado com `BudgetLedger` usando apenas o saldo de requisições, tokens e dólares do experimento autorizado.

## Limites que permanecem

O [teste posterior com um prompt complexo](experiments/complex-json/README.md) não confirmou preservação da qualidade: nas duas respostas retornadas por versão, normal e compactada tiveram 0/2 resultados integralmente corretos. A versão compactada custou 24,37% menos nesses pares, mas isso não é economia por tarefa bem-sucedida. Uma resposta normal foi truncada; a quinta tentativa não retornou texto e manteve uma reserva de cobrança desconhecida. O runtime bloqueou a compactação automática desse prompt devido às 18 constraints, e esse limite foi preservado.

Esta é uma otimização focada em extração de dados, sem reescrita semântica por outro LLM. JSON já compacto, código, tarefas abertas e prompts curtos podem não oferecer redução. A verificação lexical não prova que qualquer modelo terá comportamento idêntico; a promoção continua condicionada aos testes pagos nos três splits.

O plugin não intercepta a inferência principal de Codex/Claude. Para afetar cobrança, a aplicação precisa usar a CLI, SDK, MCP downstream ou gateway. Instalar o plugin sozinho não reduz o consumo do host. O uso geral em coding/reasoning requer outros avaliadores e evidência; não se deve promover este codec com base apenas nesses casos de extração.

O controle de reasoning segue a [API OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). `exclude` somente oculta reasoning; esses tokens continuam cobrados. A política de cache segue a [documentação de cache de respostas](https://openrouter.ai/docs/guides/features/response-caching). Suporte a níveis de reasoning e comportamento de cache dependem do modelo/provider.
