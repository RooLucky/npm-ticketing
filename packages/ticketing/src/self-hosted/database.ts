import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { SelfHostedTicketingError } from "./errors.js";
import {
  TICKETING_DATABASE_TIMEOUTS,
  validateAppliedTicketingMigrations,
} from "./migrations.js";
import { assertTicketingDatabaseUrl } from "./schemas.js";
import type {
  CreateReplyInput,
  CreateTicketInput,
  IdempotentResult,
  SelfHostedTicketingPrincipal,
  StoredAttachment,
  StoredReply,
  StoredTicket,
  StoredTicketSummary,
  StoredUpload,
  TicketingAcceptedContentType,
  TicketingCategory,
  TicketingRepository,
  TicketingStatus,
  TicketListInput,
} from "./types.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type TicketRow = {
  id: string;
  title: string;
  description: string;
  category: TicketingCategory;
  status: TicketingStatus;
  reply_count: number;
  attachment_count: number;
  created_at: Date;
  updated_at: Date;
  requester_id: string;
  reporter_name: string;
  reporter_email: string | null;
  source_system: string;
  module_name: string | null;
  page_url: string | null;
};

type UploadRow = {
  id: string;
  client_id: string;
  requester_id: string;
  file_name: string;
  content_type: TicketingAcceptedContentType;
  expected_size: number;
  object_key: string;
  expires_at: Date;
  attachment_id: string | null;
};

type AttachmentRow = {
  id: string;
  file_name: string;
  content_type: TicketingAcceptedContentType;
  size: number;
  object_key: string;
  target_id: string;
};

type ReplyRow = {
  id: string;
  message: string;
  author_type: "requester" | "agent";
  author_id: string;
  author_name: string;
  created_at: Date;
};

const pools = new Map<string, Pool>();

export const MAX_ACTIVE_UPLOAD_RESERVATIONS_PER_OWNER = 30;

function poolKey(databaseUrl: string): string {
  return createHash("sha256").update(databaseUrl).digest("hex");
}

export function poolForTicketingDatabase(databaseUrl: string): Pool {
  assertTicketingDatabaseUrl(databaseUrl);
  const key = poolKey(databaseUrl);
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: TICKETING_DATABASE_TIMEOUTS.statementMilliseconds,
    lock_timeout: TICKETING_DATABASE_TIMEOUTS.lockMilliseconds,
    idle_in_transaction_session_timeout:
      TICKETING_DATABASE_TIMEOUTS.idleTransactionMilliseconds,
    query_timeout: TICKETING_DATABASE_TIMEOUTS.queryMilliseconds,
    allowExitOnIdle: true,
  });
  pool.on("error", () => undefined);
  pools.set(key, pool);
  return pool;
}

function unavailable(error: unknown): SelfHostedTicketingError {
  if (error instanceof SelfHostedTicketingError) return error;
  return new SelfHostedTicketingError(
    503,
    "UPSTREAM_UNAVAILABLE",
    "The ticketing database is unavailable",
    { cause: error },
  );
}

function mapUpload(row: UploadRow): StoredUpload {
  return {
    id: row.id,
    clientId: row.client_id,
    requesterId: row.requester_id,
    fileName: row.file_name,
    contentType: row.content_type,
    expectedSize: row.expected_size,
    objectKey: row.object_key,
    expiresAt: new Date(row.expires_at),
  };
}

function mapAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    size: Number(row.size),
    objectKey: row.object_key,
  };
}

