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

Then configure these server-only variables:

```env
TICKETING_API_URL=https://support.example.com/api/v1
TICKETING_CLIENT_ID=hris-production
TICKETING_CLIENT_SECRET=replace-with-at-least-32-random-bytes
```

Replace the documented secret placeholder before running the application; generated
configuration rejects it deliberately.

The generated `Ticketing` server component receives the host application's authenticated user, signs a short-lived session, and renders create/list/detail/reply UI. Images and PDFs upload directly through presigned private-storage URLs, so permanent credentials never reach the browser.

Use `init --dry-run` to preview changes. The installer supports `--cwd`, `--yes`, `--overwrite`, and `--skip-install`, detects npm/pnpm/Yarn/Bun, and supports both root and `src/` App Router layouts.

This package does not include the production ticketing database, storage, agent dashboard, or SLA workers. The required central API contract is included at `dist/openapi/ticketing-v1.openapi.yaml`.

See the [GitHub repository](https://github.com/RooLucky/npm-ticketing) for the full guide and mock service.
