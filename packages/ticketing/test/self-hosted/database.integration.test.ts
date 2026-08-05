import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_UPLOAD_RESERVATIONS_PER_OWNER,
  PostgresTicketingRepository,
} from "../../src/self-hosted/database.js";
import { SelfHostedTicketingError } from "../../src/self-hosted/errors.js";
import {
  migrateTicketingDatabase,
  TICKETING_SCHEMA_VERSION,
} from "../../src/self-hosted/migrations.js";
import type {
  SelfHostedTicketingPrincipal,
  StoredUpload,
} from "../../src/self-hosted/types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_TICKETING_URL ?? "";
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const PAST = new Date("2000-01-01T00:00:00.000Z");

const ownerA: SelfHostedTicketingPrincipal = {
  iss: "integration-client-a",
  sub: "requester-a",
  name: "Requester A",
  email: "requester-a@example.test",
  sourceSystem: "integration",
  moduleName: "database",
  pageUrl: "/integration/a",
  scopes: ["tickets:read", "tickets:create", "tickets:reply", "uploads:create"],
};

const ownerB: SelfHostedTicketingPrincipal = {
  ...ownerA,
  iss: "integration-client-b",
  sub: "requester-b",
  name: "Requester B",
  email: "requester-b@example.test",
  pageUrl: "/integration/b",
};

function storedUpload(
  id: string,
  owner: SelfHostedTicketingPrincipal,
  expiresAt = FUTURE,
): StoredUpload {
  return {
    id,
    clientId: owner.iss,
    requesterId: owner.sub,
    fileName: `${id}.png`,
    contentType: "image/png",
    expectedSize: 128,
    objectKey: `integration/${owner.iss}/${owner.sub}/${id}`,
    expiresAt,
  };
}

