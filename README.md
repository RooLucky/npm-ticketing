# @quanby/ticketing

`@quanby/ticketing` adds an editable support-ticket portal to a TypeScript Next.js App Router application. It follows the shadcn model for UI source and supports two server-side persistence modes:

- `connected` (default) sends authenticated requests to a separately deployed ticketing API.
- `self-hosted` stores tickets in the consuming application's separately configured PostgreSQL database and uploads files directly to its private S3-compatible bucket.

## Install

Run any one of these commands from a Next.js project:

```bash
npx @quanby/ticketing@latest init
pnpx @quanby/ticketing@latest init
pnx @quanby/ticketing@latest init
pnpm dlx @quanby/ticketing@latest init
```

To install the self-hosted database and private-storage integration instead:

```bash
pnpx @quanby/ticketing@latest init --mode self-hosted
```

Preview every operation without modifying the project:

```bash
npx @quanby/ticketing@latest init --dry-run
```

The installer detects npm, pnpm, Yarn, and Bun; supports root and `src/` layouts; preserves existing shadcn configuration; and refuses to replace edited generated files unless `--overwrite` is supplied.

## Connected configuration

Add these server-only variables to the consuming application:

```env
TICKETING_API_URL=https://support.example.com/api/v1
TICKETING_CLIENT_ID=hris-production
TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes
```

Replace the example secret with at least 32 random bytes; the generated validator
intentionally rejects the public placeholder. Never prefix these names with
`NEXT_PUBLIC_`.

## Self-hosted configuration

Self-hosted mode runs only in the consuming Next.js application's Node.js server runtime. Add these values to that application's server environment (for local development, usually `.env.local`):

```env
TICKETING_CLIENT_ID=hris-production
TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes

DATABASE_TICKETING_URL=postgresql://ticketing:password@database.example.com:5432/ticketing?sslmode=verify-full
# REDIS_TICKETING_URL=rediss://default:password@redis.example.com:6379

AWS_ACCESS_KEY_ID=replace-with-aws-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-aws-secret-access-key
AWS_REGION=ap-southeast-1
S3_BUCKET_NAME=private-ticketing-attachments
```

For AWS S3, no storage endpoint is required; the SDK derives it from `AWS_REGION`. For R2, MinIO, or another S3-compatible provider, set `STORAGE_ENDPOINT` and optionally `STORAGE_FORCE_PATH_STYLE=true`. The equivalent `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY` names are also accepted as explicit overrides.

Remote PostgreSQL connections must use certificate-verified TLS with `sslmode=verify-full`, and remote Redis connections must use `rediss://`. Plain `postgresql://` and `redis://` are accepted only for `localhost`, `127.0.0.1`, or `[::1]` development services.

Then apply the package-owned schema to `DATABASE_TICKETING_URL`:

```bash
pnpm exec ticketing migrate --cwd .
```

The migrator uses a dedicated PostgreSQL `ticketing` schema and never runs during package installation, application build, or a web request. Ticket and reply records plus attachment metadata are stored in PostgreSQL. Image and PDF bytes stay in the private bucket. Redis is optional and, when configured, is used for distributed rate limiting rather than durable data.

### Upgrade an existing 0.1.x installation

Running `pnpx` previously generated editable source but did not add a persistent runtime package. Preview the safe mode switch, then run it once and migrate the new ticketing schema:

```bash
pnpx @quanby/ticketing@latest init --mode self-hosted --dry-run --yes
pnpx @quanby/ticketing@latest init --mode self-hosted --yes
pnpm exec ticketing migrate --cwd .
```

The installer removes only unchanged connected-mode files, preserves locally modified generated files unless overwrite is explicitly approved, and does not edit your page. A legacy `TICKETING_API_URL` may remain in an existing `.env.example`, but self-hosted mode ignores it and it can be removed.

The bucket must permit browser `PUT`, `GET`, and `HEAD` requests from the consuming application's origins, including the `Content-Type` and `If-None-Match` request headers. Keep it private: the server returns short-lived presigned upload and download URLs. Use a dedicated IAM principal restricted to `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for this bucket's `ticketing/*` keys. Upload signatures bind the exact byte length, content type, and unused object key; the browser supplies `Content-Length` automatically from the original `File` or `Blob`. When used, `STORAGE_ENDPOINT` must be the provider's S3 API endpoint, not a public custom-domain URL.

