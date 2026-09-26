# NPATI Browser Use Worker

Internal Python service used only by the NPATI Company capability runtime. It owns Chrome execution and durable browser-job/profile state; it is not exposed publicly.

Required production variables:

- `NPATI_BROWSER_INTERNAL_TOKEN`: unique random secret (32+ characters) shared only with `agent-api` and `company-worker`.
- `BROWSER_USE_API_KEY`: Browser Use model gateway key for autonomous tasks. Deterministic navigation, forms, extraction, upload, and screenshots do not need this key.
- `BROWSER_USE_MODEL`: defaults to `bu-2-0`.

Start the stack with `docker compose up --build`. Health is available internally at `http://browser-use-worker:8765/health`.

Credentials must first be stored through `POST /companies/:companyId/browser-credentials`. Company Agents receive only the returned credential ID and field names. At execution time NPATI decrypts the selected record, sends values through the authenticated internal request, and Browser Use injects them as domain-scoped `sensitive_data`. Values are not included in the agent task, SQLite job state, result, Activity log, or Run Trace.

Uploads accept only attachment UUIDs already linked to the selected Company's Knowledge. NPATI materializes them temporarily under the shared read-only worker mount and removes them after the job completes.
