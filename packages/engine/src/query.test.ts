import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compileJsonQuery, executeLocalTask } from "./index.js";

const data = [{ id: "a", priority: 2, active: true, region: "BR", cents: 400 },
  { id: "b", priority: 9, active: true, region: "BR", cents: 800 },
  { id: "c", priority: 10, active: false, region: "BR", cents: 100 },
  { id: "d", priority: 2, active: true, region: "PT", cents: 200 }];
const filter = { op: "filter", all: [{ op: "eq", path: ["active"], value: true },
  { op: "eq", path: ["region"], value: "BR" }] };
const task = (steps: unknown[], rows: unknown = data) => ({ kind: "json_query_v1", data: rows, path: [], steps });

describe("explicit local query compiler", () => {
  it("filters conjunctions and sorts descending without mutating data", () => {
    const input = task([filter, { op: "sort", by: [{ path: ["priority"], direction: "desc", type: "integer" }] },
      { op: "project", path: ["id"] }]);
    const before = JSON.stringify(input);
    expect(executeLocalTask(input)).toMatchObject({ result: ["b", "a"], usage: { providerCalls: 0 }, costUsd: 0 });
    expect(JSON.stringify(input)).toBe(before);
    const plan = compileJsonQuery(input);
    expect(plan.steps.map(step => step.outputType)).toEqual(["array", "array", "array"]);
    expect(plan.programSha256).toBe(compileJsonQuery({ ...input, data: [] }).programSha256);
    expect(plan.dataSha256).not.toBe(compileJsonQuery({ ...input, data: [] }).dataSha256);
  });
  it("sums exact integers and rejects overflow, unsafe values, missing paths and invalid programs", () => {
    expect(executeLocalTask(task([filter, { op: "sum", path: ["cents"] }])).result).toBe(1200);
    expect(executeLocalTask(task([{ op: "count" }], [])).result).toBe(0);
    for (const input of [task([{ op: "sum", path: [] }], [Number.MAX_SAFE_INTEGER, 1]),
      task([{ op: "sum", path: [] }], [0.1]), task([{ op: "project", path: ["missing"] }]),
      task([{ op: "count" }, { op: "project", path: [] }]), task([{ op: "eval", code: "1+1" }]),
      task([{ op: "sort", by: [{ path: [], type: "integer", direction: "asc" }] }], ["1"]),
      task([{ op: "filter", all: [{ op: "eq", path: ["active"], value: false },
        { op: "gte", path: ["missing"], value: 1 }] }]),
      task([{ op: "project", path: ["__proto__"] }]), task([{ op: "count" }], {})]) {
      expect(() => executeLocalTask(input)).toThrow();
    }
  });
  it("preserves stable ties and explicit string ordering", () => {
    const input = task([{ op: "sort", by: [{ path: ["priority"], type: "integer", direction: "asc" }] },
      { op: "project", path: ["id"] }]);
    expect(executeLocalTask(input).result).toEqual(["a", "d", "b", "c"]);
    expect(executeLocalTask(task([{ op: "sort", by: [{ path: [], type: "string", direction: "asc" }] }], ["z", "A", "a"])).result)
      .toEqual(["A", "a", "z"]);
  });
  it("matches independent arithmetic and ordering references on generated inputs", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: -100000, max: 100000 }), { maxLength: 100 }), rows => {
      const sorted = executeLocalTask(task([{ op: "sort", by: [{ path: [], direction: "desc", type: "integer" }] }], rows)).result as number[];
      expect(sorted).toEqual([...rows].sort((a, b) => b - a));
      const sum = executeLocalTask(task([{ op: "filter", all: [{ op: "gte", path: [], value: 0 }] },
        { op: "sum", path: [] }], rows)).result;
      expect(sum).toBe(rows.reduce((total, value) => total + Math.max(0, value), 0));
    }), { numRuns: 200 });
  });
});
