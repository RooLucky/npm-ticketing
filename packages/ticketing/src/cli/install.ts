import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { CliError } from "./errors.js";
import { parseJsonc } from "./json.js";
import { detectProject } from "./detect.js";
import {
  loadTemplates,
  resolveSafeProjectPath,
  sha256,
  type RenderedTemplate,
} from "./templates.js";
import type {
  CommandInvocation,
  FileAction,
  InitOptions,
  InitResult,
  InstallerDependencies,
  PackageManager,
  ProjectInfo,
} from "./types.js";

const GENERATED_MANIFEST = ".ticketing/manifest.json";
const ENV_EXAMPLE = ".env.example";
const SHADCN_VERSION = "4.16.1";
const REQUIRED_ENVIRONMENT: ReadonlyArray<[string, string]> = [
  ["TICKETING_API_URL", "https://support.example.com/api/v1"],
  ["TICKETING_CLIENT_ID", "replace-with-your-client-id"],
  ["TICKETING_CLIENT_SECRET", "replace-with-at-least-32-random-bytes"],
];

type GeneratedManifest = {
  schemaVersion: 1;
  package: {
    name: "@quanby/ticketing";
    version: string;
  };
  files: Record<string, { sha256: string }>;
};

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function validatePreviousManifest(value: unknown, manifestPath: string): GeneratedManifest {
  if (!value || typeof value !== "object") {
    throw new CliError(`Invalid generated-file manifest: ${manifestPath}`);
  }
  const candidate = value as Partial<GeneratedManifest>;
  if (candidate.schemaVersion !== 1 || !candidate.files || typeof candidate.files !== "object") {
    throw new CliError(`Invalid generated-file manifest: ${manifestPath}`);
  }
  for (const [file, entry] of Object.entries(candidate.files)) {
    if (
      !file ||
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { sha256?: unknown }).sha256 !== "string"
    ) {
      throw new CliError(`Invalid generated-file entry for ${file} in ${manifestPath}`);
    }
  }
  return candidate as GeneratedManifest;
}

async function readPreviousManifest(manifestPath: string): Promise<GeneratedManifest | undefined> {
  const raw = await readOptional(manifestPath);
  if (raw === undefined) {
    return undefined;
  }
  return validatePreviousManifest(parseJsonc<unknown>(raw, manifestPath), manifestPath);
}

function normaliseManifestPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function mergeEnvironmentExample(existing: string | undefined): string {
  let result = existing ?? "";
  const missing = REQUIRED_ENVIRONMENT.filter(([key]) => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`, "m").test(result);
  });
  if (missing.length === 0) {
    return result;
  }

  if (result && !result.endsWith("\n")) {
    result += "\n";
  }
  if (result && !result.endsWith("\n\n")) {
    result += "\n";
  }
  result += "# @quanby/ticketing\n";
  result += missing.map(([key, value]) => `${key}=${value}`).join("\n");
  result += "\n";
  return result;
}

function shadcnInvocation(
  packageManager: PackageManager,
  packageManagerVersion: string | undefined,
  args: string[],
  cwd: string,
): CommandInvocation {
  const packageSpec = `shadcn@${SHADCN_VERSION}`;
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", packageSpec, ...args], cwd };
    case "yarn":
      if (packageManagerVersion && !packageManagerVersion.startsWith("1.")) {
        return { command: "yarn", args: ["dlx", packageSpec, ...args], cwd };
      }
      return { command: "npx", args: ["--yes", packageSpec, ...args], cwd };
    case "bun":
      return { command: "bunx", args: [packageSpec, ...args], cwd };
    case "npm":
      return { command: "npx", args: ["--yes", packageSpec, ...args], cwd };
  }
}

function addDependenciesInvocation(
  packageManager: PackageManager,
  dependencies: string[],
  cwd: string,
): CommandInvocation {
  switch (packageManager) {
    case "npm":
      return { command: "npm", args: ["install", ...dependencies], cwd };
    case "pnpm":
      return { command: "pnpm", args: ["add", ...dependencies], cwd };
    case "yarn":
      return { command: "yarn", args: ["add", ...dependencies], cwd };
    case "bun":
      return { command: "bun", args: ["add", ...dependencies], cwd };
  }
}

function dependencyName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const versionSeparator = specifier.indexOf("@", specifier.indexOf("/") + 1);
    return versionSeparator === -1 ? specifier : specifier.slice(0, versionSeparator);
  }
  const versionSeparator = specifier.indexOf("@");
  return versionSeparator === -1 ? specifier : specifier.slice(0, versionSeparator);
}

function dependencyRange(specifier: string): string | undefined {
  const name = dependencyName(specifier);
  const range = specifier.slice(name.length + (specifier[name.length] === "@" ? 1 : 0));
  return range || undefined;
}

async function missingDependencies(root: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) {
    return [];
  }
  const packageJson = parseJsonc<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(await readFile(path.join(root, "package.json"), "utf8"), "package.json");
  return requested.filter((specifier) => {
    const name = dependencyName(specifier);
    const declared = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
    if (!declared) return true;

    const required = dependencyRange(specifier);
    if (!required) return false;
    const declaredRange = semver.validRange(declared);
    const requiredRange = semver.validRange(required);
    if (!declaredRange || !requiredRange) {
      throw new CliError(
        `${name} is declared as ${declared}, which cannot be checked against the required ${required}. ` +
          `Use a compatible semver range and run the installer again.`,
      );
    }
    if (!semver.intersects(declaredRange, requiredRange)) {
      throw new CliError(
        `${name} ${declared} is incompatible with the generated portal (requires ${required}). ` +
          `Upgrade it deliberately, verify your application, and run the installer again.`,
      );
    }
    return !semver.subset(declaredRange, requiredRange);
  });
}

export async function buildInstallCommands(
  project: ProjectInfo,
  dependencies: string[],
  components: string[],
  yes: boolean,
): Promise<CommandInvocation[]> {
  const commands: CommandInvocation[] = [];
  if (!project.shadcn.installed) {
    commands.push(
      shadcnInvocation(
        project.packageManager,
        project.packageManagerVersion,
        ["init", ...(yes ? ["--defaults"] : [])],
        project.root,
      ),
    );
  }
  if (components.length > 0) {
    commands.push(
      shadcnInvocation(
        project.packageManager,
        project.packageManagerVersion,
        ["add", ...components, ...(yes ? ["--yes"] : [])],
        project.root,
      ),
    );
  }
  const missing = await missingDependencies(project.root, dependencies);
  if (missing.length > 0) {
    commands.push(addDependenciesInvocation(project.packageManager, missing, project.root));
  }
  return commands;
}

async function decideFileActions(
  files: RenderedTemplate[],
  previous: GeneratedManifest | undefined,
  options: InitOptions,
  confirm: InstallerDependencies["confirm"],
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  for (const file of files) {
    const current = await readOptional(file.targetPath);
    if (current === undefined) {
      actions.push({ kind: "create", path: file.relativeTarget });
      continue;
    }

    const currentHash = sha256(current);
    if (currentHash === file.hash) {
      actions.push({ kind: "identical", path: file.relativeTarget });
      continue;
    }

    const previousHash = previous?.files[normaliseManifestPath(file.relativeTarget)]?.sha256;
    if (previousHash && previousHash === currentHash) {
      actions.push({ kind: "update", path: file.relativeTarget });
    } else if (options.overwrite) {
      actions.push({ kind: "overwrite", path: file.relativeTarget });
    } else {
      actions.push({ kind: "conflict", path: file.relativeTarget });
    }
  }

  const overwriteCount = actions.filter((action) => action.kind === "overwrite").length;
  if (overwriteCount > 0 && !options.yes && !options.dryRun) {
    const accepted = await confirm(
      `Overwrite ${overwriteCount} modified generated ${overwriteCount === 1 ? "file" : "files"}?`,
    );
    if (!accepted) {
      for (const action of actions) {
        if (action.kind === "overwrite") {
          action.kind = "conflict";
        }
      }
    }
  }
  return actions;
}

function printSummary(
  dependencies: InstallerDependencies,
  options: InitOptions,
  actions: FileAction[],
  commands: CommandInvocation[],
): void {
  const prefix = options.dryRun ? "Would" : "Will";
  const changed = actions.filter((action) =>
    ["create", "update", "overwrite"].includes(action.kind),
  );
  dependencies.logger.info(
    `${prefix} generate ${changed.length} ${changed.length === 1 ? "file" : "files"}.`,
  );
  for (const action of actions.filter((entry) => entry.kind === "conflict")) {
    dependencies.logger.warn(`Preserved modified file: ${action.path}`);
  }
  if (commands.length > 0) {
    if (options.skipInstall) {
      dependencies.logger.info("Dependency/UI installation was skipped. Run these commands manually:");
      for (const command of commands) {
        dependencies.logger.info(
          `  ${command.command} ${command.args.map((argument) =>
            /\s/.test(argument) ? JSON.stringify(argument) : argument,
          ).join(" ")}`,
        );
      }
    } else {
      dependencies.logger.info(
        `${prefix} run ${commands.length} dependency/UI ${commands.length === 1 ? "command" : "commands"}.`,
      );
    }
  }
}

export async function initProject(
  options: InitOptions,
  dependencies: InstallerDependencies,
): Promise<InitResult> {
  const project = await detectProject(options.cwd);
  if (!project.importAlias) {
    dependencies.logger.warn(
      "No wildcard path alias maps to the source root; generated files will use relative imports.",
    );
  }
  const templates = await loadTemplates(dependencies.templatesDirectory, project);
  const manifestPath = await resolveSafeProjectPath(project.root, GENERATED_MANIFEST);
  const previousManifest = await readPreviousManifest(manifestPath);
  const actions = await decideFileActions(
    templates.files,
    previousManifest,
    options,
    dependencies.confirm,
  );
  const commands = await buildInstallCommands(
    project,
    templates.manifest.dependencies ?? [],
    templates.manifest.shadcnComponents ?? [],
    options.yes,
  );

  const envPath = await resolveSafeProjectPath(project.root, ENV_EXAMPLE);
  const currentEnv = await readOptional(envPath);
  const mergedEnv = mergeEnvironmentExample(currentEnv);
  actions.push({
    kind:
      currentEnv === mergedEnv
        ? "identical"
        : currentEnv === undefined
          ? "create"
          : "update",
    path: ENV_EXAMPLE,
  });

  printSummary(dependencies, options, actions, commands);
  if (!options.dryRun) {
    if (!options.skipInstall) {
      for (const command of commands) {
        try {
          await dependencies.runner.run(command);
        } catch (error) {
          throw new CliError(
            `Command failed: ${command.command} ${command.args.join(" ")}`,
            1,
            { cause: error },
          );
        }
      }
    }

    for (const file of templates.files) {
      const action = actions.find((candidate) => candidate.path === file.relativeTarget);
      if (action && ["create", "update", "overwrite"].includes(action.kind)) {
        await atomicWrite(file.targetPath, file.content);
      }
    }
    if (currentEnv !== mergedEnv) {
      await atomicWrite(envPath, mergedEnv);
    }

    const manifestFiles: GeneratedManifest["files"] = {
      ...(previousManifest?.files ?? {}),
    };
    for (const file of templates.files) {
      const action = actions.find((candidate) => candidate.path === file.relativeTarget);
      if (action?.kind !== "conflict") {
        manifestFiles[normaliseManifestPath(file.relativeTarget)] = { sha256: file.hash };
      }
    }
    const nextManifest: GeneratedManifest = {
      schemaVersion: 1,
      package: {
        name: "@quanby/ticketing",
        version: dependencies.packageVersion,
      },
      files: manifestFiles,
    };
    await atomicWrite(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  }

  const conflicts = actions
    .filter((action) => action.kind === "conflict")
    .map((action) => action.path);
  if (conflicts.length === 0) {
    dependencies.logger.info(
      options.dryRun
        ? "Dry run complete; no files were changed."
        : "Ticketing portal installed successfully.",
    );
  }

  return {
    project,
    actions,
    commands,
    conflicts,
    manifestPath,
  };
}
