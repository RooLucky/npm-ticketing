import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
