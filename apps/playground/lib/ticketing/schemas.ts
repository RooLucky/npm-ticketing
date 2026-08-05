import { z } from "zod";

export const TICKET_CATEGORIES = ["bug", "request", "question"] as const;
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_for_user",
  "resolved",
  "closed",
] as const;
export const TICKETING_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export const TICKETING_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const TICKET_ID_PATTERN = /^tkt_[A-Za-z0-9_-]+$/;
const UPLOAD_ID_PATTERN = /^upl_[A-Za-z0-9_-]+$/;
const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/;
const REPLY_ID_PATTERN = /^rpl_[A-Za-z0-9_-]+$/;

export const TicketCategorySchema = z.enum(TICKET_CATEGORIES);
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export const TicketingAcceptedTypeSchema = z.enum(TICKETING_ACCEPTED_TYPES);

export const TicketingPageUrlSchema = z
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

export const TicketingPrivateUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]"))
  );
}, "Private ticketing URLs must use HTTPS outside localhost");

export const TicketingUserSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  email: z.email().optional(),
}).strict();

export const ReporterSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  email: z.email().optional(),
}).strict();

export const TicketSourceSchema = z.object({
  system: z.string().min(1).max(128),
  module: z.string().min(1).max(128).optional(),
  pageUrl: TicketingPageUrlSchema.optional(),
}).strict();

export const AttachmentSchema = z.object({
  id: z.string().regex(ATTACHMENT_ID_PATTERN),
  fileName: z.string().min(1).max(255),
  contentType: TicketingAcceptedTypeSchema,
  size: z.number().int().min(1).max(TICKETING_MAX_UPLOAD_BYTES),
  downloadUrl: TicketingPrivateUrlSchema,
  downloadExpiresAt: z.iso.datetime(),
}).strict();

export const ReplySchema = z.object({
  id: z.string().regex(REPLY_ID_PATTERN),
  message: z.string().min(1).max(5_000),
  author: z.object({
    type: z.enum(["requester", "agent"]),
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
  }).strict(),
  createdAt: z.iso.datetime(),
  attachments: z.array(AttachmentSchema),
}).strict();

export const TicketSummarySchema = z.object({
  id: z.string().max(128).regex(TICKET_ID_PATTERN),
  title: z.string().min(3).max(160),
  category: TicketCategorySchema,
  status: TicketStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  replyCount: z.number().int().min(0),
  attachmentCount: z.number().int().min(0),
}).strict();

export const TicketDetailSchema = TicketSummarySchema.extend({
  description: z.string().min(1).max(10_000),
  reporter: ReporterSchema,
  source: TicketSourceSchema,
  attachments: z.array(AttachmentSchema),
  replies: z.array(ReplySchema),
}).strict();

export const TicketListQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: TicketCategorySchema.optional(),
  status: TicketStatusSchema.optional(),
}).strict();

export const TicketListResponseSchema = z.object({
  items: z.array(TicketSummarySchema),
  nextCursor: z.string().nullable(),
}).strict();

export const TicketDetailResponseSchema = z.object({
  ticket: TicketDetailSchema,
}).strict();

const UploadIdsSchema = z
  .array(z.string().regex(UPLOAD_ID_PATTERN))
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length);

export const CreateTicketRequestSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(10_000),
  category: TicketCategorySchema,
  uploadIds: UploadIdsSchema.default([]),
}).strict();

export const CreateTicketResponseSchema = TicketDetailResponseSchema;

export const CreateReplyRequestSchema = z.object({
  message: z.string().trim().min(1).max(5_000),
  uploadIds: UploadIdsSchema.default([]),
}).strict();

export const CreateReplyResponseSchema = z.object({
  reply: ReplySchema,
}).strict();

export const PresignUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: TicketingAcceptedTypeSchema,
  size: z.number().int().min(1).max(TICKETING_MAX_UPLOAD_BYTES),
}).strict();

export const PresignUploadResponseSchema = z.object({
  uploadId: z.string().regex(UPLOAD_ID_PATTERN),
  uploadUrl: TicketingPrivateUrlSchema,
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
}).strict();

export const TicketIdSchema = z
  .string()
  .max(128)
  .regex(TICKET_ID_PATTERN, "Invalid ticket identifier");

export const ApiErrorCodeSchema = z.enum([
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
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
]);

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().max(500),
    fieldErrors: z.record(z.string(), z.array(z.string().max(500)).max(20)).optional(),
    requestId: z.string().max(128).optional(),
  }),
});

export type TicketCategory = z.infer<typeof TicketCategorySchema>;
export type TicketStatus = z.infer<typeof TicketStatusSchema>;
export type TicketingAcceptedType = z.infer<typeof TicketingAcceptedTypeSchema>;
export type TicketingUser = z.infer<typeof TicketingUserSchema>;
export type TicketAttachment = z.infer<typeof AttachmentSchema>;
export type TicketReply = z.infer<typeof ReplySchema>;
export type TicketSummary = z.infer<typeof TicketSummarySchema>;
export type TicketDetail = z.infer<typeof TicketDetailSchema>;
export type TicketListResponse = z.infer<typeof TicketListResponseSchema>;
export type PresignUploadResponse = z.infer<typeof PresignUploadResponseSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export type TicketingProps = {
  user: TicketingUser;
  sourceSystem: string;
  moduleName?: string;
  pageUrl?: string;
  initialView?: "list" | "create";
  className?: string;
  attachments?: {
    enabled?: boolean;
    maximumFiles?: number;
    maximumFileSizeMb?: number;
    accept?: TicketingAcceptedType[];
  };
};

export type ResolvedAttachmentOptions = {
  enabled: boolean;
  maximumFiles: number;
  maximumFileSizeMb: number;
  accept: TicketingAcceptedType[];
};
