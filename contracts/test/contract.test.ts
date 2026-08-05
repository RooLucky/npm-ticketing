import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CreateTicketRequestSchema,
  IdempotencyKeySchema,
  PageUrlSchema,
  PrivateTransferUrlSchema,
  TicketingClaimsSchema,
} from "../src/schemas.js";
import { renderOpenApiDocument } from "../src/openapi.js";

describe("canonical ticketing contract", () => {
  it("keeps the committed OpenAPI document deterministic", async () => {
    const committed = await readFile(
      new URL("../openapi/ticketing-v1.yaml", import.meta.url),
      "utf8",
    );
    expect(committed.replace(/\r\n/g, "\n")).toBe(renderOpenApiDocument());
  });

  it("enforces the security-sensitive shared boundaries", () => {
    expect(PageUrlSchema.safeParse("/support").success).toBe(true);
    expect(PageUrlSchema.safeParse("//attacker.test/support").success).toBe(false);
    expect(PageUrlSchema.safeParse("https://").success).toBe(false);
    expect(PrivateTransferUrlSchema.safeParse("https://uploads.example.test/file").success).toBe(
      true,
    );
    expect(PrivateTransferUrlSchema.safeParse("http://uploads.example.test/file").success).toBe(
      false,
    );
    expect(PrivateTransferUrlSchema.safeParse("http://localhost:4010/file").success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("valid-key-0001").success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("invalid key").success).toBe(false);
    expect(
      CreateTicketRequestSchema.safeParse({
        title: "A valid ticket",
        description: "Details",
        category: "bug",
      }).success,
    ).toBe(true);
  });

  it("requires canonical identity, context, lifetime, and scope claims", () => {
    const claims = {
      iss: "fixture-app",
      sub: "alice",
      aud: "ticketing-api",
      name: "Alice",
      sourceSystem: "fixture-app",
      pageUrl: "/support",
      scopes: ["tickets:read"],
      iat: 100,
      exp: 3700,
      jti: "session-1",
    };
    expect(TicketingClaimsSchema.safeParse(claims).success).toBe(true);
    expect(TicketingClaimsSchema.safeParse({ ...claims, exp: 3701 }).success).toBe(false);
  });
});
