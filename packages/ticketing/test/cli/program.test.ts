import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import type { InstallerDependencies } from "../../src/cli/types.js";
import {
  createNextProject,
  createTemplates,
  RecordingLogger,
  RecordingRunner,
  writeText,
} from "./fixture.js";

const temporaryDirectories: string[] = [];
const originalDatabaseUrl = process.env.DATABASE_TICKETING_URL;

afterEach(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_TICKETING_URL;
  } else {
    process.env.DATABASE_TICKETING_URL = originalDatabaseUrl;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createProgram", () => {
  it("wires init flags and prints a server-page example without editing a page", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "ticketing-program-project-"));
    const templates = await mkdtemp(path.join(os.tmpdir(), "ticketing-program-templates-"));
    temporaryDirectories.push(project, templates);
    await createNextProject(project, { alias: "~", packageManager: "pnpm" });
    await createTemplates(templates);
    const runner = new RecordingRunner();
    const logger = new RecordingLogger();
    const dependencies: InstallerDependencies = {
      templatesDirectory: templates,
      packageVersion: "0.1.0",
      runner,
      logger,
      confirm: async () => false,
    };

    await createProgram(dependencies).parseAsync([
      "node",
      "ticketing",
      "init",
      "--cwd",
      project,
      "--mode",
      "self-hosted",
      "--dry-run",
      "--skip-install",
      "--yes",
      "--overwrite",
    ]);

    expect(runner.invocations).toHaveLength(0);
    expect(logger.infoMessages.join("\n")).toContain(
      'import { Ticketing } from "~/components/ticketing";',
    );
    expect(logger.infoMessages.join("\n")).toContain("sourceSystem=\"your-app\"");
    expect(logger.infoMessages.join("\n")).toContain("Ticketing mode: self-hosted.");
    expect(logger.infoMessages.join("\n")).toContain(
      "pnpm exec ticketing migrate --cwd .",
    );
    expect(logger.infoMessages.join("\n")).toContain(
      "Self-hosted mode ignores TICKETING_API_URL",
    );
  });

  it("rejects a remote database URL that explicitly disables TLS before migrations", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "ticketing-program-project-"));
    const templates = await mkdtemp(path.join(os.tmpdir(), "ticketing-program-templates-"));
    temporaryDirectories.push(project, templates);
    await writeText(
      project,
      ".env.local",
      "DATABASE_TICKETING_URL=postgresql://ticketing:password@database.example.com/ticketing?sslmode=disable\n",
    );
    const dependencies: InstallerDependencies = {
      templatesDirectory: templates,
      packageVersion: "0.2.1",
      runner: new RecordingRunner(),
      logger: new RecordingLogger(),
      confirm: async () => false,
    };

    await expect(
      createProgram(dependencies).parseAsync([
        "node",
        "ticketing",
        "migrate",
        "--cwd",
        project,
      ]),
    ).rejects.toThrow("must not disable TLS");
  });
});
