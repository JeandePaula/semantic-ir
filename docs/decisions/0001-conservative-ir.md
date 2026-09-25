# ADR 0001: IR conservador e fonte integral

**Status:** aceito para Phase 1.

Uma análise automática de linguagem natural não consegue provar, por si só, que capturou toda a intenção. O IR inicial mantém o prompt completo em memória e produz anotações parciais com offsets e proveniência. Constraints extraídas reproduzem trechos do original em vez de paráfrases. Literais têm checksum próprio. `analysis.status` marca a extração como parcial.

Consequência: esta fase não oferece compressão nem economia; oferece uma base auditável para testar codecs. Um codec que omita texto original não recebe confiança por round-trip estrutural apenas. É necessário testar preservação de literals, constraints, comportamento e qualidade contra baseline original.

Offsets são índices UTF-16, compatíveis com `slice()` em JavaScript. A persistência futura exclui `source.text` por padrão.
