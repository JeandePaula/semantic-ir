import { sha256, type LiteralSpan } from "@semantic-ir/semantic-ir";

type Kind = LiteralSpan["kind"];
type Candidate = { kind: Kind; start: number; end: number; priority: number };

function addMatches(
  source: string,
  candidates: Candidate[],
  pattern: RegExp,
  kind: Kind,
  priority: number,
  trimTrailing = false,
): void {
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined) continue;
    let end = match.index + match[0].length;
    if (trimTrailing) {
      while (end > match.index && /[.,;:!?)]/.test(source[end - 1] ?? "")) end--;
    }
    if (end > match.index) candidates.push({ kind, start: match.index, end, priority });
  }
}

function addFencedCode(source: string, candidates: Candidate[]): void {
  const pattern = /\x60{3}([^\n\x60]*)\r?\n[\s\S]*?\x60{3}/g;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const language = (match[1] ?? "").trim().toLowerCase();
    const kind: Kind =
      language === "json" ? "json" :
      language === "sql" ? "sql" :
      language === "xml" ? "xml" :
      language === "yaml" || language === "yml" ? "yaml" : "code";
    candidates.push({ kind, start: match.index, end: match.index + match[0].length, priority: 100 });
  }
}

function addJsonObjects(source: string, candidates: Candidate[]): void {
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{") continue;
    if (!/^\s*"/.test(source.slice(start + 1, start + 32))) continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < Math.min(source.length, start + 100_000); end++) {
      const char = source[end];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === "{") depth++;
      if (char === "}") depth--;
      if (depth !== 0) continue;
      const text = source.slice(start, end + 1);
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          candidates.push({ kind: "json", start, end: end + 1, priority: 90 });
          start = end;
        }
      } catch {
        // A brace in ordinary prose is not JSON.
      }
      break;
    }
  }
}

/**
 * Finds likely lossless islands. Unrecognized data remains protected by
 * SemanticIR.source.text; this scanner never claims semantic completeness.
 * Offsets are UTF-16 indices into the original JavaScript string.
 */
export function detectLiteralSpans(source: string): LiteralSpan[] {
  const candidates: Candidate[] = [];
  addFencedCode(source, candidates);
  addMatches(source, candidates, /\x60[^\x60\r\n]+\x60/g, "code", 95);
  addJsonObjects(source, candidates);
  addMatches(source, candidates, /<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g, "xml", 88);
  addMatches(source, candidates, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]{1,10000};/gi, "sql", 87);
  addMatches(source, candidates, /https?:\/\/[^\s<>"'\x60]+/g, "url", 85, true);
  addMatches(source, candidates, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "uuid", 84);
  addMatches(source, candidates, /\b[a-f0-9]{32,128}\b/gi, "hash", 82);
  addMatches(source, candidates, /(?:[A-Za-z]:\\|\\\\)[^\s"'\x60<>]+/g, "path", 81, true);
  addMatches(source, candidates, /(?:\/[A-Za-z0-9._{}-]+){2,}/g, "path", 80, true);
  addMatches(source, candidates, /\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._{}-]+/g, "path", 79, true);
  addMatches(source, candidates, /\/(?:\\.|[^/\n])+\/[dgimsuvy]*/g, "regex", 75);
  addMatches(source, candidates, /\b[A-Za-z_][\w-]*\.(?:tsx?|jsx?|py|json|ya?ml|sql|xml|md|txt|css|html|sh|toml)\b/gi, "filename", 74);
  addMatches(source, candidates, /\b(?:function|class|def)\s+[A-Za-z_]\w*/g, "identifier", 72);
  addMatches(source, candidates, /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, "date", 71);
  addMatches(source, candidates, /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, "time", 70);
  addMatches(source, candidates, /(?:[$€£]\s?\d+(?:[.,]\d+)*|\b(?:USD|EUR|BRL)\s?\d+(?:[.,]\d+)*)/g, "money", 69);
  addMatches(source, candidates, /(?<![\w])[-+]?\d+(?:[.,]\d+)*\s?%/g, "percentage", 68);
  addMatches(source, candidates, /["“][^"”\r\n]+["”]/g, "quoted", 60);
  addMatches(source, candidates, /(?<![\w])[-+]?\d+(?:[.,]\d+)*(?![\w])/g, "number", 10);

  // Prefer outer, high-confidence structures (code/JSON/URL) over inner tokens.
  candidates.sort((a, b) => b.priority - a.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const selected: Candidate[] = [];
  const occupied = new Uint8Array(source.length);
  for (const candidate of candidates) {
    if (!occupied.subarray(candidate.start, candidate.end).some((value) => value !== 0)) {
      selected.push(candidate);
      occupied.fill(1, candidate.start, candidate.end);
    }
  }
  selected.sort((a, b) => a.start - b.start);
  return selected.map((item, index) => {
    const text = source.slice(item.start, item.end);
    return { id: "L" + index, kind: item.kind, start: item.start, end: item.end, text, sha256: sha256(text) };
  });
}

export function verifyLiteralSpans(source: string, spans: readonly LiteralSpan[]): boolean {
  let previousEnd = 0;
  for (const span of spans) {
    if (span.start < previousEnd || span.start >= span.end || span.end > source.length) return false;
    const actual = source.slice(span.start, span.end);
    if (actual !== span.text || sha256(actual) !== span.sha256) return false;
    previousEnd = span.end;
  }
  return true;
}
