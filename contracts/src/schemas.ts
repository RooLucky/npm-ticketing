import { z } from "zod";

export const TICKETING_AUDIENCE = "ticketing-api";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const TICKET_CATEGORIES = ["bug", "request", "question"] as const;
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_for_user",
  "resolved",
  "closed",
] as const;
export const TICKETING_SCOPES = [
  "tickets:read",
  "tickets:create",
  "tickets:reply",
  "uploads:create",
] as const;
export const ACCEPTED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export const PAGE_URL_PATTERN =
  /^(?:[hH][tT][tT][pP][sS]?:\/\/|\/(?!\/))[^\\]*$/;
export const PRIVATE_TRANSFER_URL_PATTERN =
  /^(?:[hH][tT][tT][pP][sS]:\/\/|[hH][tT][tT][pP]:\/\/(?:[lL][oO][cC][aA][lL][hH][oO][sS][tT]|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:\/|$))/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]+$/;
export const TICKET_ID_PATTERN = /^tkt_[A-Za-z0-9_-]+$/;
export const UPLOAD_ID_PATTERN = /^upl_[A-Za-z0-9_-]+$/;
export const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/;
export const REPLY_ID_PATTERN = /^rpl_[A-Za-z0-9_-]+$/;

function containsNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

export const PageUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(PAGE_URL_PATTERN)
  .refine(containsNoControlCharacters)
  .refine((value) => {
    if (value.startsWith("/")) return !value.startsWith("//");
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  })
  .meta({
    id: "PageUrl",
    format: "uri-reference",
    description: "An HTTP(S) URL or an origin-relative path such as `/support`.",
  });

export const PrivateTransferUrlSchema = z
  .url()
  .regex(PRIVATE_TRANSFER_URL_PATTERN)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "[::1]"))
    );
  })
  .meta({
    id: "PrivateTransferUrl",
    format: "uri",
    description:
      "HTTPS URL; HTTP is permitted only for localhost loopback fixtures.",
  });

export const TicketCategorySchema = z.enum(TICKET_CATEGORIES).meta({
  id: "TicketCategory",
});
export const TicketStatusSchema = z.enum(TICKET_STATUSES).meta({
  id: "TicketStatus",
});
export const TicketingScopeSchema = z.enum(TICKETING_SCOPES).meta({
  id: "TicketingScope",
});
export const AcceptedContentTypeSchema = z.enum(ACCEPTED_CONTENT_TYPES);

export const TicketIdSchema = z
  .string()
  .max(128)
  .regex(TICKET_ID_PATTERN)
  .meta({ id: "TicketId" });
export const UploadIdSchema = z.string().regex(UPLOAD_ID_PATTERN);
export const AttachmentIdSchema = z
  .string()
  .regex(ATTACHMENT_ID_PATTERN)
  .meta({ id: "AttachmentId" });
export const ReplyIdSchema = z
  .string()
  .regex(REPLY_ID_PATTERN)
  .meta({ id: "ReplyId" });
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(IDEMPOTENCY_KEY_PATTERN)
  .meta({
    id: "IdempotencyKey",
    description:
      "Unique mutation key. Identical replay returns the original result; reuse with a different body conflicts.",
  });

const audienceSchema = z.union([
  z.literal(TICKETING_AUDIENCE),
  z.array(z.literal(TICKETING_AUDIENCE)).min(1),
]);

export const TicketingClaimsSchema = z
  .object({
    iss: z.string().min(1).max(128).meta({
      description: "Integration client ID; must equal the protected JWT kid.",
    }),
    sub: z.string().min(1).max(256).meta({
      description: "Stable requester ID in the consuming application.",
    }),
    aud: audienceSchema,
    name: z.string().min(1).max(256),
    email: z.email().optional(),
    sourceSystem: z.string().min(1).max(128),
    moduleName: z.string().min(1).max(128).optional(),
    pageUrl: PageUrlSchema.optional(),
    scopes: z
      .array(TicketingScopeSchema)
      .min(1)
      .refine((scopes) => new Set(scopes).size === scopes.length)
      .meta({ uniqueItems: true }),
    iat: z.number().int().meta({ description: "Issued-at time in epoch seconds." }),
    exp: z.number().int().meta({
      description:
        "Expiry in epoch seconds; must be after iat and no more than 3600 seconds later.",
    }),
    jti: z.string().min(1).max(128),
  })
  .passthrough()
  .refine((claims) => claims.exp > claims.iat && claims.exp - claims.iat <= 3600)
  .meta({
    id: "TicketingClaims",
    description:
      "Required JWT claims. exp must be after iat and no more than 3600 seconds later.",
  });

export const PresignUploadRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    contentType: AcceptedContentTypeSchema,
    size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  })
  .strict()
  .meta({ id: "PresignUploadRequest" });

export const PresignUploadResponseSchema = z
  .object({
    uploadId: UploadIdSchema,
    uploadUrl: PrivateTransferUrlSchema,
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "PresignUploadResponse" });

export const UploadIdsSchema = z
  .array(UploadIdSchema)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length)
  .meta({ uniqueItems: true });

export const CreateTicketRequestSchema = z
  .object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(1).max(10_000),
    category: TicketCategorySchema,
    uploadIds: UploadIdsSchema.optional().default([]),
  })
  .strict()
  .meta({ id: "CreateTicketRequest" });

export const CreateReplyRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(5_000),
    uploadIds: UploadIdsSchema.optional().default([]),
  })
  .strict()
  .meta({ id: "CreateReplyRequest" });

