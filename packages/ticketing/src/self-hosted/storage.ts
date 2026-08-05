import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { SelfHostedTicketingError } from "./errors.js";
import type {
  SelfHostedTicketingConfig,
  StoredAttachment,
  StoredUpload,
  TicketingStorage,
} from "./types.js";

const UPLOAD_URL_TTL_SECONDS = 10 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
const STORAGE_OPERATION_TIMEOUT_MS = 10_000;

function safeDownloadName(fileName: string): string {
  return fileName.replace(/[\r\n"\\/]/g, "_");
}

function storageUnavailable(error: unknown): SelfHostedTicketingError {
  if (error instanceof SelfHostedTicketingError) return error;
  return new SelfHostedTicketingError(
    503,
    "UPSTREAM_UNAVAILABLE",
    "Private ticketing storage is unavailable",
    { cause: error },
  );
}

export class S3TicketingStorage implements TicketingStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: SelfHostedTicketingConfig["storage"],
    private readonly now: () => Date = () => new Date(),
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async presignUpload(upload: StoredUpload): Promise<{
    uploadUrl: string;
    headers: Record<string, string>;
    expiresAt: Date;
  }> {
    try {
      const uploadUrl = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: upload.objectKey,
          ContentLength: upload.expectedSize,
          ContentType: upload.contentType,
          IfNoneMatch: "*",
        }),
        {
          expiresIn: UPLOAD_URL_TTL_SECONDS,
          signableHeaders: new Set(["content-length", "content-type", "if-none-match"]),
        },
      );
      return {
        uploadUrl,
        // Browsers generate Content-Length from the File/Blob body and forbid
        // JavaScript from setting it directly. It is signed above but must not
        // be returned as a header for XMLHttpRequest/fetch to set.
        headers: { "Content-Type": upload.contentType, "If-None-Match": "*" },
        expiresAt: new Date(this.now().getTime() + UPLOAD_URL_TTL_SECONDS * 1_000),
      };
    } catch (error) {
      throw storageUnavailable(error);
    }
  }

  async verifyUpload(upload: StoredUpload): Promise<void> {
    try {
      const object = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: upload.objectKey,
      }), { abortSignal: AbortSignal.timeout(STORAGE_OPERATION_TIMEOUT_MS) });
      const contentType = object.ContentType?.split(";", 1)[0]?.trim();
      if (object.ContentLength !== upload.expectedSize || contentType !== upload.contentType) {
        throw new SelfHostedTicketingError(
          422,
          "UPLOAD_NOT_READY",
          "One or more uploads are unavailable or incomplete",
        );
      }
    } catch (error) {
      if (error instanceof SelfHostedTicketingError) throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NotFound") {
        throw new SelfHostedTicketingError(
          422,
          "UPLOAD_NOT_READY",
          "One or more uploads are unavailable or incomplete",
        );
      }
      throw storageUnavailable(error);
    }
  }

  async deleteUpload(upload: StoredUpload): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: upload.objectKey,
      }), { abortSignal: AbortSignal.timeout(STORAGE_OPERATION_TIMEOUT_MS) });
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      // S3 DELETE is normally idempotent. Treat providers that report an
      // already-absent object as success as well.
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") return;
      throw storageUnavailable(error);
    }
  }

  async presignDownload(attachment: StoredAttachment): Promise<{
    downloadUrl: string;
    expiresAt: Date;
  }> {
    try {
      const fileName = safeDownloadName(attachment.fileName);
      const downloadUrl = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: attachment.objectKey,
          ResponseContentType: attachment.contentType,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
      return {
        downloadUrl,
        expiresAt: new Date(this.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1_000),
      };
    } catch (error) {
      throw storageUnavailable(error);
    }
  }
}
