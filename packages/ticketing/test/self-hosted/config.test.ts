import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertTicketingDatabaseUrl,
  SelfHostedConfigSchema,
  TicketingDatabaseUrlSchema,
  TicketingRedisUrlSchema,
  ticketingPostgresConnectionOptions,
} from "../../src/self-hosted/schemas.js";

describe("self-hosted transport configuration", () => {
  it.each([
    "postgresql://ticketing:secret@localhost:5432/ticketing",
    "postgres://ticketing:secret@127.0.0.1:5432/ticketing?sslmode=disable",
    "postgresql://ticketing:secret@[::1]:5432/ticketing",
  ])("allows a plaintext loopback PostgreSQL URL: %s", (value) => {
    expect(TicketingDatabaseUrlSchema.safeParse(value).success).toBe(true);
    expect(() => assertTicketingDatabaseUrl(value)).not.toThrow();
  });

  it("accepts managed PostgreSQL URLs while rejecting explicit insecure TLS modes", () => {
    for (const suffix of ["", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=verify-full"]) {
      expect(
        TicketingDatabaseUrlSchema.safeParse(
          `postgresql://ticketing:secret@database.example.test:5432/ticketing${suffix}`,
        ).success,
      ).toBe(true);
    }

    for (const suffix of [
      "?sslmode=disable",
      "?sslmode=prefer",
      "?sslmode=verify-full&sslmode=disable",
      "?ssl=false",
    ]) {
      expect(
        TicketingDatabaseUrlSchema.safeParse(
          `postgresql://ticketing:secret@database.example.test:5432/ticketing${suffix}`,
        ).success,
      ).toBe(false);
    }
  });

  it("enforces certificate-verified TLS for provider URLs that omit sslmode", () => {
    const providerUrl =
      "postgresql://postgres.project:secret@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres";
    expect(ticketingPostgresConnectionOptions(providerUrl)).toEqual({
      connectionString: providerUrl,
      ssl: { rejectUnauthorized: true },
    });

    const withProviderMode = `${providerUrl}?sslmode=require`;
    expect(ticketingPostgresConnectionOptions(withProviderMode)).toEqual({
      connectionString: providerUrl,
      ssl: { rejectUnauthorized: true },
    });
  });

  it.each([
    "redis://localhost:6379",
    "redis://127.0.0.1:6379",
    "redis://[::1]:6379",
    "rediss://cache.example.test:6379",
  ])("allows a secure or loopback Redis URL: %s", (value) => {
    expect(TicketingRedisUrlSchema.safeParse(value).success).toBe(true);
  });

  it("rejects plaintext Redis outside exact loopback hosts", () => {
    for (const value of [
      "redis://cache.example.test:6379",
      "redis://localhost.example.test:6379",
      "http://localhost:6379",
    ]) {
      expect(TicketingRedisUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("applies the transport policy through the complete runtime config", () => {
    const authentication = {
      clientId: "runtime-config-test",
      clientSecret: new TextEncoder().encode(
        "runtime-config-test-secret-with-at-least-32-bytes",
      ),
    };
    const storage = {
      region: "auto",
      bucket: "private-ticketing",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      forcePathStyle: false,
    };
    expect(
      SelfHostedConfigSchema.safeParse({
        ...authentication,
        databaseUrl: "postgresql://ticketing:secret@database.example.test:5432/ticketing",
        redisUrl: "rediss://cache.example.test:6379",
        storage,
      }).success,
    ).toBe(true);
    expect(
      SelfHostedConfigSchema.safeParse({
        ...authentication,
        databaseUrl:
          "postgresql://ticketing:secret@database.example.test:5432/ticketing?sslmode=disable",
        redisUrl: "redis://cache.example.test:6379",
        storage,
      }).success,
    ).toBe(false);
  });

  it("uses the shared schemas in the generated server-only config", async () => {
    const template = await readFile(
      new URL(
        "../../templates/files/lib/ticketing/config.self-hosted.ts.template",
        import.meta.url,
      ),
      "utf8",
    );

    expect(template).toContain("TicketingDatabaseUrlSchema");
    expect(template).toContain("TicketingRedisUrlSchema.optional()");
    expect(template).not.toContain("function requireProtocol");
  });
});
