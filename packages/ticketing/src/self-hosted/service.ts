import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { SelfHostedTicketingError } from "./errors.js";
import {
  CreateReplySchema,
  CreateTicketSchema,
  IdempotencyKeySchema,
  PresignUploadSchema,
  PrincipalSchema,
  TicketIdSchema,
  TicketListSchema,
} from "./schemas.js";
import type {
  CreateReplyInput,
  CreateTicketInput,
  PresignUploadInput,
  SelfHostedTicketingDependencies,
  SelfHostedTicketingOperation,
  SelfHostedTicketingPrincipal,
  StoredAttachment,
  StoredReply,
  StoredTicket,
  StoredTicketSummary,
  StoredUpload,
  TicketListInput,
  TicketingScope,
} from "./types.js";

type OperationResult = { status: number; body: unknown };

function defaultId(prefix: "upl" | "tkt" | "rpl" | "att"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function ownerKey(principal: SelfHostedTicketingPrincipal): string {
  return createHash("sha256")
    .update(`${principal.iss}\0${principal.sub}`)
    .digest("hex")
    .slice(0, 32);
}

function requireScope(principal: SelfHostedTicketingPrincipal, scope: TicketingScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new SelfHostedTicketingError(
      403,
      "FORBIDDEN",
      "This ticketing session cannot perform that action",
    );
  }
}

function requiredScope(operation: SelfHostedTicketingOperation, path: string): TicketingScope {
  if (operation.method === "POST" && path === "uploads/presign") return "uploads:create";
  if (operation.method === "GET" && path === "tickets") return "tickets:read";
  if (operation.method === "POST" && path === "tickets") return "tickets:create";
  if (operation.method === "GET" && /^tickets\/tkt_[A-Za-z0-9_-]+$/.test(path)) {
    return "tickets:read";
  }
  if (operation.method === "POST" && /^tickets\/tkt_[A-Za-z0-9_-]+\/replies$/.test(path)) {
    return "tickets:reply";
  }
  throw new SelfHostedTicketingError(404, "NOT_FOUND", "The requested ticketing route was not found");
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "request";
    fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
  }
  throw new SelfHostedTicketingError(
    400,
    "VALIDATION_ERROR",
    "Please correct the highlighted fields",
    { fieldErrors },
  );
}

async function serializedAttachment(
  dependencies: SelfHostedTicketingDependencies,
  attachment: StoredAttachment,
) {
  const signed = await dependencies.storage.presignDownload(attachment);
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    downloadUrl: signed.downloadUrl,
    downloadExpiresAt: signed.expiresAt.toISOString(),
  };
}

async function serializedReply(
  dependencies: SelfHostedTicketingDependencies,
  reply: StoredReply,
) {
  return {
    id: reply.id,
    message: reply.message,
    author: reply.author,
    attachments: await Promise.all(
      reply.attachments.map((attachment) => serializedAttachment(dependencies, attachment)),
    ),
    createdAt: reply.createdAt.toISOString(),
  };
}

function serializedSummary(ticket: StoredTicketSummary) {
  return {
    id: ticket.id,
    title: ticket.title,
    category: ticket.category,
    status: ticket.status,
    replyCount: ticket.replyCount,
    attachmentCount: ticket.attachmentCount,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

async function serializedTicket(
  dependencies: SelfHostedTicketingDependencies,
  ticket: StoredTicket,
) {
  return {
    ...serializedSummary(ticket),
    description: ticket.description,
    reporter: ticket.reporter,
    source: ticket.source,
    attachments: await Promise.all(
      ticket.attachments.map((attachment) => serializedAttachment(dependencies, attachment)),
    ),
    replies: await Promise.all(
      ticket.replies.map((reply) => serializedReply(dependencies, reply)),
    ),
  };
}

async function loadTicketOrThrow(
  dependencies: SelfHostedTicketingDependencies,
  principal: SelfHostedTicketingPrincipal,
  ticketId: string,
): Promise<StoredTicket> {
  const ticket = await dependencies.repository.getTicket(principal, ticketId);
  if (!ticket) {
    throw new SelfHostedTicketingError(404, "NOT_FOUND", "The requested ticket was not found");
  }
  return ticket;
}

async function verifyUploads(
  dependencies: SelfHostedTicketingDependencies,
  principal: SelfHostedTicketingPrincipal,
  uploadIds: string[],
  now: Date,
): Promise<StoredUpload[]> {
  const uploads = await dependencies.repository.findClaimableUploads(principal, uploadIds, now);
  await Promise.all(uploads.map((upload) => dependencies.storage.verifyUpload(upload)));
  return uploads;
}

async function deleteExpiredUploads(
  dependencies: SelfHostedTicketingDependencies,
  now: Date,
  limit: number,
): Promise<number> {
  const expired = await dependencies.repository.listExpiredUploads(now, limit);
  let deleted = 0;
  for (const upload of expired) {
    await dependencies.storage.deleteUpload(upload);
    if (await dependencies.repository.deleteExpiredUpload(upload.id, now)) {
      deleted += 1;
    }
  }
  return deleted;
}

function cleanupLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SelfHostedTicketingError(
      400,
      "VALIDATION_ERROR",
      "Cleanup limit must be an integer between 1 and 100",
    );
  }
  return limit;
}

