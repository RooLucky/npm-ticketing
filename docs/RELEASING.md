# Releasing `@quanby/ticketing`

## First public release

The first publish creates the package on npm. A GitHub push alone does not reserve
the package name.

1. Sign in interactively with `npm login`, confirm the account email is verified,
   and keep the profile email visibility private on npmjs.com.
2. Enable authorization-and-writes 2FA, preferably with a WebAuthn security key:

   ```bash
   npm profile enable-2fa auth-and-writes
   ```

3. Create the free public-package organization named `quanby` on npmjs.com and
   confirm the publishing user is an owner. If that name is unavailable, stop and
   choose a new scope before changing any package metadata.
4. Run the complete acceptance gates from the repository root:

   ```bash
   npm ci
   npm run check
   npm run test:e2e
   npm run bundle:scan
   npm run pack:verify
   npm run test:packed-cli
   ```

5. Inspect `npm pack --workspace=@quanby/ticketing --dry-run`, then publish with the
   interactive 2FA prompt:

   ```bash
   npm publish --workspace=@quanby/ticketing --access public
   ```

6. Confirm the live registry through both npm and pnpm launchers:

   ```bash
   npx @quanby/ticketing@latest init --dry-run
   pnpx @quanby/ticketing@latest init --dry-run
   ```

## Trusted releases after `0.1.0`

In the npm package settings, configure the GitHub Actions trusted publisher with
these exact, case-sensitive values:

- Organization or user: `RooLucky`
- Repository: `npm-ticketing`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The workflow uses a GitHub-hosted runner and OIDC, so no long-lived npm write token
is needed. Trusted publishing automatically attaches provenance. Protect the GitHub
`npm` environment and release tags, and require a human approval if desired.

For a later version, update `packages/ticketing/package.json`, merge the validated
commit, and push a matching `v<version>` tag. The workflow rejects mismatched tags.