function mapSummary(row: TicketRow): StoredTicketSummary {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    replyCount: Number(row.reply_count),
    attachmentCount: Number(row.attachment_count),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function ownerDigest(principal: SelfHostedTicketingPrincipal): string {
  return createHash("sha256")
    .update(`${principal.iss}\0${principal.sub}`)
    .digest("base64url")
    .slice(0, 22);
}

type Cursor = {
  v: 1;
  owner: string;
  updatedAt: string;
  id: string;
  status: TicketingStatus | null;
  category: TicketingCategory | null;
};

function encodeCursor(
  principal: SelfHostedTicketingPrincipal,
  input: TicketListInput,
  item: StoredTicketSummary,
): string {
  const cursor: Cursor = {
    v: 1,
    owner: ownerDigest(principal),
    updatedAt: item.updatedAt.toISOString(),
    id: item.id,
    status: input.status ?? null,
    category: input.category ?? null,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  principal: SelfHostedTicketingPrincipal,
  input: TicketListInput,
): Cursor | undefined {
  if (!input.cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      parsed.v !== 1 ||
      parsed.owner !== ownerDigest(principal) ||
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.id !== "string" ||
      parsed.status !== (input.status ?? null) ||
      parsed.category !== (input.category ?? null)
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as Cursor;
  } catch (error) {
    throw new SelfHostedTicketingError(
      400,
      "VALIDATION_ERROR",
      "The ticket cursor is invalid",
      { fieldErrors: { cursor: ["Use the opaque cursor returned by the previous response."] }, cause: error },
    );
  }
}

async function loadAttachments(
  queryable: Queryable,
  principal: SelfHostedTicketingPrincipal,
  targetType: "ticket" | "reply",
  targetIds: string[],
): Promise<Map<string, StoredAttachment[]>> {
  const result = new Map<string, StoredAttachment[]>();
  if (targetIds.length === 0) return result;
  const rows = await queryable.query<AttachmentRow>(
    `SELECT id, file_name, content_type, size, object_key, target_id
       FROM ticketing.attachments
      WHERE target_type = $1
        AND target_id = ANY($2::text[])
        AND client_id = $3
        AND requester_id = $4
      ORDER BY created_at ASC, id ASC`,
    [targetType, targetIds, principal.iss, principal.sub],
  );
  for (const row of rows.rows) {
    result.set(row.target_id, [...(result.get(row.target_id) ?? []), mapAttachment(row)]);
  }
  return result;
}

async function loadTicket(
  queryable: Queryable,
  principal: SelfHostedTicketingPrincipal,
  ticketId: string,
): Promise<StoredTicket | undefined> {
  const ticketResult = await queryable.query<TicketRow>(
    `SELECT id, title, description, category, status, reply_count, attachment_count,
            created_at, updated_at, requester_id, reporter_name, reporter_email,
            source_system, module_name, page_url
       FROM ticketing.tickets
      WHERE id = $1 AND client_id = $2 AND requester_id = $3`,
    [ticketId, principal.iss, principal.sub],
  );
  const row = ticketResult.rows[0];
  if (!row) return undefined;
  const replyResult = await queryable.query<ReplyRow>(
    `SELECT id, message, author_type, author_id, author_name, created_at
       FROM ticketing.replies WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC`,
    [ticketId],
  );
  const [ticketAttachments, replyAttachments] = await Promise.all([
    loadAttachments(queryable, principal, "ticket", [ticketId]),
    loadAttachments(
      queryable,
      principal,
      "reply",
      replyResult.rows.map((reply) => reply.id),
    ),
  ]);
  const replies: StoredReply[] = replyResult.rows.map((reply) => ({
    id: reply.id,
    message: reply.message,
    author: {
      type: reply.author_type,
      id: reply.author_id,
      name: reply.author_name,
    },
    attachments: replyAttachments.get(reply.id) ?? [],
    createdAt: new Date(reply.created_at),
  }));
  return {
    ...mapSummary(row),
    description: row.description,
    reporter: {
      id: row.requester_id,
      name: row.reporter_name,
      ...(row.reporter_email ? { email: row.reporter_email } : {}),
    },
    source: {
      system: row.source_system,
      ...(row.module_name ? { module: row.module_name } : {}),
      ...(row.page_url ? { pageUrl: row.page_url } : {}),
    },
    attachments: ticketAttachments.get(ticketId) ?? [],
    replies,
  };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL statement_timeout = '${TICKETING_DATABASE_TIMEOUTS.statementMilliseconds}ms'`,
    );
    await client.query(
      `SET LOCAL lock_timeout = '${TICKETING_DATABASE_TIMEOUTS.lockMilliseconds}ms'`,
    );
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = '${TICKETING_DATABASE_TIMEOUTS.idleTransactionMilliseconds}ms'`,
    );
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockedUploads(
  client: PoolClient,
  principal: SelfHostedTicketingPrincipal,
  ids: string[],
): Promise<UploadRow[]> {
  if (ids.length === 0) return [];
  const rows = await client.query<UploadRow>(
    `SELECT id, client_id, requester_id, file_name, content_type, expected_size,
            object_key, expires_at, attachment_id
       FROM ticketing.uploads
      WHERE id = ANY($1::text[])
        AND client_id = $2
        AND requester_id = $3
        AND attachment_id IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      FOR UPDATE`,
    [ids, principal.iss, principal.sub],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id));
  if (ordered.some((row) => !row)) {
    throw new SelfHostedTicketingError(
      422,
      "UPLOAD_NOT_READY",
      "One or more uploads are unavailable or incomplete",
    );
  }
  return ordered as UploadRow[];
}

async function lockedIdempotency(
  client: PoolClient,
  principal: SelfHostedTicketingPrincipal,
  operation: string,
  key: string,
  fingerprint: string,
): Promise<IdempotentResult | undefined> {
  const lockScope = JSON.stringify([principal.iss, principal.sub, operation, key]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockScope]);
  const existing = await client.query<{
    request_fingerprint: string;
    result_type: "ticket" | "reply";
    result_id: string;
  }>(
    `SELECT request_fingerprint, result_type, result_id
       FROM ticketing.idempotency
      WHERE client_id = $1 AND requester_id = $2 AND operation = $3 AND idempotency_key = $4`,
    [principal.iss, principal.sub, operation, key],
  );
  const row = existing.rows[0];
  if (!row) return undefined;
  if (row.request_fingerprint !== fingerprint) {
    throw new SelfHostedTicketingError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "This request key was already used for a different operation",
    );
  }
  return { kind: row.result_type, resultId: row.result_id };
}

