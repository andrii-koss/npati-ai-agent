import { prepareCommerceDocument } from "../commerce-presentation";
import type { AuthContext, Project } from "@npati/workspace";
import { TEMPLATE_CATALOG } from "@npati/shared";
import type { DataBackendService } from "./service";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaOperation } from "./data-provider";
import type { ProjectMigrationEngine } from "./migration-engine";
import type { AgentDataStudioService } from "./agent-data-service";
import { syncProjectMdSchema } from "./agent-data-service";
import type { ProjectAuthService } from "./auth-service";
import type { ProjectApiGatewayService } from "./gateway-service";
import type { DataStudioUiService } from "./studio-service";
import type { ProjectWorkspace } from "../project-workspace";
import { createWebsiteDataFiles } from "../website-data-scaffold";
import { DataStudioError } from "./identifier";

export const isCommerceWebsite = (prompt: string) => /інтернет[ -]?магазин|магазин|e-?commerce|online\s*(?:shop|store)|\bstore\b|\bshop\b/iu.test(prompt);

export interface WebsiteBootstrapServices {
  backends: DataBackendService;
  repository: DataBackendRepository;
  provider: DataProvider;
  migrations: ProjectMigrationEngine;
  agentData: AgentDataStudioService;
  auth: ProjectAuthService;
  gateway: ProjectApiGatewayService;
  studio: DataStudioUiService;
  workspace: ProjectWorkspace;
}

