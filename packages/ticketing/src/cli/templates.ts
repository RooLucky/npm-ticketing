import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CliError } from "./errors.js";
import { parseJsonc } from "./json.js";
import type { ProjectInfo, TemplateManifest } from "./types.js";

const templateManifestSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    placeholders: z.record(z.string(), z.string()).optional(),
    files: z
      .array(
        z.object({
          source: z.string().min(1),
          target: z.string().min(1),
        }),
      )
      .min(1),
    dependencies: z
      .union([
        z.array(z.string().min(1)),
        z.record(z.string().min(1), z.string().min(1)),
      ])
      .optional(),
    shadcnComponents: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type RenderedTemplate = {
  sourcePath: string;
  targetPath: string;
  relativeTarget: string;
  content: string;
  hash: string;
};

export type LoadedTemplates = {
  manifest: TemplateManifest;
  files: RenderedTemplate[];
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new CliError(`Could not resolve a safe parent for ${candidate}.`);
      }
      current = parent;
    }
  }
}

async function assertNoSymlinkEscape(root: string, candidate: string): Promise<void> {
  const rootReal = await realpath(root);
  const existingAncestor = await nearestExistingPath(candidate);
  const ancestorReal = await realpath(existingAncestor);
  if (!isWithin(rootReal, ancestorReal)) {
    throw new CliError(`Refusing to access a path outside the project: ${candidate}`);
  }
}

export async function resolveSafeProjectPath(
  root: string,
  relativeTarget: string,
): Promise<string> {
  const target = safeRelativeTarget(root, relativeTarget);
  await assertNoSymlinkEscape(root, target.absolute);
  return target.absolute;
}

function interpolate(value: string, replacements: Record<string, string>): string {
  let result = value;
  for (const [name, replacement] of Object.entries(replacements)) {
    result = result.split(`{{${name}}}`).join(replacement);
  }
  const unresolved = result.match(/{{[A-Z][A-Z0-9_]*}}/);
  if (unresolved) {
    throw new CliError(`Unknown template placeholder ${unresolved[0]}.`);
  }
  return result;
}

function relativeSourceImport(project: ProjectInfo, targetPath: string): string {
  const sourceRoot = project.sourceRoot === "."
    ? project.root
    : path.join(project.root, project.sourceRoot);
  const relative = path
    .relative(path.dirname(targetPath), sourceRoot)
    .replaceAll(path.sep, "/");
  if (!relative) return ".";
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function safeRelativeTarget(root: string, target: string): {
  absolute: string;
  relative: string;
} {
  if (target.includes("\0")) {
    throw new CliError("A template target contains an invalid null byte.");
  }

  const platformTarget = target.replaceAll("/", path.sep).replaceAll("\\", path.sep);
  if (path.isAbsolute(platformTarget)) {
    throw new CliError(`Template target must be relative: ${target}`);
  }

  const absolute = path.resolve(root, platformTarget);
  if (!isWithin(root, absolute) || absolute === root) {
    throw new CliError(`Template target escapes the project: ${target}`);
  }

  return {
    absolute,
    relative: path.relative(root, absolute).replaceAll(path.sep, "/"),
  };
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function loadTemplates(
  templatesDirectory: string,
  project: ProjectInfo,
): Promise<LoadedTemplates> {
  const templatesRoot = await realpath(path.resolve(templatesDirectory)).catch((error) => {
    throw new CliError(`Templates directory does not exist: ${templatesDirectory}`, 1, {
      cause: error,
    });
  });
  const manifestPath = path.join(templatesRoot, "manifest.json");
  const rawManifest = await readFile(manifestPath, "utf8").catch((error) => {
    throw new CliError(`Could not read template manifest: ${manifestPath}`, 1, {
      cause: error,
    });
  });

  const parsedManifest = parseJsonc<unknown>(rawManifest, manifestPath);
  const validated = templateManifestSchema.safeParse(parsedManifest);
  if (!validated.success) {
    throw new CliError(
      `Invalid template manifest: ${validated.error.issues
        .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const manifest: TemplateManifest = {
    files: validated.data.files,
    dependencies: Array.isArray(validated.data.dependencies)
      ? validated.data.dependencies
      : Object.entries(validated.data.dependencies ?? {}).map(
          ([name, version]) => `${name}@${version}`,
        ),
    ...(validated.data.shadcnComponents
      ? { shadcnComponents: validated.data.shadcnComponents }
      : {}),
  };

  const projectReplacements = {
    SOURCE_ROOT: project.sourceRoot,
    APP_ROOT: project.appRoot,
    IMPORT_ALIAS: project.importAlias || ".",
  };
  const seenTargets = new Set<string>();
  const files: RenderedTemplate[] = [];

  for (const entry of manifest.files) {
    const sourcePath = path.resolve(templatesRoot, entry.source.replaceAll("/", path.sep));
    if (!isWithin(templatesRoot, sourcePath) || sourcePath === templatesRoot) {
      throw new CliError(`Template source escapes the templates directory: ${entry.source}`);
    }
    const sourceReal = await realpath(sourcePath).catch((error) => {
      throw new CliError(`Template source does not exist: ${entry.source}`, 1, {
        cause: error,
      });
    });
    if (!isWithin(templatesRoot, sourceReal)) {
      throw new CliError(`Template source escapes through a symlink: ${entry.source}`);
    }

    const renderedTarget = interpolate(entry.target, projectReplacements);
    const target = safeRelativeTarget(project.root, renderedTarget);
    await assertNoSymlinkEscape(project.root, target.absolute);
    const targetKey = process.platform === "win32"
      ? target.relative.toLowerCase()
      : target.relative;
    if (seenTargets.has(targetKey)) {
      throw new CliError(`Multiple templates target ${target.relative}.`);
    }
    seenTargets.add(targetKey);

    const source = await readFile(sourceReal, "utf8");
    const content = interpolate(source, {
      ...projectReplacements,
      IMPORT_ALIAS: project.importAlias || relativeSourceImport(project, target.absolute),
      UI_IMPORT:
        project.shadcn.uiImport ??
        `${project.importAlias || relativeSourceImport(project, target.absolute)}/components/ui`,
    });
    files.push({
      sourcePath: sourceReal,
      targetPath: target.absolute,
      relativeTarget: target.relative,
      content,
      hash: sha256(content),
    });
  }

  return { manifest, files };
}
