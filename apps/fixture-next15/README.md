# Next.js 15 compatibility fixture

This private, non-deployable workspace verifies generated ticketing source against
Next.js 15.5 and Tailwind CSS 3. It intentionally tracks that legacy compatibility
line even when npm reports advisories that are only resolved by upgrading Next.js.
The public `@quanby/ticketing` tarball does not include this fixture or its dependencies.
