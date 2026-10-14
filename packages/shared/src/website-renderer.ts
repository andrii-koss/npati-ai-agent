import { StaticHtmlAdapter } from "./static-website-renderer";
import type { WebsiteDocument, WebsiteBlock } from "./website-schema";

export interface WebsiteRendererAdapter {
  framework: "nextjs" | "vite" | "static" | "astro";
  scaffoldProject(doc: WebsiteDocument): Record<string, string>;
  syncDocument(doc: WebsiteDocument, existingFiles?: Record<string, string>): Record<string, string>;
}

export class NextJsAdapter implements WebsiteRendererAdapter {
  readonly framework = "nextjs" as const;

  scaffoldProject(doc: WebsiteDocument): Record<string, string> {
    const files: Record<string, string> = {};

    // 1. package.json
    files["package.json"] = JSON.stringify(
      {
        name: doc.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "npati-website",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "next dev --hostname 0.0.0.0",
          build: "next build",
          start: "next start --hostname 0.0.0.0",
        },
        dependencies: {
          next: "^14.2.14",
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          "@types/node": "^20",
          "@types/react": "^18",
          "@types/react-dom": "^18",
          typescript: "^5",
        },
      },
      null,
      2
    ) + "\n";

    // 2. tsconfig.json
    files["tsconfig.json"] = JSON.stringify(
      {
        compilerOptions: {
          target: "es5",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] },
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2
    ) + "\n";

    // 3. website.config.json (Single Source of Truth)
    files["website.config.json"] = JSON.stringify(doc, null, 2) + "\n";

    // 4. app/globals.css
    files["app/globals.css"] = this.generateGlobalsCss(doc);

