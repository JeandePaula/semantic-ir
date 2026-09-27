import type { SemanticIR } from "@semantic-ir/core";

/** Validate grammar, then remove only JSON whitespace outside strings. Do not reserialize:
 * that would round large numbers, collapse duplicate keys and rewrite escapes. */
export function compactJsonValue(source: string): string {
  try { JSON.parse(source); } catch { return source; }
  let quoted = false;
  let escaped = false;
  let output = "";
  for (const char of source) {
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      output += char;
    } else if (!/[ \t\r\n]/.test(char)) {
      output += char;
    }
  }
  return output;
}

export function compactJsonLiteral(text: string): string {
  const fence = /^(\x60{3}json[^\n]*\n)([\s\S]*?)(\r?\n?\x60{3})$/i.exec(text);
  return fence ? fence[1] + compactJsonValue(fence[2] ?? "") + fence[3] : compactJsonValue(text);
}

export function compactJsonPrompt(ir: SemanticIR): string {
  // Formatting and source reproduction are distinct tasks, even if data is also extracted.
  if (!["extraction", "structured_output"].includes(ir.intent.task) ||
      /\b(?:verbatim|verbatimly|byte|bytes|whitespace|indentation|indent|formatting|format|checksum|hash|signature|original|unchanged|unmodified|exactly|length|size|offset|position|literalmente|formata[çc][ãa]o|espa[çc]os|linhas|lines|columns|colunas|caracteres|characters|tamanho|comprimento|posi[çc][ãa]o|inalterad[oa]|exatamente|assinatura|copy|copie|reproduce|reproduza)\b/i.test(ir.source.text)) {
    return ir.source.text;
  }
  let text = ir.source.text;
  for (const literal of [...ir.literals].reverse()) {
    if (literal.kind !== "json") continue;
    text = text.slice(0, literal.start) + compactJsonLiteral(literal.text) + text.slice(literal.end);
  }
  return text;
}
