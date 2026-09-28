import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("architecture boundaries", () => {
  it("keeps domain packages independent of OmniRoute source internals", () => {
    for (const packageName of ["agent", "business-brain", "memory", "skills", "branding", "hub-connector"]) {
      const manifest = readFileSync(join(process.cwd(), "packages", packageName, "package.json"), "utf8");
      expect(manifest).not.toContain("vendor/omniroute");
    }
  });

  it("keeps the web proxy resilient when the API container is recreated", () => {
    const nginxConfig = readFileSync(join(process.cwd(), "apps", "web", "nginx.conf"), "utf8");

    expect(nginxConfig).toContain("resolver 127.0.0.11");
    expect(nginxConfig).toContain("server agent-api:3001 resolve;");
    expect(nginxConfig).toContain("proxy_pass http://agent_api/;");
  });

  it("keeps native workspace dependencies and local liveness in the API image", () => {
    const dockerfile = readFileSync(join(process.cwd(), "apps", "agent-api", "Dockerfile"), "utf8");
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    const dokployCompose = readFileSync(join(process.cwd(), "docker-compose.dokploy.yml"), "utf8");

    expect(dockerfile).toContain(
      "COPY --from=build /app/apps/agent-api/node_modules ./node_modules",
    );
    expect(compose).toContain("http://127.0.0.1:3001/health/live");
    expect(compose).not.toContain("fetch('http://127.0.0.1:3001/health')");
    expect(dokployCompose).toContain("http://127.0.0.1:3001/health/live");
    expect(dokployCompose).not.toContain("fetch('http://127.0.0.1:3001/health')");
    expect(dokployCompose).toContain("omniroute-db-init:");
    expect(dokployCompose).toContain("CREATE TABLE IF NOT EXISTS compression_run_telemetry");
    expect(dokployCompose).toContain("OMNIROUTE_MANAGEMENT_PASSWORD is required");
  });

  it("keeps Company navigation distinct without a duplicate Agents entry", () => {
    const appSource = readFileSync(join(process.cwd(), "apps", "web", "src", "App.tsx"), "utf8");
    const companyPage = readFileSync(join(process.cwd(), "apps", "web", "src", "CompanyPage.tsx"), "utf8");

    expect(appSource).toContain('to: "/settings/company"');
    expect(appSource).toContain('title: t("settings.cards.company.title")');
    expect(appSource).toContain('t("settings.cards.company.title")');
    expect(appSource).not.toContain('title: "Agents"');
    expect(appSource).toContain('<Route path="/company"');
    expect(appSource).toContain('<Route path="/settings/company"');
    expect(appSource).not.toContain('<Route path="/agents"');
    expect(companyPage).toContain('init?.body != null');
    expect(companyPage).toContain('?expectedRevision=');
  });
});
