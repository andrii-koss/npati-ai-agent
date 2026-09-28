# Email stability and security

Last reviewed: 2026-09-28.

## Automated load coverage

Run `npm run test:email-stability`. The suite verifies 1,000 simultaneous unique
messages, a 500-request replay storm for one provider `Message-ID`, bounded AI
concurrency, payload limits, sender authentication, and prompt-injection rejection.

The 1,000-message test is an application-layer certification with an in-memory
repository and a deterministic AI provider. It detects data loss, duplicate side
effects, unbounded fan-out, excessive memory growth, and major latency regressions.
It is not a substitute for a production-like PostgreSQL/IMAP/SMTP soak test.

## Security controls reviewed

- Mailbox credentials are encrypted by the repository vault.
- Inbound messages can require SPF, DKIM, or DMARC authentication and are filtered
  by sender/domain policy before AI execution.
- Provider retries are deduplicated by `Message-ID`; PostgreSQL uses an advisory
  lock so the guarantee also applies across API replicas.
- Email content is marked untrusted and checked for prompt injection. Credentials
  are masked before model input.
- Subject, body, attachment count, individual attachment size, and aggregate
  attachment size are rejected before expensive processing.
- AI calls are limited to eight concurrent requests per process by default. Set
  `EMAIL_AI_MAX_CONCURRENCY` from 1 through 64 to match provider quotas.
- SMTP headers are sanitized against CRLF injection. OAuth state uses PKCE,
  encryption, expiry, and single-use consumption.
- Durable jobs use bounded claims, retry backoff, stale-lease recovery, and
  transactional account/company/recipient send quotas.

## Dependency audit

`npm audit --audit-level=high` reports no high or critical vulnerabilities. It
does report eight moderate and one low advisory in the current dependency tree:
Vitest and esbuild affect development tooling; MinIO transitive parsers expose
denial-of-service advisories; ExcelJS carries an older UUID implementation. The
available automatic remediation requires breaking dependency downgrades or major
upgrades, so it was not applied implicitly. These advisories should remain tracked
and the storage/import endpoints should retain request-size and timeout controls.


## Operational limits and release guidance

The current worker intentionally processes claimed outbound jobs and IMAP messages
in bounded batches. A sudden mailbox backlog is drained over multiple ticks instead
of creating unlimited parallel work. This favors stability, but throughput depends
on mailbox count, database capacity, AI latency, and provider quotas.

Before enabling high-volume production traffic, run the Docker scale certification
and a multi-hour soak test against production-like PostgreSQL, Redis, IMAP, SMTP,
and an AI-provider emulator. Monitor queue depth, oldest-job age, rejection counts,
retry counts, provider latency, heap usage, and database pool saturation. Do not
claim a fixed messages-per-second capacity until that environment-specific test is
