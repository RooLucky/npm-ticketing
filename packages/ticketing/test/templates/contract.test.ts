import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function template(path: string): Promise<string> {
  return readFile(new URL(`../../templates/files/${path}`, import.meta.url), "utf8");
}

describe("generated v1 contract", () => {
  it("keeps generated validators aligned with the canonical OpenAPI limits", async () => {
    const [schemas, proxy, session, component, config, openapi] = await Promise.all([
      template("lib/ticketing/schemas.ts.template"),
      template("lib/ticketing/proxy.ts.template"),
      template("lib/ticketing/session.ts.template"),
      template("components/ticketing/Ticketing.tsx.template"),
      template("lib/ticketing/config.ts.template"),
      readFile(
        new URL("../../../../contracts/openapi/ticketing-v1.yaml", import.meta.url),
        "utf8",
      ),
    ]);

    expect(schemas).toContain(".max(100).default(20)");
    expect(schemas).toContain("/^tkt_[A-Za-z0-9_-]+$/");
    expect(proxy).toContain("/^[A-Za-z0-9._~:-]{8,255}$/");
    expect(session).toContain("pageUrl: TicketingPageUrlSchema.optional()");
    expect(component).toContain("TicketingPageUrlSchema.parse(pageUrl)");
    expect(schemas).toContain("uploadUrl: TicketingPrivateUrlSchema");
    expect(schemas).toContain("downloadUrl: TicketingPrivateUrlSchema");
    expect(config).toContain("secret !== TICKETING_SECRET_PLACEHOLDER");
    expect(config).toContain('"replace-with-at-least-32-random-bytes"');

    expect(openapi).toContain("maxLength: 255");
    expect(openapi).toContain("^tkt_[A-Za-z0-9_-]+$");
    expect(openapi).toContain("#/components/schemas/PageUrl");
    expect(openapi).toContain("#/components/schemas/PrivateTransferUrl");
  });

  it("maps canonical upstream statuses without forwarding upstream messages", async () => {
    const proxy = await template("lib/ticketing/proxy.ts.template");

    expect(proxy).toContain('response.status === 400');
    expect(proxy).toContain('"VALIDATION_ERROR"');
    expect(proxy).toContain('response.status === 403');
    expect(proxy).toContain('"FORBIDDEN"');
    expect(proxy).toContain('response.status === 409');
    expect(proxy).toContain('"IDEMPOTENCY_CONFLICT"');
    expect(proxy).toContain('response.status === 413');
    expect(proxy).toContain('"FILE_TOO_LARGE"');
    expect(proxy).toContain('response.status === 422');
    expect(proxy).toContain('"UPLOAD_NOT_READY"');
    expect(proxy).not.toContain("parsedError.data.error.message");
  });
});