export const TicketListQuerySchema = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    status: TicketStatusSchema.optional(),
    category: TicketCategorySchema.optional(),
  })
  .strict();

export const ReporterSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    email: z.email().optional(),
  })
  .strict()
  .meta({ id: "Reporter" });

export const TicketSourceSchema = z
  .object({
    system: z.string().min(1).max(128),
    module: z.string().min(1).max(128).optional(),
    pageUrl: PageUrlSchema.optional(),
  })
  .strict()
  .meta({ id: "TicketSource" });

export const AttachmentSchema = z
  .object({
    id: AttachmentIdSchema,
    fileName: z.string().min(1).max(255),
    contentType: AcceptedContentTypeSchema,
    size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    downloadUrl: PrivateTransferUrlSchema,
    downloadExpiresAt: z.iso.datetime(),
  })
  .strict()
  .meta({
    id: "Attachment",
    description: "Private attachment metadata with a short-lived download URL.",
  });

export const ReplyAuthorSchema = z
  .object({
    type: z.enum(["requester", "agent"]),
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
  })
  .strict()
  .meta({ id: "ReplyAuthor" });

export const TicketReplySchema = z
  .object({
    id: ReplyIdSchema,
    message: z.string().min(1).max(5_000),
    author: ReplyAuthorSchema,
    attachments: z.array(AttachmentSchema),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "TicketReply" });

export const TicketSummarySchema = z
  .object({
    id: TicketIdSchema,
    title: z.string().min(3).max(160),
    category: TicketCategorySchema,
    status: TicketStatusSchema,
    replyCount: z.number().int().min(0),
    attachmentCount: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "TicketSummary" });

export const TicketSchema = TicketSummarySchema.extend({
  description: z.string().min(1).max(10_000),
  reporter: ReporterSchema,
  source: TicketSourceSchema,
  attachments: z.array(AttachmentSchema),
  replies: z.array(TicketReplySchema),
})
  .strict()
  .meta({ id: "Ticket" });

export const TicketEnvelopeSchema = z
  .object({ ticket: TicketSchema })
  .strict()
  .meta({ id: "TicketEnvelope" });
export const ReplyEnvelopeSchema = z
  .object({ reply: TicketReplySchema })
  .strict()
  .meta({ id: "ReplyEnvelope" });
export const TicketPageSchema = z
  .object({
    items: z.array(TicketSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .meta({ id: "TicketPage" });

export const ErrorCodeSchema = z
  .enum([
    "VALIDATION_ERROR",
    "INVALID_SESSION",
    "SESSION_EXPIRED",
    "FORBIDDEN",
    "NOT_FOUND",
    "IDEMPOTENCY_CONFLICT",
    "UPLOAD_NOT_READY",
    "FILE_TOO_LARGE",
    "UNSUPPORTED_FILE_TYPE",
    "RATE_LIMITED",
    "UPSTREAM_TIMEOUT",
    "INTERNAL_ERROR",
  ])
  .meta({ id: "ErrorCode" });

export const ErrorDetailSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(500),
    fieldErrors: z.record(z.string(), z.array(z.string().max(500)).max(20)).optional(),
    requestId: z.string().max(128).optional(),
  })
  .strict()
  .meta({ id: "ErrorDetail" });
export const ErrorResponseSchema = z
  .object({ error: ErrorDetailSchema })
  .strict()
  .meta({ id: "ErrorResponse" });

export type TicketCategory = z.infer<typeof TicketCategorySchema>;
export type TicketStatus = z.infer<typeof TicketStatusSchema>;
export type TicketingScope = z.infer<typeof TicketingScopeSchema>;
export type AcceptedContentType = z.infer<typeof AcceptedContentTypeSchema>;
export type TicketingClaims = z.infer<typeof TicketingClaimsSchema>;
export type PresignUploadRequest = z.infer<typeof PresignUploadRequestSchema>;
export type CreateTicketRequest = z.infer<typeof CreateTicketRequestSchema>;
export type CreateReplyRequest = z.infer<typeof CreateReplyRequestSchema>;
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type TicketReply = z.infer<typeof TicketReplySchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const openApiComponentSchemas = {
  TicketingClaims: TicketingClaimsSchema,
  TicketingScope: TicketingScopeSchema,
  TicketCategory: TicketCategorySchema,
  TicketStatus: TicketStatusSchema,
  TicketId: TicketIdSchema,
  AttachmentId: AttachmentIdSchema,
  ReplyId: ReplyIdSchema,
  PresignUploadRequest: PresignUploadRequestSchema,
  PresignUploadResponse: PresignUploadResponseSchema,
  CreateTicketRequest: CreateTicketRequestSchema,
  CreateReplyRequest: CreateReplyRequestSchema,
  Reporter: ReporterSchema,
  TicketSource: TicketSourceSchema,
  PageUrl: PageUrlSchema,
  PrivateTransferUrl: PrivateTransferUrlSchema,
  Attachment: AttachmentSchema,
  ReplyAuthor: ReplyAuthorSchema,
  TicketReply: TicketReplySchema,
  TicketSummary: TicketSummarySchema,
  Ticket: TicketSchema,
  TicketEnvelope: TicketEnvelopeSchema,
  ReplyEnvelope: ReplyEnvelopeSchema,
  TicketPage: TicketPageSchema,
  ErrorCode: ErrorCodeSchema,
  ErrorDetail: ErrorDetailSchema,
  ErrorResponse: ErrorResponseSchema,
} as const;
