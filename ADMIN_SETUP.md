# Capella Roastery Admin deployment

The dashboard is served from `admin-preview/` by Cloudflare Pages project `capella-admin`. It must remain protected at `admin.copacapella.com` by Cloudflare Access.

## One-time database migration
Run `database/admin-migration.sql` in Cloudflare D1 database `capella-orders` SQL Console.

## Cloudflare Pages project bindings
Under capella-admin > Settings > Bindings, add a **D1 database** binding:
- Variable name: `DB`
- Database: `capella-orders`

Under capella-admin > Settings > Variables and secrets, add:
- `ACCESS_TEAM_DOMAIN`: your Cloudflare Zero Trust team domain (e.g. `example.cloudflareaccess.com`), **not** admin.copacapella.com
- `ACCESS_AUD`: the Application Audience (AUD) tag shown on the Cloudflare Access application settings for admin.copacapella.com
- `ADMIN_EMAILS`: comma-separated email addresses allowed in the Cloudflare Access policy

These are server-side variables, not public client-side configuration. The API verifies JWT signature against the Cloudflare Access JWKS and checks issuer, audience, expiration and email allowlist. No client-supplied identity is trusted.

## Important deployment note
Cloudflare Pages Functions must be built from the repo's root `functions/` folder. The Pages output directory remains `admin-preview`. If `/api/dashboard` returns 404, check that Pages Functions were included in the deployment and that the project is configured as Pages, not Workers. Do not expose D1 through a public endpoint as a workaround.

## Capabilities and limitations
- Live orders from the shared D1 database, bag totals, fulfillment changes
- Manual one-time orders, recurring custom schedules, pause/resume, manual payment status
- Recurring custom orders materialize into future Friday roast windows when the dashboard loads. Existing generated occurrences are not automatically removed by pausing a plan; review/cancel any already generated orders separately.
- Custom Stripe automatic billing is **not yet implemented**. Selecting Stripe for a manual recurring order tracks billing preference only, and does not charge cards.
- Recurring subscription invoices and shipping/pickup details must be separately verified before production.
- Protect all routes; public `pages.dev` addresses can still serve static HTML but cannot retrieve order data without a valid Access JWT.