async function enforceRateLimit(
  dependencies: SelfHostedTicketingDependencies,
  principal: SelfHostedTicketingPrincipal,
  path: string,
): Promise<void> {
  if (!dependencies.rateLimiter) return;
  const upload = path === "uploads/presign";
  const windowSeconds = 60;
  const allowed = await dependencies.rateLimiter.consume(
    `ticketing:rate:${ownerKey(principal)}:${upload ? "uploads" : "api"}`,
    upload ? 30 : 120,
    windowSeconds,
  );
  if (!allowed) {
    throw new SelfHostedTicketingError(
      429,
      "RATE_LIMITED",
      "Too many requests. Please try again shortly.",
      { retryAfter: String(windowSeconds) },
    );
  }
}

export function createSelfHostedTicketingRuntime(
  dependencies: SelfHostedTicketingDependencies,
): {
  execute(principalValue: unknown, operation: SelfHostedTicketingOperation): Promise<Response>;
  cleanupExpiredUploads(limit?: number): Promise<number>;
} {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? defaultId;

  async function executeOperation(
    principal: SelfHostedTicketingPrincipal,
    operation: SelfHostedTicketingOperation,
  ): Promise<OperationResult> {
    const path = operation.path.replace(/^\/+|\/+$/g, "");
    requireScope(principal, requiredScope(operation, path));
    await dependencies.repository.assertMigrated();
    await enforceRateLimit(dependencies, principal, path);

    if (operation.method === "POST" && path === "uploads/presign") {
      const body = parse(PresignUploadSchema, operation.body) as PresignUploadInput;
      const current = now();
      // Expired reservations can never be claimed. Delete their exact object
      // keys before admitting more uploads; claimed attachments are untouched.
      await deleteExpiredUploads(dependencies, current, 20);
      const uploadId = randomId("upl");
      const upload: StoredUpload = {
        id: uploadId,
        clientId: principal.iss,
        requesterId: principal.sub,
        fileName: body.fileName,
        contentType: body.contentType,
        expectedSize: body.size,
        objectKey: `ticketing/${ownerKey(principal)}/uploads/${uploadId}`,
        expiresAt: new Date(current.getTime() + 60 * 60 * 1_000),
      };
      await dependencies.repository.createUpload(upload);
      let signed: Awaited<ReturnType<typeof dependencies.storage.presignUpload>>;
      try {
        signed = await dependencies.storage.presignUpload(upload);
      } catch (error) {
        // A failed signing operation never gave the browser a usable URL. Free
        // the exact unclaimed reservation immediately so it cannot consume the
        // per-user cap until expiry.
        await dependencies.repository.deleteUploadReservation(upload).catch(() => undefined);
        throw error;
      }
      return {
        status: 201,
        body: {
          uploadId: upload.id,
          uploadUrl: signed.uploadUrl,
          method: "PUT",
          headers: signed.headers,
          expiresAt: signed.expiresAt.toISOString(),
        },
      };
    }

    if (operation.method === "GET" && path === "tickets") {
      const query = parse(TicketListSchema, operation.query ?? {});
      const listInput: TicketListInput = {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
      };
      const page = await dependencies.repository.listTickets(principal, listInput);
      return {
        status: 200,
        body: { items: page.items.map(serializedSummary), nextCursor: page.nextCursor },
      };
    }

    if (operation.method === "POST" && path === "tickets") {
      const body = parse(CreateTicketSchema, operation.body) as CreateTicketInput;
      const key = parse(IdempotencyKeySchema, operation.idempotencyKey);
      const bodyFingerprint = fingerprint(body);
      const prior = await dependencies.repository.findIdempotentResult(
        principal, "POST:/tickets", key, bodyFingerprint,
      );
      if (prior) {
        if (prior.kind !== "ticket") {
          throw new SelfHostedTicketingError(500, "INTERNAL_ERROR", "Ticket metadata is unavailable");
        }
        const replay = await loadTicketOrThrow(dependencies, principal, prior.resultId);
        return { status: 201, body: { ticket: await serializedTicket(dependencies, replay) } };
      }
      const current = now();
      await verifyUploads(dependencies, principal, body.uploadIds, current);
      const result = await dependencies.repository.createTicket(principal, body, {
        idempotencyKey: key,
        fingerprint: bodyFingerprint,
        now: current,
        ticketId: randomId("tkt"),
        attachmentIds: body.uploadIds.map(() => randomId("att")),
      });
      const ticket = await loadTicketOrThrow(dependencies, principal, result.resultId);
      return { status: 201, body: { ticket: await serializedTicket(dependencies, ticket) } };
    }

    const detailMatch = path.match(/^tickets\/(tkt_[A-Za-z0-9_-]+)$/);
    if (operation.method === "GET" && detailMatch) {
      const ticketId = parse(TicketIdSchema, detailMatch[1]);
      const ticket = await loadTicketOrThrow(dependencies, principal, ticketId);
      return { status: 200, body: { ticket: await serializedTicket(dependencies, ticket) } };
    }

    const replyMatch = path.match(/^tickets\/(tkt_[A-Za-z0-9_-]+)\/replies$/);
    if (operation.method === "POST" && replyMatch) {
      const ticketId = parse(TicketIdSchema, replyMatch[1]);
      const body = parse(CreateReplySchema, operation.body) as CreateReplyInput;
      const key = parse(IdempotencyKeySchema, operation.idempotencyKey);
      const bodyFingerprint = fingerprint(body);
      const operationName = `POST:/tickets/${ticketId}/replies`;
      const prior = await dependencies.repository.findIdempotentResult(
        principal, operationName, key, bodyFingerprint,
      );
      if (prior) {
        const ticket = await loadTicketOrThrow(dependencies, principal, ticketId);
        const replay = ticket.replies.find((reply) => reply.id === prior.resultId);
        if (!replay) {
          throw new SelfHostedTicketingError(500, "INTERNAL_ERROR", "Reply metadata is unavailable");
        }
        return { status: 201, body: { reply: await serializedReply(dependencies, replay) } };
      }
      await loadTicketOrThrow(dependencies, principal, ticketId);
      const current = now();
      await verifyUploads(dependencies, principal, body.uploadIds, current);
      const result = await dependencies.repository.createReply(principal, ticketId, body, {
        idempotencyKey: key,
        fingerprint: bodyFingerprint,
        now: current,
        replyId: randomId("rpl"),
        attachmentIds: body.uploadIds.map(() => randomId("att")),
      });
      const ticket = await loadTicketOrThrow(dependencies, principal, ticketId);
      const reply = ticket.replies.find((entry) => entry.id === result.resultId);
      if (!reply) {
        throw new SelfHostedTicketingError(500, "INTERNAL_ERROR", "Reply metadata is unavailable");
      }
      return { status: 201, body: { reply: await serializedReply(dependencies, reply) } };
    }

    throw new SelfHostedTicketingError(404, "NOT_FOUND", "The requested ticketing route was not found");
  }

  return {
    async cleanupExpiredUploads(limit) {
      await dependencies.repository.assertMigrated();
      return deleteExpiredUploads(dependencies, now(), cleanupLimit(limit));
    },
    async execute(principalValue, operation) {
      const requestId = randomUUID();
      try {
        const principal = parse(PrincipalSchema, principalValue) as SelfHostedTicketingPrincipal;
        const result = await executeOperation(principal, operation);
        return Response.json(result.body, {
          status: result.status,
          headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
        });
      } catch (error) {
        if (error instanceof SelfHostedTicketingError) {
          throw new SelfHostedTicketingError(error.status, error.code, error.message, {
            ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
            ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
            requestId,
            cause: error.cause,
          });
        }
        throw new SelfHostedTicketingError(
          500,
          "INTERNAL_ERROR",
          "The ticketing request could not be completed",
          { requestId, cause: error },
        );
      }
    },
  };
}
