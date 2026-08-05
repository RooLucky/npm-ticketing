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
} from "./fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createProgram", () => {
  it("wires init flags and prints a server-page example without editing a page", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "ticketing-program-project-"));
    const templates = await mkdtemp(path.join(os.tmpdir(), "ticketing-program-templates-"));
    temporaryDirectories.push(project, templates);
    await createNextProject(project, { alias: "~" });
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
  });
});
