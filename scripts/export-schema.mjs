import { writeFile } from "node:fs/promises";
import { semanticIRJsonSchema } from "../packages/semantic-ir/dist/index.js";
import { CodecDefinitionSchema } from "../packages/engine/dist/codec.js";
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
