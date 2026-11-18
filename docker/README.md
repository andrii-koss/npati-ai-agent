# Docker

The root `docker-compose.yml` is the only local entry point for milestone one.
Application images are defined next to their apps. OmniRoute runs from the
official versioned image `diegosouzapw/omniroute:3.8.49`; the matching pinned
source remains in `vendor/omniroute` for audit and controlled upgrades.

Data Studio (project databases, Project Auth, promote, backups, quotas and
external databases) has its own operations guide:
[`docs/audit/data-studio/SELF_HOSTING.md`](../docs/audit/data-studio/SELF_HOSTING.md). It
covers the `data-studio` / `local-sandbox` compose profiles, the snapshot volume,
every Data Studio environment variable, the promote workflow, backup/restore and
retention, quotas and troubleshooting codes.
