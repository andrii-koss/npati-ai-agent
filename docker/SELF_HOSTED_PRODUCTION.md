# Self-hosted project production

The standard Docker Compose installation starts the `production` and `traefik` services by default. Traefik accepts public HTTP and HTTPS. Production builds and serves project releases. The Code Workspace calls Production through a separate control network. Preview continues to run in the existing sandbox.

## Configure publication

The quick start uses `.env.example`, which enables local project publication on loopback ports 18080 and 18443. If you already have a `.env`, add the production settings from the example. Generate a unique control secret with `openssl rand -hex 32` and replace the local example token before exposing the installation.

For public domains, use settings such as these:

```dotenv
NPATI_PRODUCTION_TOKEN=<random-generated-secret>
NPATI_PRODUCTION_LOCAL=false
NPATI_PRODUCTION_BIND=0.0.0.0
NPATI_PRODUCTION_HTTP_PORT=80
NPATI_PRODUCTION_HTTPS_PORT=443
NPATI_PRODUCTION_ACME_EMAIL=operator@example.com
NPATI_PRODUCTION_DOMAIN=sites.example.com
NPATI_PRODUCTION_CPUS=4
NPATI_PRODUCTION_MEMORY=4g
```

Start the standard stack. Keep the existing project name, environment files and overrides:

```sh
docker compose -f docker-compose.yml up -d --build
```

Traefik uses ports 80 and 443. Forward both ports to the server. Point the domain's A record, and its AAAA record if IPv6 is configured, at this installation. For automatic project domains, configure wildcard DNS such as `*.sites.example.com` for the suffix you control. For a custom domain, add the TXT record displayed under **Domain & SSL / Network**. Each domain is assigned to one project at a time.

When Let's Encrypt is enabled, Traefik obtains and renews host certificates through the HTTP-01 challenge. The Production header displays whether the certificate is pending or issued. For a local install use `NPATI_PRODUCTION_LOCAL=true`, `NPATI_PRODUCTION_BIND=127.0.0.1`, and available ports such as `NPATI_PRODUCTION_HTTP_PORT=18080` and `NPATI_PRODUCTION_HTTPS_PORT=18443`. Local `*.localhost` projects use HTTP.

## Publish a project

Open **Settings → Projects**. Use **Create New Project** or open a project's menu and choose **Rename** to open its existing settings. Under **Domain & SSL / Network**, set the domain, path, port, entrypoints, SSL and project limits. Choose **Publish** for an existing project or **Create and publish** for a new one. **Save** records settings for the next publication. A failed build or readiness check keeps the last successful release live. Use **Unpublish** to remove the public route. The Code Workspace shows the live link, status, logs and activity.

To use both `example.com` and `www.example.com`, enter them in **Domain** and **Additional domain** on the same project. Point both DNS names at the server and add the TXT record shown for each custom hostname. Enable **Redirect to the primary domain** to send visitors to the main address while preserving the path and query. With redirection off, both hostnames serve the same release. Let's Encrypt provisions certificates for both hostnames when SSL is on.

The **Port** field starts with the selected template's port. For example, it uses `3000` for Next.js and Express, `5173` for Vite, and `4321` for Astro. Use the application's actual listening port for a Node.js server. Static builds are served by Production's shared HTTP server. Traefik's public entrypoints are separate from the application port. Leave **Use custom entrypoint for domain** off for automatic routing, or choose `web` for HTTP or `websecure` for HTTPS. Let's Encrypt still needs public port `80` for validation when you choose HTTPS only.

Supported releases are HTML/CSS/JavaScript with `index.html`, npm builds that produce a static site in `dist`, `out` or `build`, and Node.js HTTP applications with `npm start` and a server listening on the configured `PORT`. Projects with npm dependencies need a lockfile. Node.js runtime environment variables are set in the same project window and stored in the private production volume. Back up that volume and the certificate store as sensitive data. Application files are read-only at runtime, and application data should use a separate database or storage service. Source snapshots are limited to 24 MiB and 4,000 files, and compiled releases are limited to 512 MiB.

## Limits and visibility

- Each published project has settings for requests per second, concurrent requests, request body size and response deadline.
- The Production supervisor samples CPU time and resident memory of each build or Node.js process tree. It pauses workloads above their CPU allocation and stops workloads above their memory limit. The resource samples are periodic, so short bursts can exceed individual settings. Docker enforces the hard CPU, RAM and process limits for the entire Production service.
- The **Logs** tab switches between Preview and Production. The **Activity** tab shows publication, domain and certificate events, plus recent traffic, 5xx errors, rate-limited responses and average response time.
- Use this shared runtime for one installation owner and projects they trust. A hosted service for separate customers requires tenant isolation, such as separate containers with per-project cgroups.
