# NPATI object storage

NPATI uses one private MinIO deployment for durable binary objects. PostgreSQL is the source of truth for file metadata and ownership; large binaries are never stored in PostgreSQL.

System buckets are intentionally bounded: `npati-chat-files`, `npati-company-knowledge`, `npati-generated-media`, and `npati-exports`. Object keys use trusted UUIDs and tenant scope, never user-supplied paths or original filenames.

## Security

- Supply MinIO credentials through deployment secrets; Compose defaults are local-development only.
- Buckets have no public policy. Reads require NPATI authorization through the private backend proxy; no permanent public object URL is issued.
- Metadata records tenant ownership, MIME, size, checksum, lifecycle status, and a malware-scanner hook status.

## Backup and recovery

The MinIO volume is persistence, not a backup. Mirror all buckets to a different failure domain such as another MinIO server, S3, or R2. Back up PostgreSQL in the same recovery window. Run restore drills into an isolated MinIO instance and verify object checksums against the `files` table. Prefer MinIO replication or `mc mirror --preserve --overwrite`; do not treat a live Docker-volume copy as the only backup.

## Runtime protection

- Upload, download, and delete limits use atomic Redis counters scoped by workspace, user, and action, so limits are shared by all API replicas. A 429 response includes Retry-After.
- MinIO metadata operations have a bounded deadline. Download/list streams have both idle and total deadlines; timed-out source streams and client responses are destroyed.
- A periodic reconciler runs under a Redis lease so only one API replica scans at a time. It checks every private bucket against paginated PostgreSQL metadata, removes MinIO-only objects only after the configured grace period, marks ready database records with missing objects as failed, finishes pending deletes, and writes storage_reconciliation_audit.
- Defaults are controlled by MINIO_*_TIMEOUT_MS and NPATI_STORAGE_RECONCILE_* environment variables. The orphan grace period defaults to 24 hours to avoid deleting in-flight uploads.
