import "server-only";

import {
  CentralApiRequestError,
  requestCentralApi,
} from "@/lib/ticketing/central-api";

export class TicketingBackendRequestError extends Error {
  constructor(public readonly kind: "timeout" | "unavailable" | "internal") {
    super("The ticketing backend request failed");
    this.name = "TicketingBackendRequestError";
  }
}

export type TicketingBackendRequest = {
  path: string;
  method: "GET" | "POST";
  sessionToken: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
};

export async function requestTicketingBackend(
  input: TicketingBackendRequest,
): Promise<Response> {
  try {
    return await requestCentralApi({
      path: input.path,
      method: input.method,
      sessionToken: input.sessionToken,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.query ? { query: input.query } : {}),
      ...(input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    });
  } catch (error) {
    if (error instanceof CentralApiRequestError) {
      throw new TicketingBackendRequestError(error.kind);
    }
    throw new TicketingBackendRequestError("internal");
  }
}
