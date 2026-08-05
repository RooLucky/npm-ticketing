import { errors, jwtVerify } from "jose";

import { SelfHostedTicketingError } from "./errors.js";
import {
  SelfHostedSessionClaimsSchema,
  TICKETING_SESSION_AUDIENCE,
  TicketingSessionTokenSchema,
} from "./schemas.js";
import type {
  SelfHostedTicketingConfig,
  SelfHostedTicketingPrincipal,
} from "./types.js";

function invalidSession(cause?: unknown): SelfHostedTicketingError {
  return new SelfHostedTicketingError(
    401,
    "INVALID_SESSION",
    "The ticketing session is invalid",
    cause === undefined ? {} : { cause },
  );
}

export async function verifySelfHostedTicketingSession(
  sessionToken: string,
  config: Pick<SelfHostedTicketingConfig, "clientId" | "clientSecret">,
): Promise<SelfHostedTicketingPrincipal> {
  const parsedToken = TicketingSessionTokenSchema.safeParse(sessionToken);
  if (!parsedToken.success) throw invalidSession();

  try {
    const { payload, protectedHeader } = await jwtVerify(
      parsedToken.data,
      config.clientSecret,
      {
        algorithms: ["HS256"],
        issuer: config.clientId,
        audience: TICKETING_SESSION_AUDIENCE,
        typ: "JWT",
        maxTokenAge: "60m",
        requiredClaims: ["exp", "jti", "name", "sourceSystem", "scopes"],
      },
    );

    if (protectedHeader.kid !== config.clientId) {
      throw invalidSession();
    }

    const claims = SelfHostedSessionClaimsSchema.parse(payload);
    return {
      iss: claims.iss,
      sub: claims.sub,
      name: claims.name,
      ...(claims.email ? { email: claims.email } : {}),
      sourceSystem: claims.sourceSystem,
      ...(claims.moduleName ? { moduleName: claims.moduleName } : {}),
      ...(claims.pageUrl ? { pageUrl: claims.pageUrl } : {}),
      scopes: claims.scopes,
    };
  } catch (error) {
    if (error instanceof SelfHostedTicketingError) throw error;
    if (error instanceof errors.JWTExpired) {
      throw new SelfHostedTicketingError(
        401,
        "SESSION_EXPIRED",
        "Your ticketing session has expired",
        { cause: error },
      );
    }
    throw invalidSession(error);
  }
}
