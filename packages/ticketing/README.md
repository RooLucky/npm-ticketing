# @quanby/ticketing

Generate a secure, editable ticketing portal for a TypeScript Next.js App Router application.

```bash
npx @quanby/ticketing@latest init
# or
pnpx @quanby/ticketing@latest init
# or
pnx @quanby/ticketing@latest init
# or
pnpm dlx @quanby/ticketing@latest init
```

The default `connected` mode uses a separately deployed API. To persist tickets in a PostgreSQL database and private S3-compatible bucket configured by the consuming application, use:

```bash
pnpx @quanby/ticketing@latest init --mode self-hosted
```

For the default connected mode, configure these server-only variables:

```env
TICKETING_API_URL=https://support.example.com/api/v1
TICKETING_CLIENT_ID=hris-production
TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes
```

Replace the documented secret placeholder before running the application; generated
configuration rejects it deliberately.

Self-hosted mode instead requires these server-only values:

```env
TICKETING_CLIENT_ID=hris-production
TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes
DATABASE_TICKETING_URL=postgresql://ticketing:password@host:5432/ticketing
# REDIS_TICKETING_URL=rediss://default:password@host:6379
AWS_ACCESS_KEY_ID=replace-with-aws-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-aws-secret-access-key
AWS_REGION=ap-southeast-1
S3_BUCKET_NAME=private-ticketing-attachments
```

For AWS S3, no endpoint is required; the AWS SDK selects the endpoint from
`AWS_REGION`. For R2, MinIO, or another S3-compatible provider, the following
optional `STORAGE_*` values override their AWS counterparts:

```env
STORAGE_ENDPOINT=https://account-id.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=private-ticketing-attachments
STORAGE_ACCESS_KEY_ID=replace-with-storage-access-key
STORAGE_SECRET_ACCESS_KEY=replace-with-storage-secret-key
STORAGE_FORCE_PATH_STYLE=false
```

Put these values in the consuming Next.js application's `.env.local` (or in its
deployment environment), not in browser code and never with a `NEXT_PUBLIC_` prefix.

Remote PostgreSQL connections automatically use certificate-verified TLS,
including provider-issued URLs from Supabase, AWS RDS/Aurora, Neon, and other
managed PostgreSQL services that omit `sslmode`. Secure provider parameters
(`sslmode=require`, `verify-ca`, or `verify-full`) are accepted; explicitly
insecure modes are rejected. Use `sslrootcert` when a provider requires a custom
CA. Remote Redis connections must use `rediss://`; plaintext Redis is accepted
only for loopback development hosts.

After setting the environment, run `pnpm exec ticketing migrate --cwd .`. The explicit migrator owns a dedicated PostgreSQL `ticketing` schema; it never runs during install, build, or a request. PostgreSQL stores ticket data and attachment metadata, while file bytes remain in the private bucket behind short-lived presigned URLs.

When upgrading generated source from `0.1.x`, run the self-hosted initializer once;
executing it through `pnpx` previously did not persist the new runtime dependency:

```bash
pnpx @quanby/ticketing@latest init --mode self-hosted --dry-run --yes
pnpx @quanby/ticketing@latest init --mode self-hosted --yes
pnpm exec ticketing migrate --cwd .
```

The dry run lists every generated file and command. Locally modified generated files
are preserved unless overwrite is explicitly approved. Self-hosted mode ignores a
legacy `TICKETING_API_URL` value.

Allow browser `PUT`, `GET`, and `HEAD` requests from the host application's origins in the bucket CORS policy, including the `Content-Type` and `If-None-Match` request headers. Keep the bucket private and use a dedicated IAM principal restricted to `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for its `ticketing/*` keys. Upload signatures bind the exact byte length, content type, and unused object key; send the original browser `File` or `Blob` so the browser supplies `Content-Length` automatically.

The database admits at most 30 active upload reservations per integration user. Before issuing a new URL, the runtime removes up to 20 expired, unclaimed reservations and their exact object keys. Claimed attachments keep the same keys, so do not configure a lifecycle rule that expires the entire `ticketing/.../uploads/` prefix.

Quiet installations can call the exported server-only
`cleanupSelfHostedTicketingUploads({ config: getTicketingConfig(), limit: 100 })`
from a scheduled job. It selects only expired, unclaimed database rows and deletes
their exact keys; a failed presign releases its reservation immediately.

The generated `Ticketing` server component receives the host application's authenticated user, signs a short-lived session, and renders create/list/detail/reply UI. Images and PDFs upload directly through presigned private-storage URLs, so permanent credentials never reach the browser.

Use `init --dry-run` to preview changes. The installer supports `--mode`, `--cwd`, `--yes`, `--overwrite`, and `--skip-install`, detects npm/pnpm/Yarn/Bun, and supports both root and `src/` App Router layouts.

The package does not provision PostgreSQL, Redis, or object-storage accounts. You provide those resources and credentials. Agent dashboards and SLA workers remain outside this release. The shared API contract is included at `dist/openapi/ticketing-v1.openapi.yaml`.

See the [GitHub repository](https://github.com/RooLucky/npm-ticketing) for the full guide and mock service.
