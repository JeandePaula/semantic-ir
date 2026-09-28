import { writeFile } from "node:fs/promises";
import { semanticIRJsonSchema } from "../packages/semantic-ir/dist/index.js";
import { CodecDefinitionSchema } from "../packages/engine/dist/codec.js";
import { LocalTaskSchema, ResponseContractSchema, JsonOutputShapeSchema } from "../packages/engine/dist/index.js";
import { z } from "zod";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://semantic-ir.local/schemas/semantic-ir-0.1.schema.json",
  ...semanticIRJsonSchema(),
};

await writeFile(
  new URL("../schemas/semantic-ir-0.1.schema.json", import.meta.url),
  JSON.stringify(schema, null, 2) + "\n",
  "utf8",
);
await writeFile(
  new URL("../schemas/codec-0.1.schema.json", import.meta.url),
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://semantic-ir.local/schemas/codec-0.1.schema.json",
    ...z.toJSONSchema(CodecDefinitionSchema),
  }, null, 2) + "\n",
  "utf8",
);
for (const [name, definition] of [["local-task-v1", LocalTaskSchema], ["response-contract-v1", ResponseContractSchema],
  ["json-output-shape-v1", JsonOutputShapeSchema]]) {
  await writeFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://semantic-ir.local/schemas/${name}.schema.json`,
    ...z.toJSONSchema(definition),
  }, null, 2) + "\n");
}
