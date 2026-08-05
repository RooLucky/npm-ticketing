import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderOpenApiDocument } from "./openapi.js";

const directory = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(directory, "../openapi/ticketing-v1.yaml");
const generated = renderOpenApiDocument();
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, "\n");

if (process.argv.includes("--stdout")) {
  process.stdout.write(generated);
} else if (process.argv.includes("--check")) {
  const committed = await readFile(outputPath, "utf8").catch(() => "");
  if (normalizeNewlines(committed) !== normalizeNewlines(generated)) {
    console.error(
      "The committed OpenAPI document is stale. Run `npm run contract:generate` and commit the result.",
    );
    process.exitCode = 1;
  } else {
    console.log("OpenAPI contract is up to date.");
  }
} else {
  await writeFile(outputPath, generated, "utf8");
  console.log(`Generated ${outputPath}`);
}
