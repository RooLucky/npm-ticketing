import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { SelfHostedTicketingError } from "./errors.js";
import { ticketingPostgresConnectionOptions } from "./schemas.js";

export const TICKETING_SCHEMA_VERSION = 1;

export const TICKETING_DATABASE_TIMEOUTS = {
  statementMilliseconds: 15_000,
  lockMilliseconds: 5_000,
  idleTransactionMilliseconds: 30_000,
  queryMilliseconds: 20_000,
} as const;

const MIGRATION_ONE_STATEMENTS = [
  `CREATE TABLE ticketing.tickets (
    id text PRIMARY KEY,
    client_id varchar(128) NOT NULL,
    requester_id varchar(256) NOT NULL,
    reporter_name varchar(256) NOT NULL,
    reporter_email text,
    source_system varchar(128) NOT NULL,
    module_name varchar(128),
    page_url text,
    title varchar(160) NOT NULL,
    description text NOT NULL,
    category varchar(32) NOT NULL CHECK (category IN ('bug', 'request', 'question')),
    status varchar(32) NOT NULL CHECK (status IN ('open', 'in_progress', 'waiting_for_user', 'resolved', 'closed')),
    reply_count integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
    attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX tickets_owner_updated_idx
    ON ticketing.tickets (client_id, requester_id, updated_at DESC, id DESC)`,
  `CREATE TABLE ticketing.replies (
    id text PRIMARY KEY,
    ticket_id text NOT NULL REFERENCES ticketing.tickets(id) ON DELETE CASCADE,
    author_type varchar(16) NOT NULL CHECK (author_type IN ('requester', 'agent')),
    author_id varchar(256) NOT NULL,
    author_name varchar(256) NOT NULL,
    message text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX replies_ticket_created_idx
    ON ticketing.replies (ticket_id, created_at ASC, id ASC)`,
  `CREATE TABLE ticketing.uploads (
    id text PRIMARY KEY,
    client_id varchar(128) NOT NULL,
    requester_id varchar(256) NOT NULL,
    file_name varchar(255) NOT NULL,
    content_type varchar(64) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    expected_size integer NOT NULL CHECK (expected_size BETWEEN 1 AND 10485760),
    object_key text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    attachment_id text UNIQUE,
    attached_to_type varchar(16) CHECK (attached_to_type IN ('ticket', 'reply')),
    attached_to_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    CHECK (
      (attachment_id IS NULL AND attached_to_type IS NULL AND attached_to_id IS NULL AND claimed_at IS NULL)
      OR
      (attachment_id IS NOT NULL AND attached_to_type IS NOT NULL AND attached_to_id IS NOT NULL AND claimed_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX uploads_owner_expiry_idx
    ON ticketing.uploads (client_id, requester_id, expires_at)`,
  `CREATE INDEX uploads_unclaimed_expiry_idx
    ON ticketing.uploads (expires_at, id) WHERE attachment_id IS NULL`,
  `CREATE TABLE ticketing.attachments (
    id text PRIMARY KEY,
    upload_id text NOT NULL UNIQUE REFERENCES ticketing.uploads(id),
    client_id varchar(128) NOT NULL,
    requester_id varchar(256) NOT NULL,
    target_type varchar(16) NOT NULL CHECK (target_type IN ('ticket', 'reply')),
    target_id text NOT NULL,
    file_name varchar(255) NOT NULL,
    content_type varchar(64) NOT NULL,
    size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
    object_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX attachments_target_idx
    ON ticketing.attachments (target_type, target_id, created_at ASC, id ASC)`,
  `CREATE TABLE ticketing.idempotency (
    client_id varchar(128) NOT NULL,
    requester_id varchar(256) NOT NULL,
    operation text NOT NULL,
    idempotency_key varchar(255) NOT NULL,
    request_fingerprint char(64) NOT NULL,
    result_type varchar(16) NOT NULL CHECK (result_type IN ('ticket', 'reply')),
    result_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, requester_id, operation, idempotency_key)
  )`,
] as const;

type MigrationDefinition = {
  version: number;
  checksum: string;
  statements: readonly string[];
};

// This literal is deliberately pinned. Editing an already released migration's SQL
// without also creating a new migration fails the definition integrity check.
const MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    checksum: "e4ad8b6ed8403ddf7196a39d79029b20332b35ff3783ee0ea3095e253746e736",
    statements: MIGRATION_ONE_STATEMENTS,
  },
] as const;

const MANAGED_RELATIONS = [
  "tickets",
  "replies",
  "uploads",
  "attachments",
  "idempotency",
] as const;

type AppliedMigrationRow = {
  version: number;
  checksum: string;
};

function calculateChecksum(statements: readonly string[]): string {
  return createHash("sha256").update(statements.join(";\n")).digest("hex");
}

