import { connection } from "next/server";

import { TicketingPortal } from "@/components/ticketing/TicketingPortal";
import {
  TICKETING_ACCEPTED_TYPES,
  TicketingPageUrlSchema,
  TicketingUserSchema,
  type ResolvedAttachmentOptions,
  type TicketingAcceptedType,
  type TicketingProps,
} from "@/lib/ticketing/schemas";
import { createTicketingSession } from "@/lib/ticketing/session";

function resolveAttachments(options: TicketingProps["attachments"]): ResolvedAttachmentOptions {
  const accepted = new Set<TicketingAcceptedType>(TICKETING_ACCEPTED_TYPES);
  const requested = options?.accept ?? [...TICKETING_ACCEPTED_TYPES];

  return {
    enabled: options?.enabled ?? true,
    maximumFiles: Math.min(5, Math.max(1, Math.floor(options?.maximumFiles ?? 5))),
    maximumFileSizeMb: Math.min(10, Math.max(1, options?.maximumFileSizeMb ?? 10)),
    accept: requested.filter((type): type is TicketingAcceptedType => accepted.has(type)),
  };
}

/**
 * Server component boundary for the ticketing portal. Pass the authenticated
 * host-application user; never derive this value from browser input.
 */
export async function Ticketing({
  user: inputUser,
  sourceSystem,
  moduleName,
  pageUrl,
  initialView = "list",
  className,
  attachments,
}: TicketingProps) {
  // Session JWTs are user-specific and must never be captured in a static RSC payload.
  await connection();

  const user = TicketingUserSchema.parse(inputUser);
  const source = sourceSystem.trim();
  if (!source || source.length > 128) {
    throw new Error("Ticketing sourceSystem must contain between 1 and 128 characters");
  }

  const sessionToken = await createTicketingSession({
    user,
    sourceSystem: source,
    ...(moduleName ? { moduleName: moduleName.slice(0, 128) } : {}),
    ...(pageUrl ? { pageUrl: TicketingPageUrlSchema.parse(pageUrl) } : {}),
  });

  return (
    <TicketingPortal
      sessionToken={sessionToken}
      initialView={initialView}
      className={className}
      attachments={resolveAttachments(attachments)}
    />
  );
}
