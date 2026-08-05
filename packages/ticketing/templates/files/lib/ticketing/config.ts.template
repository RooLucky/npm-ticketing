import "server-only";

import { z } from "zod";

const TICKETING_SECRET_PLACEHOLDER = "replace-with-at-least-32-random-bytes";

const ConfigSchema = z.object({
  TICKETING_API_URL: z.url(),
  TICKETING_CLIENT_ID: z.string().trim().min(1).max(128),
  TICKETING_CLIENT_SECRET: z
    .string()
    .refine(
      (secret) => secret !== TICKETING_SECRET_PLACEHOLDER,
      "TICKETING_CLIENT_SECRET must replace the documented placeholder",
    )
    .refine(
      (secret) => new TextEncoder().encode(secret).byteLength >= 32,
      "TICKETING_CLIENT_SECRET must contain at least 32 bytes",
    ),
});

export type TicketingConfig = {
  apiUrl: URL;
  clientId: string;
  clientSecret: Uint8Array;
};

let cachedConfig: TicketingConfig | undefined;

function isLocalhost(url: URL) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function getTicketingConfig(): TicketingConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid ticketing configuration: ${missing}`);
  }

  const apiUrl = new URL(parsed.data.TICKETING_API_URL);
  if (apiUrl.protocol !== "https:" && !isLocalhost(apiUrl)) {
    throw new Error("TICKETING_API_URL must use HTTPS outside localhost");
  }

  if (!apiUrl.pathname.endsWith("/")) apiUrl.pathname += "/";

  cachedConfig = {
    apiUrl,
    clientId: parsed.data.TICKETING_CLIENT_ID,
    clientSecret: new TextEncoder().encode(parsed.data.TICKETING_CLIENT_SECRET),
  };
  return cachedConfig;
}