function assertMigrationDefinitions(): void {
  for (const [index, migration] of MIGRATIONS.entries()) {
    if (migration.version !== index + 1) {
      throw new SelfHostedTicketingError(
        500,
        "INTERNAL_ERROR",
        "Ticketing migration definitions must be contiguous",
      );
    }
    if (calculateChecksum(migration.statements) !== migration.checksum) {
      throw new SelfHostedTicketingError(
        500,
        "INTERNAL_ERROR",
        `Ticketing migration ${migration.version} failed its definition integrity check`,
      );
    }
  }
  if (MIGRATIONS.at(-1)?.version !== TICKETING_SCHEMA_VERSION) {
    throw new SelfHostedTicketingError(
      500,
      "INTERNAL_ERROR",
      "The ticketing schema version does not match its migration definitions",
    );
  }
}

function incompatible(message: string): SelfHostedTicketingError {
  return new SelfHostedTicketingError(503, "UPSTREAM_UNAVAILABLE", message);
}

export function validateAppliedTicketingMigrations(
  rows: readonly AppliedMigrationRow[],
  options: { requireCurrent: boolean },
): number {
  assertMigrationDefinitions();
  const ordered = [...rows].sort((left, right) => left.version - right.version);
  let current = 0;

  for (const row of ordered) {
    const expected = MIGRATIONS[current];
    if (!expected) {
      throw incompatible(
        "The ticketing database schema is newer than this package version",
      );
    }
    if (row.version !== expected.version) {
      throw incompatible("The ticketing database migration history is invalid");
    }
    if (row.checksum !== expected.checksum) {
      throw incompatible(
        `Ticketing database migration ${row.version} failed its checksum validation`,
      );
    }
    current += 1;
  }

  if (options.requireCurrent && current !== MIGRATIONS.length) {
    throw incompatible("The ticketing database schema is out of date");
  }
  return current;
}

async function configureTransactionTimeouts(client: PoolClient): Promise<void> {
  await client.query(
    `SET LOCAL statement_timeout = '${TICKETING_DATABASE_TIMEOUTS.statementMilliseconds}ms'`,
  );
  await client.query(
    `SET LOCAL lock_timeout = '${TICKETING_DATABASE_TIMEOUTS.lockMilliseconds}ms'`,
  );
  await client.query(
    `SET LOCAL idle_in_transaction_session_timeout = '${TICKETING_DATABASE_TIMEOUTS.idleTransactionMilliseconds}ms'`,
  );
}

async function createMigrationTableIfMissing(client: PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('ticketing.schema_migrations')::text AS table_name",
  );
  if (result.rows[0]?.table_name) return;
  await client.query(`CREATE TABLE ticketing.schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function assertNoUnmanagedMigrationOneRelations(
  client: PoolClient,
): Promise<void> {
  const result = await client.query<{ relation_name: string }>(
    `SELECT c.relname AS relation_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ticketing'
        AND c.relname = ANY($1::text[])`,
    [MANAGED_RELATIONS],
  );
  if (result.rows.length > 0) {
    throw incompatible(
      "The ticketing schema contains unmanaged tables; migration was refused",
    );
  }
}

export type MigrateTicketingDatabaseInput = {
  databaseUrl: string;
};

export async function migrateTicketingDatabase(
  input: MigrateTicketingDatabaseInput,
): Promise<{ version: number }> {
  assertMigrationDefinitions();
  const connection = ticketingPostgresConnectionOptions(input.databaseUrl);
  const pool = new Pool({
    ...connection,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: TICKETING_DATABASE_TIMEOUTS.statementMilliseconds,
    lock_timeout: TICKETING_DATABASE_TIMEOUTS.lockMilliseconds,
    idle_in_transaction_session_timeout:
      TICKETING_DATABASE_TIMEOUTS.idleTransactionMilliseconds,
    query_timeout: TICKETING_DATABASE_TIMEOUTS.queryMilliseconds,
    allowExitOnIdle: true,
  });
  let client: PoolClient | undefined;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await configureTransactionTimeouts(client);
    await client.query("SELECT pg_advisory_xact_lock($1)", [742_133_021]);
    await client.query("CREATE SCHEMA IF NOT EXISTS ticketing");
    await createMigrationTableIfMissing(client);
    const appliedResult = await client.query<AppliedMigrationRow>(
      `SELECT version, checksum::text AS checksum
         FROM ticketing.schema_migrations
        ORDER BY version ASC`,
    );
    const appliedCount = validateAppliedTicketingMigrations(appliedResult.rows, {
      requireCurrent: false,
    });

    for (const migration of MIGRATIONS.slice(appliedCount)) {
      if (migration.version === 1) {
        await assertNoUnmanagedMigrationOneRelations(client);
      }
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO ticketing.schema_migrations(version, checksum)
         VALUES ($1, $2)`,
        [migration.version, migration.checksum],
      );
    }

    await client.query("COMMIT");
    return { version: TICKETING_SCHEMA_VERSION };
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SelfHostedTicketingError) throw error;
    throw new SelfHostedTicketingError(
      503,
      "UPSTREAM_UNAVAILABLE",
      client
        ? "The ticketing database migration failed"
        : "The ticketing database is unavailable",
      { cause: error },
    );
  } finally {
    client?.release();
    await pool.end();
  }
}
