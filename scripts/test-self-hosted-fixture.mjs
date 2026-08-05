import { spawn } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCliPath = process.env.npm_execpath;
const temporaryPrefix = "quanby-ticketing-self-hosted-fixture-";
const fixtureDefinitions = Object.freeze([
  {
    label: "Next.js 15",
    sourceRoot: path.join(workspaceRoot, "apps", "fixture-next15"),
    temporaryName: "fixture-next15",
  },
  {
    label: "Next.js 16",
    sourceRoot: path.join(workspaceRoot, "apps", "playground"),
    temporaryName: "fixture-next16",
  },
]);

if (!npmCliPath) {
  throw new Error(
    "npm_execpath is unavailable. Run this check through `npm run test:self-hosted-fixture`.",
  );
}

const sentinelParts = Object.freeze({
  databaseUser: "ticketing_acceptance_db_user_4f319a",
  databasePassword: "ticketing_acceptance_db_password_92e7cd",
  redisPassword: "ticketing_acceptance_redis_password_b1406e",
});

const sentinelEnvironment = Object.freeze({
  TICKETING_CLIENT_ID: "ticketing-acceptance-client-721d8f",
  TICKETING_CLIENT_SECRET:
    "ticketing_acceptance_client_secret_5841c9b733fe44db",
  DATABASE_TICKETING_URL:
    `postgresql://${sentinelParts.databaseUser}:${sentinelParts.databasePassword}` +
    "@127.0.0.1:55432/ticketing_acceptance_06a513",
  REDIS_TICKETING_URL:
    `redis://:${sentinelParts.redisPassword}` +
    "@127.0.0.1:56379/9",
  AWS_ACCESS_KEY_ID: "ticketing_acceptance_aws_access_key_8c1e7b",
  AWS_SECRET_ACCESS_KEY:
    "ticketing_acceptance_aws_secret_access_key_f61db7f28a",
  AWS_REGION: "ticketing-acceptance-region-36ab19",
  S3_BUCKET_NAME: "ticketing-acceptance-bucket-d1794c",
});

const serverOnlyNames = Object.freeze([
  ...Object.keys(sentinelEnvironment),
  "STORAGE_ENDPOINT",
  "STORAGE_FORCE_PATH_STYLE",
  // Guard against the legacy storage names returning to generated client code.
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
]);