async function insertTicket(
  repository: PostgresTicketingRepository,
  owner: SelfHostedTicketingPrincipal,
  suffix: string,
) {
  return repository.createTicket(
    owner,
    {
      title: `Integration ticket ${suffix}`,
      description: "Created by the real PostgreSQL integration test.",
      category: "bug",
      uploadIds: [],
    },
    {
      idempotencyKey: `ticket-key-${suffix}`,
      fingerprint: "a".repeat(64),
      now: new Date("2026-08-05T07:00:00.000Z"),
      ticketId: `tkt_${suffix}`,
      attachmentIds: [],
    },
  );
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL ticketing integration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA IF EXISTS ticketing CASCADE");
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DROP SCHEMA IF EXISTS ticketing CASCADE");
    await pool.end();
  });

  it(
    "serializes concurrent migration attempts and records one immutable checksum",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL }),
        ),
      );
      expect(results).toEqual(
        Array.from({ length: 6 }, () => ({ version: TICKETING_SCHEMA_VERSION })),
      );

      const history = await pool.query<{
        version: number;
        checksum: string;
      }>(
        "SELECT version, checksum::text AS checksum FROM ticketing.schema_migrations",
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({ version: 1 });
      expect(history.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    },
    30_000,
  );

  it("rejects altered checksums in both the migrator and runtime repository", async () => {
    await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
    await pool.query(
      "UPDATE ticketing.schema_migrations SET checksum = $1 WHERE version = 1",
      ["0".repeat(64)],
    );

    await expect(
      migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL }),
    ).rejects.toMatchObject({
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
      message: expect.stringContaining("checksum"),
    });
    await expect(
      new PostgresTicketingRepository(pool).assertMigrated(),
    ).rejects.toMatchObject({
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
      message: expect.stringContaining("checksum"),
    });
  });

  it("refuses a database migration history newer than the installed package", async () => {
    await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
    await pool.query(
      `INSERT INTO ticketing.schema_migrations(version, checksum)
       VALUES (2, $1)`,
      ["0".repeat(64)],
    );

    await expect(
      migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL }),
    ).rejects.toMatchObject({
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
      message: expect.stringContaining("newer"),
    });
    await expect(
      new PostgresTicketingRepository(pool).assertMigrated(),
    ).rejects.toMatchObject({
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
      message: expect.stringContaining("newer"),
    });
  });

  it("does not stamp a pre-existing drifted ticketing table as migrated", async () => {
    await pool.query("CREATE SCHEMA ticketing");
    await pool.query("CREATE TABLE ticketing.tickets (id integer PRIMARY KEY)");

    await expect(
      migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL }),
    ).rejects.toMatchObject({
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
      message: expect.stringContaining("unmanaged"),
    });

    const relations = await pool.query<{
      tickets: string | null;
      migrations: string | null;
    }>(
      `SELECT to_regclass('ticketing.tickets')::text AS tickets,
              to_regclass('ticketing.schema_migrations')::text AS migrations`,
    );
    expect(relations.rows[0]).toEqual({
      tickets: "ticketing.tickets",
      migrations: null,
    });
  });

  it("isolates tickets and attachments by both client and requester", async () => {
    await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
    const repository = new PostgresTicketingRepository(pool);
    await repository.assertMigrated();
    await insertTicket(repository, ownerA, "owner_a");
    await insertTicket(repository, ownerB, "owner_b");

    await repository.createReply(
      ownerA,
      "tkt_owner_a",
      { message: "Owner A reply", uploadIds: [] },
      {
        idempotencyKey: "reply-key-owner-a",
        fingerprint: "b".repeat(64),
        now: new Date("2026-08-05T07:01:00.000Z"),
        replyId: "rpl_owner_a",
        attachmentIds: [],
      },
    );

    const ticketUpload = storedUpload("upl_cross_ticket", ownerB);
    const replyUpload = storedUpload("upl_cross_reply", ownerB);
    await repository.createUpload(ticketUpload);
    await repository.createUpload(replyUpload);
    await pool.query(
      `INSERT INTO ticketing.attachments
        (id, upload_id, client_id, requester_id, target_type, target_id,
         file_name, content_type, size, object_key, created_at)
       VALUES
        ('att_cross_ticket', $1, $3, $4, 'ticket', 'tkt_owner_a', $5, $6, $7, $8, now()),
        ('att_cross_reply', $2, $3, $4, 'reply', 'rpl_owner_a', $9, $10, $11, $12, now())`,
      [
        ticketUpload.id,
        replyUpload.id,
        ownerB.iss,
        ownerB.sub,
        ticketUpload.fileName,
        ticketUpload.contentType,
        ticketUpload.expectedSize,
        ticketUpload.objectKey,
        replyUpload.fileName,
        replyUpload.contentType,
        replyUpload.expectedSize,
        replyUpload.objectKey,
      ],
    );

    await expect(repository.getTicket(ownerB, "tkt_owner_a")).resolves.toBeUndefined();
    const ownerATicket = await repository.getTicket(ownerA, "tkt_owner_a");
    expect(ownerATicket?.attachments).toEqual([]);
    expect(ownerATicket?.replies[0]?.attachments).toEqual([]);

    const ownerAList = await repository.listTickets(ownerA, { limit: 20 });
    expect(ownerAList.items.map(({ id }) => id)).toEqual(["tkt_owner_a"]);
  });

  it("returns one durable result when identical idempotent writes race", async () => {
    await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
    const repository = new PostgresTicketingRepository(pool);
    const options = {
      idempotencyKey: "concurrent-idempotency-key",
      fingerprint: "c".repeat(64),
      now: new Date("2026-08-05T08:00:00.000Z"),
      ticketId: "tkt_idempotency_race",
      attachmentIds: [],
    };
    const input = {
      title: "Idempotency race",
      description: "Concurrent retries must have one durable effect.",
      category: "request" as const,
      uploadIds: [],
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.createTicket(ownerA, input, options),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({
        kind: "ticket",
        resultId: "tkt_idempotency_race",
      })),
    );
    const counts = await pool.query<{ tickets: number; keys: number }>(
      `SELECT
        (SELECT count(*)::integer FROM ticketing.tickets) AS tickets,
        (SELECT count(*)::integer FROM ticketing.idempotency) AS keys`,
    );
    expect(counts.rows[0]).toEqual({ tickets: 1, keys: 1 });
  });

  it("rechecks upload expiration in PostgreSQL when claiming it", async () => {
    await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
    const repository = new PostgresTicketingRepository(pool);
    const expired = storedUpload("upl_expired_during_verification", ownerA, PAST);
    await repository.createUpload(expired);

    await expect(
      repository.createTicket(
        ownerA,
        {
          title: "Expired upload",
          description: "The reservation expired after object verification.",
          category: "bug",
          uploadIds: [expired.id],
        },
        {
          idempotencyKey: "expired-upload-key",
          fingerprint: "d".repeat(64),
          now: new Date("1999-01-01T00:00:00.000Z"),
          ticketId: "tkt_expired_upload",
          attachmentIds: ["att_expired_upload"],
        },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "UPLOAD_NOT_READY",
    });
  });

  it("lists and deletes only expired unclaimed upload reservations", async () => {
    await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
    const repository = new PostgresTicketingRepository(pool);
    const expired = storedUpload("upl_cleanup_expired", ownerA, PAST);
    const active = storedUpload("upl_cleanup_active", ownerA);
    const claimed = storedUpload("upl_cleanup_claimed", ownerA);
    await repository.createUpload(expired);
    await repository.createUpload(active);
    await repository.createUpload(claimed);
    await repository.createTicket(
      ownerA,
      {
        title: "Claimed upload",
        description: "A claimed object must never be selected for orphan cleanup.",
        category: "bug",
        uploadIds: [claimed.id],
      },
      {
        idempotencyKey: "cleanup-claimed-key",
        fingerprint: "e".repeat(64),
        now: new Date("2026-08-05T09:00:00.000Z"),
        ticketId: "tkt_cleanup_claimed",
        attachmentIds: ["att_cleanup_claimed"],
      },
    );
    await pool.query(
      "UPDATE ticketing.uploads SET expires_at = $1 WHERE id = $2",
      [PAST, claimed.id],
    );

    const listed = await repository.listExpiredUploads(FUTURE, 20);
    expect(listed.map(({ id }) => id)).toEqual([expired.id]);
    await expect(
      repository.deleteUploadReservation(claimed),
    ).resolves.toBe(false);
    await expect(
      repository.deleteUploadReservation(active),
    ).resolves.toBe(true);
    await expect(
      repository.deleteUploadReservation(active),
    ).resolves.toBe(false);
    await expect(
      repository.deleteExpiredUpload(active.id, FUTURE),
    ).resolves.toBe(false);
    await expect(
      repository.deleteExpiredUpload(claimed.id, FUTURE),
    ).resolves.toBe(false);
    await expect(
      repository.deleteExpiredUpload(expired.id, FUTURE),
    ).resolves.toBe(true);
    await expect(
      repository.deleteExpiredUpload(expired.id, FUTURE),
    ).resolves.toBe(false);
  });

  it(
    "enforces the active upload reservation cap under concurrent requests",
    async () => {
      await migrateTicketingDatabase({ databaseUrl: TEST_DATABASE_URL });
      const repository = new PostgresTicketingRepository(pool);
      const attempts = await Promise.allSettled(
        Array.from(
          { length: MAX_ACTIVE_UPLOAD_RESERVATIONS_PER_OWNER + 1 },
          (_, index) =>
            repository.createUpload(
              storedUpload(`upl_reservation_${index}`, ownerA),
            ),
        ),
      );

      expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(
        MAX_ACTIVE_UPLOAD_RESERVATIONS_PER_OWNER,
      );
      const rejected = attempts.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          status: 429,
          code: "RATE_LIMITED",
        }),
      });
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(SelfHostedTicketingError);
      }
    },
    30_000,
  );
});
