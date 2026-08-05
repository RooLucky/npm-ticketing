import { SelfHostedTicketingError } from "../../src/self-hosted/errors.js";
import type {
  CreateReplyInput,
  CreateTicketInput,
  IdempotentResult,
  SelfHostedTicketingDependencies,
  SelfHostedTicketingPrincipal,
  StoredAttachment,
  StoredReply,
  StoredTicket,
  StoredTicketSummary,
  StoredUpload,
  TicketListInput,
  TicketingRateLimiter,
  TicketingRepository,
  TicketingStorage,
} from "../../src/self-hosted/types.js";

export const NOW = new Date("2026-08-05T06:00:00.000Z");

export const principal: SelfHostedTicketingPrincipal = {
  iss: "hris-production",
  sub: "user-42",
  name: "Ada Lovelace",
  email: "ada@example.test",
  sourceSystem: "hris",
  moduleName: "leave",
  pageUrl: "/leave/requests/42",
  scopes: [
    "tickets:read",
    "tickets:create",
    "tickets:reply",
    "uploads:create",
  ],
};

type IdempotencyEntry = {
  fingerprint: string;
  result: IdempotentResult;
};

function owner(principalValue: SelfHostedTicketingPrincipal): string {
  return `${principalValue.iss}\0${principalValue.sub}`;
}

function idempotencyMapKey(
  principalValue: SelfHostedTicketingPrincipal,
  operation: string,
  key: string,
): string {
  return JSON.stringify([owner(principalValue), operation, key]);
}

