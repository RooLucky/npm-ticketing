import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpmVersion = "11.20.0";
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error("npm_execpath is unavailable. Run this check through `npm run test:packed-cli`.");
}

const npxCliPath = path.join(path.dirname(npmCliPath), "npx-cli.js");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code}.\n${stdout}${stderr}`,
          ),
        );
      }
    });
  });
}

async function createFixture(fixtureRoot) {
  await mkdir(path.join(fixtureRoot, "src", "app"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({
      name: "ticketing-packed-cli-smoke-fixture",
      version: "0.0.0",
      private: true,
      packageManager: "npm@11.13.0",
      dependencies: {
        next: "16.3.0",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: {
        typescript: "6.0.3",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["./src/*"] },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureRoot, "src", "app", "page.tsx"),
    "export default function Page() { return null; }\n",
    "utf8",
  );
}

function assertDryRun(name, output) {
  const combined = `${output.stdout}\n${output.stderr}`;
  if (!combined.includes("Dry run complete; no files were changed.")) {
    throw new Error(`${name} did not execute the ticketing dry run.\n${combined}`);
  }
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "quanby-ticketing-packed-cli-"));
try {
  const packRoot = path.join(temporaryRoot, "pack");
  const fixtureRoot = path.join(temporaryRoot, "fixture");
  const pnpmRoot = path.join(temporaryRoot, "pnpm");
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(pnpmRoot, { recursive: true }),
    createFixture(fixtureRoot),
  ]);

  const packResult = await run(process.execPath, [npmCliPath,
    "pack",
    "--workspace=@quanby/ticketing",
    "--pack-destination",
    packRoot,
    "--json",
  ]);
  const jsonBoundary = packResult.stdout.lastIndexOf("\n[");
  const packJson = (jsonBoundary === -1
    ? packResult.stdout
    : packResult.stdout.slice(jsonBoundary + 1)).trim();
  const packed = JSON.parse(packJson);
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`npm pack did not return a tarball filename.\n${packResult.stdout}`);
  }
  const tarballPath = path.join(packRoot, filename);
  await readFile(tarballPath);

  await run(process.execPath, [npmCliPath,
    "install",
    "--prefix",
    pnpmRoot,
    "--no-save",
    "--no-package-lock",
    "--ignore-scripts",
    `pnpm@${pnpmVersion}`,
  ]);

  const pnpmPackageRoot = path.join(pnpmRoot, "node_modules", "pnpm");
  const pnpmPackageJson = JSON.parse(
    await readFile(path.join(pnpmPackageRoot, "package.json"), "utf8"),
  );
  const pnpmBin = pnpmPackageJson.bin;
  const pnpmCliPath = path.join(pnpmPackageRoot, pnpmBin.pnpm);
  const pnpxCliPath = path.join(pnpmPackageRoot, pnpmBin.pnpx);
  const pnxCliPath = path.join(pnpmPackageRoot, pnpmBin.pnx);
  const cliArguments = [
    "init",
    "--cwd",
    fixtureRoot,
    "--dry-run",
    "--skip-install",
  ];
  const packageSpecifier = tarballPath.replaceAll(path.sep, "/");
  const invocations = [
    {
      name: "npx",
      command: process.execPath,
      args: [npxCliPath, "--yes", "--package", packageSpecifier, "ticketing", ...cliArguments],
    },
    {
      name: "pnpx",
      command: process.execPath,
      args: [pnpxCliPath, packageSpecifier, ...cliArguments],
    },
    {
      name: "pnx",
      command: process.execPath,
      args: [pnxCliPath, packageSpecifier, ...cliArguments],
    },
    {
      name: "pnpm dlx",
      command: process.execPath,
      args: [pnpmCliPath, "dlx", packageSpecifier, ...cliArguments],
    },
  ];

  for (const invocation of invocations) {
    const output = await run(invocation.command, invocation.args, { cwd: temporaryRoot });
    assertDryRun(invocation.name, output);
    console.log(`Verified ${invocation.name} with ${filename}.`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
