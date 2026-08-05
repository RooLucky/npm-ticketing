import { TicketDetailResponseSchema, TicketIdSchema } from "@/lib/ticketing/schemas";
import { proxyTicketingRequest, ticketingError } from "@/lib/ticketing/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ ticketId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const parsed = TicketIdSchema.safeParse((await context.params).ticketId);
  if (!parsed.success) return ticketingError("VALIDATION_ERROR", "Invalid ticket identifier", 400);

  return proxyTicketingRequest(request, {
    path: `tickets/${encodeURIComponent(parsed.data)}`,
    method: "GET",
    responseSchema: TicketDetailResponseSchema,
  });
}
