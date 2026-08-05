import { buildMockApi } from "./server.js";

const host = process.env.MOCK_API_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MOCK_API_PORT ?? "4010", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("MOCK_API_PORT must be an integer between 1 and 65535.");
}

const app = await buildMockApi({
  ...(process.env.MOCK_API_PUBLIC_URL
    ? { publicBaseUrl: process.env.MOCK_API_PUBLIC_URL }
    : {}),
  corsOrigin: process.env.MOCK_API_CORS_ORIGIN ?? true,
  // Signed mock upload/download tokens are query parameters; avoid logging URLs.
  logger: false,
});

const close = async () => {
  await app.close();
  process.exit(0);
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

await app.listen({ host, port });
