import { z } from "zod";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export const TICKETING_SESSION_AUDIENCE = "ticketing-api";

const TicketingScopeSchema = z.enum([
  "tickets:read",
  "tickets:create",
  "tickets:reply",
  "uploads:create",
]);

const TicketingPageUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 31 || codePoint === 127 || character === "\\") return false;
    }
    if (value.startsWith("/")) return !value.startsWith("//");
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "Page URL must be an HTTP(S) URL or an origin-relative path");

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export const TicketingDatabaseUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    context.addIssue({
      code: "custom",
      message: "Ticketing database URLs must use postgres: or postgresql:",
    });
    return;
  }

  if (isLoopbackHostname(url.hostname)) return;
  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
    context.addIssue({
      code: "custom",
      message:
        "Remote ticketing database URLs must set exactly one sslmode=verify-full parameter",
    });
  }
});

export const TicketingRedisUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    context.addIssue({
      code: "custom",
      message: "Ticketing Redis URLs must use redis: or rediss:",
    });
    return;
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== "rediss:") {
    context.addIssue({
      code: "custom",
      message: "Remote ticketing Redis URLs must use rediss:",
    });
  }
});

export function assertTicketingDatabaseUrl(value: string): void {
  TicketingDatabaseUrlSchema.parse(value);
}

export const PrincipalSchema = z.object({
  iss: z.string().min(1).max(128),
  sub: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  email: z.email().optional(),
  sourceSystem: z.string().min(1).max(128),
  moduleName: z.string().min(1).max(128).optional(),
  pageUrl: TicketingPageUrlSchema.optional(),
  scopes: z.array(TicketingScopeSchema).min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length),
}).strict();

export const SelfHostedSessionClaimsSchema = PrincipalSchema.extend({
  aud: z.union([
    z.literal(TICKETING_SESSION_AUDIENCE),
    z.array(z.literal(TICKETING_SESSION_AUDIENCE)).min(1),
  ]),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string().min(1).max(128),
}).refine(
  (claims) => claims.exp > claims.iat && claims.exp - claims.iat <= 3600,
  "Ticketing sessions must expire within 60 minutes of issuance",
);

export const TicketingSessionTokenSchema = z.string().min(1).max(8192);

export const SelfHostedConfigSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  clientSecret: z.instanceof(Uint8Array).refine(
    (secret) => secret.byteLength >= 32,
    "clientSecret must contain at least 32 bytes",
  ),
  databaseUrl: TicketingDatabaseUrlSchema,
  redisUrl: TicketingRedisUrlSchema.optional(),
  storage: z.object({
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    }).optional(),
    region: z.string().min(1).max(128),
    bucket: z.string().min(1).max(255),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    forcePathStyle: z.boolean(),
  }).strict(),
}).strict();

export const PresignUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(ACCEPTED_CONTENT_TYPES),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
}).strict();

const UploadIdsSchema = z.array(z.string().regex(/^upl_[A-Za-z0-9_-]+$/)).max(5)
  .refine((ids) => new Set(ids).size === ids.length);

export const CreateTicketSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(10_000),
  category: z.enum(["bug", "request", "question"]),
  uploadIds: UploadIdsSchema.default([]),
}).strict();

export const CreateReplySchema = z.object({
  message: z.string().trim().min(1).max(5_000),
  uploadIds: UploadIdsSchema.default([]),
}).strict();

export const TicketListSchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["open", "in_progress", "waiting_for_user", "resolved", "closed"]).optional(),
  category: z.enum(["bug", "request", "question"]).optional(),
}).strict();

export const IdempotencyKeySchema = z.string().min(8).max(255)
  .regex(/^[A-Za-z0-9._~:-]+$/);

export const TicketIdSchema = z.string().max(128).regex(/^tkt_[A-Za-z0-9_-]+$/);
