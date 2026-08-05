import { createHash, randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import {
  AttachmentIdSchema as attachmentIdSchema,
  CreateReplyRequestSchema as createReplySchema,
  CreateTicketRequestSchema as createTicketSchema,
  IdempotencyKeySchema as idempotencyKeySchema,
  MAX_UPLOAD_BYTES,
  PresignUploadRequestSchema as presignUploadSchema,
  TICKETING_AUDIENCE,
  TicketIdSchema as ticketIdSchema,
  TicketingClaimsSchema as claimsSchema,
  TicketListQuerySchema as listTicketsSchema,
  UploadIdSchema as uploadIdSchema,
  type AcceptedContentType,
  type TicketCategory,
  type TicketStatus,
  type TicketingScope,
} from "@quanby/ticketing-contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";
import {
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import { z, type ZodType } from "zod";

export { MAX_UPLOAD_BYTES, TICKETING_AUDIENCE };
export const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;
export const ORPHAN_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

export const MOCK_CLIENT_ID = "test-client";
export const MOCK_CLIENT_SECRET = "mock-ticketing-secret-change-me-now";
const TICKETING_SECRET_PLACEHOLDER = "replace-with-at-least-32-random-bytes";

interface Principal {
  clientId: string;
  userId: string;
  name: string;
  email?: string;
  sourceSystem: string;
  moduleName?: string;
  pageUrl?: string;
  scopes: Set<TicketingScope>;
}

interface PendingUpload {
  id: string;
  ownerKey: string;
  fileName: string;
  contentType: AcceptedContentType;
  expectedSize: number;
  uploadToken: string;
  presignExpiresAt: number;
  orphanExpiresAt?: number;
  data?: Buffer;
  attachmentId?: string;
  attachedTo?: string;
}

interface StoredAttachment {
  id: string;
  ownerKey: string;
  fileName: string;
  contentType: string;
  size: number;
  data: Buffer;
}

interface StoredReply {
  id: string;
  message: string;
  author: {
    type: "requester";
    id: string;
    name: string;
  };
  attachmentIds: string[];
  createdAt: string;
}

interface StoredTicket {
  id: string;
  ownerKey: string;
  title: string;
  description: string;
  category: TicketCategory;
  status: TicketStatus;
  reporter: {
    id: string;
    name: string;
    email?: string;
  };
  source: {
    system: string;
    module?: string;
    pageUrl?: string;
  };
  attachmentIds: string[];
  replies: StoredReply[];
  createdAt: string;
  updatedAt: string;
}

interface DownloadGrant {
  attachmentId: string;
  expiresAt: number;
}

interface IdempotencyRecord {
  fingerprint: string;
  kind: "ticket" | "reply";
  ticketId: string;
  replyId?: string;
}

interface MockState {
  uploads: Map<string, PendingUpload>;
  attachments: Map<string, StoredAttachment>;
  tickets: Map<string, StoredTicket>;
  downloadGrants: Map<string, DownloadGrant>;
  idempotency: Map<string, IdempotencyRecord>;
}

export interface BuildMockApiOptions {
  /** Map of JWT issuer/client ID to an HS256 secret of at least 32 UTF-8 bytes. */
  clients?: Record<string, string>;
  /** Base URL placed in upload and download links. In inject tests this may be omitted. */
  publicBaseUrl?: string;
  /** CORS origin accepted by @fastify/cors. Defaults to true for test fixtures. */
  corsOrigin?: boolean | string | string[];
  /** Test clock hook. */
  now?: () => Date;
  logger?: boolean;
}

type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "UPLOAD_NOT_READY"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "INTERNAL_ERROR";

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function makeId(prefix: "tkt" | "rpl" | "upl" | "att"): string {
  return `${prefix}_${randomUUID()}`;
}

function ownerKey(principal: Principal): string {
  return JSON.stringify([principal.clientId, principal.userId]);
}

function parseWithSchema<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const flattened = result.error.flatten();
  const fieldErrors = Object.fromEntries(
    Object.entries(flattened.fieldErrors).filter(
      (entry): entry is [string, string[]] => Array.isArray(entry[1]),
    ),
  );
  if (flattened.formErrors.length > 0) {
    fieldErrors._form = flattened.formErrors;
  }
  throw new ApiError(
    400,
    "VALIDATION_ERROR",
    "The request is invalid.",
    fieldErrors,
  );
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function getBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new ApiError(401, "INVALID_SESSION", "A bearer session is required.");
  }
  return token;
}