function summary(ticket: StoredTicket): StoredTicketSummary {
  return {
    id: ticket.id,
    title: ticket.title,
    category: ticket.category,
    status: ticket.status,
    replyCount: ticket.replies.length,
    attachmentCount:
      ticket.attachments.length +
      ticket.replies.reduce(
        (count, reply) => count + reply.attachments.length,
        0,
      ),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export class InMemoryTicketingRepository implements TicketingRepository {
  readonly uploads = new Map<string, StoredUpload>();
  readonly tickets = new Map<string, StoredTicket>();
  readonly ticketOwners = new Map<string, string>();
  readonly claimedUploads = new Set<string>();
  readonly idempotency = new Map<string, IdempotencyEntry>();
  readonly calls = {
    assertMigrated: 0,
    createUpload: [] as StoredUpload[],
    deleteUploadReservation: [] as StoredUpload[],
    listExpiredUploads: [] as Array<{ now: Date; limit: number }>,
    deleteExpiredUpload: [] as Array<{ uploadId: string; now: Date }>,
    findClaimableUploads: [] as Array<{
      principal: SelfHostedTicketingPrincipal;
      uploadIds: string[];
    }>,
    findIdempotentResult: [] as Array<{
      principal: SelfHostedTicketingPrincipal;
      operation: string;
      key: string;
      fingerprint: string;
    }>,
    listTickets: [] as Array<{
      principal: SelfHostedTicketingPrincipal;
      input: TicketListInput;
    }>,
    getTicket: [] as Array<{
      principal: SelfHostedTicketingPrincipal;
      ticketId: string;
    }>,
    createTicket: [] as Array<{
      principal: SelfHostedTicketingPrincipal;
      input: CreateTicketInput;
    }>,
    createReply: [] as Array<{
      principal: SelfHostedTicketingPrincipal;
      ticketId: string;
      input: CreateReplyInput;
    }>,
  };

  migrationError: unknown;
  private mutationQueue: Promise<void> = Promise.resolve();

  private async acquireMutationLock(): Promise<() => void> {
    const previous = this.mutationQueue;
    let release = (): void => undefined;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async assertMigrated(): Promise<void> {
    this.calls.assertMigrated += 1;
    if (this.migrationError) throw this.migrationError;
  }

  async createUpload(upload: StoredUpload): Promise<void> {
    this.calls.createUpload.push(upload);
    this.uploads.set(upload.id, upload);
  }

  async deleteUploadReservation(upload: StoredUpload): Promise<boolean> {
    this.calls.deleteUploadReservation.push(upload);
    const stored = this.uploads.get(upload.id);
    if (
      !stored ||
      stored.clientId !== upload.clientId ||
      stored.requesterId !== upload.requesterId ||
      stored.objectKey !== upload.objectKey ||
      this.claimedUploads.has(upload.id)
    ) {
      return false;
    }
    this.uploads.delete(upload.id);
    return true;
  }

  async listExpiredUploads(now: Date, limit: number): Promise<StoredUpload[]> {
    this.calls.listExpiredUploads.push({ now, limit });
    return [...this.uploads.values()]
      .filter((upload) => upload.expiresAt <= now && !this.claimedUploads.has(upload.id))
      .sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime())
      .slice(0, limit);
  }

  async deleteExpiredUpload(uploadId: string, now: Date): Promise<boolean> {
    this.calls.deleteExpiredUpload.push({ uploadId, now });
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.expiresAt > now || this.claimedUploads.has(uploadId)) {
      return false;
    }
    this.uploads.delete(uploadId);
    return true;
  }

  async findClaimableUploads(
    principalValue: SelfHostedTicketingPrincipal,
    uploadIds: string[],
    now: Date,
  ): Promise<StoredUpload[]> {
    this.calls.findClaimableUploads.push({
      principal: principalValue,
      uploadIds: [...uploadIds],
    });
    const uploads = uploadIds.map((uploadId) => this.uploads.get(uploadId));
    if (
      uploads.some(
        (upload) =>
          !upload ||
          upload.clientId !== principalValue.iss ||
          upload.requesterId !== principalValue.sub ||
          upload.expiresAt <= now ||
          this.claimedUploads.has(upload.id),
      )
    ) {
      throw new SelfHostedTicketingError(
        422,
        "UPLOAD_NOT_READY",
        "One or more uploads are unavailable or incomplete",
      );
    }
    return uploads as StoredUpload[];
  }

  async findIdempotentResult(
    principalValue: SelfHostedTicketingPrincipal,
    operation: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotentResult | undefined> {
    this.calls.findIdempotentResult.push({
      principal: principalValue,
      operation,
      key,
      fingerprint,
    });
    const prior = this.idempotency.get(
      idempotencyMapKey(principalValue, operation, key),
    );
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint) {
      throw new SelfHostedTicketingError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This request key was already used for a different operation",
      );
    }
    return prior.result;
  }

  async listTickets(
    principalValue: SelfHostedTicketingPrincipal,
    input: TicketListInput,
  ): Promise<{ items: StoredTicketSummary[]; nextCursor: string | null }> {
    this.calls.listTickets.push({ principal: principalValue, input });
    const matching = [...this.tickets.values()]
      .filter(
        (ticket) =>
          this.ticketOwners.get(ticket.id) === owner(principalValue) &&
          (!input.status || ticket.status === input.status) &&
          (!input.category || ticket.category === input.category),
      )
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    const offset = input.cursor ? Number(input.cursor) : 0;
    const items = matching.slice(offset, offset + input.limit).map(summary);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < matching.length ? String(nextOffset) : null,
    };
  }

  async getTicket(
    principalValue: SelfHostedTicketingPrincipal,
    ticketId: string,
  ): Promise<StoredTicket | undefined> {
    this.calls.getTicket.push({ principal: principalValue, ticketId });
    if (this.ticketOwners.get(ticketId) !== owner(principalValue)) {
      return undefined;
    }
    return this.tickets.get(ticketId);
  }

  async createTicket(
    principalValue: SelfHostedTicketingPrincipal,
    input: CreateTicketInput,
    options: {
      idempotencyKey: string;
      fingerprint: string;
      now: Date;
      ticketId: string;
      attachmentIds: string[];
    },
  ): Promise<IdempotentResult> {
    this.calls.createTicket.push({
      principal: principalValue,
      input: { ...input, uploadIds: [...input.uploadIds] },
    });
    const release = await this.acquireMutationLock();
    try {
      const mapKey = idempotencyMapKey(
        principalValue,
        "POST:/tickets",
        options.idempotencyKey,
      );
      const prior = this.idempotency.get(mapKey);
      if (prior) {
        if (prior.fingerprint !== options.fingerprint) {
          throw new SelfHostedTicketingError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This request key was already used for a different operation",
          );
        }
        return prior.result;
      }

      const uploads = await this.findClaimableUploads(
        principalValue,
        input.uploadIds,
        options.now,
      );
      const attachments = uploads.map((upload, index): StoredAttachment => ({
        id: options.attachmentIds[index]!,
        fileName: upload.fileName,
        contentType: upload.contentType,
        size: upload.expectedSize,
        objectKey: upload.objectKey,
      }));
      const ticket: StoredTicket = {
        id: options.ticketId,
        title: input.title,
        description: input.description,
        category: input.category,
        status: "open",
        reporter: {
          id: principalValue.sub,
          name: principalValue.name,
          ...(principalValue.email ? { email: principalValue.email } : {}),
        },
        source: {
          system: principalValue.sourceSystem,
          ...(principalValue.moduleName
            ? { module: principalValue.moduleName }
            : {}),
          ...(principalValue.pageUrl ? { pageUrl: principalValue.pageUrl } : {}),
        },
        attachments,
        replies: [],
        replyCount: 0,
        attachmentCount: attachments.length,
        createdAt: options.now,
        updatedAt: options.now,
      };
      const result: IdempotentResult = {
        kind: "ticket",
        resultId: ticket.id,
      };

      // These mutations intentionally occur together to model one database transaction.
      this.tickets.set(ticket.id, ticket);
      this.ticketOwners.set(ticket.id, owner(principalValue));
      uploads.forEach((upload) => this.claimedUploads.add(upload.id));
      this.idempotency.set(mapKey, {
        fingerprint: options.fingerprint,
        result,
      });
      return result;
    } finally {
      release();
    }
  }

  async createReply(
    principalValue: SelfHostedTicketingPrincipal,
    ticketId: string,
    input: CreateReplyInput,
    options: {
      idempotencyKey: string;
      fingerprint: string;
      now: Date;
      replyId: string;
      attachmentIds: string[];
    },
  ): Promise<IdempotentResult> {
    this.calls.createReply.push({
      principal: principalValue,
      ticketId,
      input: { ...input, uploadIds: [...input.uploadIds] },
    });
    const release = await this.acquireMutationLock();
    try {
      const operation = `POST:/tickets/${ticketId}/replies`;
      const mapKey = idempotencyMapKey(
        principalValue,
        operation,
        options.idempotencyKey,
      );
      const prior = this.idempotency.get(mapKey);
      if (prior) {
        if (prior.fingerprint !== options.fingerprint) {
          throw new SelfHostedTicketingError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This request key was already used for a different operation",
          );
        }
        return prior.result;
      }

      const ticket = await this.getTicket(principalValue, ticketId);
      if (!ticket) {
        throw new SelfHostedTicketingError(
          404,
          "NOT_FOUND",
          "The requested ticket was not found",
        );
      }
      const uploads = await this.findClaimableUploads(
        principalValue,
        input.uploadIds,
        options.now,
      );
      const reply: StoredReply = {
        id: options.replyId,
        message: input.message,
        author: {
          type: "requester",
          id: principalValue.sub,
          name: principalValue.name,
        },
        attachments: uploads.map((upload, index) => ({
          id: options.attachmentIds[index]!,
          fileName: upload.fileName,
          contentType: upload.contentType,
          size: upload.expectedSize,
          objectKey: upload.objectKey,
        })),
        createdAt: options.now,
      };
      const result: IdempotentResult = {
        kind: "reply",
        resultId: reply.id,
      };

      ticket.replies.push(reply);
      ticket.replyCount = ticket.replies.length;
      ticket.attachmentCount += reply.attachments.length;
      ticket.updatedAt = options.now;
      uploads.forEach((upload) => this.claimedUploads.add(upload.id));
      this.idempotency.set(mapKey, {
        fingerprint: options.fingerprint,
        result,
      });
      return result;
    } finally {
      release();
    }
  }
}