    // 5. app/layout.tsx
    files["app/layout.tsx"] = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: ${JSON.stringify(doc.name)},
  description: "Created with NPATI AI Agent & Website Builder",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
`;

    // 6. components/BlockRenderer.tsx
    files["components/BlockRenderer.tsx"] = this.generateBlockRendererComponent();

    // 7. app/page.tsx (Home page)
    files["app/page.tsx"] = `"use client";

import websiteConfig from "../website.config.json";
import { BlockRenderer } from "../components/BlockRenderer";

export default function HomePage() {
  const homePage = websiteConfig.pages.find((p) => p.slug === "/") || websiteConfig.pages[0];
  const blocks = homePage?.blocks || [];

  return (
    <main className="website-root">
      {blocks.map((block: any) => (
        <BlockRenderer key={block.id} block={block} theme={websiteConfig.theme} />
      ))}
    </main>
  );
}
`;

    // 8. Generate additional page files for non-root pages if present
    for (const page of doc.pages) {
      if (page.slug && page.slug !== "/") {
        const cleanSlug = page.slug.replace(/^\//, "");
        files[`app/${cleanSlug}/page.tsx`] = `"use client";

import websiteConfig from "../../website.config.json";
import { BlockRenderer } from "../../components/BlockRenderer";

export default function Page() {
  const currentPage = websiteConfig.pages.find((p) => p.slug === "/${cleanSlug}" || p.slug === "${cleanSlug}") || websiteConfig.pages[0];
  const blocks = currentPage?.blocks || [];

  return (
    <main className="website-root">
      {blocks.map((block: any) => (
        <BlockRenderer key={block.id} block={block} theme={websiteConfig.theme} />
      ))}
    </main>
  );
}
`;
      }
    }

    return files;
  }

  syncDocument(doc: WebsiteDocument, existingFiles?: Record<string, string>): Record<string, string> {
    const updated: Record<string, string> = {
      ...(existingFiles || {}),
    };

    // Update single source of truth
    updated["website.config.json"] = JSON.stringify(doc, null, 2) + "\n";
    // Sync globals.css with new theme tokens
    updated["app/globals.css"] = this.generateGlobalsCss(doc);

    // Sync any new pages
    for (const page of doc.pages) {
      if (page.slug && page.slug !== "/") {
        const cleanSlug = page.slug.replace(/^\//, "");
        const path = `app/${cleanSlug}/page.tsx`;
        if (!updated[path]) {
          updated[path] = `"use client";

import websiteConfig from "../../website.config.json";
import { BlockRenderer } from "../../components/BlockRenderer";

export default function Page() {
  const currentPage = websiteConfig.pages.find((p) => p.slug === "/${cleanSlug}" || p.slug === "${cleanSlug}") || websiteConfig.pages[0];
  const blocks = currentPage?.blocks || [];

  return (
    <main className="website-root">
      {blocks.map((block: any) => (
        <BlockRenderer key={block.id} block={block} theme={websiteConfig.theme} />
      ))}
    </main>
  );
}
`;
        }
      }
    }

    return updated;
  }

  private generateGlobalsCss(doc: WebsiteDocument): string {
    const t = doc.theme;
    return `:root {
  --primary-color: ${t.primaryColor};
  --secondary-color: ${t.secondaryColor};
  --accent-color: ${t.accentColor};
  --bg-color: ${t.backgroundColor};
  --text-color: ${t.textColor};
  --muted-color: ${t.mutedColor};
  --font-family: ${t.fontFamily === "system" ? "system-ui, -apple-system, sans-serif" : `'${t.fontFamily}', sans-serif`};
  --border-radius: ${t.borderRadius === "full" ? "9999px" : t.borderRadius === "lg" ? "16px" : t.borderRadius === "md" ? "10px" : t.borderRadius === "sm" ? "6px" : "0px"};
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--bg-color);
  color: var(--text-color);
  font-family: var(--font-family);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a {
  color: inherit;
  text-decoration: none;
}

.website-root {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.section-container {
  width: 100%;
  margin-left: auto;
  margin-right: auto;
  padding-left: 1.5rem;
  padding-right: 1.5rem;
}

.container-small { max-width: 680px; }
.container-medium { max-width: 960px; }
.container-large { max-width: 1200px; }
.container-full { max-width: 100%; }

.pad-y-none { padding-top: 0; padding-bottom: 0; }
.pad-y-small { padding-top: 2rem; padding-bottom: 2rem; }
.pad-y-medium { padding-top: 4rem; padding-bottom: 4rem; }
.pad-y-large { padding-top: 6rem; padding-bottom: 6rem; }
.pad-y-xlarge { padding-top: 8rem; padding-bottom: 8rem; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  padding: 0.75rem 1.5rem;
  border-radius: var(--border-radius);
  transition: all 0.2s ease;
  cursor: pointer;
  border: 1px solid transparent;
  font-size: 0.95rem;
}

.btn-primary {
  background-color: var(--primary-color);
  color: #ffffff;
}

.btn-primary:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.btn-secondary {
  background-color: rgba(255, 255, 255, 0.08);
  color: var(--text-color);
  border-color: rgba(255, 255, 255, 0.15);
}

.btn-secondary:hover {
  background-color: rgba(255, 255, 255, 0.16);
}

.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem; }
.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 2rem; }
.grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; }

.card {
  background-color: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--border-radius);
  padding: 2rem;
  transition: transform 0.2s ease, border-color 0.2s ease;
}

.card:hover {
  border-color: var(--primary-color);
  transform: translateY(-2px);
}

@media (max-width: 768px) {
  .pad-y-xlarge { padding-top: 4rem; padding-bottom: 4rem; }
  .pad-y-large { padding-top: 3rem; padding-bottom: 3rem; }
}
`;
  }

  private generateBlockRendererComponent(): string {
    return `"use client";

import React, { useState } from "react";

