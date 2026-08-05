import {
  PresignUploadRequestSchema,
  PresignUploadResponseSchema,
} from "@/lib/ticketing/schemas";
import { proxyTicketingRequest } from "@/lib/ticketing/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return proxyTicketingRequest(request, {
    path: "uploads/presign",
    method: "POST",
    bodySchema: PresignUploadRequestSchema,
    responseSchema: PresignUploadResponseSchema,
  });
}
