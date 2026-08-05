import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initProject } from "../../src/cli/install.js";
import type { InitOptions, InstallerDependencies } from "../../src/cli/types.js";
import {
  createNextProject,
  createTemplates,
  RecordingLogger,
  RecordingRunner,
  writeText,
} from "./fixture.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  project: string;
  templates: string;
  runner: RecordingRunner;
  logger: RecordingLogger;
  dependencies: InstallerDependencies;
}> {
  const project = await temporaryDirectory("ticketing-project-");
  const templates = await temporaryDirectory("ticketing-templates-");
  await createNextProject(project, { sourceRoot: "src" });
  await createTemplates(templates);
  const runner = new RecordingRunner();
  const logger = new RecordingLogger();
  return {
    project,
    templates,
    runner,
    logger,
    dependencies: {
      templatesDirectory: templates,
      packageVersion: "0.1.0-test",
      runner,
      logger,
      confirm: async () => false,
    },
  };
}

function options(project: string, overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    cwd: project,
    yes: false,
    dryRun: false,
    overwrite: false,
    skipInstall: true,
    ...overrides,
  };
}

describe("initProject", () => {
  it("keeps dry runs side-effect free while reporting files and injectable commands", async () => {
    const setup = await fixture();

    const result = await initProject(
      options(setup.project, { dryRun: true, skipInstall: false, yes: true }),
      setup.dependencies,
    );

    expect(result.actions).toEqual(
      expect.arrayContaining([
        { kind: "create", path: "src/components/ticketing/example.ts" },
        { kind: "create", path: ".env.example" },
      ]),
    );
    expect(result.commands.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "npx", args: ["--yes", "shadcn@4.16.1", "init", "--defaults"] },
      {
        command: "npx",
        args: ["--yes", "shadcn@4.16.1", "add", "button", "card", "--yes"],
      },
      { command: "npm", args: ["install", "jose@^6.1.0", "zod@^4.1.0"] },
    ]);
    expect(setup.runner.invocations).toHaveLength(0);
    await expect(
      readFile(path.join(setup.project, "src/components/ticketing/example.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(setup.project, ".env.example"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prints required manual commands when dependency installation is skipped", async () => {
    const setup = await fixture();

    const result = await initProject(options(setup.project), setup.dependencies);

    expect(result.commands.length).toBeGreaterThan(0);
    expect(setup.runner.invocations).toHaveLength(0);
    expect(setup.logger.infoMessages.join("\n")).toContain(
      "Dependency/UI installation was skipped. Run these commands manually:",
    );
    expect(setup.logger.infoMessages.join("\n")).toContain("shadcn@4.16.1");
  });

  it("renders placeholders, merges environment examples, and records hashes", async () => {
    const setup = await fixture();
    await writeText(
      setup.project,
      ".env.example",
      "EXISTING=value\nTICKETING_API_URL=https://custom.example/api\n",
    );

    const result = await initProject(options(setup.project), setup.dependencies);

    expect(result.conflicts).toEqual([]);
    expect(
      await readFile(
        path.join(setup.project, "src/components/ticketing/example.ts"),
        "utf8",
      ),
    ).toBe("alias=@ app=src/app source=src\n");
    const environment = await readFile(path.join(setup.project, ".env.example"), "utf8");
    expect(environment).toContain("EXISTING=value");
    expect(environment).toContain("TICKETING_API_URL=https://custom.example/api");
    expect(environment.match(/TICKETING_API_URL=/g)).toHaveLength(1);
    expect(environment).toContain("TICKETING_CLIENT_ID=replace-with-your-client-id");
    expect(environment).toContain(
      "TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes",
    );
    const generatedManifest = JSON.parse(
      await readFile(path.join(setup.project, ".ticketing/manifest.json"), "utf8"),
    ) as {
      package: { version: string };
      files: Record<string, { sha256: string }>;
    };
    expect(generatedManifest.package.version).toBe("0.1.0-test");
    expect(generatedManifest.files["src/components/ticketing/example.ts"]?.sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(setup.runner.invocations).toHaveLength(0);
  });

  it("renders working relative imports when no source-root alias exists", async () => {
    const setup = await fixture();
    await createNextProject(setup.project, { sourceRoot: "src", alias: false });

    await initProject(options(setup.project), setup.dependencies);

    expect(
      await readFile(
        path.join(setup.project, "src/components/ticketing/example.ts"),
        "utf8",
      ),
    ).toBe("alias=../.. app=src/app source=src\n");
    expect(setup.logger.warningMessages).toContain(
      "No wildcard path alias maps to the source root; generated files will use relative imports.",
    );
  });

  it("renders the configured shadcn UI import path", async () => {
    const setup = await fixture();
    await createNextProject(setup.project, { sourceRoot: "src", shadcn: true });
    await writeText(
      setup.project,
      "components.json",
      JSON.stringify({ aliases: { components: "@/design", ui: "@/design/primitives" } }),
    );
    await createTemplates(setup.templates, "ui={{UI_IMPORT}}\n");

    await initProject(options(setup.project), setup.dependencies);

    expect(
      await readFile(
        path.join(setup.project, "src/components/ticketing/example.ts"),
        "utf8",
      ),
    ).toBe("ui=@/design/primitives\n");
  });

  it("is idempotent and safely upgrades an unmodified generated file", async () => {
    const setup = await fixture();
    await initProject(options(setup.project), setup.dependencies);

    const second = await initProject(options(setup.project), setup.dependencies);
    expect(second.actions).toContainEqual({
      kind: "identical",
      path: "src/components/ticketing/example.ts",
    });

    await createTemplates(setup.templates, "updated {{IMPORT_ALIAS}}\n");
    const upgraded = await initProject(options(setup.project), setup.dependencies);
    expect(upgraded.actions).toContainEqual({
      kind: "update",
      path: "src/components/ticketing/example.ts",
    });
    expect(
      await readFile(
        path.join(setup.project, "src/components/ticketing/example.ts"),
        "utf8",
      ),
    ).toBe("updated @\n");
  });

  it("preserves modified files unless overwrite is explicitly accepted", async () => {
    const setup = await fixture();
    await initProject(options(setup.project), setup.dependencies);
    const generatedFile = path.join(setup.project, "src/components/ticketing/example.ts");
    await writeText(setup.project, "src/components/ticketing/example.ts", "user edit\n");
    await createTemplates(setup.templates, "new generator content\n");

    const preserved = await initProject(options(setup.project), setup.dependencies);
    expect(preserved.conflicts).toEqual(["src/components/ticketing/example.ts"]);
    expect(await readFile(generatedFile, "utf8")).toBe("user edit\n");

    const confirm = vi.fn(async () => false);
    const declined = await initProject(
      options(setup.project, { overwrite: true }),
      { ...setup.dependencies, confirm },
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(declined.conflicts).toEqual(["src/components/ticketing/example.ts"]);
    expect(await readFile(generatedFile, "utf8")).toBe("user edit\n");

    const accepted = await initProject(
      options(setup.project, { overwrite: true, yes: true }),
      { ...setup.dependencies, confirm: vi.fn(async () => false) },
    );
    expect(accepted.conflicts).toEqual([]);
    expect(accepted.actions).toContainEqual({
      kind: "overwrite",
      path: "src/components/ticketing/example.ts",
    });
    expect(await readFile(generatedFile, "utf8")).toBe("new generator content\n");
  });

  it("rejects a manifest target that escapes the consuming project", async () => {
    const setup = await fixture();
    await writeText(
      setup.templates,
      "manifest.json",
      JSON.stringify({
        files: [{ source: "files/example.ts.template", target: "../outside.ts" }],
      }),
    );

    await expect(initProject(options(setup.project), setup.dependencies)).rejects.toThrow(
      "Template target escapes the project",
    );
  });
});
