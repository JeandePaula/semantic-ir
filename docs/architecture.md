# Arquitetura implementada

O fluxo controlado é `texto → SemanticIR → codec por modelo/tarefa → provider → avaliação/saída`. O texto original acompanha o IR em memória e permanece o fallback. O analisador é heurístico e parcial; não reivindica compreensão completa ou entailment formal.

| Componente | Responsabilidade atual |
| --- | --- |
| `packages/semantic-ir` | Schema `sir/0.1`, validação e hash canônico. |
| `packages/lossless-islands` | Spans literais com offsets e checksums. |
| `packages/semantic-analyzer` | Tarefa, constraints, negações e confidence conservadores. |
| `packages/core` | API de análise, contratos e seleção de estratégia por scope/capacidade. |
| `packages/engine` | Codec DSL, OpenAI adapter, benchmark, evaluator exato, otimizador, profiles SQLite e runtime. |
| `apps/cli` | CLI, MCP stdio, gateway local, dashboard mínimo e matriz de hosts. |
| `integrations/` | Somente manifests e skills específicos de Codex, Claude Code, Antigravity e MCP genérico. |

O `CodecDefinition` é JSON declarativo validado por Zod; não executa código, shell ou expressões. Além das variantes de formatação/metadata, o codec `context_dedupe` remove linhas idênticas dentro de blocos explícitos `CONTEXT`/`CONTEXTO` em tarefas de extração; perguntas sobre contagem ou repetição não são transformadas. Antes de enviar uma versão compilada, o compilador verifica o checksum da fonte, presença e multiplicidade de literais e constraints explícitas. Esses checks são necessários, mas não provam equivalência semântica universal.

As suites embutidas contêm casos de extração com resposta exata e splits calibration/validation/holdout; `redundant-extraction` usa contexto repetido. Somente casos com oracle exato participam da seleção. O otimizador compara a resposta do prompt original com candidatos, exige sucesso exato e custo menor em cada caso. Para OpenRouter usa custo medido pelo provider; para OpenAI pode usar preço configurado e usage observado. O holdout é consultado só depois da seleção em calibration e validation. Nenhum perfil é promovido quando falta oracle, custo ou confirmação. Categorias abertas exigem avaliadores próprios antes de otimização automática.

O `BudgetLedger` reserva tokens e custo antes de cada inferência e para quando o teto de requests, tokens, custo calculado ou tempo é atingido. OpenAI usa a pré-contagem do provider. OpenRouter usa um envelope estimado de bytes, limite de saída e preço do catálogo com `provider.max_price`; cada resposta é checada contra a reserva e custo medido. O limite local em USD não é uma garantia absoluta; um limite de gasto na chave OpenRouter fornece uma barreira externa. Cached input é subconjunto de input. Reasoning pode ser subconjunto do output ou informado de outro modo; não somar esses campos sem confirmar o contrato do provider. O custo da calibração aparece no relatório persistido, separado das métricas de inferência do usuário.

Os profiles estáveis ficam em SQLite, associados ao fingerprint de provider/modelo/snapshot/capacidades e classe de tarefa. Mudança de fingerprint marca o profile para reverificação. O router usa o original diante de risco alto, profile ausente, drift, codec inválido ou erro de compilação; uma chamada compilada que falha tenta o original. Métricas locais armazenam IDs, scope, modelo, usage e motivo de fallback, sem texto de prompt/resposta.

O adapter OpenAI usa Responses para o caminho de texto simples e `responses/input_tokens` para pré-contagem. O adapter OpenRouter usa Chat Completions, preços do catálogo e usage/custo medidos após cada chamada. A ausência de pré-contagem exata é exposta no relatório como `conservative_byte_envelope`. O gateway em `127.0.0.1` aceita uma forma restrita de Chat Completions; recursos não suportados são encaminhados sem compilação. MCP e plugins usam o mesmo engine. O dashboard distingue economia da amostra holdout de economia de produção, ainda indisponível sem comparação em tráfego real. Chamadas ao provider exigem credencial própria via variável de ambiente ou arquivo privado; o produto não tenta usar credenciais internas de agentes.

`safe` retorna texto normal; `structured` tenta parse local de JSON; `agent` retorna um novo IR da resposta. `SemanticState` e `SemanticDelta` são protótipos locais, sem estado distribuído. Anthropic e Gemini como providers diretos, modelos locais, streaming transformado, cobrança SaaS e otimização do prompt primário dos agentes permanecem extensões futuras.

As interfaces e o modelo de persistência estão em [data-model.md](data-model.md). Os limites dos hosts e fontes oficiais estão em [ADR 0002](decisions/0002-host-integrations.md).
