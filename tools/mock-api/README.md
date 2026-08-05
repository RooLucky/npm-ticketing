# Ticketing mock API

This private Fastify service exercises the v1 contract in
`contracts/openapi/ticketing-v1.yaml`. It is test infrastructure, not a
production ticketing backend. State and uploaded file bytes are held in memory
and disappear when the process exits.

The API is mounted at `http://127.0.0.1:4010/api/v1` by default. It additionally
serves opaque, short-lived mock upload and download URLs under `/mock`; clients
must use the returned URLs rather than construct those paths.

## Configuration

- `MOCK_API_HOST` and `MOCK_API_PORT` set the listener (defaults: `127.0.0.1`
  and `4010`).
- `MOCK_API_PUBLIC_URL` overrides the origin embedded in presigned URLs. It
  must use HTTPS, except that HTTP is accepted for exact localhost loopback
  hosts.
- `MOCK_API_CORS_ORIGIN` limits CORS to one origin. It defaults to permissive
  CORS because this service is intended for local browser fixtures.
- `TICKETING_CLIENT_SECRETS` is a JSON object mapping JWT issuer/client IDs to
  HS256 secrets, for example `{"fixture-app":"at-least-32-random-bytes-here"}`.
- Alternatively, set `TICKETING_CLIENT_ID` and `TICKETING_CLIENT_SECRET`
  together. With neither form set, the exported test client credentials are
  used for local fixtures only.

Each secret must be at least 32 UTF-8 bytes. The service never returns or logs
configured secrets.

## Required package wiring

The workspace package that owns this directory needs runtime dependencies on
`fastify`, `@fastify/cors`, `jose`, and `zod`, plus development dependencies on
`typescript`, `tsx`, `vitest`, and `@types/node`. Recommended scripts are:

```json
{
  "dev": "tsx watch src/index.ts",
  "start": "tsx src/index.ts",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

JWTs must use HS256, set the protected `kid` equal to payload `iss`, use the
`ticketing-api` audience, and include `sub`, `name`, `sourceSystem`, and
`scopes`. The supported scopes are `tickets:read`, `tickets:create`,
`tickets:reply`, and `uploads:create`.
