import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { parseJsonc } from "./json.js";
import type { PackageManager, PathAlias, ProjectInfo } from "./types.js";

type PackageJson = {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type TsConfig = {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
};

type ComponentsJson = {
  aliases?: {
    components?: string;
    ui?: string;
    [key: string]: string | undefined;
  };
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findFirst(root: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const candidate = path.join(root, name);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function dependencyVersion(packageJson: PackageJson, name: string): string | undefined {
  return packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
}

function parsePackageManager(value: string | undefined): {
  name: PackageManager;
  version?: string;
} | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^(npm|pnpm|yarn|bun)(?:@(.+))?$/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  return {
    name: match[1] as PackageManager,
    ...(match[2] ? { version: match[2] } : {}),
  };
}

async function detectPackageManager(
  root: string,
  packageJson: PackageJson,
): Promise<{ name: PackageManager; version?: string }> {
  const lockfiles: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ];

  let current = root;
  while (true) {
    let currentPackageJson = current === root ? packageJson : undefined;
    const currentPackagePath = path.join(current, "package.json");
    if (current !== root && await exists(currentPackagePath)) {
      currentPackageJson = parseJsonc<PackageJson>(
        await readFile(currentPackagePath, "utf8"),
        currentPackagePath,
      );
    }

    const declared = parsePackageManager(currentPackageJson?.packageManager);
    if (declared) return declared;

    for (const [lockfile, manager] of lockfiles) {
      if (await exists(path.join(current, lockfile))) {
        return { name: manager };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { name: "npm" };
}

function normaliseComparablePath(filePath: string): string {
  const normalised = path.resolve(filePath);
  return process.platform === "win32" ? normalised.toLowerCase() : normalised;
}

function detectAliases(root: string, tsconfig: TsConfig): PathAlias[] {
  const compilerOptions = tsconfig.compilerOptions ?? {};
  const baseUrl = path.resolve(root, compilerOptions.baseUrl ?? ".");
  const aliases: PathAlias[] = [];

  for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
    const target = targets?.[0];
    if (!target || (!pattern.endsWith("/*") && !pattern.endsWith("*"))) {
      continue;
    }

    const prefix = pattern.replace(/\/?\*$/, "");
    if (!prefix) {
      continue;
    }

    aliases.push({
      prefix,
      pattern,
      target: path.resolve(baseUrl, target.replace(/\/?\*$/, "")),
    });
  }

  return aliases;
}

function chooseImportAlias(
  aliases: PathAlias[],
  root: string,
  sourceRoot: "." | "src",
  componentsJson?: ComponentsJson,
): string {
  const desiredTarget = normaliseComparablePath(
    sourceRoot === "." ? root : path.join(root, sourceRoot),
  );
  const exact = aliases.filter(
    (alias) => normaliseComparablePath(alias.target) === desiredTarget,
  );

  const componentAlias = componentsJson?.aliases?.components;
  const componentMatch = componentAlias?.match(/^([^/]+)\/components(?:\/|$)/);
  if (componentMatch?.[1]) {
    const configured = exact.find((alias) => alias.prefix === componentMatch[1]);
    if (configured) return configured.prefix;
  }

  return exact[0]?.prefix ?? "";
}

export async function detectProject(cwd: string): Promise<ProjectInfo> {
  const requestedRoot = path.resolve(cwd);
  let root: string;
  try {
    const rootStat = await stat(requestedRoot);
    if (!rootStat.isDirectory()) {
      throw new CliError(`Project path is not a directory: ${requestedRoot}`);
    }
    root = await realpath(requestedRoot);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Project directory does not exist: ${requestedRoot}`, 1, {
      cause: error,
    });
  }

  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    throw new CliError(`No package.json was found in ${root}.`);
  }

  const packageJson = parseJsonc<PackageJson>(
    await readFile(packageJsonPath, "utf8"),
    packageJsonPath,
  );
  const nextVersion = dependencyVersion(packageJson, "next");
  if (!nextVersion) {
    throw new CliError("This installer requires a Next.js project.");
  }

  const tsconfigPath = path.join(root, "tsconfig.json");
  if (!(await exists(tsconfigPath))) {
    throw new CliError("This installer supports TypeScript projects only (tsconfig.json is missing).");
  }
  const tsconfig = parseJsonc<TsConfig>(
    await readFile(tsconfigPath, "utf8"),
    tsconfigPath,
  );

  const srcApp = path.join(root, "src", "app");
  const rootApp = path.join(root, "app");
  let sourceRoot: "." | "src";
  let appRoot: string;
  if (await exists(srcApp)) {
    sourceRoot = "src";
    appRoot = "src/app";
  } else if (await exists(rootApp)) {
    sourceRoot = ".";
    appRoot = "app";
  } else {
    throw new CliError(
      "No Next.js App Router directory was found. Expected app/ or src/app/.",
    );
  }

  const componentsJsonPath = path.join(root, "components.json");
  let componentsJson: ComponentsJson | undefined;
  if (await exists(componentsJsonPath)) {
    componentsJson = parseJsonc<ComponentsJson>(
      await readFile(componentsJsonPath, "utf8"),
      componentsJsonPath,
    );
  }

  const aliases = detectAliases(root, tsconfig);
  const packageManager = await detectPackageManager(root, packageJson);
  const tailwindConfigPath = await findFirst(root, [
    "tailwind.config.ts",
    "tailwind.config.js",
    "tailwind.config.mjs",
    "tailwind.config.cjs",
  ]);
  const tailwindVersion = dependencyVersion(packageJson, "tailwindcss");

  return {
    root,
    appRoot,
    sourceRoot,
    importAlias: chooseImportAlias(aliases, root, sourceRoot, componentsJson),
    aliases,
    packageManager: packageManager.name,
    ...(packageManager.version ? { packageManagerVersion: packageManager.version } : {}),
    nextVersion,
    tailwind: {
      installed: Boolean(tailwindVersion || tailwindConfigPath),
      ...(tailwindVersion ? { version: tailwindVersion } : {}),
      ...(tailwindConfigPath
        ? { configPath: path.relative(root, tailwindConfigPath).replaceAll(path.sep, "/") }
        : {}),
    },
    shadcn: {
      installed: Boolean(componentsJson),
      ...(componentsJson
        ? { configPath: path.relative(root, componentsJsonPath).replaceAll(path.sep, "/") }
        : {}),
      ...(componentsJson?.aliases?.ui
        ? { uiImport: componentsJson.aliases.ui.replace(/\/+$/, "") }
        : {}),
    },
  };
}
