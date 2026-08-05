import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildMockApi,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  TICKETING_AUDIENCE,
} from "../src/server.js";

const allScopes = [
  "tickets:read",
  "tickets:create",
  "tickets:reply",
  "uploads:create",
];

async function sessionFor(userId: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    name: userId === "alice" ? "Alice Requester" : "Bob Requester",
    email: `${userId}@example.test`,
    sourceSystem: "fixture-app",
    moduleName: "support",
    pageUrl: "/help",
    scopes: allScopes,
    ...overrides,
  })
    .setProtectedHeader({ alg: "HS256", kid: MOCK_CLIENT_ID })
    .setIssuer(MOCK_CLIENT_ID)
    .setSubject(userId)
    .setAudience(TICKETING_AUDIENCE)
    .setJti(`session-${userId}-${now}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60)
    .sign(new TextEncoder().encode(MOCK_CLIENT_SECRET));
}

function headers(token: string, idempotencyKey?: string) {
  return {
    authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function createTicket(
  app: FastifyInstance,
  token: string,
  idempotencyKey: string,
  title = "Broken payroll export",
  uploadIds: string[] = [],
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/tickets",
    headers: headers(token, idempotencyKey),
    payload: {
      title,
      description: "The export fails after selecting a date range.",
      category: "bug",
      uploadIds,
    },
  });
}

describe("ticketing mock API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildMockApi({
      clients: { [MOCK_CLIENT_ID]: MOCK_CLIENT_SECRET },
      publicBaseUrl: "http://localhost:4010",
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("isolates tickets by JWT issuer and subject", async () => {
    const alice = await sessionFor("alice");
    const bob = await sessionFor("bob");
    const created = await createTicket(app, alice, "alice-create-0001");

    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id as string;

    const aliceList = await app.inject({
      method: "GET",
      url: "/api/v1/tickets",
      headers: headers(alice),
    });
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json().items).toHaveLength(1);

    const bobList = await app.inject({
      method: "GET",
      url: "/api/v1/tickets",
      headers: headers(bob),
    });
    expect(bobList.statusCode).toBe(200);
    expect(bobList.json().items).toHaveLength(0);

    const crossUserRead = await app.inject({
      method: "GET",
      url: `/api/v1/tickets/${ticketId}`,
      headers: headers(bob),
    });
    expect(crossUserRead.statusCode).toBe(404);
    expect(crossUserRead.json().error.code).toBe("NOT_FOUND");
  });

  it("uploads directly, attaches privately, and serves a signed download", async () => {
    const alice = await sessionFor("alice");
    const file = Buffer.from("mock-pdf-content");
    const reservation = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/presign",
      headers: headers(alice),
      payload: {
        fileName: "failure report.pdf",
        contentType: "application/pdf",
        size: file.byteLength,
      },
    });
    expect(reservation.statusCode).toBe(201);

    const reserved = reservation.json();
    const uploadUrl = new URL(reserved.uploadUrl);
    const uploaded = await app.inject({
      method: "PUT",
      url: `${uploadUrl.pathname}${uploadUrl.search}`,
      headers: { "content-type": "application/pdf" },
      payload: file,
    });
    expect(uploaded.statusCode).toBe(200);

    const created = await createTicket(
      app,
      alice,
      "alice-create-upload-0001",
      "Ticket with evidence",
      [reserved.uploadId],
    );
    expect(created.statusCode).toBe(201);
    const attachment = created.json().ticket.attachments[0];
    expect(attachment).toMatchObject({
      fileName: "failure report.pdf",
      contentType: "application/pdf",
      size: file.byteLength,
    });
    expect(attachment).not.toHaveProperty("storageKey");

    const downloadUrl = new URL(attachment.downloadUrl);
    const downloaded = await app.inject({
      method: "GET",
      url: `${downloadUrl.pathname}${downloadUrl.search}`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("application/pdf");
    expect(downloaded.rawPayload).toEqual(file);
  });

  it("replays identical idempotent creates and rejects conflicting reuse", async () => {
    const alice = await sessionFor("alice");
    const first = await createTicket(app, alice, "same-create-key-0001");
    const replay = await createTicket(app, alice, "same-create-key-0001");
    const conflict = await createTicket(
      app,
      alice,
      "same-create-key-0001",
      "A different title",
    );

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().ticket.id).toBe(first.json().ticket.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("creates idempotent replies and exposes them from requester-owned detail", async () => {
    const alice = await sessionFor("alice");
    const bob = await sessionFor("bob");
    const created = await createTicket(app, alice, "reply-ticket-create-0001");
    const ticketId = created.json().ticket.id as string;
    const replyRequest = {
      method: "POST" as const,
      url: `/api/v1/tickets/${ticketId}/replies`,
      headers: headers(alice, "reply-create-key-0001"),
      payload: { message: "Here are the reproduction steps.", uploadIds: [] },
    };

    const first = await app.inject(replyRequest);
    const replay = await app.inject(replyRequest);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().reply.id).toBe(first.json().reply.id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/tickets/${ticketId}`,
      headers: headers(alice),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().ticket.replies).toHaveLength(1);
    expect(detail.json().ticket.replies[0].author).toMatchObject({
      type: "requester",
      id: "alice",
      name: "Alice Requester",
    });

    const crossUserReply = await app.inject({
      method: "POST",
      url: `/api/v1/tickets/${ticketId}/replies`,
      headers: headers(bob, "bob-reply-key-0001"),
      payload: { message: "I should not see this ticket." },
    });
    expect(crossUserReply.statusCode).toBe(404);
  });

  it("requires endpoint scopes and reports expired sessions distinctly", async () => {
    const noRead = await sessionFor("alice", { scopes: ["tickets:create"] });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/tickets",
      headers: headers(noRead),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");

    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({
      name: "Alice Requester",
      sourceSystem: "fixture-app",
      scopes: allScopes,
    })
      .setProtectedHeader({ alg: "HS256", kid: MOCK_CLIENT_ID })
      .setIssuer(MOCK_CLIENT_ID)
      .setSubject("alice")
      .setAudience(TICKETING_AUDIENCE)
      .setJti("expired-session")
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(new TextEncoder().encode(MOCK_CLIENT_SECRET));
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tickets",
      headers: headers(expired),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("SESSION_EXPIRED");
  });

  it("refuses to emit transfer URLs over non-local HTTP", async () => {
    await expect(
      buildMockApi({
        clients: { [MOCK_CLIENT_ID]: MOCK_CLIENT_SECRET },
        publicBaseUrl: "http://uploads.example.test",
      }),
    ).rejects.toThrow("must use HTTPS outside localhost");
  });

  it("rejects the documented client-secret placeholder", async () => {
    await expect(
      buildMockApi({
        clients: {
          [MOCK_CLIENT_ID]: "replace-with-at-least-32-random-bytes",
        },
      }),
    ).rejects.toThrow("must replace the documented placeholder");
  });
});
