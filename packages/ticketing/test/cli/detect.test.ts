import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../../src/cli/detect.js";
import { createNextProject, writeText } from "./fixture.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticketing-detect-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("detectProject", () => {
  it("detects a src App Router project, JSONC aliases, Tailwind, shadcn, and the declared manager", async () => {
    const root = await temporaryDirectory();
    await createNextProject(root, {
      sourceRoot: "src",
      packageManager: "pnpm",
      alias: "~",
      tailwind: true,
      shadcn: true,
    });

    const project = await detectProject(root);

    expect(project).toMatchObject({
      root,
      sourceRoot: "src",
      appRoot: "src/app",
      importAlias: "~",
      packageManager: "pnpm",
      packageManagerVersion: "1.0.0",
      nextVersion: "16.3.0",
      tailwind: { installed: true, version: "^4.1.0" },
      shadcn: { installed: true, configPath: "components.json" },
    });
  });

  it("preserves a custom shadcn UI import path", async () => {
    const root = await temporaryDirectory();
    await createNextProject(root, { sourceRoot: "src", shadcn: true });
    await writeText(
      root,
      "components.json",
      JSON.stringify({ aliases: { components: "@/design", ui: "@/design/primitives" } }),
    );

    await expect(detectProject(root)).resolves.toMatchObject({
      shadcn: { uiImport: "@/design/primitives" },
    });
  });

  it.each([
    ["npm", "package-lock.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
  ] as const)("detects %s from %s", async (manager) => {
    const root = await temporaryDirectory();
    await createNextProject(root, {
      sourceRoot: ".",
      packageManager: manager,
      packageManagerField: false,
    });

    const project = await detectProject(root);

    expect(project.sourceRoot).toBe(".");
    expect(project.appRoot).toBe("app");
    expect(project.packageManager).toBe(manager);
  });

  it("prefers src/app when both App Router roots exist", async () => {
    const root = await temporaryDirectory();
    await createNextProject(root, { sourceRoot: "src" });
    await writeText(root, "app/layout.tsx", "export default null;\n");

    await expect(detectProject(root)).resolves.toMatchObject({
      sourceRoot: "src",
      appRoot: "src/app",
    });
  });

  it("does not select an alias that points somewhere other than the source root", async () => {
    const root = await temporaryDirectory();
    await createNextProject(root, { sourceRoot: "src", alias: false });
    await writeText(
      root,
      "tsconfig.json",
      '{"compilerOptions":{"baseUrl":".","paths":{"~/*":["./src/lib/*"]}}}\n',
    );

    await expect(detectProject(root)).resolves.toMatchObject({ importAlias: "" });
  });

  it("inherits the nearest monorepo package manager", async () => {
    const monorepo = await temporaryDirectory();
    const root = path.join(monorepo, "apps", "web");
    await writeText(
      monorepo,
      "package.json",
      '{"private":true,"packageManager":"pnpm@11.20.0"}\n',
    );
    await createNextProject(root, {
      packageManagerField: false,
      packageManager: "npm",
    });
    await rm(path.join(root, "package-lock.json"));

    await expect(detectProject(root)).resolves.toMatchObject({
      packageManager: "pnpm",
      packageManagerVersion: "11.20.0",
    });
  });

  it("rejects non-Next, JavaScript-only, and Pages Router projects", async () => {
    const noNext = await temporaryDirectory();
    await writeText(noNext, "package.json", "{\"dependencies\":{}}\n");
    await expect(detectProject(noNext)).rejects.toThrow("requires a Next.js project");

    const noTypescript = await temporaryDirectory();
    await writeText(noTypescript, "package.json", "{\"dependencies\":{\"next\":\"16\"}}\n");
    await expect(detectProject(noTypescript)).rejects.toThrow("TypeScript projects only");

    const pagesRouter = await temporaryDirectory();
    await writeText(pagesRouter, "package.json", "{\"dependencies\":{\"next\":\"16\"}}\n");
    await writeText(pagesRouter, "tsconfig.json", "{}\n");
    await writeText(pagesRouter, "pages/index.tsx", "export default null;\n");
    await expect(detectProject(pagesRouter)).rejects.toThrow("No Next.js App Router directory");
  });
});
