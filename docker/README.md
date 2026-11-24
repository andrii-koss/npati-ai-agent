# Docker

The root `docker-compose.yml` is the only local entry point for milestone one.
Application images are defined next to their apps. OmniRoute runs from the
official versioned image `diegosouzapw/omniroute:3.8.49`; the matching pinned
source remains in `vendor/omniroute` for audit and controlled upgrades.

Data Studio (project databases, Project Auth, promote, backups, quotas and
external databases) has its own operations guide:
[`DATA_STUDIO_SELF_HOSTING.md`](DATA_STUDIO_SELF_HOSTING.md). It
covers the `data-studio` / `local-sandbox` compose profiles, the snapshot volume,
every Data Studio environment variable, the promote workflow, backup/restore and
retention, quotas and troubleshooting codes.

## Secrets (required since the 2026-11-24 security audit)

`docker-compose.yml` no longer falls back to secrets committed in this repository: every service refuses to start
without them, and the API/worker refuse a value that matches a shipped default (`NODE_ENV=production` is enough; it no
longer depends on `NPATI_ENV`). Generate them once:

```sh
node scripts/generate-local-secrets.mjs          # writes missing values into .env (backup next to it)
node scripts/generate-local-secrets.mjs --check  # lists what is missing, never prints values
```

The API publishes ports 3000/3001 on `127.0.0.1` only. Set `NPATI_API_BIND=0.0.0.0` to expose it deliberately.

### Upgrading an installation that ran on the old defaults

1. **Encryption key.** The script keeps the previous key as `NPATI_ENCRYPTION_KEY_PREVIOUS` (decrypt-only). After the
   stack is up with the new key, rewrite the stored ciphertext and then delete that line from `.env`:
   ```sh
   DATABASE_URL=postgresql://npati:<NPATI_POSTGRES_PASSWORD>@127.0.0.1:5432/npati_agent \
   NPATI_ENCRYPTION_KEY=<new> NPATI_ENCRYPTION_KEY_PREVIOUS=<old> npx tsx scripts/reencrypt-vault-secrets.ts
   ```
   External audit anchors are signed with `NPATI_AUDIT_ANCHOR_KEY` or, when unset, the encryption key: anchors written
   before the rotation will no longer verify. Set `NPATI_AUDIT_ANCHOR_KEY` explicitly to keep them independent.
2. **Postgres.** `POSTGRES_PASSWORD` only applies when a volume is created. Set the role passwords to the new values
   *before* recreating the API:
   ```sh
   docker compose exec -T postgres psql -U npati -d npati_agent -c "ALTER USER npati PASSWORD '<NPATI_POSTGRES_PASSWORD>'"
   docker compose exec -T postgres-projects psql -U npati_projects_admin -d postgres -c "ALTER USER npati_projects_admin PASSWORD '<NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD>'"
   ```
3. **MinIO, Redis, OmniRoute** pick up their new credentials when recreated (`docker compose up -d`). OmniRoute claims
   `OMNIROUTE_MANAGEMENT_PASSWORD` as its dashboard password on start instead of waiting for an open onboarding.

### Preview origin

A Preview runs the project's own code and is served only from an isolated host: `<project>.preview.localhost` on a
local installation, or `NPATI_PREVIEW_ORIGIN` (for example `https://{project}.preview.example.com`, with wildcard DNS
and TLS) elsewhere. On the app's own host the proxy answers `421`. A self-hosted owner who cannot provide such a domain
may accept the risk with `NPATI_PREVIEW_ALLOW_APP_ORIGIN=true`; it is ignored when `NPATI_DEPLOYMENT_TYPE=npati_hosted`.

### Other switches

- `NPATI_MAIL_ALLOW_PRIVATE_HOSTS=true` — self-hosted only: allow IMAP/SMTP servers on private networks and non-mail ports.
- `NPATI_TRUST_PROXY` — reverse-proxy hops (`1`) or proxy addresses/CIDRs allowed to set `X-Forwarded-For`; unset = none.
- `NPATI_RATE_LIMIT_DISABLED=true` — turns off the per-client limits on sign-in, OAuth callbacks, webhooks, connection probes and media generation.

### Browser sessions (cookies)

The web app's session is an HttpOnly cookie (`npati_access`, `SameSite=Lax`) that page JavaScript cannot read, with an
optional refresh cookie (`npati_refresh`, `Path=/api/auth`) and a readable `npati_csrf` cookie. Requests that change
data with the cookie must send `x-csrf-token` equal to `npati_csrf`, and their `Origin` must be this host or
`NPATI_WEB_ORIGIN` (comma-separated list allowed). Token-issuing endpoints answer a browser (a request with an `Origin`
header) with cookies and no token in the body; CLI and server clients (no `Origin`) still receive tokens and use the
`Authorization: Bearer` header, which needs no CSRF header. After upgrading, open browser tabs reload into the cookie
session on their next authorization check; the old `localStorage` token keys are deleted on load.

### Passkey confirmation for sensitive actions

From the browser (cookie session), creating an API key or a remote access token, revealing a saved browser
password, a webhook URL with its secret or Data Studio API keys, and rotating Data Studio keys need a passkey
confirmation (WebAuthn with user verification). People add passkeys in Settings → Security; adding a further passkey
or removing one needs a confirmation with an existing passkey. The relying party is the site's own host, so the app
must be opened on its final domain (or `localhost`) — and over HTTPS anywhere but `localhost`. API keys and Bearer
tokens (CLI, server to server) are not asked: page script cannot reach them. The first passkey of an account can be
added by whoever holds the session, so every passkey is listed in Settings → Security.
