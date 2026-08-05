import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TicketingDatabaseUrlSchema,
  TicketingRedisUrlSchema,
} from "../../src/self-hosted/schemas.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const configTemplate = new URL(
  "../../templates/files/lib/ticketing/config.self-hosted.ts.template",
  import.meta.url,
);
const environmentNames = [
  "TICKETING_CLIENT_ID",
  "TICKETING_CLIENT_SECRET",
  "DATABASE_TICKETING_URL",
  "REDIS_TICKETING_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "S3_BUCKET_NAME",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
] as const;

type GeneratedTicketingConfig = {
  databaseUrl: string;
  storage: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
};

type SchemaTestGlobal = typeof globalThis & {
  __TICKETING_GENERATED_CONFIG_TEST_SCHEMAS__?: {
    TicketingDatabaseUrlSchema: typeof TicketingDatabaseUrlSchema;
    TicketingRedisUrlSchema: typeof TicketingRedisUrlSchema;
  };
};

const temporaryDirectories: string[] = [];
let originalEnvironment: Partial<Record<(typeof environmentNames)[number], string>>;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    environmentNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  for (const name of environmentNames) delete process.env[name];
});

afterEach(async () => {
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  delete (globalThis as SchemaTestGlobal)
    .__TICKETING_GENERATED_CONFIG_TEST_SCHEMAS__;
});

function setEnvironment(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

async function loadGeneratedConfig(): Promise<GeneratedTicketingConfig> {
  const directory = await mkdtemp(
    path.join(packageRoot, ".ticketing-self-hosted-config-test-"),
  );
  temporaryDirectories.push(directory);
  let source = (await readFile(configTemplate, "utf8")).replace(
    /^import "server-only";\r?\n\r?\n/u,
    "",
  );
  source = source.replace(
    /import\s*\{\s*TicketingDatabaseUrlSchema,\s*TicketingRedisUrlSchema,?\s*\}\s*from "@quanby\/ticketing\/self-hosted";\r?\n/u,
    "const { TicketingDatabaseUrlSchema, TicketingRedisUrlSchema } = " +
      "globalThis.__TICKETING_GENERATED_CONFIG_TEST_SCHEMAS__;\n",
  );
  if (source.includes('from "@quanby/ticketing/self-hosted"')) {
    throw new Error("Could not inject the source runtime schemas into the config template");
  }
  (globalThis as SchemaTestGlobal).__TICKETING_GENERATED_CONFIG_TEST_SCHEMAS__ = {
    TicketingDatabaseUrlSchema,
    TicketingRedisUrlSchema,
  };
  const compiled = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
    },
    fileName: "config.ts",
  }).outputText;
  const modulePath = path.join(directory, "config.mjs");
  await writeFile(modulePath, compiled, "utf8");
  const generated = (await import(pathToFileURL(modulePath).href)) as {
    getTicketingConfig(): GeneratedTicketingConfig;
  };
  return generated.getTicketingConfig();
}

function commonEnvironment(): Record<string, string> {
  return {
    TICKETING_CLIENT_ID: "rms-production",
    TICKETING_CLIENT_SECRET: "test-client-secret-that-is-at-least-32-bytes",
    DATABASE_TICKETING_URL:
      "postgresql://ticketing:password@database.example.test:5432/ticketing?sslmode=verify-full",
  };
}

describe("generated self-hosted environment adapter", () => {
  it("maps the exact RMS AWS names without requiring a storage endpoint", async () => {
    setEnvironment({
      ...commonEnvironment(),
      AWS_ACCESS_KEY_ID: "rms-aws-access-key",
      AWS_SECRET_ACCESS_KEY: "rms-aws-secret-key",
      AWS_REGION: "ap-southeast-1",
      S3_BUCKET_NAME: "rms-ticketing-attachments",
    });

    const config = await loadGeneratedConfig();

    expect(config.databaseUrl).toBe(
      "postgresql://ticketing:password@database.example.test:5432/ticketing?sslmode=verify-full",
    );
    expect(config.storage).toEqual({
      region: "ap-southeast-1",
      bucket: "rms-ticketing-attachments",
      accessKeyId: "rms-aws-access-key",
      secretAccessKey: "rms-aws-secret-key",
      forcePathStyle: false,
    });
    expect(config.storage.endpoint).toBeUndefined();
  });

  it("gives explicit STORAGE names precedence for S3-compatible providers", async () => {
    setEnvironment({
      ...commonEnvironment(),
      AWS_ACCESS_KEY_ID: "aws-access-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret-key",
      AWS_REGION: "ap-southeast-1",
      S3_BUCKET_NAME: "aws-bucket",
      STORAGE_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      STORAGE_REGION: "auto",
      STORAGE_BUCKET: "r2-ticketing-attachments",
      STORAGE_ACCESS_KEY_ID: "r2-access-key",
      STORAGE_SECRET_ACCESS_KEY: "r2-secret-key",
      STORAGE_FORCE_PATH_STYLE: "true",
    });

    const config = await loadGeneratedConfig();

    expect(config.storage).toEqual({
      endpoint: "https://account-id.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "r2-ticketing-attachments",
      accessKeyId: "r2-access-key",
      secretAccessKey: "r2-secret-key",
      forcePathStyle: true,
    });
  });
});
