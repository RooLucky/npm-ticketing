import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error("npm_execpath is unavailable. Run this check through `npm run pack:verify`.");
}

const output = await run(process.execPath, [
  npmCliPath,
  "pack",
  "--workspace=@quanby/ticketing",
  "--dry-run",
  "--json",
]);
const jsonBoundary = output.lastIndexOf("\n[");
const packJson = (jsonBoundary === -1 ? output : output.slice(jsonBoundary + 1)).trim();
const [pack] = JSON.parse(packJson);
const names = new Set(pack.files.map((file) => file.path.replaceAll("\\", "/")));

for (const required of [
  "dist/cli/index.js",
  "dist/openapi/ticketing-v1.openapi.yaml",
  "templates/manifest.json",
  "README.md",
  "LICENSE",
  "package.json",
]) {
  if (!names.has(required)) {
    throw new Error(`Packed package is missing ${required}`);
  }
}

for (const name of names) {
  if (
    name.startsWith("test/") ||
    name.startsWith("src/") ||
    /(^|\/)\.env(?:\.|$)/u.test(name) ||
    name.endsWith(".tgz")
  ) {
    throw new Error(`Unexpected packed file: ${name}`);
  }
}

console.log(`Verified ${pack.name}@${pack.version}: ${pack.files.length} files, ${pack.size} bytes.`);
