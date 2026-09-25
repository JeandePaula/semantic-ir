# Modelo de dados SQLite

O MVP usa `node:sqlite` no arquivo `~/.semantic-ir/semantic-ir.sqlite`, substituível com `SEMANTIC_IR_DB`. O schema é criado por `packages/engine/src/storage.ts` e mantém texto de prompts e respostas fora do banco por padrão.

| Tabela atual | Conteúdo |
| --- | --- |
| `codecs` | ID, definição declarativa JSON, status. |
| `profiles` | Provider, modelo, classe de tarefa, hash do fingerprint, codec estável e estado. |
| `profile_history` | Promoções e rollback com data. |
| `metrics` | Request ID, optimization scope, modelo, tarefa, codec, fallback, usage, custo estimado e latência. |
| `settings` | Modelo padrão e tabela de preço fornecida pelo usuário. |

`usage_json` tem input, cached input, output, reasoning e total, cada um nullable, mais a origem. Cached input é subconjunto de input; a relação de reasoning com output depende do contrato do provider. `cost_json` pode usar custo reportado pelo OpenRouter (`measured`) ou combinar usage observado com preços configurados (`estimated`). Ausência de dados permanece `null`, nunca vira economia zero.

O banco não armazena automaticamente casos privados, API keys ou texto das chamadas. O benchmark sintético é distribuído em código. A CLI não ativa treinamento com pedidos reais.

Para uma versão SaaS, o desenho deve migrar para entidades imutáveis de versão de codec, runs de otimização, avaliações por caso, fingerprints históricos e métricas de calibração separadas de inferência do cliente. Essa migração ainda não existe; o armazenamento atual é local e de usuário único.
