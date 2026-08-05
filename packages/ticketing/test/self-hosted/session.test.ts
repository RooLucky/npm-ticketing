import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  executeSelfHostedTicketingRequest,
  SelfHostedTicketingError,
} from "../../src/self-hosted/index.js";
import type {
  SelfHostedTicketingConfig,
  SelfHostedTicketingOperation,
} from "../../src/self-hosted/types.js";

const clientId = "self-hosted-session-test";
const clientSecret = new TextEncoder().encode(
  "self-hosted-session-test-secret-with-at-least-32-bytes",
);
const config: SelfHostedTicketingConfig = {
  clientId,
  clientSecret,
  databaseUrl: "postgresql://ticketing:ticketing@localhost:5432/ticketing_session_test",
  storage: {
    region: "session-test-region",
    bucket: "session-test-bucket",
    accessKeyId: "session-test-access-key",
    secretAccessKey: "session-test-secret-key",
    forcePathStyle: false,
  },
};
const unreachableOperation: SelfHostedTicketingOperation = {
  path: "not-a-ticketing-route",
  method: "GET",
};

type SessionOverrides = {
  issuer?: string;
  audience?: string | string[];
  kid?: string;
  algorithm?: string;
  tokenType?: string;
  issuedAt?: number;
  expiresAt?: number;
  scopes?: string[];
  omitName?: boolean;
};

async function issueSession(overrides: SessionOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    ...(overrides.omitName ? {} : { name: "Session Test User" }),
    email: "session-user@example.test",
    sourceSystem: "session-tests",
    moduleName: "security",
    pageUrl: "/ticketing",
    scopes: overrides.scopes ?? [
      "tickets:read",
      "tickets:create",
      "tickets:reply",
      "uploads:create",
    ],
  })
    .setProtectedHeader({
      alg: overrides.algorithm ?? "HS256",
      typ: overrides.tokenType ?? "JWT",
      kid: overrides.kid ?? clientId,
    })
    .setIssuer(overrides.issuer ?? clientId)
    .setSubject("session-user-1")
    .setAudience(overrides.audience ?? "ticketing-api")
    .setJti("session-test-jti")
    .setIssuedAt(overrides.issuedAt ?? now)
    .setExpirationTime(overrides.expiresAt ?? now + 3600)
    .sign(clientSecret);
}

async function requestError(sessionToken: string): Promise<SelfHostedTicketingError> {
  try {
    await executeSelfHostedTicketingRequest({
      config,
      sessionToken,
      operation: unreachableOperation,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(SelfHostedTicketingError);
    return error as SelfHostedTicketingError;
  }
  throw new Error("Expected the self-hosted request to fail");
}

describe("executeSelfHostedTicketingRequest session verification", () => {
  it("rejects a payload modified after signing before creating a runtime request", async () => {
    const token = await issueSession();
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    payload.sub = "tampered-user";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");

    await expect(requestError(parts.join("."))).resolves.toMatchObject({
      status: 401,
      code: "INVALID_SESSION",
      message: "The ticketing session is invalid",
    });
  });

  it("reports a correctly signed expired session distinctly", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await issueSession({
      issuedAt: now - 3600,
      expiresAt: now - 1,
    });

    await expect(requestError(token)).resolves.toMatchObject({
      status: 401,
      code: "SESSION_EXPIRED",
      message: "Your ticketing session has expired",
    });
  });

  it.each([
    ["issuer", { issuer: "another-client" }],
    ["audience", { audience: "another-audience" }],
    ["key id", { kid: "another-client" }],
    ["algorithm", { algorithm: "HS384" }],
    ["token type", { tokenType: "NOT-JWT" }],
    ["required claims", { omitName: true }],
  ] as const)("rejects a session with the wrong %s", async (_name, overrides) => {
    const token = await issueSession(overrides);
    await expect(requestError(token)).resolves.toMatchObject({
      status: 401,
      code: "INVALID_SESSION",
    });
  });

  it("rejects future issuance and lifetimes over 60 minutes", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const overrides of [
      { issuedAt: now + 60, expiresAt: now + 3600 },
      { issuedAt: now, expiresAt: now + 3601 },
    ]) {
      await expect(requestError(await issueSession(overrides))).resolves.toMatchObject({
        status: 401,
        code: "INVALID_SESSION",
      });
    }
  });

  it("accepts canonical claims and rejects signed non-canonical claims", async () => {
    const valid = await requestError(await issueSession());
    expect(valid).toMatchObject({ status: 404, code: "NOT_FOUND" });

    const duplicatedScopes = await issueSession({
      scopes: ["tickets:read", "tickets:read"],
    });
    await expect(requestError(duplicatedScopes)).resolves.toMatchObject({
      status: 401,
      code: "INVALID_SESSION",
    });
  });
});
