# Architecture boundaries

- The web application communicates only with Agent API.
- Agent API composes the orchestration layer and infrastructure adapters.
- Business Brain has no UI dependency.
- NPATI Business Memory owns its abstraction and rejects secret-shaped fields.
- OmniRoute Adapter is the only NPATI package aware of OmniRoute HTTP routes.
- Hub Connector owns future NPATI Hub transport details.
- Secrets are environment configuration, never business memory.

The first milestone deliberately uses an in-memory provider and one demonstration
skill. These are replaceable through interfaces without changing OmniRoute.

