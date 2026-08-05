import "server-only";

import { NextResponse } from "next/server";
import { type ZodType, z } from "zod";

import {
  CentralApiRequestError,
  requestCentralApi,
} from "@/lib/ticketing/central-api";
import { ApiErrorResponseSchema } from "@/lib/ticketing/schemas";
import {
  TicketingSessionError,
  verifyTicketingSession,
} from "@/lib/ticketing/session";

type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "UPLOAD_NOT_READY"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export function ticketingError(
  code: ErrorCode,
  message: string,
  status: number,
  options?: { fieldErrors?: Record<string, string[]>; requestId?: string; retryAfter?: string | null },
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(options?.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
        ...(options?.requestId ? { requestId: options.requestId } : {}),
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(options?.retryAfter ? { "Retry-After": options.retryAfter } : {}),
      },
    },
  );
}

function fieldErrors(error: z.ZodError) {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "request";
    result[key] = [...(result[key] ?? []), issue.message];
  }
  return result;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function safeRequestId(response: Response) {
  const value = response.headers.get("x-request-id");
  return value && value.length <= 128 ? value : undefined;
}

function statusError(response: Response, requestId?: string, upstreamCode?: ErrorCode) {
  if (response.status === 400) {
    if (upstreamCode === "UNSUPPORTED_FILE_TYPE") {
      return ticketingError("UNSUPPORTED_FILE_TYPE", "This file type is not supported", 400, {
        requestId,
      });
    }
    return ticketingError("VALIDATION_ERROR", "The ticketing request is invalid", 400, {
      requestId,
    });
  }
  if (response.status === 401) {
    const expired = upstreamCode === "SESSION_EXPIRED";
    return ticketingError(
      expired ? "SESSION_EXPIRED" : "INVALID_SESSION",
      expired
        ? "Your ticketing session has expired. Refresh the host page."
        : "The ticketing service rejected this session",
      401,
      { requestId },
    );
  }
  if (response.status === 403) {
    return ticketingError("FORBIDDEN", "This ticketing session cannot perform that action", 403, {
      requestId,
    });
  }
  if (response.status === 404) {
    return ticketingError("NOT_FOUND", "The requested ticket was not found", 404, { requestId });
  }
  if (response.status === 409) {
    return ticketingError(
      "IDEMPOTENCY_CONFLICT",
      "This request key was already used for a different operation",
      409,
      { requestId },
    );
  }
  if (response.status === 413) {
    return ticketingError("FILE_TOO_LARGE", "The selected file is too large", 413, { requestId });
  }
  if (response.status === 422) {
    return ticketingError(
      "UPLOAD_NOT_READY",
      "One or more uploads are unavailable or incomplete",
      422,
      { requestId },
    );
  }
  if (response.status === 429) {
    return ticketingError("RATE_LIMITED", "Too many requests. Please try again shortly.", 429, {
      requestId,
      retryAfter: response.headers.get("retry-after"),
    });
  }
  return ticketingError("UPSTREAM_ERROR", "The ticketing service could not complete the request", 502, {
    requestId,
  });
}

export type ProxyTicketingOptions<T> = {
  path: string;
  method: "GET" | "POST";
  responseSchema: ZodType<T>;
  bodySchema?: ZodType;
  query?: Record<string, string | number | undefined>;
  requireIdempotencyKey?: boolean;
};

export async function proxyTicketingRequest<T>(
  request: Request,
  options: ProxyTicketingOptions<T>,
) {
  const token = bearerToken(request);
  if (!token) return ticketingError("INVALID_SESSION", "A ticketing session is required", 401);

  try {
    await verifyTicketingSession(token);
  } catch (error) {
    if (error instanceof TicketingSessionError) {
      return ticketingError(error.code, error.message, 401);
    }
    return ticketingError("INVALID_SESSION", "The ticketing session is invalid", 401);
  }

  let body: unknown;
  if (options.bodySchema) {
    const parsed = options.bodySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return ticketingError("VALIDATION_ERROR", "Please correct the highlighted fields", 400, {
        fieldErrors: fieldErrors(parsed.error),
      });
    }
    // Zod object schemas remove unknown identity fields before forwarding.
    body = parsed.data;
  }

  let idempotencyKey: string | undefined;
  if (options.requireIdempotencyKey) {
    const candidate = request.headers.get("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9._~:-]{8,255}$/.test(candidate)) {
      return ticketingError("VALIDATION_ERROR", "A valid Idempotency-Key header is required", 400);
    }
    idempotencyKey = candidate;
  }

  try {
    const upstream = await requestCentralApi({
      path: options.path,
      method: options.method,
      sessionToken: token,
      body,
      query: options.query,
      idempotencyKey,
    });
    const requestId = safeRequestId(upstream);

    if (!upstream.ok) {
      // Consume the body without relaying potentially sensitive upstream details.
      const upstreamBody = await upstream.json().catch(() => undefined);
      const parsedError = ApiErrorResponseSchema.safeParse(upstreamBody);
      return statusError(
        upstream,
        requestId,
        parsedError.success ? parsedError.data.error.code : undefined,
      );
    }

    const json = await upstream.json().catch(() => undefined);
    const parsed = options.responseSchema.safeParse(json);
    if (!parsed.success) {
      return ticketingError("UPSTREAM_ERROR", "The ticketing service returned an invalid response", 502, {
        requestId,
      });
    }

    return NextResponse.json(parsed.data, {
      status: upstream.status,
      headers: {
        "Cache-Control": "no-store",
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
    });
  } catch (error) {
    if (error instanceof CentralApiRequestError) {
      return ticketingError(
        error.kind === "timeout" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        error.kind === "timeout"
          ? "The ticketing service took too long to respond"
          : "The ticketing service is temporarily unavailable",
        error.kind === "timeout" ? 504 : 503,
      );
    }
    return ticketingError("INTERNAL_ERROR", "Ticketing is not configured correctly", 500);
  }
}

export function parseTicketingQuery<T>(schema: ZodType<T>, request: Request) {
  const values = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    return {
      response: ticketingError("VALIDATION_ERROR", "The ticket filters are invalid", 400, {
        fieldErrors: fieldErrors(parsed.error),
      }),
    } as const;
  }
  return { data: parsed.data } as const;
}
