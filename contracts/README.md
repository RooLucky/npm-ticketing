# Ticketing API contract

`src/schemas.ts` is the canonical v1 wire contract. The private Fastify service
in `tools/mock-api` imports those schemas directly. `openapi/ticketing-v1.yaml`
is generated deterministically from the Zod registry and must not be edited by
hand. The source templates shipped by `@quanby/ticketing` must use the same
request, response, identifier, pagination, idempotency, and session rules.

Run `npm run contract:generate` from the repository root after an intentional
schema change. `npm run contract:check` fails when the committed OpenAPI file is
stale, and is part of the root `check` command used by CI. Redocly validation is
kept as a separate semantic OpenAPI check.

## Session claims

`components.schemas.TicketingClaims` is the authoritative JWT claims schema and
is linked from the bearer security scheme through `x-jwt-claims`. A session:

- uses HS256 and sets protected-header `kid` equal to payload `iss`;
- uses the `ticketing-api` audience;
- identifies the requester with `sub`, `name`, and optional `email`;
- carries `sourceSystem`, optional `moduleName`, and optional `pageUrl` context;
- includes one or more unique `tickets:read`, `tickets:create`,
  `tickets:reply`, or `uploads:create` scopes; and
- includes `iat`, `exp`, and `jti`, with `exp` after `iat` and no more than
  3,600 seconds later.

The optional `pageUrl` accepts an HTTP(S) URL or an origin-relative path such as
`/support`. Runtime validators reject protocol-relative paths, backslashes,
control characters, empty values, and values longer than 2,048 characters.

Mutation idempotency keys contain 8-255 ASCII letters, digits, `.`, `_`, `~`,
`:`, or `-`. Ticket IDs use `tkt_` followed by ASCII letters, digits, `_`, or
`-`, with a maximum total length of 128 characters.

Presigned upload and private attachment download URLs must use HTTPS. HTTP is
accepted only for exact `localhost`, `127.0.0.1`, or `[::1]` loopback hosts so
local browser fixtures do not need TLS. Other schemes and non-local HTTP URLs
are invalid.

Integration secrets contain at least 32 UTF-8 bytes. The documented
`replace-with-at-least-32-random-bytes` example is always rejected as a known
placeholder and must be replaced before generated routes can create sessions.
