import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function template(path: string): Promise<string> {
  return readFile(new URL(`../../templates/files/${path}`, import.meta.url), "utf8");
}

describe("generated backend modes", () => {
  it("verifies sessions without forwarding derived claims through the backend seam", async () => {
    const [proxy, connected] = await Promise.all([
      template("lib/ticketing/proxy.ts.template"),
      template("lib/ticketing/backend.connected.ts.template"),
    ]);

    expect(proxy).toContain("await verifyTicketingSession(token)");
    expect(proxy).toContain("requestTicketingBackend({");
    expect(proxy).not.toContain("claims,");
    expect(proxy).toContain('"Ticketing is not configured correctly"');
    expect(proxy).not.toContain("requestCentralApi({");
    expect(connected).toContain("requestCentralApi({");
    expect(connected).toContain("sessionToken: input.sessionToken");
    expect(connected).not.toContain("TicketingSessionClaims");
    expect(connected).not.toContain("claims:");
    expect(connected).not.toContain("@quanby/ticketing/self-hosted");
  });

  it("keeps self-hosted storage configuration server-only and explicit", async () => {
    const [backend, config] = await Promise.all([
      template("lib/ticketing/backend.self-hosted.ts.template"),
      template("lib/ticketing/config.self-hosted.ts.template"),
    ]);

    expect(backend).toContain('import "server-only"');
    expect(backend).toContain('from "@quanby/ticketing/self-hosted"');
    expect(backend).toContain("executeSelfHostedTicketingRequest({");
    expect(backend).toContain("clientId,");
    expect(backend).toContain("clientSecret,");
    expect(backend).toContain("sessionToken: input.sessionToken");
    expect(backend).not.toContain("principal:");
    expect(backend).not.toContain("TicketingSessionClaims");
    expect(backend).toContain("databaseUrl,");
    expect(backend).toContain("secretAccessKey: storage.secretAccessKey");
    expect(backend).toContain('"X-Request-Id": error.requestId');
    expect(backend).not.toContain("process.env");
    expect(backend).not.toContain("error.cause");

    expect(config).toContain('import "server-only"');
    expect(config).toContain("DATABASE_TICKETING_URL");
    expect(config).toContain("REDIS_TICKETING_URL");
    expect(config).toContain("AWS_ACCESS_KEY_ID");
    expect(config).toContain("AWS_SECRET_ACCESS_KEY");
    expect(config).toContain("AWS_REGION");
    expect(config).toContain("S3_BUCKET_NAME");
    expect(config).toContain("STORAGE_SECRET_ACCESS_KEY");
    expect(config).toContain("endpoint?: string");
    expect(config).toContain("parsed.data.STORAGE_REGION ?? parsed.data.AWS_REGION");
    expect(config).toContain("parsed.data.STORAGE_BUCKET ?? parsed.data.S3_BUCKET_NAME");
    expect(config).toContain(
      "parsed.data.STORAGE_ACCESS_KEY_ID ?? parsed.data.AWS_ACCESS_KEY_ID",
    );
    expect(config).toContain(
      "parsed.data.STORAGE_SECRET_ACCESS_KEY ?? parsed.data.AWS_SECRET_ACCESS_KEY",
    );
    expect(config).toContain("storageEndpointValue ? { endpoint: storageEndpointValue }");
    expect(backend).toContain("storage.endpoint ? { endpoint: storage.endpoint }");
    expect(config).not.toContain("TICKETING_API_URL");
  });
});