/** Trusted bootstrap of new dev objects, explicitly authorized by creating the site. */
export async function bootstrapWebsiteData(ctx: AuthContext, project: Project, prompt: string, services: WebsiteBootstrapServices): Promise<void> {
  // Creating a website does not authorize provisioning; only enrich an explicit attachment.
  if (!project.dataBackendId) return;
  const { backends, repository, provider, migrations, agentData, auth, gateway, studio, workspace } = services;
  const companyId = project.companyId;
  const commerce = isCommerceWebsite(prompt);
  const publicBase = process.env.NPATI_PROJECT_API_PUBLIC_URL || process.env.NPATI_AGENT_PUBLIC_DOMAIN || process.env.NPATI_WEB_ORIGIN;
  if (!publicBase) throw new DataStudioError(503, "website_bootstrap", "Configure NPATI_PROJECT_API_PUBLIC_URL to connect the website to its database", false, "PROJECT_API_URL_REQUIRED");
  let publicUrl: URL;
  try { publicUrl = new URL(publicBase); } catch { throw new DataStudioError(503, "website_bootstrap", "Invalid Project API public URL", false, "INVALID_API_URL"); }
  if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new DataStudioError(503, "website_bootstrap", "Invalid Project API public URL", false, "INVALID_API_URL");
  let backendId = project.dataBackendId;
  if (!backendId) {
    const backend = await backends.create(ctx, companyId, { name: `${project.name} data`.slice(0, 200) });
    await backends.attach(ctx, companyId, project.id, backend.id);
    backendId = backend.id;
  }
  const { backend } = await backends.get(ctx, companyId, backendId);
  if (backend.status !== "ready") throw new DataStudioError(503, "website_bootstrap", "Website database is not ready", true, "BACKEND_NOT_READY");
  let schema = await provider.introspectSchema(backend, "dev");
  if (commerce) {
    const template = TEMPLATE_CATALOG.find(template => template.id === "ecommerce")!;
    const existing = template.collections.filter(collection => schema.tables.some(table => table.name === collection.name));
    if (!existing.length) await agentData.applyTemplate(ctx, companyId, project.id, "ecommerce", { approved: true });
    else if (existing.length !== template.collections.length) throw new DataStudioError(409, "website_bootstrap", "An incomplete store schema requires repair before generating the website", false, "INCOMPLETE_STORE_SCHEMA");
  }
  schema = await provider.introspectSchema(backend, "dev");
  const operations: SchemaOperation[] = [];
  if (!schema.tables.some(table => table.name === "contact_messages")) operations.push({ kind: "create_collection", collection: "contact_messages", fields: [{ name: "name", type: "string", required: true }, { name: "email", type: "string", required: true }, { name: "message", type: "text", required: true }] });
  if (!schema.tables.some(table => table.name === "form_submissions")) operations.push({ kind: "create_collection", collection: "form_submissions", fields: [{ name: "form_name", type: "string", required: true }, { name: "payload", type: "json", required: true }] });
  if (operations.length) await migrations.applyBatch(ctx, { backend, environment: "dev", operations, authorId: ctx.userId, policies: operations.map(operation => ({ collection: operation.collection, rule: "public", actions: ["insert"] })) });
  await auth.ensureInitialized(ctx, backend, "dev");
  const environment = await repository.environment(ctx, companyId, backend.id, "dev");
  await repository.setEnvironment(ctx, companyId, backend.id, "dev", { providerConfig: { ...environment.providerConfig, ...(commerce ? { commerce: true } : {}), websiteBootstrap: { projectId: project.id, status: "preparing" } } });
  const webOrigin = process.env.NPATI_WEB_ORIGIN;
  const previousOrigins = (environment.providerConfig.corsOriginsByProject as Record<string, string[]> | undefined)?.[project.id] ?? [];
  const origins = [...new Set([...previousOrigins, publicUrl.origin, ...(webOrigin ? [new URL(webOrigin).origin] : [])])];
  await studio.updateCorsOrigins(ctx, companyId, project.id, "dev", origins);
  const apiEnvironment = await gateway.getSandboxEnvironment(ctx, companyId, project.id);
  if (!apiEnvironment.PROJECT_API_URL || !apiEnvironment.PROJECT_PUBLISHABLE_KEY) throw new DataStudioError(503, "website_bootstrap", "Project API configuration is unavailable", true, "PROJECT_API_UNAVAILABLE");
  // The SDK synchronizer must succeed before creating files that import it.
  const inspected = await gateway.inspectApi(ctx, companyId, project.id);
  if (!inspected.sdk?.available) throw new DataStudioError(503, "website_bootstrap", "Project client SDK could not be delivered", true, "PROJECT_SDK_UNAVAILABLE");
  const files = createWebsiteDataFiles(publicBase.replace(new RegExp("/+$"), "") + "/v1/projects/" + encodeURIComponent(project.id), apiEnvironment.PROJECT_PUBLISHABLE_KEY, project.id, commerce);
  for (const [filePath, content] of Object.entries(files)) {
    let existing;
    try { existing = await workspace.readFile(ctx, companyId, project.id, filePath); } catch { /* New scaffold asset. */ }
    if (existing) continue;
    await workspace.createFile(ctx, companyId, project.id, filePath, content);
  }
  if (commerce) {
    const config = await workspace.readFile(ctx, companyId, project.id, "website.config.json");
    const document = JSON.parse(config.content);
    const storefront = prepareCommerceDocument(document);
    if (storefront !== document) await workspace.writeFile(ctx, companyId, project.id, "website.config.json", JSON.stringify(storefront, null, 2)+"\n", config.revision);
    const existing = await workspace.readFile(ctx, companyId, project.id, "app/page.tsx");
    // Only adapt our generated homepage, never overwrite a custom agent/user page.
    if ((existing.content.includes("BlockRenderer") && existing.content.includes("websiteConfig") && !existing.content.includes("ProjectStore")) || /^import \{ ProjectStore \}[^]*return <ProjectStore \/>/.test(existing.content)) await workspace.writeFile(ctx, companyId, project.id, "app/page.tsx", files["app/page.tsx"]!, existing.revision);
    const products = await migrations.listOwnerRows(ctx, backend, "dev", "products", { limit: 1 });
    if (!products.length) {
      const initialProducts = [
        { title: "Механічна клавіатура", slug: "mechanical-keyboard", description: "RGB геймерська клавіатура з тактильними перемикачами", price: 2499, is_active: true, image_url: null },
        { title: "Бездротова миша", slug: "wireless-mouse", description: "Ергономічна бездротова миша з високою точністю", price: 1299, is_active: true, image_url: null },
        { title: "Ігрова гарнітура", slug: "gaming-headset", description: "Звукова гарнітура з просторовим аудіо", price: 3199, is_active: true, image_url: null },
      ];
      for (const item of initialProducts) {
        const product = await migrations.createOwnerRow(ctx, backend, "dev", "products", item);
        if (product) {
          await migrations.createOwnerRow(ctx, backend, "dev", "product_variants", { product_id: product.id, sku: `SKU-${item.slug.toUpperCase()}`, title: "Стандарт", price: item.price, inventory_count: 50 });
        }
      }
    }
  }
  const renderer = await workspace.readFile(ctx, companyId, project.id, "components/BlockRenderer.tsx");
  if (!renderer.content.includes('import { ProjectForm }')) {
    const content = renderer.content.replace(/("use client";?)/, '$1\nimport { ProjectForm } from "./ProjectForm";')
      .replace(/<form className="card" onSubmit=\{\(e\) => \{ e\.preventDefault\(\); alert\("Thank you! Message sent\."\); \}\}>[\s\S]*?<\/form>/, '<ProjectForm collection="contact_messages" />')
      .replace('    case "custom":', '    case "forms":\n      return <ProjectForm fields={props.fields} title={props.title || "Форма"} />;\n\n    case "custom":');
    await workspace.writeFile(ctx, companyId, project.id, "components/BlockRenderer.tsx", content, renderer.revision);
  }
  const layout = await workspace.readFile(ctx, companyId, project.id, "app/layout.tsx");
  if (!commerce && !layout.content.includes('href="/auth"')) await workspace.writeFile(ctx, companyId, project.id, "app/layout.tsx", layout.content.replace("<body>{children}</body>", '<body><nav style={{padding:16}}><a href="/auth">Вхід / Реєстрація</a></nav>{children}</body>'), layout.revision);
  schema = await provider.introspectSchema(backend, "dev");
  await repository.setExpectedSchema(ctx, companyId, backend.id, "dev", schema, provider.schemaFingerprint(schema));
  const completed = await repository.environment(ctx, companyId, backend.id, "dev");
  await repository.setEnvironment(ctx, companyId, backend.id, "dev", { providerConfig: { ...completed.providerConfig, websiteBootstrap: { projectId: project.id, status: "ready" } } });
  await syncProjectMdSchema(ctx, companyId, project.id, backend.name, schema, workspace);
}