function normalizeClients(clients: Record<string, string>): Record<string, Uint8Array> {
  const normalized: Record<string, Uint8Array> = {};
  for (const [clientId, secret] of Object.entries(clients)) {
    if (!clientId.trim() || clientId.length > 128) {
      throw new Error(
        "Ticketing mock client IDs must contain between 1 and 128 characters.",
      );
    }
    if (secret === TICKETING_SECRET_PLACEHOLDER) {
      throw new Error(
        `Ticketing mock secret for ${clientId} must replace the documented placeholder.`,
      );
    }
    const bytes = new TextEncoder().encode(secret);
    if (bytes.byteLength < 32) {
      throw new Error(
        `Ticketing mock secret for ${clientId} must contain at least 32 UTF-8 bytes.`,
      );
    }
    normalized[clientId] = bytes;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("At least one ticketing mock client must be configured.");
  }
  return normalized;
}

export function clientsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (environment.TICKETING_CLIENT_SECRETS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(environment.TICKETING_CLIENT_SECRETS);
    } catch {
      throw new Error("TICKETING_CLIENT_SECRETS must be a JSON object.");
    }
    const result = z.record(z.string(), z.string()).safeParse(parsed);
    if (!result.success) {
      throw new Error("TICKETING_CLIENT_SECRETS must map client IDs to secrets.");
    }
    return result.data;
  }

  if (environment.TICKETING_CLIENT_ID || environment.TICKETING_CLIENT_SECRET) {
    if (!environment.TICKETING_CLIENT_ID || !environment.TICKETING_CLIENT_SECRET) {
      throw new Error(
        "TICKETING_CLIENT_ID and TICKETING_CLIENT_SECRET must be configured together.",
      );
    }
    return {
      [environment.TICKETING_CLIENT_ID]: environment.TICKETING_CLIENT_SECRET,
    };
  }

  return { [MOCK_CLIENT_ID]: MOCK_CLIENT_SECRET };
}

async function verifySession(
  request: FastifyRequest,
  clients: Record<string, Uint8Array>,
  currentDate: Date,
): Promise<Principal> {
  const token = getBearerToken(request);
  try {
    const header = decodeProtectedHeader(token);
    const unverified = decodeJwt(token);
    if (header.alg !== "HS256" || typeof header.kid !== "string") {
      throw new ApiError(
        401,
        "INVALID_SESSION",
        "The ticketing session is invalid.",
      );
    }
    if (typeof unverified.iss !== "string" || unverified.iss !== header.kid) {
      throw new ApiError(
        401,
        "INVALID_SESSION",
        "The ticketing session is invalid.",
      );
    }

    const secret = clients[unverified.iss];
    if (!secret) {
      throw new ApiError(
        401,
        "INVALID_SESSION",
        "The ticketing session is invalid.",
      );
    }

    const verification = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: unverified.iss,
      audience: TICKETING_AUDIENCE,
      clockTolerance: 5,
      currentDate,
    });
    const parsedClaims = claimsSchema.safeParse(verification.payload);
    if (!parsedClaims.success) {
      throw new ApiError(
        401,
        "INVALID_SESSION",
        "The ticketing session is invalid.",
      );
    }
    const claims = parsedClaims.data;
    return {
      clientId: unverified.iss,
      userId: claims.sub,
      name: claims.name,
      ...(claims.email ? { email: claims.email } : {}),
      sourceSystem: claims.sourceSystem,
      ...(claims.moduleName ? { moduleName: claims.moduleName } : {}),
      ...(claims.pageUrl ? { pageUrl: claims.pageUrl } : {}),
      scopes: new Set(claims.scopes),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof joseErrors.JWTExpired) {
      throw new ApiError(
        401,
        "SESSION_EXPIRED",
        "The ticketing session has expired. Refresh the host page.",
      );
    }
    throw new ApiError(401, "INVALID_SESSION", "The ticketing session is invalid.");
  }
}

