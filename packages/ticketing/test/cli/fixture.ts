import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CommandInvocation,
  CommandRunner,
  InstallerLogger,
  PackageManager,
} from "../../src/cli/types.js";

export async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function createNextProject(
  root: string,
  options: {
    sourceRoot?: "." | "src";
    packageManager?: PackageManager;
    packageManagerVersion?: string;
    packageManagerField?: boolean;
    alias?: string | false;
    tailwind?: boolean;
    shadcn?: boolean;
    dependencies?: Record<string, string>;
  } = {},
): Promise<void> {
  const sourceRoot = options.sourceRoot ?? "src";
  const manager = options.packageManager ?? "npm";
  const alias = options.alias === undefined ? "@" : options.alias;
  const dependencies = {
    next: "16.3.0",
    react: "19.2.0",
    ...(options.tailwind ? { tailwindcss: "^4.1.0" } : {}),
    ...(options.dependencies ?? {}),
  };
  await writeText(
    root,
    "package.json",
    `${JSON.stringify(
      {
        private: true,
        ...(options.packageManagerField === false
          ? {}
          : { packageManager: `${manager}@${options.packageManagerVersion ?? "1.0.0"}` }),
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    root,
    "tsconfig.json",
    `{
      // JSONC is intentional.
      "compilerOptions": {
        "baseUrl": ".",
        ${
          alias === false
            ? ""
            : `"paths": { "${alias}/*": ["${sourceRoot === "src" ? "./src/*" : "./*"}"] },`
        }
      },
    }\n`,
  );
  await writeText(root, `${sourceRoot === "src" ? "src/" : ""}app/layout.tsx`, "export default null;\n");
  if (options.shadcn) {
    await writeText(
      root,
      "components.json",
      `${JSON.stringify({ aliases: { components: `${alias || "@"}/components` } })}\n`,
    );
  }
  if (options.tailwind) {
    await writeText(root, "postcss.config.mjs", "export default {};\n");
  }
  if (options.packageManagerField === false) {
    const lockfile: Record<PackageManager, string> = {
      npm: "package-lock.json",
      pnpm: "pnpm-lock.yaml",
      yarn: "yarn.lock",
      bun: "bun.lock",
    };
    await writeText(root, lockfile[manager], "\n");
  }
}

export async function createTemplates(
  root: string,
  content = "alias={{IMPORT_ALIAS}} app={{APP_ROOT}} source={{SOURCE_ROOT}}\n",
): Promise<void> {
  await writeText(
    root,
    "manifest.json",
    `${JSON.stringify(
      {
        schemaVersion: 2,
        placeholders: { IMPORT_ALIAS: "test" },
        dependencies: { jose: "^6.1.0", zod: "^4.1.0" },
        modeDependencies: {
          "self-hosted": { "self-host-helper": "^1.0.0" },
        },
        shadcnComponents: ["button", "card"],
        files: [
          {
            source: "files/example.ts.template",
            target: "{{SOURCE_ROOT}}/components/ticketing/example.ts",
          },
          {
            source: "files/mode.connected.ts.template",
            target: "{{SOURCE_ROOT}}/lib/ticketing/mode.ts",
            modes: ["connected"],
          },
          {
            source: "files/mode.self-hosted.ts.template",
            target: "{{SOURCE_ROOT}}/lib/ticketing/mode.ts",
            modes: ["self-hosted"],
          },
          {
            source: "files/connected-only.ts.template",
            target: "{{SOURCE_ROOT}}/lib/ticketing/connected-only.ts",
            modes: ["connected"],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeText(root, "files/example.ts.template", content);
  await writeText(root, "files/mode.connected.ts.template", 'export const mode = "connected";\n');
  await writeText(root, "files/mode.self-hosted.ts.template", 'export const mode = "self-hosted";\n');
  await writeText(root, "files/connected-only.ts.template", "export const connected = true;\n");
}

export class RecordingRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];

  async run(invocation: CommandInvocation): Promise<void> {
    this.invocations.push(invocation);
  }
}

export class RecordingLogger implements InstallerLogger {
  readonly infoMessages: string[] = [];
  readonly warningMessages: string[] = [];
  readonly errorMessages: string[] = [];

  info(message: string): void {
    this.infoMessages.push(message);
  }

  warn(message: string): void {
    this.warningMessages.push(message);
  }

  error(message: string): void {
    this.errorMessages.push(message);
  }
}
