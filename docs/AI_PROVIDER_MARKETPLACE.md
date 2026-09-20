# AI Provider Marketplace

This milestone targets the pinned OmniRoute `v3.8.50` source at commit
`5458026c216f77a3da68ea49152dc33470cfe2cb`. OmniRoute core is a read-only
submodule and remains unmodified.

## Source audit

The implementation was checked against both `vendor/omniroute/docs/openapi.yaml`
and the route handlers under `vendor/omniroute/src/app/api`. Route source takes
precedence where generated OpenAPI and implementation differ.

The generated compatibility catalog currently contains 352 provider definitions across
these source categories:

- `api-key`: 233
- `oauth`: 25
- `web-cookie`: 35
- `noauth`: 13
- `local`: 14
- `search`: 14
- `audio`: 12
- `upstream-proxy`: 2
- `cloud-agent`: 3
- `system`: 1

Routable providers and provider-model entries are read from OmniRoute's live plugin
manifest and can differ by version and runtime configuration. The adapter normalizes raw
auth types and source categories to `api_key`, `oauth`, `none`, `local`, `web_session`,
or `other`.

The complete provider list is not copied into React. A build-time AST extractor
reads the pinned OmniRoute TypeScript registry and produces the adapter-owned
compatibility snapshot. Runtime availability, auth overrides, model metadata,
connections, health, and live model discovery are fetched from OmniRoute. A
version bump plus rebuild regenerates the provider snapshot automatically.

## Actual OmniRoute endpoints

The adapter uses:

- `GET /api/v1/provider-plugin-manifest` — routable provider/model registry
- `GET /api/monitoring/health` — version, full registry count, local/runtime health
- `GET /api/providers` — safe provider connections
- `POST /api/providers` — API-key, optional-key, no-auth, and local connection creation
- `DELETE /api/providers/:connectionId` — disconnect
- `POST /api/providers/validate` — pre-save API-key validation
- `POST /api/providers/:connectionId/test` — saved connection test
- `GET /api/providers/:connectionId/models` — provider-specific live/static models
- `POST /api/providers/:connectionId/sync-models` — live model discovery and import
- `GET /api/oauth/:provider/device-code` — start supported device flows
- `POST /api/oauth/:provider/poll` — poll device authorization and persist tokens
- `GET /api/oauth/:provider/authorize` — start authorization-code/PKCE flows
- `POST /api/oauth/:provider/exchange` — exchange code and persist tokens
- `GET|POST /api/settings/require-login` — supported local bootstrap only when no
  management password exists; configured passwords use `/api/auth/login`

The existing inference boundary continues to use
`POST /api/v1/chat/completions`. Automatic mode is the verified OmniRoute model
identifier `auto`.

## Secrets and persistence

Provider credentials are never written to NPATI preferences or browser storage.
They go from the browser request to Agent API, through the adapter, and into
OmniRoute's encrypted credential database. Responses contain safe connection
state only.

NPATI persists only added model metadata and routing preferences in
`/app/data/ai-preferences.json` on the `npati-agent-data` Docker volume. The file
is created with owner-only permissions and contains no provider credentials.

## Model synchronization

Connection creation triggers OmniRoute's own asynchronous discovery. Manual
Refresh calls `POST /api/providers/:connectionId/sync-models`, which fetches the
provider's current model endpoint, persists discovered models per connection,
and returns added/removed/updated counts. NPATI then invalidates its 10-minute
catalog cache and reads the provider-specific model endpoint again.

## Local providers

The pinned registry exposes 12 local providers. Their individual `localDefault`
URLs drive the form. In Docker, loopback defaults are translated inside the
adapter to `host.docker.internal`; this is not applied to cloud providers.
OmniRoute v3.8.50 has model discovery for configured local providers, but no
generic Ollama/LM Studio/vLLM model pull/install route. The NPATI UI therefore
shows detection/configuration and Refresh models, never a fake Install button.

## OAuth limitations

Generic device-code and authorization-code flows are proxied through NPATI.
Provider-specific OAuth prerequisites still apply (for example, some providers
need an upstream client ID/secret or support token import instead of browser
OAuth). The adapter returns OmniRoute's sanitized unsupported/setup message.
Authorization callbacks accepted by the provider return to
`/settings/ai/oauth/callback`; fixed or headless callback flows can be completed
by pasting the code or callback URL in the connection drawer.
