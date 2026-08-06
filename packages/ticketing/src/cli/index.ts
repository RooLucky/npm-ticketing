#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { CliError } from "./errors.js";
import { createProgram } from "./program.js";
import { defaultConfirm, defaultRunner } from "./runner.js";
import type { InstallerDependencies } from "./types.js";

function packageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

function packageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    ) as { version?: string };
    return packageJson.version ?? "0.2.1";
  } catch {
    return "0.2.1";
  }
}

export function defaultDependencies(
  overrides: Partial<InstallerDependencies> = {},
): InstallerDependencies {
  return {
    templatesDirectory: path.join(packageRoot(), "templates"),
    packageVersion: packageVersion(),
    runner: defaultRunner,
    logger: console,
    confirm: defaultConfirm,
    ...overrides,
  };
}

export async function runCli(
  argv: string[] = process.argv,
  overrides: Partial<InstallerDependencies> = {},
): Promise<void> {
  const dependencies = defaultDependencies(overrides);
  await createProgram(dependencies).parseAsync(argv);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const invokedPath = realpathSync(path.resolve(process.argv[1]));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return pathToFileURL(invokedPath).href === pathToFileURL(modulePath).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli().catch((error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { CliError } from "./errors.js";
export { detectProject } from "./detect.js";
export { initProject, buildInstallCommands } from "./install.js";
export { createProgram } from "./program.js";
export { loadTemplates, resolveSafeProjectPath, sha256 } from "./templates.js";
export type * from "./types.js";
