import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { parse as parseYaml } from "yaml";
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
  TicketingMode,
} from "./types.js";

const GENERATED_MANIFEST = ".ticketing/manifest.json";
const ENV_EXAMPLE = ".env.example";
const SHADCN_VERSION = "4.16.1";
type EnvironmentExample = {
  key: string;
  value: string;
  optional?: boolean;
};

const COMMON_ENVIRONMENT: readonly EnvironmentExample[] = [
  { key: "TICKETING_CLIENT_ID", value: "replace-with-your-client-id" },
  {
    key: "TICKETING_CLIENT_SECRET",
    value: "replace-with-at-least-32-random-bytes",
  },
];
const MODE_ENVIRONMENT: Record<TicketingMode, readonly EnvironmentExample[]> = {
  connected: [
    { key: "TICKETING_API_URL", value: "https://support.example.com/api/v1" },
  ],
  "self-hosted": [
    {
      key: "DATABASE_TICKETING_URL",
      value: "postgresql://ticketing:ticketing@localhost:5432/ticketing",
    },
    {
      key: "REDIS_TICKETING_URL",
      value: "redis://localhost:6379",
      optional: true,
    },
    { key: "AWS_ACCESS_KEY_ID", value: "replace-with-aws-access-key-id" },
    {
      key: "AWS_SECRET_ACCESS_KEY",
      value: "replace-with-aws-secret-access-key",
    },
    { key: "AWS_REGION", value: "ap-southeast-1" },
    { key: "S3_BUCKET_NAME", value: "private-ticketing-attachments" },
    {
      key: "STORAGE_ENDPOINT",
      value: "https://s3-compatible.example.com",
      optional: true,
    },
    { key: "STORAGE_REGION", value: "auto", optional: true },
    {
      key: "STORAGE_BUCKET",
      value: "private-ticketing-attachments",
      optional: true,
    },
    {
      key: "STORAGE_ACCESS_KEY_ID",
      value: "replace-with-storage-access-key",
      optional: true,
    },
    {
      key: "STORAGE_SECRET_ACCESS_KEY",
      value: "replace-with-storage-secret-key",
      optional: true,
    },
    { key: "STORAGE_FORCE_PATH_STYLE", value: "false", optional: true },
  ],
};

type GeneratedManifest = {
  schemaVersion: 2;
  mode: TicketingMode;
  package: {
    name: "@quanby/ticketing";
    version: string;
  };
  files: Record<string, { sha256: string }>;
};