export function BlockRenderer({ block, theme }: { block: any; theme: any }) {
  if (block.isHidden) return null;

  const { type, props = {}, styles = {} } = block;
  const containerClass = \`section-container container-\${styles.maxWidth || "large"}\`;
  const padClass = \`pad-y-\${styles.paddingY || "medium"}\`;
  const sectionStyle: React.CSSProperties = {
    backgroundColor: styles.backgroundColor || undefined,
    color: styles.textColor || undefined,
    textAlign: (styles.textAlign as any) || undefined,
    borderRadius: styles.borderRadius ? (styles.borderRadius === "lg" ? "16px" : "8px") : undefined,
  };

  switch (type) {
    case "navbar":
      return (
        <header
          style={{
            backgroundColor: styles.backgroundColor || "var(--bg-color)",
            position: props.sticky ? "sticky" : "relative",
            top: 0,
            zIndex: 50,
            borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
          }}
          className={padClass}
        >
          <div className={containerClass} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontWeight: 700, fontSize: "1.25rem" }}>
              {props.logoUrl && <img src={props.logoUrl} alt={props.brandName} style={{ height: "32px" }} />}
              <span>{props.brandName}</span>
            </div>
            <nav style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
              {(props.links || []).map((link: any, idx: number) => (
                <a key={idx} href={link.url} style={{ color: "var(--muted-color)", fontWeight: 500 }}>
                  {link.text}
                </a>
              ))}
              {props.ctaText && (
                <a href={props.ctaUrl || "#"} className="btn btn-primary">
                  {props.ctaText}
                </a>
              )}
            </nav>
          </div>
        </header>
      );

    case "hero":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass}>
            {props.layout === "split" && props.imageUrl ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "3rem", alignItems: "center" }}>
                <div style={{ textAlign: "left" }}>
                  {props.badge && (
                    <span style={{ display: "inline-block", padding: "0.35rem 0.85rem", borderRadius: "9999px", background: "rgba(59, 130, 246, 0.15)", color: "var(--primary-color)", fontSize: "0.85rem", fontWeight: 600, marginBottom: "1rem" }}>
                      {props.badge}
                    </span>
                  )}
                  <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.5rem)", fontWeight: 800, lineHeight: 1.15, marginBottom: "1.25rem" }}>
                    {props.title}
                  </h1>
                  <p style={{ color: "var(--muted-color)", fontSize: "1.15rem", marginBottom: "2rem" }}>
                    {props.subtitle}
                  </p>
                  <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                    {props.primaryCtaText && (
                      <a href={props.primaryCtaUrl || "#"} className="btn btn-primary">
                        {props.primaryCtaText}
                      </a>
                    )}
                    {props.secondaryCtaText && (
                      <a href={props.secondaryCtaUrl || "#"} className="btn btn-secondary">
                        {props.secondaryCtaText}
                      </a>
                    )}
                  </div>
                </div>
                <div>
                  <img src={props.imageUrl} alt={props.title} style={{ width: "100%", borderRadius: "16px", boxShadow: "0 20px 40px rgba(0,0,0,0.5)", objectFit: "cover" }} />
                </div>
              </div>
            ) : (
              <div style={{ maxWidth: "800px", margin: "0 auto", textAlign: styles.textAlign || "center" }}>
                {props.badge && (
                  <span style={{ display: "inline-block", padding: "0.35rem 0.85rem", borderRadius: "9999px", background: "rgba(59, 130, 246, 0.15)", color: "var(--primary-color)", fontSize: "0.85rem", fontWeight: 600, marginBottom: "1rem" }}>
                    {props.badge}
                  </span>
                )}
                <h1 style={{ fontSize: "clamp(2.5rem, 6vw, 4rem)", fontWeight: 800, lineHeight: 1.15, marginBottom: "1.25rem" }}>
                  {props.title}
                </h1>
                <p style={{ color: "var(--muted-color)", fontSize: "1.2rem", marginBottom: "2.5rem" }}>
                  {props.subtitle}
                </p>
                <div style={{ display: "flex", gap: "1rem", justifyContent: styles.textAlign === "left" ? "flex-start" : "center", flexWrap: "wrap" }}>
                  {props.primaryCtaText && (
                    <a href={props.primaryCtaUrl || "#"} className="btn btn-primary">
                      {props.primaryCtaText}
                    </a>
                  )}
                  {props.secondaryCtaText && (
                    <a href={props.secondaryCtaUrl || "#"} className="btn btn-secondary">
                      {props.secondaryCtaText}
                    </a>
                  )}
                </div>
                {props.imageUrl && (
                  <div style={{ marginTop: "3.5rem" }}>
                    <img src={props.imageUrl} alt={props.title} style={{ width: "100%", borderRadius: "16px", boxShadow: "0 25px 50px rgba(0,0,0,0.6)" }} />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      );

    case "features":
      return (
        <section style={sectionStyle} className={padClass} id="features">
          <div className={containerClass}>
            <div style={{ textAlign: "center", marginBottom: "3.5rem" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>{props.title}</h2>
              {props.subtitle && <p style={{ color: "var(--muted-color)", fontSize: "1.1rem" }}>{props.subtitle}</p>}
            </div>
            <div className={\`grid-\${props.columns || 3}\`}>
              {(props.items || []).map((item: any, idx: number) => (
                <div key={idx} className="card">
                  <div style={{ fontSize: "2rem", marginBottom: "1rem" }}>{item.icon}</div>
                  <h3 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>{item.title}</h3>
                  <p style={{ color: "var(--muted-color)", fontSize: "0.95rem" }}>{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      );

    case "pricing":
      return (
        <section style={sectionStyle} className={padClass} id="pricing">
          <div className={containerClass}>
            <div style={{ textAlign: "center", marginBottom: "3.5rem" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>{props.title}</h2>
              {props.subtitle && <p style={{ color: "var(--muted-color)", fontSize: "1.1rem" }}>{props.subtitle}</p>}
            </div>
            <div className="grid-3">
              {(props.tiers || []).map((tier: any, idx: number) => (
                <div
                  key={idx}
                  className="card"
                  style={{
                    position: "relative",
                    borderColor: tier.isPopular ? "var(--primary-color)" : undefined,
                    boxShadow: tier.isPopular ? "0 10px 30px rgba(59, 130, 246, 0.2)" : undefined,
                  }}
                >
                  {tier.isPopular && (
                    <span style={{ position: "absolute", top: "-12px", right: "20px", background: "var(--primary-color)", color: "#fff", fontSize: "0.75rem", fontWeight: 700, padding: "0.2rem 0.6rem", borderRadius: "9999px" }}>
                      POPULAR
                    </span>
                  )}
                  <h3 style={{ fontSize: "1.3rem", fontWeight: 700 }}>{tier.name}</h3>
                  <p style={{ color: "var(--muted-color)", fontSize: "0.9rem", minHeight: "2.5rem" }}>{tier.description}</p>
                  <div style={{ margin: "1.5rem 0", display: "flex", alignItems: "baseline" }}>
                    <span style={{ fontSize: "2.5rem", fontWeight: 800 }}>{tier.price}</span>
                    <span style={{ color: "var(--muted-color)", marginLeft: "0.35rem" }}>{props.billingPeriod || "/month"}</span>
                  </div>
                  <ul style={{ listStyle: "none", marginBottom: "2rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    {(tier.features || []).map((feat: string, fIdx: number) => (
                      <li key={fIdx} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.95rem" }}>
                        <span style={{ color: "var(--primary-color)" }}>✓</span> {feat}
                      </li>
                    ))}
                  </ul>
                  <a
                    href={tier.buttonUrl || "#"}
                    className={\`btn \${tier.isPopular ? "btn-primary" : "btn-secondary"}\`}
                    style={{ width: "100%" }}
                  >
                    {tier.buttonText || "Get Started"}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </section>
      );

    case "cta":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass}>
            <div style={{ backgroundColor: "rgba(255, 255, 255, 0.05)", border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: "20px", padding: "3.5rem 2rem", textAlign: "center" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "1rem" }}>{props.title}</h2>
              <p style={{ color: "var(--muted-color)", fontSize: "1.1rem", maxWidth: "600px", margin: "0 auto 2rem auto" }}>
                {props.subtitle}
              </p>
              <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
                {props.primaryText && (
                  <a href={props.primaryUrl || "#"} className="btn btn-primary">
                    {props.primaryText}
                  </a>
                )}
                {props.secondaryText && (
                  <a href={props.secondaryUrl || "#"} className="btn btn-secondary">
                    {props.secondaryText}
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
      );

    case "testimonials":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass}>
            <div style={{ textAlign: "center", marginBottom: "3rem" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>{props.title}</h2>
              {props.subtitle && <p style={{ color: "var(--muted-color)", fontSize: "1.1rem" }}>{props.subtitle}</p>}
            </div>
            <div className="grid-2">
              {(props.items || []).map((item: any, idx: number) => (
                <div key={idx} className="card">
                  <p style={{ fontSize: "1.05rem", fontStyle: "italic", marginBottom: "1.5rem" }}>"{item.quote}"</p>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    {item.avatar && <img src={item.avatar} alt={item.author} style={{ width: "48px", height: "48px", borderRadius: "50%", objectFit: "cover" }} />}
                    <div>
                      <h4 style={{ fontWeight: 600 }}>{item.author}</h4>
                      <small style={{ color: "var(--muted-color)" }}>{item.role}</small>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      );

    case "faq":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass}>
            <div style={{ textAlign: "center", marginBottom: "3rem" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>{props.title}</h2>
              {props.subtitle && <p style={{ color: "var(--muted-color)", fontSize: "1.1rem" }}>{props.subtitle}</p>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {(props.items || []).map((faqItem: any, idx: number) => (
                <details key={idx} style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "8px", padding: "1.25rem", cursor: "pointer" }}>
                  <summary style={{ fontWeight: 600, fontSize: "1.1rem", outline: "none" }}>{faqItem.question}</summary>
                  <p style={{ color: "var(--muted-color)", marginTop: "0.75rem", fontSize: "0.95rem" }}>{faqItem.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      );

    case "gallery":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass}>
            <div style={{ textAlign: "center", marginBottom: "3rem" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>{props.title}</h2>
              {props.subtitle && <p style={{ color: "var(--muted-color)", fontSize: "1.1rem" }}>{props.subtitle}</p>}
            </div>
            <div className={\`grid-\${props.columns || 3}\`}>
              {(props.items || []).map((img: any, idx: number) => (
                <div key={idx} style={{ overflow: "hidden", borderRadius: "12px", border: "1px solid rgba(255, 255, 255, 0.1)" }}>
                  <img src={img.url} alt={img.caption || ""} style={{ width: "100%", height: "220px", objectFit: "cover" }} />
                  {img.caption && <p style={{ padding: "0.75rem", fontSize: "0.9rem", color: "var(--muted-color)" }}>{img.caption}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>
      );

    case "stats":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass}>
            {props.title && <h2 style={{ textAlign: "center", fontSize: "1.75rem", fontWeight: 700, marginBottom: "2rem" }}>{props.title}</h2>}
            <div className="grid-4" style={{ textAlign: "center" }}>
              {(props.items || []).map((stat: any, idx: number) => (
                <div key={idx}>
                  <div style={{ fontSize: "2.5rem", fontWeight: 800, color: "var(--primary-color)" }}>{stat.value}</div>
                  <div style={{ fontWeight: 600, margin: "0.25rem 0" }}>{stat.label}</div>
                  {stat.description && <small style={{ color: "var(--muted-color)" }}>{stat.description}</small>}
                </div>
              ))}
            </div>
          </div>
        </section>
      );

    case "contact":
      return (
        <section style={sectionStyle} className={padClass} id="contact">
          <div className={containerClass}>
            <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
              <h2 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>{props.title}</h2>
              {props.subtitle && <p style={{ color: "var(--muted-color)", fontSize: "1.1rem" }}>{props.subtitle}</p>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "2rem" }}>
              <div className="card">
                <h3 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}>Direct Contacts</h3>
                {props.email && <p style={{ marginBottom: "0.5rem" }}>📧 <a href={\`mailto:\${props.email}\`} style={{ color: "var(--primary-color)" }}>{props.email}</a></p>}
                {props.phone && <p style={{ marginBottom: "0.5rem" }}>📞 {props.phone}</p>}
                {props.address && <p style={{ color: "var(--muted-color)" }}>📍 {props.address}</p>}
              </div>
              {props.showForm && (
                <form className="card" onSubmit={(e) => { e.preventDefault(); alert("Thank you! Message sent."); }}>
                  <div style={{ marginBottom: "1rem" }}>
                    <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem" }}>Your Name</label>
                    <input type="text" required style={{ width: "100%", padding: "0.6rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "6px", color: "#fff" }} />
                  </div>
                  <div style={{ marginBottom: "1rem" }}>
                    <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem" }}>Email</label>
                    <input type="email" required style={{ width: "100%", padding: "0.6rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "6px", color: "#fff" }} />
                  </div>
                  <div style={{ marginBottom: "1.25rem" }}>
                    <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem" }}>Message</label>
                    <textarea rows={3} required style={{ width: "100%", padding: "0.6rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "6px", color: "#fff" }} />
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                    {props.buttonText || "Send Message"}
                  </button>
                </form>
              )}
            </div>
          </div>
        </section>
      );

    case "footer":
      return (
        <footer style={{ backgroundColor: styles.backgroundColor || "#05080f", borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: "auto" }} className={padClass}>
          <div className={containerClass}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "2.5rem", marginBottom: "2.5rem" }}>
              <div>
                <h3 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: "0.75rem", color: "#fff" }}>{props.brandName}</h3>
                <p style={{ color: "var(--muted-color)", fontSize: "0.9rem" }}>{props.brandDescription}</p>
              </div>
              {(props.columns || []).map((col: any, idx: number) => (
                <div key={idx}>
                  <h4 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#fff", marginBottom: "0.75rem" }}>{col.title}</h4>
                  <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {(col.links || []).map((link: any, lIdx: number) => (
                      <li key={lIdx}>
                        <a href={link.url} style={{ color: "var(--muted-color)", fontSize: "0.85rem" }}>{link.text}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "1.5rem", textAlign: "center", color: "var(--muted-color)", fontSize: "0.85rem" }}>
              {props.copyright}
            </div>
          </div>
        </footer>
      );

    case "custom":
      return (
        <section style={sectionStyle} className={padClass}>
          <div className={containerClass} dangerouslySetInnerHTML={{ __html: props.htmlContent || "" }} />
        </section>
      );

    default:
      return null;
  }
}
`;
  }
}

