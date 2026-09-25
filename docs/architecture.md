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
| `integrations/` | Somente manifests e skills específicos de Codex, Claude Code e MCP genérico. |

O `CodecDefinition` é JSON declarativo validado por Zod; não executa código, shell ou expressões. Os codecs atuais preservam o texto original ou fazem mudanças pequenas de formatação/metadata. Antes de enviar uma versão compilada, o compilador verifica o checksum da fonte, presença e multiplicidade de literais e constraints explícitas. Esses checks são necessários, mas não provam equivalência semântica universal.

O benchmark embutido contém quatro casos de extração com resposta exata e splits calibration/validation/holdout. Somente casos com oracle exato participam da seleção. O otimizador compara a resposta do prompt original com candidatos, exige sucesso exato e custo menor usando usage observado e preços configurados. O holdout é consultado só depois da seleção em calibration e validation. Nenhum perfil é promovido quando falta oracle, custo ou confirmação. Categorias abertas exigem avaliadores próprios antes de otimização automática.

O `BudgetLedger` reserva o máximo de tokens de output configurado antes de cada inferência e para quando o teto de requests, tokens, custo calculado ou tempo é atingido. O teto em USD é uma estimativa baseada nos preços informados pelo usuário, não uma garantia de cobrança do provider. `inputTokens` inclui cached tokens como subconjunto; `outputTokens` inclui reasoning tokens como subconjunto. Não somar esses campos novamente. O custo de calibração aparece no relatório da execução, separado das métricas persistidas de inferência do usuário.

Os profiles estáveis ficam em SQLite, associados ao fingerprint de provider/modelo/snapshot/capacidades e classe de tarefa. Mudança de fingerprint marca o profile para reverificação. O router usa o original diante de risco alto, profile ausente, drift, codec inválido ou erro de compilação; uma chamada compilada que falha tenta o original. Métricas locais armazenam IDs, scope, modelo, usage e motivo de fallback, sem texto de prompt/resposta.

O adapter OpenAI usa Responses para o caminho de texto simples e `responses/input_tokens` para pré-contagem. O gateway em `127.0.0.1` aceita uma forma restrita de Chat Completions; recursos não suportados são encaminhados sem compilação. MCP e plugins usam o mesmo engine. O dashboard mostra contagens locais e `verified savings: unavailable` até existir comparação confiável de produção. Chamadas ao provider exigem credencial própria `OPENAI_API_KEY`; o produto não tenta usar credenciais internas de agentes.

`safe` retorna texto normal; `structured` tenta parse local de JSON; `agent` retorna um novo IR da resposta. `SemanticState` e `SemanticDelta` são protótipos locais, sem estado distribuído. Anthropic, Gemini, OpenRouter, modelos locais, streaming transformado, cobrança SaaS e otimização do prompt primário dos agentes permanecem extensões futuras.

As interfaces e o modelo de persistência estão em [data-model.md](data-model.md). Os limites dos hosts e fontes oficiais estão em [ADR 0002](decisions/0002-host-integrations.md).
