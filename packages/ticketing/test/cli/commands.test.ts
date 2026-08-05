import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../../src/cli/detect.js";
import { buildInstallCommands } from "../../src/cli/install.js";
import type { PackageManager } from "../../src/cli/types.js";
import { createNextProject } from "./fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("buildInstallCommands", () => {
  it.each([
    ["npm", "npx", ["--yes", "shadcn@4.16.1"]],
    ["pnpm", "pnpm", ["dlx", "shadcn@4.16.1"]],
    ["yarn", "npx", ["--yes", "shadcn@4.16.1"]],
    ["bun", "bunx", ["shadcn@4.16.1"]],
  ] as const)("uses %s-native commands", async (manager, executable, prefix) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `ticketing-${manager}-`));
    temporaryDirectories.push(root);
    await createNextProject(root, {
      packageManager: manager as PackageManager,
      shadcn: true,
      dependencies: { jose: "^6.0.0" },
    });
    const project = await detectProject(root);

    const commands = await buildInstallCommands(
      project,
      ["jose@^6.1.0", "zod@^4.1.0"],
      ["button"],
      true,
    );

    expect(commands[0]).toMatchObject({
      command: executable,
      args: [...prefix, "add", "button", "--yes"],
      cwd: root,
    });
    expect(commands.at(-1)?.args).toContain("zod@^4.1.0");
    expect(commands.at(-1)?.args).toContain("jose@^6.1.0");
  });

  it("uses yarn dlx for modern Yarn releases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ticketing-yarn-berry-"));
    temporaryDirectories.push(root);
    await createNextProject(root, {
      packageManager: "yarn",
      packageManagerVersion: "4.9.2",
      shadcn: true,
    });

    const commands = await buildInstallCommands(
      await detectProject(root),
      [],
      ["button"],
      true,
    );

    expect(commands[0]).toMatchObject({
      command: "yarn",
      args: ["dlx", "shadcn@4.16.1", "add", "button", "--yes"],
    });
  });

  it("rejects an incompatible dependency major instead of silently generating broken code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ticketing-zod-3-"));
    temporaryDirectories.push(root);
    await createNextProject(root, {
      shadcn: true,
      dependencies: { zod: "^3.25.0" },
    });

    await expect(
      buildInstallCommands(await detectProject(root), ["zod@^4.1.0"], [], true),
    ).rejects.toThrow("zod ^3.25.0 is incompatible");
  });
});