async function saveIdempotency(
  client: PoolClient,
  principal: SelfHostedTicketingPrincipal,
  operation: string,
  key: string,
  fingerprint: string,
  result: IdempotentResult,
): Promise<void> {
  await client.query(
    `INSERT INTO ticketing.idempotency
      (client_id, requester_id, operation, idempotency_key, request_fingerprint, result_type, result_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [principal.iss, principal.sub, operation, key, fingerprint, result.kind, result.resultId],
  );
}

export class PostgresTicketingRepository implements TicketingRepository {
  private migrationCheck: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  assertMigrated(): Promise<void> {
    if (this.migrationCheck) return this.migrationCheck;
    this.migrationCheck = (async () => {
      try {
        const table = await this.pool.query<{ table_name: string | null }>(
          "SELECT to_regclass('ticketing.schema_migrations')::text AS table_name",
        );
        if (!table.rows[0]?.table_name) {
          throw new SelfHostedTicketingError(
            503,
            "UPSTREAM_UNAVAILABLE",
            "Ticketing database migrations have not been applied",
          );
        }
        const applied = await this.pool.query<{
          version: number;
          checksum: string;
        }>(
          `SELECT version, checksum::text AS checksum
             FROM ticketing.schema_migrations
            ORDER BY version ASC`,
        );
        validateAppliedTicketingMigrations(applied.rows, {
          requireCurrent: true,
        });
      } catch (error) {
        throw unavailable(error);
      }
    })().catch((error) => {
      this.migrationCheck = undefined;
      throw error;
    });
    return this.migrationCheck;
  }

  async createUpload(upload: StoredUpload): Promise<void> {
    try {
      await transaction(this.pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [upload.clientId, upload.requesterId],
        );
        const active = await client.query<{
          active_count: number;
          retry_after: number;
        }>(
          `SELECT count(*)::integer AS active_count,
                  COALESCE(
                    LEAST(
                      86400::numeric,
                      GREATEST(
                        1::numeric,
                        ceil(EXTRACT(EPOCH FROM (min(expires_at) - CURRENT_TIMESTAMP)))
                      )
                    )::integer,
                    60
                  ) AS retry_after
             FROM ticketing.uploads
            WHERE client_id = $1
              AND requester_id = $2
              AND attachment_id IS NULL
              AND expires_at > CURRENT_TIMESTAMP`,
          [upload.clientId, upload.requesterId],
        );
        const current = active.rows[0];
        if (
          (current?.active_count ?? 0) >=
          MAX_ACTIVE_UPLOAD_RESERVATIONS_PER_OWNER
        ) {
          throw new SelfHostedTicketingError(
            429,
            "RATE_LIMITED",
            "Too many active upload reservations",
            { retryAfter: String(current?.retry_after ?? 60) },
          );
        }
        await client.query(
          `INSERT INTO ticketing.uploads
            (id, client_id, requester_id, file_name, content_type, expected_size, object_key, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [upload.id, upload.clientId, upload.requesterId, upload.fileName, upload.contentType,
            upload.expectedSize, upload.objectKey, upload.expiresAt],
        );
      });
    } catch (error) {
      throw unavailable(error);
    }
  }

  async deleteUploadReservation(upload: StoredUpload): Promise<boolean> {
    try {
      const result = await this.pool.query<{ id: string }>(
        `DELETE FROM ticketing.uploads
          WHERE id = $1
            AND client_id = $2
            AND requester_id = $3
            AND object_key = $4
            AND attachment_id IS NULL
        RETURNING id`,
        [upload.id, upload.clientId, upload.requesterId, upload.objectKey],
      );
      return result.rows.length === 1;
    } catch (error) {
      throw unavailable(error);
    }
  }

  async listExpiredUploads(_now: Date, limit: number): Promise<StoredUpload[]> {
    try {
      const result = await this.pool.query<UploadRow>(
        `SELECT id, client_id, requester_id, file_name, content_type, expected_size,
                object_key, expires_at, attachment_id
           FROM ticketing.uploads
          WHERE attachment_id IS NULL
            AND expires_at <= CURRENT_TIMESTAMP
          ORDER BY expires_at ASC, id ASC
          LIMIT $1`,
        [Math.max(1, Math.min(100, Math.trunc(limit)))],
      );
      return result.rows.map(mapUpload);
    } catch (error) {
      throw unavailable(error);
    }
  }

  async deleteExpiredUpload(uploadId: string, _now: Date): Promise<boolean> {
    try {
      const result = await this.pool.query<{ id: string }>(
        `DELETE FROM ticketing.uploads
          WHERE id = $1
            AND attachment_id IS NULL
            AND expires_at <= CURRENT_TIMESTAMP
        RETURNING id`,
        [uploadId],
      );
      return result.rows.length === 1;
    } catch (error) {
      throw unavailable(error);
    }
  }

  async findClaimableUploads(
    principal: SelfHostedTicketingPrincipal,
    uploadIds: string[],
    _now: Date,
  ): Promise<StoredUpload[]> {
    if (uploadIds.length === 0) return [];
    try {
      const result = await this.pool.query<UploadRow>(
        `SELECT id, client_id, requester_id, file_name, content_type, expected_size,
                object_key, expires_at, attachment_id
           FROM ticketing.uploads
          WHERE id = ANY($1::text[])
            AND client_id = $2
            AND requester_id = $3
            AND attachment_id IS NULL
            AND expires_at > CURRENT_TIMESTAMP`,
        [uploadIds, principal.iss, principal.sub],
      );
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      const ordered = uploadIds.map((id) => byId.get(id));
      if (ordered.some((row) => !row)) {
        throw new SelfHostedTicketingError(
          422,
          "UPLOAD_NOT_READY",
          "One or more uploads are unavailable or incomplete",
        );
      }
      return (ordered as UploadRow[]).map(mapUpload);
    } catch (error) {
      throw unavailable(error);
    }
  }

  async findIdempotentResult(
    principal: SelfHostedTicketingPrincipal,
    operation: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotentResult | undefined> {
    try {
      const result = await this.pool.query<{
        request_fingerprint: string;
        result_type: "ticket" | "reply";
        result_id: string;
      }>(
        `SELECT request_fingerprint, result_type, result_id
           FROM ticketing.idempotency
          WHERE client_id = $1 AND requester_id = $2 AND operation = $3 AND idempotency_key = $4`,
        [principal.iss, principal.sub, operation, key],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      if (row.request_fingerprint !== fingerprint) {
        throw new SelfHostedTicketingError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This request key was already used for a different operation",
        );
      }
      return { kind: row.result_type, resultId: row.result_id };
    } catch (error) {
      throw unavailable(error);
    }
  }

  async listTickets(
    principal: SelfHostedTicketingPrincipal,
    input: TicketListInput,
  ): Promise<{ items: StoredTicketSummary[]; nextCursor: string | null }> {
    const cursor = decodeCursor(principal, input);
    const values: unknown[] = [principal.iss, principal.sub];
    const where = ["client_id = $1", "requester_id = $2"];
    if (input.status) {
      values.push(input.status);
      where.push(`status = $${values.length}`);
    }
    if (input.category) {
      values.push(input.category);
      where.push(`category = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.updatedAt, cursor.id);
      where.push(`(updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    values.push(input.limit + 1);
    try {
      const result = await this.pool.query<TicketRow>(
        `SELECT id, title, description, category, status, reply_count, attachment_count,
                created_at, updated_at, requester_id, reporter_name, reporter_email,
                source_system, module_name, page_url
           FROM ticketing.tickets
          WHERE ${where.join(" AND ")}
          ORDER BY updated_at DESC, id DESC
          LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > input.limit;
      const items = result.rows.slice(0, input.limit).map(mapSummary);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor(principal, input, last) : null,
      };
    } catch (error) {
      throw unavailable(error);
    }
  }

  async getTicket(
    principal: SelfHostedTicketingPrincipal,
    ticketId: string,
  ): Promise<StoredTicket | undefined> {
    try {
      return await loadTicket(this.pool, principal, ticketId);
    } catch (error) {
      throw unavailable(error);
    }
  }

  async createTicket(
    principal: SelfHostedTicketingPrincipal,
    input: CreateTicketInput,
    options: {
      idempotencyKey: string;
      fingerprint: string;
      now: Date;
      ticketId: string;
      attachmentIds: string[];
    },
  ): Promise<IdempotentResult> {
    const operation = "POST:/tickets";
    try {
      return await transaction(this.pool, async (client) => {
        const prior = await lockedIdempotency(
          client, principal, operation, options.idempotencyKey, options.fingerprint,
        );
        if (prior) return prior;
        const uploads = await lockedUploads(client, principal, input.uploadIds);
        await client.query(
          `INSERT INTO ticketing.tickets
            (id, client_id, requester_id, reporter_name, reporter_email, source_system,
             module_name, page_url, title, description, category, status, reply_count,
             attachment_count, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',0,$12,$13,$13)`,
          [options.ticketId, principal.iss, principal.sub, principal.name, principal.email ?? null,
            principal.sourceSystem, principal.moduleName ?? null, principal.pageUrl ?? null,
            input.title, input.description, input.category, uploads.length, options.now],
        );
        for (const [index, upload] of uploads.entries()) {
          const attachmentId = options.attachmentIds[index]!;
          await client.query(
            `INSERT INTO ticketing.attachments
              (id, upload_id, client_id, requester_id, target_type, target_id,
               file_name, content_type, size, object_key, created_at)
             VALUES ($1,$2,$3,$4,'ticket',$5,$6,$7,$8,$9,$10)`,
            [attachmentId, upload.id, principal.iss, principal.sub, options.ticketId,
              upload.file_name, upload.content_type, upload.expected_size, upload.object_key, options.now],
          );
          await client.query(
            `UPDATE ticketing.uploads SET attachment_id=$1, attached_to_type='ticket',
                    attached_to_id=$2, claimed_at=$3 WHERE id=$4`,
            [attachmentId, options.ticketId, options.now, upload.id],
          );
        }
        const result: IdempotentResult = { kind: "ticket", resultId: options.ticketId };
        await saveIdempotency(
          client, principal, operation, options.idempotencyKey, options.fingerprint, result,
        );
        return result;
      });
    } catch (error) {
      throw unavailable(error);
    }
  }

  async createReply(
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
  ): Promise<IdempotentResult> {
    const operation = `POST:/tickets/${ticketId}/replies`;
    try {
      return await transaction(this.pool, async (client) => {
        const prior = await lockedIdempotency(
          client, principal, operation, options.idempotencyKey, options.fingerprint,
        );
        if (prior) return prior;
        const owned = await client.query<{ id: string }>(
          `SELECT id FROM ticketing.tickets
            WHERE id=$1 AND client_id=$2 AND requester_id=$3 FOR UPDATE`,
          [ticketId, principal.iss, principal.sub],
        );
        if (!owned.rows[0]) {
          throw new SelfHostedTicketingError(404, "NOT_FOUND", "The requested ticket was not found");
        }
        const uploads = await lockedUploads(client, principal, input.uploadIds);
        await client.query(
          `INSERT INTO ticketing.replies
            (id, ticket_id, author_type, author_id, author_name, message, created_at)
           VALUES ($1,$2,'requester',$3,$4,$5,$6)`,
          [options.replyId, ticketId, principal.sub, principal.name, input.message, options.now],
        );
        for (const [index, upload] of uploads.entries()) {
          const attachmentId = options.attachmentIds[index]!;
          await client.query(
            `INSERT INTO ticketing.attachments
              (id, upload_id, client_id, requester_id, target_type, target_id,
               file_name, content_type, size, object_key, created_at)
             VALUES ($1,$2,$3,$4,'reply',$5,$6,$7,$8,$9,$10)`,
            [attachmentId, upload.id, principal.iss, principal.sub, options.replyId,
              upload.file_name, upload.content_type, upload.expected_size, upload.object_key, options.now],
          );
          await client.query(
            `UPDATE ticketing.uploads SET attachment_id=$1, attached_to_type='reply',
                    attached_to_id=$2, claimed_at=$3 WHERE id=$4`,
            [attachmentId, options.replyId, options.now, upload.id],
          );
        }
        await client.query(
          `UPDATE ticketing.tickets
              SET reply_count=reply_count+1, attachment_count=attachment_count+$1, updated_at=$2
            WHERE id=$3 AND client_id=$4 AND requester_id=$5`,
          [uploads.length, options.now, ticketId, principal.iss, principal.sub],
        );
        const result: IdempotentResult = { kind: "reply", resultId: options.replyId };
        await saveIdempotency(
          client, principal, operation, options.idempotencyKey, options.fingerprint, result,
        );
        return result;
      });
    } catch (error) {
      throw unavailable(error);
    }
  }
}