type PreviousGeneratedManifest = {
  mode: TicketingMode;
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

function validatePreviousManifest(
  value: unknown,
  manifestPath: string,
): PreviousGeneratedManifest {
  if (!value || typeof value !== "object") {
    throw new CliError(`Invalid generated-file manifest: ${manifestPath}`);
  }
  const candidate = value as {
    schemaVersion?: unknown;
    mode?: unknown;
    files?: unknown;
  };
  if (
    (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) ||
    !candidate.files ||
    typeof candidate.files !== "object" ||
    Array.isArray(candidate.files)
  ) {
    throw new CliError(`Invalid generated-file manifest: ${manifestPath}`);
  }
  if (
    candidate.schemaVersion === 2 &&
    candidate.mode !== "connected" &&
    candidate.mode !== "self-hosted"
  ) {
    throw new CliError(`Invalid generated-file mode in ${manifestPath}`);
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
  return {
    mode:
      candidate.schemaVersion === 2
        ? (candidate.mode as TicketingMode)
        : "connected",
    files: candidate.files as PreviousGeneratedManifest["files"],
  };
}

async function readPreviousManifest(
  manifestPath: string,
): Promise<PreviousGeneratedManifest | undefined> {
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

function environmentForMode(mode: TicketingMode): readonly EnvironmentExample[] {
  return [...COMMON_ENVIRONMENT, ...MODE_ENVIRONMENT[mode]];
}

function mergeEnvironmentExample(
  existing: string | undefined,
  mode: TicketingMode,
): string {
  let result = existing ?? "";
  const missing = environmentForMode(mode).filter(({ key, optional }) => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(
      `^\\s*${optional ? "(?:#\\s*)?" : ""}(?:export\\s+)?${escapedKey}\\s*=`,
      "m",
    ).test(result);
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
  result += missing
    .map(({ key, value, optional }) => `${optional ? "# " : ""}${key}=${value}`)
    .join("\n");
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
  exact: boolean,
): CommandInvocation {
  switch (packageManager) {
    case "npm":
      return {
        command: "npm",
        args: ["install", ...(exact ? ["--save-exact"] : []), ...dependencies],
        cwd,
      };
    case "pnpm":
      return {
        command: "pnpm",
        args: ["add", ...(exact ? ["--save-exact"] : []), ...dependencies],
        cwd,
      };
    case "yarn":
      return {
        command: "yarn",
        args: ["add", ...(exact ? ["--exact"] : []), ...dependencies],
        cwd,
      };
    case "bun":
      return {
        command: "bun",
        args: ["add", ...(exact ? ["--exact"] : []), ...dependencies],
        cwd,
      };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function findPnpmWorkspace(root: string): Promise<{
  path: string;
  configuration: Record<string, unknown>;
} | undefined> {
  let current = path.resolve(root);
  while (true) {
    const workspacePath = path.join(current, "pnpm-workspace.yaml");
    const raw = await readOptional(workspacePath);
    if (raw !== undefined) {
      let configuration: unknown;
      try {
        configuration = parseYaml(raw);
      } catch (error) {
        throw new CliError(`Could not parse pnpm workspace configuration: ${workspacePath}`, 1, {
          cause: error,
        });
      }
      if (!isRecord(configuration)) {
        throw new CliError(`Invalid pnpm workspace configuration: ${workspacePath}`);
      }
      return { path: workspacePath, configuration };
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolveDeclaredRange(
  root: string,
  name: string,
  declared: string,
): Promise<string> {
  if (!declared.startsWith("catalog:")) return declared;

  const workspace = await findPnpmWorkspace(root);
  if (!workspace) {
    throw new CliError(
      `${name} is declared as ${declared}, but no pnpm-workspace.yaml was found from ${root}.`,
    );
  }

  const requestedCatalog = declared.slice("catalog:".length);
  const catalogName = requestedCatalog || "default";
  let catalog: unknown;
  if (catalogName === "default") {
    catalog = workspace.configuration.catalog;
  } else {
    const catalogs = workspace.configuration.catalogs;
    catalog = isRecord(catalogs) ? catalogs[catalogName] : undefined;
  }

  if (!isRecord(catalog)) {
    throw new CliError(
      `${name} references catalog:${catalogName}, but that catalog is not defined in ${workspace.path}.`,
    );
  }

  const resolved = catalog[name];
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new CliError(
      `${name} is declared as ${declared}, but it has no version in ${workspace.path}.`,
    );
  }
  return resolved.trim();
}

async function missingDependencies(root: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) {
    return [];
  }
  const packageJson = parseJsonc<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(await readFile(path.join(root, "package.json"), "utf8"), "package.json");
  const missing: string[] = [];
  for (const specifier of requested) {
    const name = dependencyName(specifier);
    const declared = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
    if (!declared) {
      missing.push(specifier);
      continue;
    }

    const required = dependencyRange(specifier);
    if (!required) continue;
    const resolvedDeclared = await resolveDeclaredRange(root, name, declared);
    const describedDeclared =
      resolvedDeclared === declared ? declared : `${declared} (resolves to ${resolvedDeclared})`;
    const declaredRange = semver.validRange(resolvedDeclared);
    const requiredRange = semver.validRange(required);
    if (!declaredRange || !requiredRange) {
      throw new CliError(
        `${name} is declared as ${describedDeclared}, which cannot be checked against the required ${required}. ` +
          `Use a compatible semver range and run the installer again.`,
      );
    }
    if (!semver.intersects(declaredRange, requiredRange)) {
      if (name === "@quanby/ticketing" && !declared.startsWith("catalog:")) {
        missing.push(specifier);
        continue;
      }
      throw new CliError(
        `${name} ${describedDeclared} is incompatible with the generated portal (requires ${required}). ` +
          `Upgrade it deliberately, verify your application, and run the installer again.`,
      );
    }
    if (!semver.subset(declaredRange, requiredRange)) {
      if (declared.startsWith("catalog:")) {
        throw new CliError(
          `${name} ${describedDeclared} does not fully satisfy ${required}. ` +
            `Update the pnpm catalog deliberately, verify your workspace, and run the installer again.`,
        );
      }
      missing.push(specifier);
    }
  }
  return missing;
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
  const packageRuntime = missing.filter(
    (specifier) => dependencyName(specifier) === "@quanby/ticketing",
  );
  const editableSourceDependencies = missing.filter(
    (specifier) => dependencyName(specifier) !== "@quanby/ticketing",
  );
  if (editableSourceDependencies.length > 0) {
    commands.push(addDependenciesInvocation(
      project.packageManager,
      editableSourceDependencies,
      project.root,
      false,
    ));
  }
  if (packageRuntime.length > 0) {
    commands.push(addDependenciesInvocation(
      project.packageManager,
      packageRuntime,
      project.root,
      true,
    ));
  }
  return commands;
}

async function decideFileActions(
  files: RenderedTemplate[],
  previous: PreviousGeneratedManifest | undefined,
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

async function decideStaleModeActions(
  root: string,
  files: RenderedTemplate[],
  previous: PreviousGeneratedManifest,
  options: InitOptions,
  confirm: InstallerDependencies["confirm"],
): Promise<{ actions: FileAction[]; stalePaths: string[] }> {
  const selected = new Set(
    files.map((file) => normaliseManifestPath(file.relativeTarget)),
  );
  const stalePaths = Object.keys(previous.files).filter(
    (file) => !selected.has(normaliseManifestPath(file)),
  );
  const actions: FileAction[] = [];
  const modifiedRemovals = new Set<string>();

  for (const stalePath of stalePaths) {
    const targetPath = await resolveSafeProjectPath(root, stalePath);
    const current = await readOptional(targetPath);
    if (current === undefined) continue;

    if (sha256(current) === previous.files[stalePath]?.sha256) {
      actions.push({ kind: "remove", path: normaliseManifestPath(stalePath) });
    } else if (options.overwrite) {
      const normalized = normaliseManifestPath(stalePath);
      actions.push({ kind: "remove", path: normalized });
      modifiedRemovals.add(normalized);
    } else {
      actions.push({ kind: "conflict", path: normaliseManifestPath(stalePath) });
    }
  }

  if (modifiedRemovals.size > 0 && !options.yes && !options.dryRun) {
    const accepted = await confirm(
      `Remove ${modifiedRemovals.size} modified generated ${modifiedRemovals.size === 1 ? "file" : "files"} that are not used by the selected mode?`,
    );
    if (!accepted) {
      for (const action of actions) {
        if (action.kind === "remove" && modifiedRemovals.has(action.path)) {
          action.kind = "conflict";
        }
      }
    }
  }

  return { actions, stalePaths: stalePaths.map(normaliseManifestPath) };
}

function printSummary(
  dependencies: InstallerDependencies,
  options: InitOptions,
  mode: TicketingMode,
  actions: FileAction[],
  commands: CommandInvocation[],
): void {
  const prefix = options.dryRun ? "Would" : "Will";
  dependencies.logger.info(`Ticketing mode: ${mode}.`);
  const changed = actions.filter((action) =>
    ["create", "update", "overwrite", "remove"].includes(action.kind),
  );
  dependencies.logger.info(
    `${prefix} apply ${changed.length} generated-file ${changed.length === 1 ? "change" : "changes"}.`,
  );
  if (options.dryRun) {
    for (const action of changed) {
      dependencies.logger.info(`  ${action.kind}: ${action.path}`);
    }
  }
  for (const action of actions.filter((entry) => entry.kind === "conflict")) {
    dependencies.logger.warn(`Preserved modified file: ${action.path}`);
  }
  if (commands.length > 0) {
    if (options.skipInstall || options.dryRun) {
      dependencies.logger.info(
        options.skipInstall
          ? "Dependency/UI installation was skipped. Run these commands manually:"
          : "Would run these dependency/UI commands:",
      );
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
  const manifestPath = await resolveSafeProjectPath(project.root, GENERATED_MANIFEST);
  const previousManifest = await readPreviousManifest(manifestPath);
  const mode = options.mode ?? previousManifest?.mode ?? "connected";
  const templates = await loadTemplates(
    dependencies.templatesDirectory,
    project,
    mode,
  );
  const actions = await decideFileActions(
    templates.files,
    previousManifest,
    options,
    dependencies.confirm,
  );
  let stalePaths: string[] = [];
  if (previousManifest && previousManifest.mode !== mode) {
    const stale = await decideStaleModeActions(
      project.root,
      templates.files,
      previousManifest,
      options,
      dependencies.confirm,
    );
    actions.push(...stale.actions);
    stalePaths = stale.stalePaths;
  }
  const modeSwitchConflicts = actions.filter((action) => {
    if (action.kind !== "conflict") return false;
    const template = templates.files.find(
      (file) => file.relativeTarget === action.path,
    );
    const previousHash = previousManifest?.files[
      normaliseManifestPath(action.path)
    ]?.sha256;
    return !template || !previousHash || template.hash !== previousHash;
  });
  if (
    previousManifest &&
    previousManifest.mode !== mode &&
    modeSwitchConflicts.length > 0 &&
    !options.dryRun
  ) {
    throw new CliError(
      `Cannot switch ticketing mode from ${previousManifest.mode} to ${mode} while ` +
        `${modeSwitchConflicts.length} generated ${modeSwitchConflicts.length === 1 ? "file has" : "files have"} local changes. ` +
        "Review the files, then rerun with --overwrite to replace them.",
    );
  }

  const requestedDependencies = [
    ...(templates.manifest.dependencies ?? []),
    ...(templates.manifest.modeDependencies?.[mode] ?? []),
  ];
  if (mode === "self-hosted") {
    if (!semver.valid(dependencies.packageVersion)) {
      throw new CliError(
        `Cannot install the self-hosted runtime for invalid package version ${dependencies.packageVersion}.`,
      );
    }
    requestedDependencies.push(
      `@quanby/ticketing@${dependencies.packageVersion}`,
    );
  }
  const commands = await buildInstallCommands(
    project,
    [...new Set(requestedDependencies)],
    templates.manifest.shadcnComponents ?? [],
    options.yes,
  );

  const envPath = await resolveSafeProjectPath(project.root, ENV_EXAMPLE);
  const currentEnv = await readOptional(envPath);
  const mergedEnv = mergeEnvironmentExample(currentEnv, mode);
  actions.push({
    kind:
      currentEnv === mergedEnv
        ? "identical"
        : currentEnv === undefined
          ? "create"
          : "update",
    path: ENV_EXAMPLE,
  });

  printSummary(dependencies, options, mode, actions, commands);
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

    for (const action of actions) {
      if (action.kind !== "remove") continue;
      const targetPath = await resolveSafeProjectPath(project.root, action.path);
      await unlink(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
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
    for (const stalePath of stalePaths) {
      delete manifestFiles[stalePath];
    }
    for (const file of templates.files) {
      const action = actions.find((candidate) => candidate.path === file.relativeTarget);
      if (action?.kind !== "conflict") {
        manifestFiles[normaliseManifestPath(file.relativeTarget)] = { sha256: file.hash };
      }
    }
    const nextManifest: GeneratedManifest = {
      schemaVersion: 2,
      mode,
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
    mode,
    actions,
    commands,
    conflicts,
    manifestPath,
  };
}
