import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyzePrompt, sha256 } from '@semantic-ir/core';
import { compilePrompt, DEFAULT_CODECS, prepareResponseValidator, validateCompiled } from '@semantic-ir/engine';

const dir = new URL('./', import.meta.url);
if (existsSync(new URL('results.json', dir))) throw new Error('Paid evidence exists; fixtures must not be changed');
mkdirSync(dir, { recursive: true });
const cases = [];
const records = Array.from({ length: 28 }, (_, i) => ({
  id: `new-${i}`, label: `Item ${i}`, active: i % 3 === 0, region: i % 2 ? 'east' : 'west',
  metadata: { owner: `Team ${i % 4}`, tags: ['stock', 'reviewed'], revision: i + 1 },
}));
function add(id, group, normal, expected, maxOutputTokens) {
  const ir = analyzePrompt(normal);
  const compiled = compilePrompt(ir, DEFAULT_CODECS.find(c => c.id === 'json_compact'));
  if (compiled.text === normal || validateCompiled(ir, compiled).length) throw new Error('Invalid compaction: ' + id);
  const responseContract = { kind: 'exact_json', expected: JSON.stringify(expected) };
  prepareResponseValidator(responseContract);
  cases.push({ id, group, normal, compact: compiled.text, responseContract, maxOutputTokens,
    prompts: Object.fromEntries(Object.entries({ normal, compact: compiled.text }).map(([version, text]) =>
      [version, { bytes: Buffer.byteLength(text), sha256: sha256(text) }])) });
}
function jsonCase(id, instruction, data, expected) {
  add(id, 'extraction', instruction + '\n```json\n' + JSON.stringify(data, null, 4) + '\n```', expected, 512);
}
jsonCase('nested-color', 'Extract launch.color from the data. Respond with only a JSON string.',
  { records, launch: { color: 'CORAL', status: 'ready' } }, 'CORAL');
jsonCase('large-string-id', 'Extract the code of the record whose id is "900719925474099312". Respond with only a JSON string.',
  { records: records.map((r, i) => ({ ...r, id: `9007199254740993${i}`, code: i === 12 ? 'TURQUOISE' : `C-${i}` })) }, 'TURQUOISE');
jsonCase('filtered-labels', 'Extract the labels of active records in region "west", preserving record order. Respond with only a JSON array of strings.',
  { records }, ['Item 0', 'Item 6', 'Item 12', 'Item 18', 'Item 24']);
const launch = { id: '9007199254740993999', name: 'São João 東京', enabled: false, roles: ['reader', 'reviewer'], note: 'Quote: "hello"; path: C:\\data' };
jsonCase('structured-record', 'Extract launch as a JSON object containing all its fields. Respond only with that object.',
  { records, launch }, launch);
const complexDir = new URL('../complex-json/', import.meta.url);
add('complex-allocation', 'complex', readFileSync(new URL('prompt.txt', complexDir), 'utf8').trimEnd(),
  JSON.parse(readFileSync(new URL('expected.json', complexDir), 'utf8')), 12288);

// Save all prompts and trusted references before any provider calls.
writeFileSync(new URL('cases.json', dir), JSON.stringify({ version: 1, cases }, null, 2) + '\n');
console.log(JSON.stringify(cases.map(({ id, group, prompts, maxOutputTokens }) => ({ id, group, prompts, maxOutputTokens })), null, 2));
