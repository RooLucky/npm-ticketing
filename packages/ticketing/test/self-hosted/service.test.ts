import { describe, expect, it } from "vitest";

import { SelfHostedTicketingError } from "../../src/self-hosted/errors.js";
import { createSelfHostedTicketingRuntime } from "../../src/self-hosted/service.js";
import type {
  SelfHostedTicketingOperation,
  SelfHostedTicketingPrincipal,
} from "../../src/self-hosted/types.js";
import {
  addUpload,
  createDependencies,
  principal,
  RecordingRateLimiter,
} from "./fixture.js";

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function ticketingError(
  promise: Promise<unknown>,
): Promise<SelfHostedTicketingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SelfHostedTicketingError);
    return error as SelfHostedTicketingError;
  }
  throw new Error("Expected the ticketing operation to fail");
}

function createTicketOperation(
  overrides: Partial<SelfHostedTicketingOperation> = {},
): SelfHostedTicketingOperation {
  return {
    path: "tickets",
    method: "POST",
    body: {
      title: "Cannot submit leave",
      description: "The submit button stays disabled.",
      category: "bug",
      uploadIds: [],
    },
    idempotencyKey: "ticket-key-001",
    ...overrides,
  };
}

describe("createSelfHostedTicketingRuntime", () => {
  it("dispatches every canonical route and emits contract-shaped responses", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);

    const presign = await runtime.execute(principal, {
      path: "/uploads/presign/",
      method: "POST",
      body: {
        fileName: "screenshot.png",
        contentType: "image/png",
        size: 128,
      },
    });
    expect(presign.status).toBe(201);
    expect(presign.headers.get("cache-control")).toBe("no-store");
    expect(presign.headers.get("x-request-id")).toMatch(requestIdPattern);
    const presigned = (await presign.json()) as {
      uploadId: string;
      uploadUrl: string;
      method: string;
      headers: Record<string, string>;
      expiresAt: string;
    };
    expect(presigned).toEqual({
      uploadId: "upl_1",
      uploadUrl: "https://storage.example.test/upload/upl_1",
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      expiresAt: "2026-08-05T06:10:00.000Z",
    });

    const created = await runtime.execute(
      principal,
      createTicketOperation({
        body: {
          title: "Cannot submit leave",
          description: "The submit button stays disabled.",
          category: "bug",
          uploadIds: [presigned.uploadId],
        },
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      ticket: { id: string; reporter: { id: string }; attachments: unknown[] };
    };
    expect(createdBody.ticket.id).toBe("tkt_1");
    expect(createdBody.ticket.reporter.id).toBe(principal.sub);
    expect(createdBody.ticket.attachments).toEqual([
      {
        id: "att_1",
        fileName: "screenshot.png",
        contentType: "image/png",
        size: 128,
        downloadUrl: "https://storage.example.test/download/att_1",
        downloadExpiresAt: "2026-08-05T06:05:00.000Z",
      },
    ]);

    const detail = await runtime.execute(principal, {
      path: `tickets/${createdBody.ticket.id}`,
      method: "GET",
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      ticket: Record<string, unknown>;
    };
    expect(detailBody.ticket).toMatchObject({
      id: "tkt_1",
      title: "Cannot submit leave",
      category: "bug",
      status: "open",
      source: {
        system: "hris",
        module: "leave",
        pageUrl: "/leave/requests/42",
      },
      createdAt: "2026-08-05T06:00:00.000Z",
      updatedAt: "2026-08-05T06:00:00.000Z",
    });
    expect(JSON.stringify(detailBody)).not.toContain("objectKey");

    const reply = await runtime.execute(principal, {
      path: "tickets/tkt_1/replies",
      method: "POST",
      body: { message: "This is still happening.", uploadIds: [] },
      idempotencyKey: "reply-key-001",
    });
    expect(reply.status).toBe(201);
    await expect(reply.json()).resolves.toMatchObject({
      reply: {
        id: "rpl_1",
        message: "This is still happening.",
        author: {
          type: "requester",
          id: principal.sub,
          name: principal.name,
        },
        attachments: [],
        createdAt: "2026-08-05T06:00:00.000Z",
      },
    });

    const list = await runtime.execute(principal, {
      path: "tickets",
      method: "GET",
      query: { limit: "10", category: "bug" },
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      items: [
        {
          id: "tkt_1",
          title: "Cannot submit leave",
          category: "bug",
          status: "open",
          replyCount: 1,
          attachmentCount: 1,
          createdAt: "2026-08-05T06:00:00.000Z",
          updatedAt: "2026-08-05T06:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(dependencies.repository.calls.listTickets[0]).toMatchObject({
      principal,
      input: { limit: 10, category: "bug" },
    });
  });

  it("removes only expired unclaimed objects before admitting a new upload", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    const expired = addUpload(dependencies.repository, "upl_expired");
    expired.expiresAt = new Date("2026-08-05T05:59:00.000Z");
    const active = addUpload(dependencies.repository, "upl_active");
    const claimed = addUpload(dependencies.repository, "upl_claimed");
    claimed.expiresAt = new Date("2026-08-05T05:59:00.000Z");
    dependencies.repository.claimedUploads.add(claimed.id);

    const response = await runtime.execute(principal, {
      path: "uploads/presign",
      method: "POST",
      body: { fileName: "fresh.png", contentType: "image/png", size: 128 },
    });

    expect(response.status).toBe(201);
    expect(dependencies.storage.deletedUploads.map(({ id }) => id)).toEqual([
      expired.id,
    ]);
    expect(dependencies.repository.uploads.has(expired.id)).toBe(false);
    expect(dependencies.repository.uploads.has(active.id)).toBe(true);
    expect(dependencies.repository.uploads.has(claimed.id)).toBe(true);
    expect(dependencies.repository.calls.listExpiredUploads[0]?.limit).toBe(20);
  });

  it("supports bounded scheduled cleanup for otherwise idle installations", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    const first = addUpload(dependencies.repository, "upl_expired_first");
    first.expiresAt = new Date("2026-08-05T05:58:00.000Z");
    const second = addUpload(dependencies.repository, "upl_expired_second");
    second.expiresAt = new Date("2026-08-05T05:59:00.000Z");

    await expect(runtime.cleanupExpiredUploads(1)).resolves.toBe(1);
    expect(dependencies.storage.deletedUploads.map(({ id }) => id)).toEqual([
      first.id,
    ]);
    expect(dependencies.repository.uploads.has(first.id)).toBe(false);
    expect(dependencies.repository.uploads.has(second.id)).toBe(true);
    await expect(ticketingError(runtime.cleanupExpiredUploads(0))).resolves.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("releases an upload reservation when URL signing fails", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    dependencies.storage.presignError = new SelfHostedTicketingError(
      503,
      "UPSTREAM_UNAVAILABLE",
      "Private ticketing storage is unavailable",
    );

    await expect(
      ticketingError(
        runtime.execute(principal, {
          path: "uploads/presign",
          method: "POST",
          body: { fileName: "failed.png", contentType: "image/png", size: 128 },
        }),
      ),
    ).resolves.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
    expect(dependencies.repository.uploads.size).toBe(0);
    expect(dependencies.repository.calls.deleteUploadReservation).toHaveLength(1);
  });

  it("enforces scopes before repository operations and scopes ownership by principal", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    const noRead: SelfHostedTicketingPrincipal = {
      ...principal,
      scopes: ["tickets:create"],
    };

    const forbidden = await ticketingError(
      runtime.execute(noRead, { path: "tickets", method: "GET" }),
    );
    expect(forbidden).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(forbidden.requestId).toMatch(requestIdPattern);
    expect(dependencies.repository.calls.listTickets).toHaveLength(0);

    const created = await runtime.execute(principal, createTicketOperation());
    const ticketId = ((await created.json()) as { ticket: { id: string } }).ticket.id;
    const differentUser: SelfHostedTicketingPrincipal = {
      ...principal,
      sub: "user-99",
    };
    const hidden = await ticketingError(
      runtime.execute(differentUser, {
        path: `tickets/${ticketId}`,
        method: "GET",
      }),
    );
    expect(hidden).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(dependencies.repository.calls.getTicket.at(-1)).toEqual({
      principal: differentUser,
      ticketId,
    });
  });

  it("verifies every upload before invoking the atomic ticket mutation", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    addUpload(dependencies.repository, "upl_ready");
    addUpload(dependencies.repository, "upl_missing");
    dependencies.storage.failVerificationFor.add("upl_missing");

    const error = await ticketingError(
      runtime.execute(
        principal,
        createTicketOperation({
          body: {
            title: "Two attachments",
            description: "One object did not finish uploading.",
            category: "bug",
            uploadIds: ["upl_ready", "upl_missing"],
          },
        }),
      ),
    );

    expect(error).toMatchObject({ status: 422, code: "UPLOAD_NOT_READY" });
    expect(dependencies.repository.calls.findClaimableUploads).toHaveLength(1);
    expect(dependencies.storage.verifiedUploads.map(({ id }) => id)).toEqual([
      "upl_ready",
      "upl_missing",
    ]);
    expect(dependencies.repository.calls.createTicket).toHaveLength(0);
    expect(dependencies.repository.tickets).toHaveLength(0);
    expect(dependencies.repository.claimedUploads).toHaveLength(0);
  });

  it("replays identical idempotent requests and propagates fingerprint conflicts", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    const operation = createTicketOperation();

    const first = await runtime.execute(principal, operation);
    const replay = await runtime.execute(principal, operation);
    const firstBody = await first.json();
    const replayBody = await replay.json();

    expect(replayBody).toEqual(firstBody);
    expect(dependencies.repository.calls.createTicket).toHaveLength(1);
    expect(dependencies.repository.tickets).toHaveLength(1);

    const conflict = await ticketingError(
      runtime.execute(
        principal,
        createTicketOperation({
          body: {
            title: "A different request",
            description: "This must not reuse the first result.",
            category: "request",
            uploadIds: [],
          },
        }),
      ),
    );
    expect(conflict).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(conflict.requestId).toMatch(requestIdPattern);
    expect(dependencies.repository.calls.createTicket).toHaveLength(1);
    expect(dependencies.repository.tickets).toHaveLength(1);
  });

  it("relies on the atomic repository mutation when identical requests race", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);
    const operation = createTicketOperation({ idempotencyKey: "race-key-001" });

    const responses = await Promise.all([
      runtime.execute(principal, operation),
      runtime.execute(principal, operation),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(dependencies.repository.calls.createTicket).toHaveLength(2);
    expect(dependencies.repository.tickets).toHaveLength(1);
    expect(dependencies.repository.idempotency).toHaveLength(1);
  });

  it("uses an optional limiter and stops rejected requests before route dispatch", async () => {
    const rateLimiter = new RecordingRateLimiter(false);
    const dependencies = createDependencies({ rateLimiter });
    const runtime = createSelfHostedTicketingRuntime(dependencies);

    const error = await ticketingError(
      runtime.execute(principal, { path: "tickets", method: "GET" }),
    );

    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(error.retryAfter).toBe("60");
    expect(error.requestId).toMatch(requestIdPattern);
    expect(rateLimiter.calls).toHaveLength(1);
    expect(rateLimiter.calls[0]).toMatchObject({
      limit: 120,
      windowSeconds: 60,
    });
    expect(rateLimiter.calls[0]?.key).not.toContain(principal.iss);
    expect(rateLimiter.calls[0]?.key).not.toContain(principal.sub);
    expect(dependencies.repository.calls.listTickets).toHaveLength(0);
  });

  it("adds request IDs to sanitized validation, dispatch, and internal errors", async () => {
    const dependencies = createDependencies();
    const runtime = createSelfHostedTicketingRuntime(dependencies);

    const invalid = await ticketingError(
      runtime.execute(
        principal,
        createTicketOperation({
          body: {
            title: "x",
            description: "",
            category: "bug",
            uploadIds: [],
          },
        }),
      ),
    );
    expect(invalid).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(invalid.fieldErrors).toMatchObject({
      title: expect.any(Array),
      description: expect.any(Array),
    });
    expect(invalid.requestId).toMatch(requestIdPattern);

    const missingRoute = await ticketingError(
      runtime.execute(principal, {
        path: "uploads/presign",
        method: "GET",
      }),
    );
    expect(missingRoute).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(missingRoute.requestId).toMatch(requestIdPattern);
    expect(missingRoute.requestId).not.toBe(invalid.requestId);

    dependencies.repository.migrationError = new Error(
      "password=must-never-reach-public-message",
    );
    const internal = await ticketingError(
      runtime.execute(principal, { path: "tickets", method: "GET" }),
    );
    expect(internal).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "The ticketing request could not be completed",
    });
    expect(internal.message).not.toContain("password");
    expect(internal.requestId).toMatch(requestIdPattern);
  });
});