function requestBaseUrl(request: FastifyRequest, configured?: string): string {
  if (configured) return assertPrivateUrlOrigin(configured);
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProtocol === "string"
      ? (forwardedProtocol.split(",")[0]?.trim() ?? request.protocol)
      : request.protocol;
  const forwardedHost = request.headers["x-forwarded-host"];
  const host =
    typeof forwardedHost === "string"
      ? (forwardedHost.split(",")[0]?.trim() ?? request.headers.host ?? "localhost")
      : request.headers.host || "localhost";
  return assertPrivateUrlOrigin(`${protocol}://${host}`);
}

function assertPrivateUrlOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(500, "INTERNAL_ERROR", "The mock public URL is invalid.");
  }
  const localhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "The mock public URL must use HTTPS outside localhost.",
    );
  }
  return url.origin;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, offset }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z
      .object({ version: z.literal(1), offset: z.number().int().min(0) })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new Error("Invalid cursor");
    return parsed.data.offset;
  } catch {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "The cursor is invalid.",
      { cursor: ["Use the opaque cursor returned by the previous response."] },
    );
  }
}

function ticketSummary(ticket: StoredTicket) {
  return {
    id: ticket.id,
    title: ticket.title,
    category: ticket.category,
    status: ticket.status,
    replyCount: ticket.replies.length,
    attachmentCount:
      ticket.attachmentIds.length +
      ticket.replies.reduce((total, reply) => total + reply.attachmentIds.length, 0),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function safeDownloadName(fileName: string): string {
  return fileName.replace(/[\r\n"\\/]/g, "_");
}

function idempotencyHeader(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  return parseWithSchema(
    idempotencyKeySchema,
    Array.isArray(header) ? header[0] : header,
  );
}

function idempotencyMapKey(
  principal: Principal,
  operation: string,
  key: string,
): string {
  return JSON.stringify([principal.clientId, principal.userId, operation, key]);
}

function findOwnedTicket(
  state: MockState,
  principal: Principal,
  ticketId: string,
): StoredTicket {
  const ticket = state.tickets.get(ticketId);
  if (!ticket || ticket.ownerKey !== ownerKey(principal)) {
    throw new ApiError(404, "NOT_FOUND", "Ticket not found.");
  }
  return ticket;
}

function claimUploads(
  state: MockState,
  principal: Principal,
  uploadIds: string[],
  targetId: string,
  currentTime: number,
): string[] {
  const owner = ownerKey(principal);
  const uploads = uploadIds.map((uploadId) => state.uploads.get(uploadId));
  if (
    uploads.some(
      (upload) =>
        !upload ||
        upload.ownerKey !== owner ||
        !upload.data ||
        upload.attachedTo ||
        !upload.orphanExpiresAt ||
        upload.orphanExpiresAt <= currentTime,
    )
  ) {
    throw new ApiError(
      422,
      "UPLOAD_NOT_READY",
      "One or more uploads are unavailable or incomplete.",
    );
  }

  return (uploads as PendingUpload[]).map((upload) => {
    const attachmentId = makeId("att");
    upload.attachedTo = targetId;
    upload.attachmentId = attachmentId;
    state.attachments.set(attachmentId, {
      id: attachmentId,
      ownerKey: owner,
      fileName: upload.fileName,
      contentType: upload.contentType,
      size: upload.data!.byteLength,
      data: upload.data!,
    });
    return attachmentId;
  });
}

function purgeExpiredDownloadGrants(state: MockState, currentTime: number): void {
  for (const [token, grant] of state.downloadGrants) {
    if (grant.expiresAt <= currentTime) state.downloadGrants.delete(token);
  }
}

function serializeAttachment(
  state: MockState,
  attachmentId: string,
  baseUrl: string,
  currentTime: number,
) {
  const attachment = state.attachments.get(attachmentId);
  if (!attachment) {
    throw new ApiError(500, "INTERNAL_ERROR", "Attachment metadata is unavailable.");
  }
  purgeExpiredDownloadGrants(state, currentTime);
  const token = randomUUID();
  const expiresAt = currentTime + DOWNLOAD_URL_TTL_MS;
  state.downloadGrants.set(token, { attachmentId, expiresAt });
  const downloadUrl = new URL(
    `/mock/attachments/${encodeURIComponent(attachmentId)}/download`,
    `${baseUrl}/`,
  );
  downloadUrl.searchParams.set("token", token);
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    downloadUrl: downloadUrl.toString(),
    downloadExpiresAt: new Date(expiresAt).toISOString(),
  };
}

function serializeReply(
  state: MockState,
  reply: StoredReply,
  baseUrl: string,
  currentTime: number,
) {
  return {
    id: reply.id,
    message: reply.message,
    author: reply.author,
    attachments: reply.attachmentIds.map((id) =>
      serializeAttachment(state, id, baseUrl, currentTime),
    ),
    createdAt: reply.createdAt,
  };
}

function serializeTicket(
  state: MockState,
  ticket: StoredTicket,
  baseUrl: string,
  currentTime: number,
) {
  return {
    ...ticketSummary(ticket),
    description: ticket.description,
    reporter: ticket.reporter,
    source: ticket.source,
    attachments: ticket.attachmentIds.map((id) =>
      serializeAttachment(state, id, baseUrl, currentTime),
    ),
    replies: ticket.replies.map((reply) =>
      serializeReply(state, reply, baseUrl, currentTime),
    ),
  };
}

function sendApiError(reply: FastifyReply, requestId: string, error: ApiError) {
  return reply.code(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      requestId,
    },
  });
}

export async function buildMockApi(
  options: BuildMockApiOptions = {},
): Promise<FastifyInstance> {
  const clients = normalizeClients(options.clients ?? clientsFromEnvironment());
  if (options.publicBaseUrl) assertPrivateUrlOrigin(options.publicBaseUrl);
  const now = options.now ?? (() => new Date());
  const state: MockState = {
    uploads: new Map(),
    attachments: new Map(),
    tickets: new Map(),
    downloadGrants: new Map(),
    idempotency: new Map(),
  };
  const principals = new WeakMap<FastifyRequest, Principal>();
  const app = Fastify({
    logger: options.logger ?? false,
    // Presigned upload and download capabilities are query tokens; never put
    // request URLs into fixture logs.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: MAX_UPLOAD_BYTES,
  });

  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key"],
    exposedHeaders: ["x-request-id"],
    credentials: false,
  });

  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body),
  );

  const authorize = (scope: TicketingScope) =>
    async (request: FastifyRequest): Promise<void> => {
      const principal = await verifySession(request, clients, now());
      if (!principal.scopes.has(scope)) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          `The ticketing session is missing the ${scope} scope.`,
        );
      }
      principals.set(request, principal);
    };

  const principalFor = (request: FastifyRequest): Principal => {
    const principal = principals.get(request);
    if (!principal) {
      throw new ApiError(500, "INTERNAL_ERROR", "Session context is unavailable.");
    }
    return principal;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return sendApiError(reply, request.id, error);
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      return sendApiError(
        reply,
        request.id,
        new ApiError(413, "FILE_TOO_LARGE", "The upload exceeds 10 MiB."),
      );
    }
    request.log.error({ err: error }, "Unhandled mock API error");
    return sendApiError(
      reply,
      request.id,
      new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred."),
    );
  });

  app.setNotFoundHandler((request, reply) =>
    sendApiError(
      reply,
      request.id,
      new ApiError(404, "NOT_FOUND", "Route not found."),
    ),
  );

  app.get("/health", async () => ({ status: "ok", version: "1" }));

  app.post(
    "/api/v1/uploads/presign",
    { preHandler: authorize("uploads:create") },
    async (request, reply) => {
      const principal = principalFor(request);
      const body = parseWithSchema(presignUploadSchema, request.body);
      const currentTime = now().getTime();
      const upload: PendingUpload = {
        id: makeId("upl"),
        ownerKey: ownerKey(principal),
        fileName: body.fileName,
        contentType: body.contentType,
        expectedSize: body.size,
        uploadToken: randomUUID(),
        presignExpiresAt: currentTime + UPLOAD_URL_TTL_MS,
      };
      state.uploads.set(upload.id, upload);

      const uploadUrl = new URL(
        `/mock/uploads/${encodeURIComponent(upload.id)}`,
        `${requestBaseUrl(request, options.publicBaseUrl)}/`,
      );
      uploadUrl.searchParams.set("token", upload.uploadToken);
      return reply.code(201).send({
        uploadId: upload.id,
        uploadUrl: uploadUrl.toString(),
        method: "PUT",
        headers: { "Content-Type": upload.contentType },
        expiresAt: new Date(upload.presignExpiresAt).toISOString(),
      });
    },
  );

  app.put("/mock/uploads/:uploadId", async (request, reply) => {
    const params = parseWithSchema(
      z.object({ uploadId: uploadIdSchema }),
      request.params,
    );
    const query = parseWithSchema(
      z.object({ token: z.string().uuid() }),
      request.query,
    );
    const upload = state.uploads.get(params.uploadId);
    const currentTime = now().getTime();
    if (
      !upload ||
      upload.uploadToken !== query.token ||
      upload.presignExpiresAt <= currentTime
    ) {
      throw new ApiError(404, "NOT_FOUND", "Upload URL not found or expired.");
    }
    if (upload.attachedTo) {
      throw new ApiError(409, "UPLOAD_NOT_READY", "The upload is already attached.");
    }

    const contentType = request.headers["content-type"]
      ?.split(";")[0]
      ?.trim();
    if (contentType !== upload.contentType) {
      throw new ApiError(
        400,
        "UNSUPPORTED_FILE_TYPE",
        `The upload Content-Type must be ${upload.contentType}.`,
      );
    }
    if (!Buffer.isBuffer(request.body)) {
      throw new ApiError(400, "VALIDATION_ERROR", "The upload body is required.");
    }
    if (request.body.byteLength !== upload.expectedSize) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "The uploaded size does not match the reserved size.",
        { size: [`Expected ${upload.expectedSize} bytes.`] },
      );
    }

    upload.data = Buffer.from(request.body);
    upload.orphanExpiresAt = currentTime + ORPHAN_UPLOAD_TTL_MS;
    return reply.code(200).send({ uploadId: upload.id, size: upload.data.byteLength });
  });

  app.get(
    "/api/v1/tickets",
    { preHandler: authorize("tickets:read") },
    async (request) => {
      const principal = principalFor(request);
      const query = parseWithSchema(listTicketsSchema, request.query);
      const offset = decodeCursor(query.cursor);
      const owner = ownerKey(principal);
      const filtered = [...state.tickets.values()]
        .filter(
          (ticket) =>
            ticket.ownerKey === owner &&
            (!query.status || ticket.status === query.status) &&
            (!query.category || ticket.category === query.category),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.id.localeCompare(left.id),
        );
      const items = filtered.slice(offset, offset + query.limit).map(ticketSummary);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset) : null,
      };
    },
  );

  app.post(
    "/api/v1/tickets",
    { preHandler: authorize("tickets:create") },
    async (request, reply) => {
      const principal = principalFor(request);
      const body = parseWithSchema(createTicketSchema, request.body);
      const key = idempotencyHeader(request);
      const mapKey = idempotencyMapKey(principal, "POST:/tickets", key);
      const bodyFingerprint = fingerprint(body);
      const prior = state.idempotency.get(mapKey);
      const baseUrl = requestBaseUrl(request, options.publicBaseUrl);
      const currentTime = now().getTime();
      if (prior) {
        if (prior.fingerprint !== bodyFingerprint) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different request.",
          );
        }
        const ticket = findOwnedTicket(state, principal, prior.ticketId);
        return reply.code(201).send({
          ticket: serializeTicket(state, ticket, baseUrl, currentTime),
        });
      }

      const ticketId = makeId("tkt");
      const timestamp = now().toISOString();
      const attachmentIds = claimUploads(
        state,
        principal,
        body.uploadIds,
        ticketId,
        currentTime,
      );
      const ticket: StoredTicket = {
        id: ticketId,
        ownerKey: ownerKey(principal),
        title: body.title,
        description: body.description,
        category: body.category,
        status: "open",
        reporter: {
          id: principal.userId,
          name: principal.name,
          ...(principal.email ? { email: principal.email } : {}),
        },
        source: {
          system: principal.sourceSystem,
          ...(principal.moduleName ? { module: principal.moduleName } : {}),
          ...(principal.pageUrl ? { pageUrl: principal.pageUrl } : {}),
        },
        attachmentIds,
        replies: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.tickets.set(ticket.id, ticket);
      state.idempotency.set(mapKey, {
        fingerprint: bodyFingerprint,
        kind: "ticket",
        ticketId: ticket.id,
      });
      return reply.code(201).send({
        ticket: serializeTicket(state, ticket, baseUrl, currentTime),
      });
    },
  );

  app.get(
    "/api/v1/tickets/:ticketId",
    { preHandler: authorize("tickets:read") },
    async (request) => {
      const principal = principalFor(request);
      const params = parseWithSchema(
        z.object({ ticketId: ticketIdSchema }),
        request.params,
      );
      const ticket = findOwnedTicket(state, principal, params.ticketId);
      return {
        ticket: serializeTicket(
          state,
          ticket,
          requestBaseUrl(request, options.publicBaseUrl),
          now().getTime(),
        ),
      };
    },
  );

  app.post(
    "/api/v1/tickets/:ticketId/replies",
    { preHandler: authorize("tickets:reply") },
    async (request, reply) => {
      const principal = principalFor(request);
      const params = parseWithSchema(
        z.object({ ticketId: ticketIdSchema }),
        request.params,
      );
      const body = parseWithSchema(createReplySchema, request.body);
      const ticket = findOwnedTicket(state, principal, params.ticketId);
      const key = idempotencyHeader(request);
      const mapKey = idempotencyMapKey(
        principal,
        `POST:/tickets/${ticket.id}/replies`,
        key,
      );
      const bodyFingerprint = fingerprint(body);
      const prior = state.idempotency.get(mapKey);
      const baseUrl = requestBaseUrl(request, options.publicBaseUrl);
      const currentTime = now().getTime();
      if (prior) {
        if (prior.fingerprint !== bodyFingerprint) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different request.",
          );
        }
        const storedReply = ticket.replies.find((entry) => entry.id === prior.replyId);
        if (!storedReply) {
          throw new ApiError(500, "INTERNAL_ERROR", "Reply metadata is unavailable.");
        }
        return reply.code(201).send({
          reply: serializeReply(state, storedReply, baseUrl, currentTime),
        });
      }

      const replyId = makeId("rpl");
      const attachmentIds = claimUploads(
        state,
        principal,
        body.uploadIds,
        replyId,
        currentTime,
      );
      const timestamp = now().toISOString();
      const storedReply: StoredReply = {
        id: replyId,
        message: body.message,
        author: {
          type: "requester",
          id: principal.userId,
          name: principal.name,
        },
        attachmentIds,
        createdAt: timestamp,
      };
      ticket.replies.push(storedReply);
      ticket.updatedAt = timestamp;
      state.idempotency.set(mapKey, {
        fingerprint: bodyFingerprint,
        kind: "reply",
        ticketId: ticket.id,
        replyId: storedReply.id,
      });
      return reply.code(201).send({
        reply: serializeReply(state, storedReply, baseUrl, currentTime),
      });
    },
  );

  app.get("/mock/attachments/:attachmentId/download", async (request, reply) => {
    const params = parseWithSchema(
      z.object({ attachmentId: attachmentIdSchema }),
      request.params,
    );
    const query = parseWithSchema(
      z.object({ token: z.string().uuid() }),
      request.query,
    );
    const currentTime = now().getTime();
    const grant = state.downloadGrants.get(query.token);
    if (
      !grant ||
      grant.attachmentId !== params.attachmentId ||
      grant.expiresAt <= currentTime
    ) {
      throw new ApiError(404, "NOT_FOUND", "Attachment link not found or expired.");
    }
    const attachment = state.attachments.get(params.attachmentId);
    if (!attachment) {
      throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    }
    return reply
      .header("content-type", attachment.contentType)
      .header(
        "content-disposition",
        `attachment; filename="${safeDownloadName(attachment.fileName)}"`,
      )
      .send(attachment.data);
  });

  return app;
}
