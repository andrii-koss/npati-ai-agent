import type { WebsiteBlock, WebsiteDocument, WebsitePage } from "./website-schema";
import type { WebsiteRendererAdapter } from "./website-renderer";

const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char] ?? char);

const pageFile = (slug: string): string => {
  if (!slug || slug === "/") return "index.html";
  const safe = slug.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9/_-]/gi, "-");
  return `${safe || "index"}.html`;
};

const safeHref = (value: unknown): string => {
  const href = String(value ?? "#").trim();
  if (/^(?:javascript|data|vbscript):/i.test(href)) return "#";
  if (href.startsWith("/")) return pageFile(href);
  return href || "#";
};

function renderBlock(block: WebsiteBlock, doc: WebsiteDocument): string {
  if (block.isHidden) return "";
  const props = block.props ?? {};
  const title = escapeHtml(props.title ?? block.name ?? "");
  const subtitle = escapeHtml(props.subtitle ?? props.description ?? "");
  const sectionId = escapeHtml(block.type);
  const button = (label: unknown, href: unknown, secondary = false) => label
    ? `<a class="button${secondary ? " secondary" : ""}" href="${escapeHtml(safeHref(href))}">${escapeHtml(label)}</a>`
    : "";

  switch (block.type) {
    case "navbar": {
      const links = Array.isArray(props.links) ? props.links : [];
      return `<header class="site-nav"><a class="brand" href="index.html">${escapeHtml(props.brandName || doc.name)}</a><nav>${links.map((item: Record<string, unknown>) => `<a href="${escapeHtml(safeHref(item.url))}">${escapeHtml(item.label || item.text)}</a>`).join("")}</nav>${button(props.ctaText, props.ctaUrl)}</header>`;
    }
    case "hero":
      return `<section class="hero" id="hero"><div class="wrap"><span class="eyebrow">${escapeHtml(props.badge)}</span><h1>${title}</h1><p>${subtitle}</p><div class="actions">${button(props.primaryCtaText, props.primaryCtaUrl)}${button(props.secondaryCtaText, props.secondaryCtaUrl, true)}</div></div></section>`;
    case "features": {
      const items = Array.isArray(props.items) ? props.items : [];
      return `<section class="section" id="features"><div class="wrap"><h2>${title}</h2><p class="section-intro">${subtitle}</p><div class="grid">${items.map((item: Record<string, unknown>) => `<article class="card"><span class="icon">${escapeHtml(item.icon)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></article>`).join("")}</div></div></section>`;
    }
    case "pricing": {
      const tiers = Array.isArray(props.tiers) ? props.tiers : [];
      return `<section class="section muted" id="pricing"><div class="wrap"><h2>${title}</h2><p class="section-intro">${subtitle}</p><div class="grid">${tiers.map((tier: Record<string, unknown>) => `<article class="card price"><h3>${escapeHtml(tier.name)}</h3><strong>${escapeHtml(tier.price)}<small>${escapeHtml(props.billingPeriod || "")}</small></strong><p>${escapeHtml(tier.description)}</p><ul>${(Array.isArray(tier.features) ? tier.features : []).map((feature: unknown) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul>${button(tier.buttonText, tier.buttonUrl)}</article>`).join("")}</div></div></section>`;
    }
    case "cta":
      return `<section class="section cta" id="cta"><div class="wrap"><h2>${title}</h2><p>${subtitle}</p>${button(props.buttonText || props.ctaText, props.buttonUrl || props.ctaUrl)}</div></section>`;
    case "contact":
    case "forms":
      return `<section class="section" id="contact"><div class="wrap"><h2>${title}</h2><p>${subtitle}</p>${props.email ? `<p><a href="mailto:${escapeHtml(props.email)}">${escapeHtml(props.email)}</a></p>` : ""}</div></section>`;
    case "footer":
      return `<footer class="site-footer"><div class="wrap"><strong>${escapeHtml(props.brandName || doc.name)}</strong><p>${escapeHtml(props.description)}</p></div></footer>`;
    default:
      return `<section class="section" id="${sectionId}"><div class="wrap"><h2>${title}</h2><p>${subtitle}</p></div></section>`;
  }
}

function renderPage(doc: WebsiteDocument, page: WebsitePage): string {
  const color = /^#[0-9a-f]{6}$/i.test(doc.theme.primaryColor) ? doc.theme.primaryColor : "#2563eb";
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.seo?.title || page.title || doc.name)}</title><meta name="description" content="${escapeHtml(page.seo?.description || doc.name)}"><style>
:root{--accent:${color};font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17233d;background:#fff}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}.wrap{max-width:1160px;margin:auto;padding:0 28px}.site-nav{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:22px max(28px,calc((100vw - 1104px)/2));background:#101b32;color:#fff;flex-wrap:wrap}.site-nav nav{display:flex;gap:20px;flex-wrap:wrap;font-size:14px}.brand{font-size:22px;font-weight:800}.button{display:inline-flex;align-items:center;justify-content:center;padding:13px 21px;border-radius:10px;background:var(--accent);color:#fff;font-weight:700}.button.secondary{background:transparent;color:inherit;border:1px solid currentColor}.hero{padding:112px 0;background:linear-gradient(135deg,#101b32,#1c3763);color:#fff}.hero .wrap{max-width:850px}.eyebrow{display:block;color:#a8c8ff;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.hero h1{font-size:clamp(42px,6vw,72px);line-height:1.08;margin:20px 0}.hero p{font-size:20px;line-height:1.6;color:#d8e4f7}.actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:30px}.section{padding:86px 0}.section.muted{background:#f3f7fc}.section h2{font-size:clamp(30px,4vw,44px);margin:0 0 14px}.section-intro{font-size:18px;color:#5a6880;max-width:740px;line-height:1.6;margin:0 0 34px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:22px}.card{padding:28px;border:1px solid #dfe7f2;border-radius:18px;background:#fff;box-shadow:0 12px 30px #101b320a}.card h3{font-size:21px;margin:12px 0}.card p{color:#5a6880;line-height:1.6}.icon{font-size:28px}.price strong{display:block;font-size:34px;color:var(--accent)}.price small{font-size:14px;color:#5a6880}.price ul{padding-left:20px;line-height:2;margin:24px 0}.price .button{margin-top:10px}.cta{background:#101b32;color:#fff;text-align:center}.cta p{color:#d8e4f7}.site-footer{padding:50px 0;background:#0b1324;color:#fff}.site-footer p{color:#b5c2d8}@media(max-width:700px){.site-nav{padding:20px}.hero{padding:80px 0}.section{padding:60px 0}.site-nav nav{width:100%;order:3}}
</style></head><body>${page.blocks.map((block) => renderBlock(block, doc)).join("\n")}</body></html>\n`;
}

export class StaticHtmlAdapter implements WebsiteRendererAdapter {
  readonly framework = "static" as const;

  scaffoldProject(doc: WebsiteDocument): Record<string, string> {
    const files: Record<string, string> = {
      "website.config.json": JSON.stringify(doc, null, 2) + "\n",
    };
    for (const page of doc.pages) files[pageFile(page.slug)] = renderPage(doc, page);
    return files;
  }

  syncDocument(doc: WebsiteDocument): Record<string, string> {
    return this.scaffoldProject(doc);
  }
}