The database admits at most 30 active upload reservations per integration user. Before issuing a new URL, the runtime removes up to 20 expired, unclaimed reservations and their exact object keys. Claimed attachments keep the same keys, so do not configure a lifecycle rule that expires the entire `ticketing/.../uploads/` prefix.

For an installation that may remain idle after users abandon uploads, schedule a server-only cleanup job. `cleanupSelfHostedTicketingUploads({ config: getTicketingConfig(), limit: 100 })` removes only database-confirmed expired, unclaimed objects; it never deletes claimed attachments. A failed presign also releases its reservation immediately.

Upload URLs sign the declared byte size as `Content-Length`. Browser code must send the original `File` or `Blob` body without transforming it; the browser supplies `Content-Length` itself because JavaScript is not permitted to set that header. A different-size body fails signature validation, and the server also verifies the stored size and media type before attaching it to a ticket.

Do not configure a blanket object-storage lifecycle rule for the `ticketing/.../uploads/` prefix: claimed attachments keep their original object keys and are permanent. Safe orphan cleanup selects only expired, unclaimed upload rows (`attachment_id IS NULL`) in PostgreSQL, deletes those exact object keys idempotently, and then removes the corresponding rows. This preserves every object referenced by an attachment.

Render the generated server component from an authenticated server page:

```tsx
import { Ticketing } from "@/components/ticketing/Ticketing";
import { getCurrentUser } from "@/lib/auth";

export default async function SupportPage() {
  const user = await getCurrentUser();

  return (
    <Ticketing
      user={{ id: user.id, name: user.fullName, email: user.email }}
      sourceSystem="HRIS"
      moduleName="Employee Self-Service"
      pageUrl="/support"
    />
  );
}
```

`Ticketing` signs the user context on the server. The permanent integration secret never reaches the browser.

## Features

- Create, list, filter, inspect, and reply to tickets.
- Cursor pagination and normalized loading, empty, error, and retry states.
- File picker, drag and drop, clipboard paste, previews, removal, progress, and retries.
- Up to five JPEG, PNG, WebP, or PDF attachments of 10 MiB each by default.
- Presigned direct uploads to private storage rather than proxying large files through Next.js.
- A versioned OpenAPI contract and a private in-memory mock service for local verification.

## CLI options

```text
--cwd <directory>  Target project directory
--mode <mode>       connected or self-hosted (connected on first install)
--yes              Accept safe defaults and confirmations
--dry-run          Print operations without writing or installing
--overwrite        Replace conflicting generated files after confirmation
--skip-install     Generate source without installing dependencies
```

## Connected API

The central service must implement the contract in [`contracts/openapi/ticketing-v1.yaml`](./contracts/openapi/ticketing-v1.yaml):

- `POST /uploads/presign`
- `GET /tickets`
- `POST /tickets`
- `GET /tickets/{ticketId}`
- `POST /tickets/{ticketId}/replies`

Ticket and reply creation require an `Idempotency-Key`. All operations are scoped to the authenticated integration and end user represented by the short-lived JWT.

Self-hosted mode implements the same contract inside the generated same-origin Next.js routes. It does not require `TICKETING_API_URL` or a separate ticketing deployment.

## Development

```bash
npm install
npm run check
npm run test:e2e
npm run pack:dry-run
```

The workspace requires Node.js 22.14 or newer. CI validates Node.js 22 and 24.

## Publishing

The first public release must be performed by a verified owner of the `quanby` npm scope with two-factor authentication:

```bash
npm publish --workspace=@quanby/ticketing --access public
```

After the initial package exists, configure `release.yml` as the package's npm trusted publisher. Later tagged releases use GitHub OIDC and npm provenance without storing a publish token.

See [`docs/RELEASING.md`](./docs/RELEASING.md) for the account, 2FA, first-publish,
and trusted-publisher checklist.

## License

MIT
