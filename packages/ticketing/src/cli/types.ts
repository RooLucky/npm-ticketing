export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type InitOptions = {
  cwd: string;
  yes: boolean;
  dryRun: boolean;
  overwrite: boolean;
  skipInstall: boolean;
};

export type PathAlias = {
  prefix: string;
  pattern: string;
  target: string;
};

export type ProjectInfo = {
  root: string;
  appRoot: string;
  sourceRoot: "." | "src";
  importAlias: string;
  aliases: PathAlias[];
  packageManager: PackageManager;
  packageManagerVersion?: string;
  nextVersion: string;
  tailwind: {
    installed: boolean;
    version?: string;
    configPath?: string;
  };
  shadcn: {
    installed: boolean;
    configPath?: string;
    uiImport?: string;
  };
};

export type CommandInvocation = {
  command: string;
  args: string[];
  cwd: string;
};

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<void>;
}

export interface InstallerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type Confirm = (message: string) => Promise<boolean>;

export type TemplateFile = {
  source: string;
  target: string;
};

export type TemplateManifest = {
  files: TemplateFile[];
  dependencies?: string[];
  shadcnComponents?: string[];
};

export type FileActionKind =
  | "create"
  | "update"
  | "overwrite"
  | "identical"
  | "conflict";

export type FileAction = {
  kind: FileActionKind;
  path: string;
};

export type InitResult = {
  project: ProjectInfo;
  actions: FileAction[];
  commands: CommandInvocation[];
  conflicts: string[];
  manifestPath: string;
};

export type InstallerDependencies = {
  templatesDirectory: string;
  packageVersion: string;
  runner: CommandRunner;
  logger: InstallerLogger;
  confirm: Confirm;
};
