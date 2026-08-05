export type SelfHostedTicketingErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "UPLOAD_NOT_READY"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class SelfHostedTicketingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: SelfHostedTicketingErrorCode,
    message: string,
    public readonly options: {
      fieldErrors?: Record<string, string[]>;
      retryAfter?: string;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SelfHostedTicketingError";
  }

  get fieldErrors(): Record<string, string[]> | undefined {
    return this.options.fieldErrors;
  }

  get retryAfter(): string | undefined {
    return this.options.retryAfter;
  }

  get requestId(): string | undefined {
    return this.options.requestId;
  }
}