export class ViteAdapter implements WebsiteRendererAdapter {
  readonly framework = "vite" as const;

  scaffoldProject(doc: WebsiteDocument): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    const files = nextAdapter.scaffoldProject(doc);
    // Vite package.json
    files["package.json"] = JSON.stringify(
      {
        name: doc.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "npati-vite-website",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "vite --host 0.0.0.0",
          build: "vite build",
          preview: "vite preview --host 0.0.0.0",
        },
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          "@vitejs/plugin-react": "^4.3.1",
          vite: "^5.4.2",
          typescript: "^5",
        },
      },
      null,
      2
    ) + "\n";
    return files;
  }

  syncDocument(doc: WebsiteDocument, existingFiles?: Record<string, string>): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    return nextAdapter.syncDocument(doc, existingFiles);
  }
}

export class AstroAdapter implements WebsiteRendererAdapter {
  readonly framework = "astro" as const;

  scaffoldProject(doc: WebsiteDocument): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    const files = nextAdapter.scaffoldProject(doc);
    files["package.json"] = JSON.stringify(
      {
        name: doc.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "npati-astro-website",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "astro dev --host 0.0.0.0",
          start: "astro dev --host 0.0.0.0",
          build: "astro build",
          preview: "astro preview --host 0.0.0.0",
        },
        dependencies: {
          astro: "5.7.13",
        },
      },
      null,
      2
    ) + "\n";
    files["astro.config.mjs"] = `import { defineConfig } from "astro/config";\n\nexport default defineConfig({});\n`;
    files["src/pages/index.astro"] = `---
const title = "${doc.name}";
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <style>
      :root {
        --bg-color: #0b0f19;
        --card-bg: #151b2b;
        --text-color: #f8fafc;
        --muted-color: #94a3b8;
        --accent: #ff5d01;
      }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg-color);
        color: var(--text-color);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 2rem;
        box-sizing: border-box;
      }
      .card {
        background: var(--card-bg);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 2.5rem;
        max-width: 600px;
        text-align: center;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      }
      .pill {
        display: inline-block;
        padding: 4px 14px;
        border-radius: 999px;
        background: rgba(255, 93, 1, 0.15);
        color: var(--accent);
        font-weight: 600;
        font-size: 0.85rem;
        margin-bottom: 1.25rem;
        border: 1px solid rgba(255, 93, 1, 0.3);
      }
      h1 { margin: 0 0 1rem; font-size: 2.2rem; }
      p { color: var(--muted-color); font-size: 1.05rem; line-height: 1.6; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="pill">🚀 Astro Framework</span>
      <h1>{title}</h1>
      <p>Performance-driven website built with Astro island architecture and live sandbox preview.</p>
    </div>
  </body>
</html>\n`;
    return files;
  }

  syncDocument(doc: WebsiteDocument, existingFiles?: Record<string, string>): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    return nextAdapter.syncDocument(doc, existingFiles);
  }
}

export function getWebsiteAdapter(framework?: string): WebsiteRendererAdapter {
  if (framework === "static") return new StaticHtmlAdapter();
  if (framework === "vite") return new ViteAdapter();
  if (framework === "astro") return new AstroAdapter();
  return new NextJsAdapter();
}

