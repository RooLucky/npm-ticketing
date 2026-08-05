export type TicketingAcceptedContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "application/pdf";

export type TicketingCategory = "bug" | "request" | "question";
export type TicketingStatus =
  | "open"
  | "in_progress"
  | "waiting_for_user"
  | "resolved"
  | "closed";

export type TicketingScope =
  | "tickets:read"
  | "tickets:create"
  | "tickets:reply"
  | "uploads:create";

export type SelfHostedTicketingPrincipal = {
  iss: string;
  sub: string;
  name: string;
  email?: string;
  sourceSystem: string;
  moduleName?: string;
  pageUrl?: string;
  scopes: TicketingScope[];
};

export type SelfHostedTicketingConfig = {
  clientId: string;
  clientSecret: Uint8Array;
  databaseUrl: string;
  redisUrl?: string;
  storage: {
    /** Omit for AWS S3; set only for R2, MinIO, or another S3-compatible API. */
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
};

export type SelfHostedTicketingOperation = {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
};

export type ExecuteSelfHostedTicketingRequestInput = {
  config: SelfHostedTicketingConfig;
  sessionToken: string;
  operation: SelfHostedTicketingOperation;
};

export type CleanupSelfHostedTicketingUploadsInput = {
  config: SelfHostedTicketingConfig;
  /** Maximum expired, unclaimed objects to remove in one bounded run. */
  limit?: number;
};

export type StoredUpload = {
  id: string;
  clientId: string;
  requesterId: string;
  fileName: string;
  contentType: TicketingAcceptedContentType;
  expectedSize: number;
  objectKey: string;
  expiresAt: Date;
};

export type StoredAttachment = {
  id: string;
  fileName: string;
  contentType: TicketingAcceptedContentType;
  size: number;
  objectKey: string;
};

export type StoredReply = {
  id: string;
  message: string;
  author: {
    type: "requester" | "agent";
    id: string;
    name: string;
  };
  attachments: StoredAttachment[];
  createdAt: Date;
};

export type StoredTicketSummary = {
  id: string;
  title: string;
  category: TicketingCategory;
  status: TicketingStatus;
  replyCount: number;
  attachmentCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredTicket = StoredTicketSummary & {
  description: string;
  reporter: { id: string; name: string; email?: string };
  source: { system: string; module?: string; pageUrl?: string };
  attachments: StoredAttachment[];
  replies: StoredReply[];
};

export type TicketListInput = {
  limit: number;
  cursor?: string;
  status?: TicketingStatus;
  category?: TicketingCategory;
};

export type CreateTicketInput = {
  title: string;
  description: string;
  category: TicketingCategory;
  uploadIds: string[];
};

export type CreateReplyInput = {
  message: string;
  uploadIds: string[];
};

export type PresignUploadInput = {
  fileName: string;
  contentType: TicketingAcceptedContentType;
  size: number;
};

export type IdempotentResult = {
  kind: "ticket" | "reply";
  resultId: string;
};

export interface TicketingRepository {
  assertMigrated(): Promise<void>;
  createUpload(upload: StoredUpload): Promise<void>;
  deleteUploadReservation(upload: StoredUpload): Promise<boolean>;
  listExpiredUploads(now: Date, limit: number): Promise<StoredUpload[]>;
  deleteExpiredUpload(uploadId: string, now: Date): Promise<boolean>;
  findClaimableUploads(
    principal: SelfHostedTicketingPrincipal,
    uploadIds: string[],
    now: Date,
  ): Promise<StoredUpload[]>;
  findIdempotentResult(
    principal: SelfHostedTicketingPrincipal,
    operation: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotentResult | undefined>;
  listTickets(
    principal: SelfHostedTicketingPrincipal,
    input: TicketListInput,
  ): Promise<{ items: StoredTicketSummary[]; nextCursor: string | null }>;
  getTicket(
    principal: SelfHostedTicketingPrincipal,
    ticketId: string,
  ): Promise<StoredTicket | undefined>;
  createTicket(
    principal: SelfHostedTicketingPrincipal,
    input: CreateTicketInput,
    options: {
      idempotencyKey: string;
      fingerprint: string;
      now: Date;
      ticketId: string;
      attachmentIds: string[];
    },
  ): Promise<IdempotentResult>;
  createReply(
    principal: SelfHostedTicketingPrincipal,
    ticketId: string,
    input: CreateReplyInput,
    options: {
      idempotencyKey: string;
      fingerprint: string;
      now: Date;
      replyId: string;
      attachmentIds: string[];
    },
  ): Promise<IdempotentResult>;
}

export interface TicketingStorage {
  presignUpload(upload: StoredUpload): Promise<{
    uploadUrl: string;
    headers: Record<string, string>;
    expiresAt: Date;
  }>;
  verifyUpload(upload: StoredUpload): Promise<void>;
  deleteUpload(upload: StoredUpload): Promise<void>;
  presignDownload(attachment: StoredAttachment): Promise<{
    downloadUrl: string;
    expiresAt: Date;
  }>;
}

export interface TicketingRateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export type SelfHostedTicketingDependencies = {
  repository: TicketingRepository;
  storage: TicketingStorage;
  rateLimiter?: TicketingRateLimiter;
  now?: () => Date;
  randomId?: (prefix: "upl" | "tkt" | "rpl" | "att") => string;
};
