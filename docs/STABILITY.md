# Stability validation

Last reviewed: 2026-09-28.

## Target workload

The first-release stability scenario covers one tenant with 50 configured AI providers,
10 companies, 60 agents per company (600 agents total), and 2,000 concurrent company-agent
reads. Ten independent preference-store instances simulate requests distributed across
multiple API replicas.

Run the focused suite with:

```bash
npm run test:stability
```

## Assertions

- All 50 provider records survive concurrent optimistic writes without lost updates.
- All 600 agents have unique IDs and remain assigned to the correct company.
- Every company returns exactly its own 60 agents.
- Concurrent reads have bounded p95 and p99 application-layer latency.
- Repeated provider and agent requests remain idempotent and create no duplicates.
- Another tenant cannot list providers, companies, or agents from the tested tenant.
- Provisioning remains below a 128 MB heap-growth ceiling and a 10-second test ceiling.
- Existing scale certification additionally covers 500,000 agent configurations,
  10,000 routing sessions, queue shedding, failover leases, and provider rate limits.

## Concurrency hardening

AI preference updates are serialized per workspace/user inside an API process. Database
revision checks remain authoritative between replicas, with bounded retry and jittered
backoff to prevent a thundering herd when many provider updates arrive together.

## Interpretation

Passing this suite validates application logic, concurrency, tenant isolation, bounded
memory, and in-process latency for the target topology. It does not prove the latency or
availability of external AI providers, the production database, Redis, or the network.

Before a production launch, also run the Docker scale certification against production-like
PostgreSQL and Redis, followed by a multi-hour soak test with provider emulators:

```bash
npm run cert:scale:smoke
npm run cert:scale
```

Real-provider tests must use explicit budget and rate limits. A provider outage should be
tested through the existing circuit-breaker, retry, and fallback suites rather than by
issuing uncontrolled paid requests.
