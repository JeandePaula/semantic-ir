# Status de implementação

O plano da especificação v2 foi implementado como um **MVP local verificável**, com limites explícitos onde faltam provider real ou host instalado. `npm run check` é o gate automatizado.

| Fases da especificação | Estado |
| --- | --- |
| 1–3: IR, literals, Codec DSL, OpenAI/OpenRouter adapters e usage | Implementado. OpenAI usa pré-contagem; OpenRouter usa reserva conservadora e custo medido depois da resposta. |
| 4–6: benchmark, evaluator e otimizador | Implementado para tarefas fechadas com oracle exato, incluindo uma suite de contexto repetido; tarefas abertas não são pontuadas. |
| 7–8: orçamento, profiles, runtime, risco e fallback | Implementado. CLI exige consentimento de gasto e limites explícitos. |
| 9: MCP | Implementado; handshake real testado em processo separado. |
| 10: Codex plugin | Instalado no Codex Windows com ponte WSL; o usuário confirmou `doctor`, análise e chamada paga real dentro de uma tarefa. |
| 11: Claude Code plugin | Pacote distribuído; a conexão MCP foi confirmada em uma instalação anterior. Uma chamada paga dentro do Claude ainda depende de verificação pelo usuário. |
| 12–13: empacotamento, matriz, drift e rollback | Implementado de forma conservadora; instalação/habilitação no host permanece verificação manual. |
| 14: gateway, SDK e dashboard mínimo | Gateway e API TypeScript locais implementados; dashboard mostra apenas métricas disponíveis. |
| 15: agent mode e state/delta | Protótipo local implementado; sem infraestrutura distribuída. |
| 16: outros hosts | Plugin para Google Antigravity empacotado e copiado para o diretório do IDE Windows; descoberta dentro do IDE ainda depende de verificação. |

Economia medida na suite fechada é evidência apenas daquela classe e amostra; validação robusta para coding/reasoning, métricas de produção, publicação npm e operação SaaS permanecem trabalhos futuros. O repositório está publicado no GitHub. O produto permanece em fallback por padrão até um experimento passar os gates para o modelo e a tarefa concretos.
