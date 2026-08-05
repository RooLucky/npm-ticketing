import { createHash } from "node:crypto";

import { PostgresTicketingRepository, poolForTicketingDatabase } from "./database.js";
import { RedisTicketingRateLimiter } from "./rate-limit.js";
import { SelfHostedConfigSchema } from "./schemas.js";
import { verifySelfHostedTicketingSession } from "./session.js";
import { createSelfHostedTicketingRuntime } from "./service.js";
import { S3TicketingStorage } from "./storage.js";
import type {
  CleanupSelfHostedTicketingUploadsInput,
  ExecuteSelfHostedTicketingRequestInput,
  SelfHostedTicketingConfig,
} from "./types.js";

const runtimes = new Map<string, ReturnType<typeof createSelfHostedTicketingRuntime>>();

function runtimeKey(config: SelfHostedTicketingConfig): string {
  return createHash("sha256").update(JSON.stringify({
    databaseUrl: config.databaseUrl,
    ...(config.redisUrl ? { redisUrl: config.redisUrl } : {}),
    storage: config.storage,
  })).digest("hex");
}

function runtimeFor(config: SelfHostedTicketingConfig) {
  const key = runtimeKey(config);
  const existing = runtimes.get(key);
  if (existing) return existing;
  const runtime = createSelfHostedTicketingRuntime({
    repository: new PostgresTicketingRepository(poolForTicketingDatabase(config.databaseUrl)),
    storage: new S3TicketingStorage(config.storage),
    ...(config.redisUrl
      ? { rateLimiter: new RedisTicketingRateLimiter(config.redisUrl) }
      : {}),
  });
  runtimes.set(key, runtime);
  return runtime;
}

export async function executeSelfHostedTicketingRequest(
  input: ExecuteSelfHostedTicketingRequestInput,
): Promise<Response> {
  const config = SelfHostedConfigSchema.parse(input.config) as SelfHostedTicketingConfig;
  const principal = await verifySelfHostedTicketingSession(input.sessionToken, config);
  return runtimeFor(config).execute(principal, input.operation);
}

export async function cleanupSelfHostedTicketingUploads(
  input: CleanupSelfHostedTicketingUploadsInput,
): Promise<{ deleted: number }> {
  const config = SelfHostedConfigSchema.parse(input.config) as SelfHostedTicketingConfig;
  const deleted = await runtimeFor(config).cleanupExpiredUploads(input.limit);
  return { deleted };
}

export { SelfHostedTicketingError } from "./errors.js";
export {
  assertTicketingDatabaseUrl,
  TicketingDatabaseUrlSchema,
  TicketingRedisUrlSchema,
} from "./schemas.js";
export {
  migrateTicketingDatabase,
  TICKETING_SCHEMA_VERSION,
} from "./migrations.js";
export type * from "./types.js";
