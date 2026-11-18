# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository, go to **Security → Advisories → Report a vulnerability**
(https://github.com/andrii-koss/npati-ai-agent/security/advisories/new). Include the steps to reproduce, the affected
version or commit, and what an attacker could do.

We aim to answer within 7 days and to agree on a disclosure date with you once a fix is ready.

## Supported versions

NPATI Agent is in beta. Security fixes go to the latest release on the main branch only.

## Running it safely

- Before exposing an installation to other people or the internet, replace every development password, encryption
  key, API token and signing secret in `.env`, and keep `NPATI_AUTH_STRICT=true`.
- Provider keys, mailbox passwords and bot tokens are stored encrypted; never commit `.env` or paste keys into issues.
- Destructive actions (deleting projects or data, risky shell commands, database changes) ask for confirmation in the
  chat. Keep these approvals on unless you understand the risk.
