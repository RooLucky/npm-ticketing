# Security policy

## Supported versions

Only the latest published version of `@quanby/ticketing` receives security updates before version 1.0.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue containing credentials, session tokens, private attachments, or reproduction data from a real ticketing system.

## Integration responsibilities

- Keep `TICKETING_CLIENT_SECRET` server-only and at least 32 random bytes long.
- Keep attachment buckets private and issue short-lived upload and download URLs.
- Validate attachment size, type, ownership, and existence again in the central API.
- Scope every ticket operation to the verified JWT issuer and subject.
- Never log integration secrets, signed upload URLs, or full private attachment URLs.
