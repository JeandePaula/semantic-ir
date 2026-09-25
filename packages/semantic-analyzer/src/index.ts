import {
  parseSemanticIR,
  sha256,
  type Claim,
  type Constraint,
  type LiteralSpan,
  type SemanticIR,
  type TaskClass,
} from "@semantic-ir/semantic-ir";
import { detectLiteralSpans } from "@semantic-ir/lossless-islands";

const TASK_RULES: ReadonlyArray<{ task: TaskClass; pattern: RegExp }> = [
  { task: "code_review", pattern: /\b(?:code review|review this code|revis[ãa]o de c[oó]digo|security review)\b/i },
  { task: "debugging", pattern: /\b(?:debug|fix (?:this |the )?bug|traceback|stack trace|corrija (?:o )?erro)\b/i },
  { task: "coding", pattern: /\b(?:implement|write (?:a |the )?(?:function|class|code)|refactor|implemente|codifique)\b/i },
  { task: "math", pattern: /\b(?:calculate|solve (?:the )?equation|calcule|resolva a equa[çc][ãa]o)\b/i },
  { task: "extraction", pattern: /\b(?:extract|parse (?:the )?data|extraia|extrair)\b/i },
  { task: "summarization", pattern: /\b(?:summari[sz]e|resuma|resumir)\b/i },
  { task: "translation", pattern: /\b(?:translate|traduza|traduzir)\b/i },
  { task: "creative_writing", pattern: /\b(?:write a story|poem|escreva (?:uma )?hist[oó]ria|poema)\b/i },
  { task: "tool_use", pattern: /\b(?:call (?:the )?tool|use (?:the )?tool|use a ferramenta)\b/i },
  { task: "structured_output", pattern: /\b(?:output (?:as|in) json|retorne json|json schema)\b/i },
  { task: "agent_communication", pattern: /\b(?:agent.to.agent|entre agentes)\b/i },
  { task: "rag", pattern: /\b(?:retrieval.augmented|use the retrieved|documentos recuperados)\b/i },
];

const MARKERS: ReadonlyArray<{ pattern: RegExp; polarity: Constraint["polarity"] }> = [
  { pattern: /\b(?:do not|don['’]t|must not|cannot|can['’]t|never|without|avoid|no)\b/gi, polarity: "negative" },
  { pattern: /\b(?:n[ãa]o|nunca|sem|evite|proibido)\b/gi, polarity: "negative" },
  { pattern: /\b(?:only|unless|except|somente|apenas|exceto)\b/gi, polarity: "restrictive" },
  { pattern: /\b(?:before|after|antes|depois)\b/gi, polarity: "temporal" },
  { pattern: /\b(?:must|required|preserve|deve|obrigat[oó]rio|preserve)\b/gi, polarity: "positive" },
];

function classifyTask(prompt: string): { task: TaskClass; confidence: number } {
  for (const rule of TASK_RULES) {
    if (rule.pattern.test(prompt)) return { task: rule.task, confidence: 0.55 };
  }
  return { task: "unknown", confidence: 0 };
}

function inLiteral(index: number, literals: readonly LiteralSpan[]): boolean {
  let low = 0;
  let high = literals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const literal = literals[middle];
    if (!literal) break;
    if (index < literal.start) high = middle;
    else if (index >= literal.end) low = middle + 1;
    else return true;
  }
  return false;
}

function buildClauses(prompt: string): Array<{ start: number; end: number }> {
  const boundaries = /[.!?](?=\s|$)|[;\n]/g;
  const clauses: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of prompt.matchAll(boundaries)) {
    if (match.index === undefined) continue;
    let end = match.index;
    while (start < end && /\s/.test(prompt[start] ?? "")) start++;
    while (end > start && /\s/.test(prompt[end - 1] ?? "")) end--;
    if (start < end) clauses.push({ start, end });
    start = match.index + match[0].length;
  }
  let end = prompt.length;
  while (start < end && /\s/.test(prompt[start] ?? "")) start++;
  while (end > start && /\s/.test(prompt[end - 1] ?? "")) end--;
  if (start < end) clauses.push({ start, end });
  return clauses;
}

function clauseAt(clauses: readonly { start: number; end: number }[], index: number): { start: number; end: number } | null {
  let low = 0;
  let high = clauses.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const clause = clauses[middle];
    if (!clause) break;
    if (index < clause.start) high = middle;
    else if (index >= clause.end) low = middle + 1;
    else return clause;
  }
  return null;
}

function extractConstraints(prompt: string, literals: readonly LiteralSpan[]): {
  constraints: Constraint[];
  prohibitions: Claim[];
} {
  const matches: Array<{ index: number; marker: string; polarity: Constraint["polarity"] }> = [];
  for (const rule of MARKERS) {
    for (const match of prompt.matchAll(rule.pattern)) {
      if (match.index === undefined || inLiteral(match.index, literals)) continue;
      matches.push({ index: match.index, marker: match[0], polarity: rule.polarity });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.marker.length - a.marker.length);
  const constraints: Constraint[] = [];
  const prohibitions: Claim[] = [];
  const clauses = buildClauses(prompt);
  let lastEnd = -1;
  for (const match of matches) {
    // A composite marker such as "must not" should yield one constraint.
    if (match.index < lastEnd) continue;
    lastEnd = match.index + match.marker.length;
    const span = clauseAt(clauses, match.index);
    if (!span) continue;
    const text = prompt.slice(span.start, span.end);
    const id = "C" + constraints.length;
    const constraint: Constraint = {
      id, text, marker: match.marker, strength: "hard", polarity: match.polarity,
      start: span.start, end: span.end, confidence: 0.65,
      provenance: { kind: "source_text", start: span.start, end: span.end, method: "modality_marker" },
    };
    constraints.push(constraint);
    if (match.polarity === "negative") {
      prohibitions.push({
        id: "P" + prohibitions.length, text, confidence: 0.65,
        provenance: constraint.provenance,
      });
    }
  }
  return { constraints, prohibitions };
}

/** A conservative baseline analyzer. It never paraphrases or removes source text. */
export function analyzePrompt(prompt: string): SemanticIR {
  if (prompt.length === 0) throw new Error("Prompt must not be empty");
  const literals = detectLiteralSpans(prompt);
  const task = classifyTask(prompt);
  const { constraints, prohibitions } = extractConstraints(prompt, literals);
  return parseSemanticIR({
    version: "sir/0.1",
    source: { text: prompt, sha256: sha256(prompt) },
    intent: {
      task: task.task, confidence: task.confidence,
      provenance: { kind: "heuristic", method: "task_keywords_v1" },
    },
    goals: [],
    facts: [],
    entities: [],
    assumptions: [],
    constraints,
    prohibitions,
    preferences: [],
    priorities: [],
    dependencies: [],
    relationships: [],
    contextReferences: [],
    uncertainty: [],
    formattingRequirements: [],
    toolRequirements: [],
    literals,
    analysis: {
      status: "partial", analyzerVersion: "baseline/0.1",
      confidence: 0.25,
      warnings: ["Heuristic annotations are incomplete; retain source text and use original-prompt fallback."],
    },
  });
}