const excludedFixtureEntries = new Set([
  ".next",
  ".turbo",
  "coverage",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const excludedFixtureTestEntries = new Set(["test", "tests"]);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${code}.` +
            (options.capture ? `\n${stdout}${stderr}` : ""),
        ),
      );
    });
  });
}

function isolatedNpmEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const name of [
    "INIT_CWD",
    "npm_config_include_workspace_root",
    "npm_config_local_prefix",
    "npm_config_workspace",
    "npm_config_workspaces",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_package_json",
    "npm_package_name",
    "npm_package_version",
  ]) {
    delete environment[name];
  }
  return environment;
}

function createFixtureCopyFilter(sourceRoot) {
  return (source) => {
    const relative = path.relative(sourceRoot, source);
    if (!relative) return true;

    const segments = relative.split(path.sep);
    if (segments.some((segment) => excludedFixtureEntries.has(segment))) {
      return false;
    }
    // The playground's tests intentionally exercise connected-mode-only files.
    // This check builds the generated production application in self-hosted mode.
    if (segments.some((segment) => excludedFixtureTestEntries.has(segment))) {
      return false;
    }
    if (segments.at(-1)?.endsWith(".tsbuildinfo")) {
      return false;
    }
    if (
      segments.at(-1) === ".env" ||
      segments.at(-1) === ".env.local" ||
      segments.at(-1)?.startsWith(".env.") && segments.at(-1)?.endsWith(".local")
    ) {
      return false;
    }
    return true;
  };
}

function parsePackedPackage(stdout) {
  const jsonBoundary = stdout.lastIndexOf("\n[");
  const json = (jsonBoundary === -1 ? stdout : stdout.slice(jsonBoundary + 1)).trim();
  const packed = JSON.parse(json);
  const entry = packed?.[0];
  if (
    !entry ||
    typeof entry.filename !== "string" ||
    typeof entry.version !== "string"
  ) {
    throw new Error(`npm pack did not return package metadata.\n${stdout}`);
  }
  return entry;
}

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

async function scanStaticBundle(fixtureRoot, label) {
  const staticRoot = path.join(fixtureRoot, ".next", "static");
  const staticStats = await stat(staticRoot).catch((error) => {
    throw new Error(`Client bundle directory does not exist: ${staticRoot}`, {
      cause: error,
    });
  });
  if (!staticStats.isDirectory()) {
    throw new Error(`Client bundle path is not a directory: ${staticRoot}`);
  }

  const files = await collectFiles(staticRoot);
  if (files.length === 0) {
    throw new Error(`No client bundle files were found in ${staticRoot}.`);
  }

  const forbidden = new Set([
    ...serverOnlyNames,
    ...serverOnlyNames.map((name) => `NEXT_PUBLIC_${name}`),
    ...Object.values(sentinelEnvironment),
    ...Object.values(sentinelParts),
  ]);
  let totalBytes = 0;
  for (const file of files) {
    const content = await readFile(file);
    totalBytes += content.byteLength;
    for (const value of forbidden) {
      if (content.includes(Buffer.from(value, "utf8"))) {
        throw new Error(
          `Client bundle contains forbidden server-only ticketing material (${value}) in ` +
            `${path.relative(fixtureRoot, file)}.`,
        );
      }
    }
  }

  console.log(
    `Scanned ${files.length} ${label} self-hosted client bundle files (${totalBytes} bytes); ` +
      "no database, AWS, storage, Redis, or signing configuration was exposed.",
  );
}

async function verifyFixture(definition, temporaryRoot, tarballPath, packageVersion) {
  const fixtureRoot = path.join(temporaryRoot, definition.temporaryName);
  await cp(definition.sourceRoot, fixtureRoot, {
    recursive: true,
    filter: createFixtureCopyFilter(definition.sourceRoot),
  });
  console.log(`Copied the clean ${definition.label} fixture to ${fixtureRoot}.`);

  await run(process.execPath, [
    npmCliPath,
    "exec",
    "--yes",
    "--package",
    tarballPath,
    "--",
    "ticketing",
    "init",
    "--cwd",
    fixtureRoot,
    "--mode",
    "self-hosted",
    "--yes",
    "--overwrite",
    "--skip-install",
  ], {
    cwd: temporaryRoot,
    env: isolatedNpmEnvironment(),
  });

  const generatedManifest = JSON.parse(
    await readFile(path.join(fixtureRoot, ".ticketing", "manifest.json"), "utf8"),
  );
  if (
    generatedManifest.mode !== "self-hosted" ||
    generatedManifest.package?.version !== packageVersion
  ) {
    throw new Error(
      `The packed CLI did not generate the expected ${definition.label} self-hosted fixture.`,
    );
  }

  await run(
    process.execPath,
    [
      npmCliPath,
      "install",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    { cwd: fixtureRoot, env: isolatedNpmEnvironment() },
  );
  const installedPackage = JSON.parse(
    await readFile(
      path.join(fixtureRoot, "node_modules", "@quanby", "ticketing", "package.json"),
      "utf8",
    ),
  );
  if (installedPackage.version !== packageVersion) {
    throw new Error(
      `Installed @quanby/ticketing@${installedPackage.version}; expected ${packageVersion}.`,
    );
  }
  console.log(
    `Installed the local @quanby/ticketing@${packageVersion} tarball into ${definition.label}.`,
  );

  const fixtureEnvironment = isolatedNpmEnvironment({
    ...sentinelEnvironment,
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  for (const name of [
    "STORAGE_ENDPOINT",
    "STORAGE_REGION",
    "STORAGE_BUCKET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
  ]) {
    delete fixtureEnvironment[name];
  }

  await run(process.execPath, [npmCliPath, "run", "typecheck"], {
    cwd: fixtureRoot,
    env: fixtureEnvironment,
  });
  await run(process.execPath, [npmCliPath, "run", "build"], {
    cwd: fixtureRoot,
    env: fixtureEnvironment,
  });
  await scanStaticBundle(fixtureRoot, definition.label);
  console.log(`${definition.label} self-hosted acceptance check passed.`);
}

async function removeTemporaryRoot(temporaryRoot) {
  const systemTemporaryRoot = path.resolve(tmpdir());
  const resolved = path.resolve(temporaryRoot);
  const relative = path.relative(systemTemporaryRoot, resolved);
  if (
    !path.basename(resolved).startsWith(temporaryPrefix) ||
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to remove unexpected temporary path: ${resolved}`);
  }
  await rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), temporaryPrefix));
try {
  const packRoot = path.join(temporaryRoot, "pack");
  await mkdir(packRoot, { recursive: true });
  const packResult = await run(
    process.execPath,
    [
      npmCliPath,
      "pack",
      "--workspace=@quanby/ticketing",
      "--pack-destination",
      packRoot,
      "--json",
    ],
    { capture: true },
  );
  const packed = parsePackedPackage(packResult.stdout);
  const tarballPath = path.join(packRoot, packed.filename);
  await stat(tarballPath);
  console.log(`Packed @quanby/ticketing@${packed.version}.`);

  for (const definition of fixtureDefinitions) {
    await verifyFixture(definition, temporaryRoot, tarballPath, packed.version);
  }
  console.log("Self-hosted packed Next.js 15 and 16 acceptance checks passed.");
} finally {
  await removeTemporaryRoot(temporaryRoot);
}
