import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const originalEnvironment = { ...process.env };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env = { ...originalEnvironment };
});

describe("generated server-only API client", () => {
  it("rejects the documented client-secret placeholder", async () => {
    process.env.TICKETING_API_URL = "https://support.example.test/api/v1";
    process.env.TICKETING_CLIENT_ID = "test-client";
    process.env.TICKETING_CLIENT_SECRET = "replace-with-at-least-32-random-bytes";
    const { getTicketingConfig } = await import("@/lib/ticketing/config");

    expect(() => getTicketingConfig()).toThrow("Invalid ticketing configuration");
  });

  it("aborts and normalizes an upstream timeout", async () => {
    vi.useFakeTimers();
    process.env.TICKETING_API_URL = "https://support.example.test/api/v1";
    process.env.TICKETING_CLIENT_ID = "test-client";
    process.env.TICKETING_CLIENT_SECRET = "a-valid-test-secret-with-more-than-32-bytes";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      ),
    );
    const { requestCentralApi } = await import("@/lib/ticketing/central-api");

    const request = requestCentralApi({
      path: "tickets",
      method: "GET",
      sessionToken: "test-session",
    });
    const rejection = expect(request).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });
});
