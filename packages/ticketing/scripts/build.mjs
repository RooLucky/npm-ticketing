import { cp, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(packageRoot, "tsconfig.json")], {
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`TypeScript exited with ${code}`)));
});

await mkdir(path.join(packageRoot, "dist", "openapi"), { recursive: true });
await cp(
  path.join(workspaceRoot, "contracts", "openapi", "ticketing-v1.yaml"),
  path.join(packageRoot, "dist", "openapi", "ticketing-v1.openapi.yaml"),
);
