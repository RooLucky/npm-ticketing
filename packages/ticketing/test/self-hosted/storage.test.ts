import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelfHostedTicketingError } from "../../src/self-hosted/errors.js";
import { SelfHostedConfigSchema } from "../../src/self-hosted/schemas.js";
import { S3TicketingStorage } from "../../src/self-hosted/storage.js";
import type {
  SelfHostedTicketingConfig,
  StoredUpload,
} from "../../src/self-hosted/types.js";

const config: SelfHostedTicketingConfig["storage"] = {
  endpoint: "https://storage.example.test",
  region: "auto",
  bucket: "private-ticketing",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  forcePathStyle: true,
};

const upload: StoredUpload = {
  id: "upl_test",
  clientId: "hris-production",
  requesterId: "user-1",
  fileName: "evidence.png",
  contentType: "image/png",
  expectedSize: 128,
  objectKey: "ticketing/hris-production/user-1/uploads/upl_test",
  expiresAt: new Date("2026-08-05T03:00:00.000Z"),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("S3TicketingStorage", () => {
  it("uses the regional AWS S3 endpoint when no custom endpoint is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T02:00:00.000Z"));
    const awsStorage = {
      region: "ap-southeast-1",
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: false,
    };
    const parsed = SelfHostedConfigSchema.parse({
      clientId: "storage-config-test",
      clientSecret: new TextEncoder().encode(
        "storage-config-test-secret-with-at-least-32-bytes",
      ),
      databaseUrl: "postgresql://ticketing:ticketing@localhost:5432/ticketing",
      storage: awsStorage,
    });
    const storage = new S3TicketingStorage(parsed.storage, () => new Date());

    const signed = await storage.presignUpload(upload);

    expect(new URL(signed.uploadUrl).hostname).toBe(
      "private-ticketing.s3.ap-southeast-1.amazonaws.com",
    );
  });

  it("signs the exact upload size without asking browser JavaScript to set Content-Length", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T02:00:00.000Z"));
    const storage = new S3TicketingStorage(config, () => new Date());

    const signed = await storage.presignUpload(upload);
    const differentSize = await storage.presignUpload({
      ...upload,
      expectedSize: upload.expectedSize + 1,
    });
    const url = new URL(signed.uploadUrl);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";");

    expect(signedHeaders).toEqual(expect.arrayContaining([
      "content-length",
      "content-type",
      "host",
      "if-none-match",
    ]));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(differentSize.uploadUrl).searchParams.get("X-Amz-Signature"),
    );
    expect(signed.headers).toEqual({
      "Content-Type": "image/png",
      "If-None-Match": "*",
    });
    expect(signed.headers).not.toHaveProperty("Content-Length");
    expect(signed.expiresAt).toEqual(new Date("2026-08-05T02:10:00.000Z"));
  });

  it("bounds HEAD verification with an abort signal", async () => {
    const send = vi.fn().mockResolvedValue({
      ContentLength: upload.expectedSize,
      ContentType: upload.contentType,
    });
    const storage = new S3TicketingStorage(
      config,
      () => new Date(),
      { send } as unknown as S3Client,
    );

    await storage.verifyUpload(upload);

    const [command, options] = send.mock.calls[0] as [HeadObjectCommand, {
      abortSignal: AbortSignal;
    }];
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({
      Bucket: config.bucket,
      Key: upload.objectKey,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  it("deletes an orphan candidate idempotently with a bounded S3 call", async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = new S3TicketingStorage(
      config,
      () => new Date(),
      { send } as unknown as S3Client,
    );

    await storage.deleteUpload(upload);

    const [command, options] = send.mock.calls[0] as [DeleteObjectCommand, {
      abortSignal: AbortSignal;
    }];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: config.bucket,
      Key: upload.objectKey,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  it.each([
    Object.assign(new Error("already absent"), { $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error("already absent"), { name: "NoSuchKey" }),
  ])("treats an already-absent orphan object as deleted", async (error) => {
    const send = vi.fn().mockRejectedValue(error);
    const storage = new S3TicketingStorage(
      config,
      () => new Date(),
      { send } as unknown as S3Client,
    );

    await expect(storage.deleteUpload(upload)).resolves.toBeUndefined();
  });

  it("normalizes unexpected delete failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const storage = new S3TicketingStorage(
      config,
      () => new Date(),
      { send } as unknown as S3Client,
    );

    await expect(storage.deleteUpload(upload)).rejects.toMatchObject<Partial<SelfHostedTicketingError>>({
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
