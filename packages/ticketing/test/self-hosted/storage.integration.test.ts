import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SelfHostedTicketingError } from "../../src/self-hosted/errors.js";
import { S3TicketingStorage } from "../../src/self-hosted/storage.js";
import type {
  SelfHostedTicketingConfig,
  StoredUpload,
} from "../../src/self-hosted/types.js";

function testStorageConfig(): SelfHostedTicketingConfig["storage"] | undefined {
  const endpoint = process.env.TEST_TICKETING_STORAGE_ENDPOINT;
  const bucket = process.env.TEST_TICKETING_STORAGE_BUCKET;
  const accessKeyId = process.env.TEST_TICKETING_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TEST_TICKETING_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;

  return {
    endpoint,
    region: process.env.TEST_TICKETING_STORAGE_REGION ?? "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.TEST_TICKETING_STORAGE_FORCE_PATH_STYLE === "true",
  };
}

function integrationUpload(expectedSize: number): StoredUpload {
  const id = `upl_integration_${randomUUID()}`;
  return {
    id,
    clientId: "integration-client",
    requesterId: "integration-user",
    fileName: "integration.png",
    contentType: "image/png",
    expectedSize,
    objectKey: `ticketing/integration-tests/uploads/${id}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
  };
}

async function putFile(
  signed: Awaited<ReturnType<S3TicketingStorage["presignUpload"]>>,
  contentType: string,
  body: string,
): Promise<Response> {
  return fetch(signed.uploadUrl, {
    method: "PUT",
    headers: signed.headers,
    body: new Blob([body], { type: contentType }),
  });
}

const storageConfig = testStorageConfig();
const describeIntegration = storageConfig ? describe : describe.skip;

describeIntegration("S3TicketingStorage integration", () => {
  it("uploads the exact size, rejects overwrite, verifies HEAD, and deletes", async () => {
    const storage = new S3TicketingStorage(storageConfig!);
    const body = "exact-size-payload";
    const upload = integrationUpload(Buffer.byteLength(body));

    try {
      const signed = await storage.presignUpload(upload);
      const firstPut = await putFile(signed, upload.contentType, body);
      const firstPutBody = await firstPut.text();
      expect(firstPut.ok, `storage returned ${firstPut.status}: ${firstPutBody}`).toBe(true);

      await expect(storage.verifyUpload(upload)).resolves.toBeUndefined();

      const overwrite = await putFile(signed, upload.contentType, body);
      await overwrite.text();
      expect([409, 412]).toContain(overwrite.status);

      await expect(storage.deleteUpload(upload)).resolves.toBeUndefined();
      await expect(storage.deleteUpload(upload)).resolves.toBeUndefined();
      await expect(storage.verifyUpload(upload)).rejects.toMatchObject<Partial<SelfHostedTicketingError>>({
        status: 422,
        code: "UPLOAD_NOT_READY",
      });
    } finally {
      await storage.deleteUpload(upload);
    }
  }, 30_000);

  it("rejects a body larger than the signed Content-Length", async () => {
    const storage = new S3TicketingStorage(storageConfig!);
    const expectedBody = "signed-size";
    const upload = integrationUpload(Buffer.byteLength(expectedBody));

    try {
      const signed = await storage.presignUpload(upload);
      const oversizedPut = await putFile(signed, upload.contentType, `${expectedBody}-oversized`);
      const responseBody = await oversizedPut.text();

      expect(
        oversizedPut.ok,
        `storage unexpectedly accepted an oversized body (${oversizedPut.status}): ${responseBody}`,
      ).toBe(false);
      expect(oversizedPut.status).toBeGreaterThanOrEqual(400);
    } finally {
      await storage.deleteUpload(upload);
    }
  }, 30_000);
});
