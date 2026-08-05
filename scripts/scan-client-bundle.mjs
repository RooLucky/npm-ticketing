import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const staticRoot = path.resolve(
  workspaceRoot,
  process.argv[2] ?? path.join("apps", "playground", ".next", "static"),
);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

let staticStats;
try {
  staticStats = await stat(staticRoot);
} catch (error) {
  throw new Error(`Client bundle directory does not exist: ${staticRoot}`, { cause: error });
}

if (!staticStats.isDirectory()) {
  throw new Error(`Client bundle path is not a directory: ${staticRoot}`);
}

const forbiddenValues = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_TICKETING_URL",
  "REDIS_TICKETING_URL",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "TICKETING_CLIENT_SECRET",
  "NEXT_PUBLIC_TICKETING_CLIENT_SECRET",
]);

const configuredSecret = process.env.TICKETING_CLIENT_SECRET;
if (!configuredSecret) {
  throw new Error(
    "TICKETING_CLIENT_SECRET must be set to a non-production sentinel before scanning the client bundle.",
  );
}
forbiddenValues.add(configuredSecret);
for (const name of [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_TICKETING_URL",
  "REDIS_TICKETING_URL",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
]) {
  const configured = process.env[name];
  if (configured) forbiddenValues.add(configured);
}

const files = await collectFiles(staticRoot);
if (files.length === 0) {
  throw new Error(`No client bundle files were found in ${staticRoot}.`);
}

let totalBytes = 0;
for (const file of files) {
  const content = await readFile(file);
  totalBytes += content.byteLength;

  for (const forbidden of forbiddenValues) {
    if (content.includes(Buffer.from(forbidden, "utf8"))) {
      throw new Error(
        `Client bundle contains forbidden ticketing secret material in ${path.relative(workspaceRoot, file)}.`,
      );
    }
  }
}

console.log(
  `Scanned ${files.length} client bundle files (${totalBytes} bytes); no ticketing secret material found.`,
);