export class InMemoryTicketingStorage implements TicketingStorage {
  readonly presignedUploads: StoredUpload[] = [];
  readonly verifiedUploads: StoredUpload[] = [];
  readonly deletedUploads: StoredUpload[] = [];
  readonly presignedDownloads: StoredAttachment[] = [];
  failVerificationFor = new Set<string>();
  presignError: unknown;

  async presignUpload(upload: StoredUpload) {
    this.presignedUploads.push(upload);
    if (this.presignError) throw this.presignError;
    return {
      uploadUrl: `https://storage.example.test/upload/${upload.id}`,
      headers: { "Content-Type": upload.contentType },
      expiresAt: new Date(NOW.getTime() + 10 * 60 * 1_000),
    };
  }

  async verifyUpload(upload: StoredUpload): Promise<void> {
    this.verifiedUploads.push(upload);
    if (this.failVerificationFor.has(upload.id)) {
      throw new SelfHostedTicketingError(
        422,
        "UPLOAD_NOT_READY",
        "One or more uploads are unavailable or incomplete",
      );
    }
  }

  async deleteUpload(upload: StoredUpload): Promise<void> {
    this.deletedUploads.push(upload);
  }

  async presignDownload(attachment: StoredAttachment) {
    this.presignedDownloads.push(attachment);
    return {
      downloadUrl: `https://storage.example.test/download/${attachment.id}`,
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1_000),
    };
  }
}

export class RecordingRateLimiter implements TicketingRateLimiter {
  readonly calls: Array<{
    key: string;
    limit: number;
    windowSeconds: number;
  }> = [];

  constructor(public allowed = true) {}

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    this.calls.push({ key, limit, windowSeconds });
    return this.allowed;
  }
}

export function createDependencies(options: {
  rateLimiter?: TicketingRateLimiter;
} = {}): SelfHostedTicketingDependencies & {
  repository: InMemoryTicketingRepository;
  storage: InMemoryTicketingStorage;
} {
  const repository = new InMemoryTicketingRepository();
  const storage = new InMemoryTicketingStorage();
  const counts = new Map<string, number>();
  return {
    repository,
    storage,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    now: () => new Date(NOW),
    randomId: (prefix) => {
      const next = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, next);
      return `${prefix}_${next}`;
    },
  };
}

export function addUpload(
  repository: InMemoryTicketingRepository,
  uploadId: string,
  ownerPrincipal: SelfHostedTicketingPrincipal = principal,
): StoredUpload {
  const upload: StoredUpload = {
    id: uploadId,
    clientId: ownerPrincipal.iss,
    requesterId: ownerPrincipal.sub,
    fileName: `${uploadId}.png`,
    contentType: "image/png",
    expectedSize: 128,
    objectKey: `ticketing/test/${uploadId}`,
    expiresAt: new Date(NOW.getTime() + 60_000),
  };
  repository.uploads.set(upload.id, upload);
  return upload;
}
