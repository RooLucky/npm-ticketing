import { createHash } from "node:crypto";
import { createClient } from "redis";

import { SelfHostedTicketingError } from "./errors.js";
import type { TicketingRateLimiter } from "./types.js";

type TicketingRedisClient = {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  on(event: "error", listener: (error: Error) => void): unknown;
  withCommandOptions(options: { timeout: number }): Pick<TicketingRedisClient, "eval">;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

const clients = new Map<string, TicketingRedisClient>();

function clientFor(redisUrl: string): TicketingRedisClient {
  const key = createHash("sha256").update(redisUrl).digest("hex");
  const existing = clients.get(key);
  if (existing) return existing;
  const client: TicketingRedisClient = createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1_000,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: false,
    },
  });
  client.on("error", () => undefined);
  clients.set(key, client);
  return client;
}

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export class RedisTicketingRateLimiter implements TicketingRateLimiter {
  private readonly client: TicketingRedisClient;
  private connecting: Promise<unknown> | undefined;

  constructor(redisUrl: string) {
    this.client = clientFor(redisUrl);
  }

  private async connect(): Promise<void> {
    if (this.client.isOpen) return;
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      await this.connect();
      const count = await this.client.withCommandOptions({ timeout: 10_000 }).eval(
        FIXED_WINDOW_SCRIPT,
        {
        keys: [key],
        arguments: [String(windowSeconds)],
        },
      );
      return Number(count) <= limit;
    } catch (error) {
      throw new SelfHostedTicketingError(
        503,
        "UPSTREAM_UNAVAILABLE",
        "Ticketing rate limiting is unavailable",
        { cause: error },
      );
    }
  }
}
