import {
  CreateTicketRequestSchema,
  CreateTicketResponseSchema,
  TicketListQuerySchema,
  TicketListResponseSchema,
} from "@/lib/ticketing/schemas";
import {
  parseTicketingQuery,
  proxyTicketingRequest,
} from "@/lib/ticketing/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = parseTicketingQuery(TicketListQuerySchema, request);
  if ("response" in parsed) return parsed.response;

  return proxyTicketingRequest(request, {
    path: "tickets",
    method: "GET",
    query: parsed.data,
    responseSchema: TicketListResponseSchema,
  });
}

export async function POST(request: Request) {
  return proxyTicketingRequest(request, {
    path: "tickets",
    method: "POST",
    bodySchema: CreateTicketRequestSchema,
    responseSchema: CreateTicketResponseSchema,
    requireIdempotencyKey: true,
  });
}
