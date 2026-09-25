# Status de implementação

O plano da especificação v2 foi implementado como um **MVP local verificável**, com limites explícitos onde faltam provider real ou host instalado. `npm run check` é o gate automatizado.

| Fases da especificação | Estado |
| --- | --- |
| 1–3: IR, literals, Codec DSL, OpenAI adapter e usage | Implementado e coberto por testes locais. |
| 4–6: benchmark, evaluator e otimizador | Implementado para tarefas sintéticas com oracle exato; tarefas abertas não são pontuadas. |
| 7–8: orçamento, profiles, runtime, risco e fallback | Implementado. CLI exige consentimento de gasto e limites explícitos. |
| 9: MCP | Implementado; handshake real testado em processo separado. |
| 10: Codex plugin | Pacote portátil e marketplace gerados, schemas validados; smoke test dentro do Codex ainda necessário. |
| 11: Claude Code plugin | Manifest, skill, MCP e marketplace gerados; CLI Claude não disponível neste ambiente para teste no host. |
| 12–13: empacotamento, matriz, drift e rollback | Implementado de forma conservadora; instalação/habilitação no host permanece verificação manual. |
| 14: gateway, SDK e dashboard mínimo | Gateway e API TypeScript locais implementados; dashboard mostra apenas métricas disponíveis. |
| 15: agent mode e state/delta | Protótipo local implementado; sem infraestrutura distribuída. |
| 16: outros hosts | Não iniciado; requer validação de formatos oficiais antes de prometer suporte. |

Ainda faltam evidências de economia real, avaliação robusta para coding/reasoning, testes end-to-end em Claude Code, publicação em GitHub/npm e operação SaaS. O produto permanece em fallback por padrão até um experimento passar os gates para o modelo e a tarefa concretos.
