# @quanby/ticketing

`@quanby/ticketing` is a source-generating CLI for adding an editable support-ticket portal to a TypeScript Next.js App Router application. It follows the shadcn model: the installer copies code into the consuming application, so teams own and can customize the result.

The package is the integration layer only. Ticket data, agent workflows, SLA processing, Redis, PostgreSQL, and private object storage belong to a separately deployed central ticketing service.

## Install

Run any one of these commands from a Next.js project:

```bash
npx @quanby/ticketing@latest init
pnpx @quanby/ticketing@latest init
pnx @quanby/ticketing@latest init
pnpm dlx @quanby/ticketing@latest init
```

Preview every operation without modifying the project:

```bash
npx @quanby/ticketing@latest init --dry-run
```

The installer detects npm, pnpm, Yarn, and Bun; supports root and `src/` layouts; preserves existing shadcn configuration; and refuses to replace edited generated files unless `--overwrite` is supplied.

## Configure

Add these server-only variables to the consuming application:

```env
TICKETING_API_URL=https://support.example.com/api/v1
TICKETING_CLIENT_ID=hris-production
TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes
```

Replace the example secret with at least 32 random bytes; the generated validator
intentionally rejects the public placeholder. Never prefix these names with
`NEXT_PUBLIC_`.

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
--yes              Accept safe defaults and confirmations
--dry-run          Print operations without writing or installing
--overwrite        Replace conflicting generated files after confirmation
--skip-install     Generate source without installing dependencies
```

## Central API

The central service must implement the contract in [`contracts/openapi/ticketing-v1.yaml`](./contracts/openapi/ticketing-v1.yaml):

- `POST /uploads/presign`
- `GET /tickets`
- `POST /tickets`
- `GET /tickets/{ticketId}`
- `POST /tickets/{ticketId}/replies`

Ticket and reply creation require an `Idempotency-Key`. All operations are scoped to the authenticated integration and end user represented by the short-lived JWT.

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
