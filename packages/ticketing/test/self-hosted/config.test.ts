import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertTicketingDatabaseUrl,
  SelfHostedConfigSchema,
  TicketingDatabaseUrlSchema,
  TicketingRedisUrlSchema,
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

  it("requires exactly sslmode=verify-full for remote PostgreSQL", () => {
    expect(
      TicketingDatabaseUrlSchema.safeParse(
        "postgresql://ticketing:secret@database.example.test:5432/ticketing?sslmode=verify-full",
      ).success,
    ).toBe(true);

    for (const suffix of [
      "",
      "?sslmode=disable",
      "?sslmode=require",
      "?sslmode=verify-ca",
      "?sslmode=verify-full&sslmode=disable",
    ]) {
      expect(
        TicketingDatabaseUrlSchema.safeParse(
          `postgresql://ticketing:secret@database.example.test:5432/ticketing${suffix}`,
        ).success,
      ).toBe(false);
    }
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
        databaseUrl:
          "postgresql://ticketing:secret@database.example.test:5432/ticketing?sslmode=verify-full",
        redisUrl: "rediss://cache.example.test:6379",
        storage,
      }).success,
    ).toBe(true);
    expect(
      SelfHostedConfigSchema.safeParse({
        ...authentication,
        databaseUrl: "postgresql://ticketing:secret@database.example.test:5432/ticketing",
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
