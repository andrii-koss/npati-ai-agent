import { isolatedPreviewUrl } from "./preview-origin";
import React from "react";
import {
  COMPONENT_REGISTRY,
  type WebsiteDocument,
  type WebsitePage,
  type WebsiteBlock,
  type WebsiteBlockType,
} from "@npati/shared";
import {
  IconSectionSymbol,
} from "./website-editor-icons";
import {
  type DeviceMode,
  type InspectorTab,
  type PreviewStatusResponse,
} from "./website-editor-support";

export interface WebsiteEditorCanvasProps {
  doc: WebsiteDocument | null;
  staticPreviewActive: boolean;
  language: string;
  canvasWidth: string;
  deviceMode: DeviceMode;
  staticHtml: string | null;
  handleStaticFrameLoad: (e: React.SyntheticEvent<HTMLIFrameElement>) => void;
  staticPreviewError: string;
  previewMode: "visual" | "sandbox";
  previewStatus: PreviewStatusResponse | null;
  iframeKey: number;
  activePage: WebsitePage | null | undefined;
  activePageId: string;
  setActivePageId: (id: string) => void;
  selectedBlockId: string | null;
  setSelectedBlockId: (id: string | null) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  handleUpdateBlockProp: (prop: string, val: any) => void;
  visualConfigUnavailable: boolean;
  setVisualConfigUnavailable: React.Dispatch<React.SetStateAction<boolean>>;
}

export function WebsiteEditorCanvas({
  doc,
  staticPreviewActive,
  language,
  canvasWidth,
  deviceMode,
  staticHtml,
  handleStaticFrameLoad,
  staticPreviewError,
  previewMode,
  previewStatus,
  iframeKey,
  activePage,
  activePageId,
  setActivePageId,
  selectedBlockId,
  setSelectedBlockId,
  setInspectorTab,
  handleUpdateBlockProp,
  visualConfigUnavailable,
  setVisualConfigUnavailable,
}: WebsiteEditorCanvasProps) {
  return (
        <main className="npati-builder-canvas-wrapper">
          {doc?.framework === "static" && !staticPreviewActive && (
            <div className="npati-builder-static-mode-note" role="note">
              {language === "uk"
                ? "Візуальний конструктор показує блоки конфігурації. Перегляд сайту показує фактичний index.html; збереження блоків замінить цей HTML."
                : "The visual editor shows configuration blocks. Site preview shows the actual index.html; saving blocks will replace that HTML."}
            </div>
          )}
          <div
            className="npati-builder-canvas-card"
            style={{
              width: canvasWidth,
              maxWidth: deviceMode === "desktop" ? "1240px" : canvasWidth,
            }}
          >
            {/* If sandbox mode is chosen and sandbox preview is active */}
            {doc?.framework === "static" && staticPreviewActive ? (
              staticHtml !== null ? (
                <iframe
                  srcDoc={staticHtml}
                  title="Website HTML preview"
                  className="npati-builder-static-preview"
                  onLoad={handleStaticFrameLoad}
                  sandbox="allow-same-origin"
                />
              ) : (
                <div className="npati-builder-static-preview-error" role="status">
                  {staticPreviewError || "Loading index.html…"}
                </div>
              )
            ) : previewMode === "sandbox" && previewStatus?.previewUrl ? (
              <iframe
                key={iframeKey}
                src={isolatedPreviewUrl(previewStatus.previewUrl)}
                title="Website Live Preview"
                style={{ width: "100%", height: "100%", minHeight: "800px", border: "none" }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            ) : visualConfigUnavailable ? (
              <div className="npati-builder-static-preview-error" role="status">
                <p>{language === "uk"
                  ? "Для цього проєкту немає готового макета конструктора. Файли сайту залишилися без змін."
                  : "This project has no visual editor layout. Its source files have not been changed."}</p>
                <button type="button" className="button-secondary" onClick={() => setVisualConfigUnavailable(false)}>
                  {language === "uk" ? "Створити макет конструктора" : "Create visual editor layout"}
                </button>
              </div>
            ) : (
              /* Rich Interactive Visual Canvas with In-line text editing */
              <div style={{ display: "flex", flexDirection: "column", width: "100%", minHeight: "100%" }}>
                {(activePage?.blocks || []).map((b) => {
                  if (b.isHidden) return null;
                  const isSelected = selectedBlockId === b.id;
                  const def = COMPONENT_REGISTRY[b.type] || COMPONENT_REGISTRY.custom;
                  const p = b.props || {};
                  const s = b.styles || {};

                  return (
                    <div
                      key={b.id}
                      className={`npati-builder-canvas-block ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedBlockId(b.id);
                        setInspectorTab("properties");
                      }}
                      style={{
                        backgroundColor: s.backgroundColor || "transparent",
                        color: s.textColor || "#0f172a",
                        textAlign: s.textAlign || "left",
                        padding: s.paddingY === "xlarge" ? "80px 32px" : s.paddingY === "large" ? "64px 32px" : s.paddingY === "small" ? "20px 32px" : s.paddingY === "none" ? "0 32px" : "44px 32px",
                      }}
                    >
                      {/* Floating selection pill tag matching mockup */}
                      {isSelected && (
                        <div className="npati-builder-selected-tag">
                          <span>{b.name || def.title}</span>
                          <span style={{ opacity: 0.85, cursor: "pointer" }}>···</span>
                        </div>
                      )}

                      {/* 1. NAVBAR */}
                      {b.type === "navbar" && (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: "1140px", margin: "0 auto", width: "100%" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", fontWeight: 800, fontSize: "20px", color: s.textColor || "#0f172a" }}>
                            {p.logoUrl ? (
                              <img src={p.logoUrl} alt={p.brandName} style={{ height: "30px" }} />
                            ) : (
                              <span style={{ display: "inline-block", width: "11px", height: "11px", borderRadius: "50%", background: "#e11d2e" }} />
                            )}
                            <span
                              className="npati-editable-text"
                              contentEditable={isSelected}
                              suppressContentEditableWarning={true}
                              onBlur={(e) => handleUpdateBlockProp("brandName", e.currentTarget.textContent || "")}
                            >
                              {p.brandName || doc?.name || "NPATI"}
                            </span>
                          </div>

                          <nav style={{ display: "flex", gap: "24px", alignItems: "center", fontSize: "14.5px", fontWeight: 500, flexWrap: "wrap" }}>
                            {((doc?.pages && doc.pages.length > 0)
                              ? doc.pages.map((pg) => ({ id: pg.id, text: pg.title || "Page", slug: pg.slug }))
                              : (p.links || [{ text: "Home" }, { text: "About" }, { text: "Services" }, { text: "Pricing" }, { text: "Blog" }])
                            ).map((linkItem: any, i: number) => {
                              const isCurrent = linkItem.id ? activePageId === linkItem.id : (activePage?.title === linkItem.text || i === 0);
                              return (
                                <span
                                  key={linkItem.id || i}
                                  onClick={(e) => {
                                    if (linkItem.id) {
                                      e.stopPropagation();
                                      setActivePageId(linkItem.id);
                                    }
                                  }}
                                  style={{
                                    color: isCurrent ? "var(--npati-red, #d83438)" : (s.textColor || "#334155"),
                                    fontWeight: isCurrent ? 700 : 500,
                                    cursor: "pointer",
                                    borderBottom: isCurrent ? "2px solid var(--npati-red, #d83438)" : "2px solid transparent",
                                    paddingBottom: "2px",
                                    transition: "all 120ms ease",
                                  }}
                                >
                                  {linkItem.text}
                                </span>
                              );
                            })}
                          </nav>

                          {p.ctaText && (
                            <button
                              type="button"
                              className="button-primary"
                              style={{ background: "#0f172a", borderColor: "#0f172a", padding: "8px 18px", fontSize: "13.5px" }}
                            >
                              {p.ctaText}
                            </button>
                          )}
                        </div>
                      )}

                      {/* 2. HERO SECTION */}
                      {b.type === "hero" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", textAlign: s.textAlign || "left" }}>
                          <div style={{ display: "grid", gridTemplateColumns: deviceMode === "mobile" ? "1fr" : "1.2fr 1fr", gap: "40px", alignItems: "center" }}>
                            <div>
                              {p.badge && (
                                <div
                                  className="npati-editable-text"
                                  contentEditable={isSelected}
                                  suppressContentEditableWarning={true}
                                  onBlur={(e) => handleUpdateBlockProp("badge", e.currentTarget.textContent || "")}
                                  style={{
                                    display: "inline-block",
                                    padding: "5px 14px",
                                    borderRadius: "999px",
                                    background: "#fef2f2",
                                    color: "#e11d2e",
                                    fontSize: "12.5px",
                                    fontWeight: 600,
                                    marginBottom: "18px",
                                    border: "1px solid #fee2e2",
                                  }}
                                >
                                  {p.badge}
                                </div>
                              )}

                              <h1
                                className="npati-editable-text"
                                contentEditable={isSelected}
                                suppressContentEditableWarning={true}
                                onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                                style={{
                                  fontSize: "clamp(2.2rem, 4.2vw, 3.4rem)",
                                  fontWeight: 800,
                                  lineHeight: 1.15,
                                  margin: "0 0 18px 0",
                                  color: s.textColor || "#0f172a",
                                  letterSpacing: "-0.03em",
                                }}
                              >
                                {p.title || "Build stunning websites with NPATI"}
                              </h1>

                              <p
                                className="npati-editable-text"
                                contentEditable={isSelected}
                                suppressContentEditableWarning={true}
                                onBlur={(e) => handleUpdateBlockProp("subtitle", e.currentTarget.textContent || "")}
                                style={{
                                  fontSize: "16px",
                                  lineHeight: 1.6,
                                  color: "#334155",
                                  margin: "0 0 28px 0",
                                  maxWidth: "540px",
                                }}
                              >
                                {p.subtitle || "Create professional, high-performing websites in minutes with our powerful no-code builder. No design or coding skills required."}
                              </p>

                              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                                {p.primaryCtaText && (
                                  <button
                                    type="button"
                                    className="button-primary"
                                    style={{ background: "#0f172a", borderColor: "#0f172a", padding: "11px 22px", fontSize: "14px", fontWeight: 700 }}
                                  >
                                    {p.primaryCtaText} →
                                  </button>
                                )}
                                {p.secondaryCtaText && (
                                  <button
                                    type="button"
                                    className="button-secondary"
                                    style={{ padding: "11px 22px", fontSize: "14px", display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600, color: "#0f172a" }}
                                  >
                                    <span style={{ fontSize: "11px" }}>▷</span> {p.secondaryCtaText}
                                  </button>
                                )}
                              </div>

                              <div style={{ display: "flex", gap: "20px", marginTop: "28px", fontSize: "13px", color: "#334155", fontWeight: 500 }}>
                                <span>✓ No credit card required</span>
                                <span>✓ Drag & drop builder</span>
                                <span>✓ Publish in minutes</span>
                              </div>
                            </div>

                            {/* Hero Visual Mockup Illustration (Browser Card + Smartphone Mockup) */}
                            <div style={{ position: "relative", minHeight: "340px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {/* Browser Frame */}
                              <div
                                style={{
                                  width: "92%",
                                  background: "#ffffff",
                                  borderRadius: "16px",
                                  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.12)",
                                  border: "1px solid #e2e8f0",
                                  overflow: "hidden",
                                }}
                              >
                                {/* Browser Window Header */}
                                <div style={{ background: "#f8fafc", padding: "10px 14px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: "6px" }}>
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#f87171" }} />
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fbbf24" }} />
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399" }} />
                                </div>
                                <div style={{ padding: "20px" }}>
                                  <div style={{ fontWeight: 800, fontSize: "18px", color: "#0f172a", marginBottom: "6px" }}>Grow your business online</div>
                                  <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "16px" }}>Beautiful websites. Real results.</div>
                                  <div style={{ height: "130px", background: "linear-gradient(135deg, #e0e7ff 0%, #fae8ff 100%)", borderRadius: "10px", display: "grid", placeItems: "center" }}>
                                    <button type="button" className="button-primary" style={{ padding: "6px 14px", fontSize: "11px", background: "#4f46e5", borderColor: "#4f46e5" }}>Get Started</button>
                                  </div>
                                </div>
                              </div>

                              {/* Overlapping Smartphone Mockup */}
                              <div
                                style={{
                                  position: "absolute",
                                  bottom: "-10px",
                                  right: "0px",
                                  width: "160px",
                                  background: "#ffffff",
                                  borderRadius: "22px",
                                  border: "4px solid #0f172a",
                                  boxShadow: "0 20px 35px rgba(0, 0, 0, 0.18)",
                                  padding: "10px",
                                  zIndex: 5,
                                }}
                              >
                                <div style={{ width: "30px", height: "4px", background: "#cbd5e1", borderRadius: "2px", margin: "0 auto 8px auto" }} />
                                <div style={{ fontSize: "11px", fontWeight: 700, color: "#0f172a" }}>Grow your business online</div>
                                <div style={{ height: "65px", background: "#f1f5f9", borderRadius: "8px", margin: "6px 0", display: "grid", placeItems: "center" }}>
                                  <button type="button" className="button-primary" style={{ padding: "4px 8px", fontSize: "9px", background: "#4f46e5", borderColor: "#4f46e5" }}>Get Started</button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 3. FEATURES */}
                      {b.type === "features" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%" }}>
                          <div style={{ textAlign: "center", marginBottom: "36px" }}>
                            <span style={{ fontSize: "11px", fontWeight: 700, color: "#e11d2e", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                              {p.badge || "FEATURES"}
                            </span>
                            <h2
                              className="npati-editable-text"
                              contentEditable={isSelected}
                              suppressContentEditableWarning={true}
                              onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                              style={{ fontSize: "28px", fontWeight: 800, margin: "6px 0 10px 0", color: s.textColor || "#0f172a" }}
                            >
                              {p.title || "Everything you need to succeed"}
                            </h2>
                            <p
                              className="npati-editable-text"
                              contentEditable={isSelected}
                              suppressContentEditableWarning={true}
                              onBlur={(e) => handleUpdateBlockProp("subtitle", e.currentTarget.textContent || "")}
                              style={{ color: "#334155", fontSize: "15px", margin: 0 }}
                            >
                              {p.subtitle || "Powerful features to help you build, launch, and grow your online presence."}
                            </p>
                          </div>

                          <div style={{ display: "grid", gridTemplateColumns: deviceMode === "mobile" ? "1fr" : "repeat(3, 1fr)", gap: "20px" }}>
                            {(p.items || [
                              { title: "Drag & Drop Builder", description: "Create beautiful websites without any coding. Just drag, drop, and customize." },
                              { title: "Responsive Design", description: "Your website looks perfect on all devices, from desktop to mobile." },
                              { title: "Fast Performance", description: "Built with modern technology for lightning-fast loading speeds." },
                            ]).map((item: any, i: number) => (
                              <div
                                key={i}
                                style={{
                                  background: "#ffffff",
                                  border: "1px solid #e2e8f0",
                                  borderRadius: "14px",
                                  padding: "24px",
                                  boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
                                }}
                              >
                                <div style={{ width: "38px", height: "38px", borderRadius: "10px", background: i === 0 ? "#eff6ff" : i === 1 ? "#ecfdf5" : "#fdf2f8", display: "grid", placeItems: "center", marginBottom: "16px", color: i === 0 ? "#2563eb" : i === 1 ? "#059669" : "#db2777" }}>
                                  <IconSectionSymbol type="features" />
                                </div>
                                <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 8px 0", color: "#0f172a" }}>{item.title}</h3>
                                <p style={{ fontSize: "13.5px", color: "#334155", margin: 0, lineHeight: 1.5 }}>{item.description}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 4. PRICING */}
                      {b.type === "pricing" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", textAlign: "center" }}>
                          <h2
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                            style={{ fontSize: "28px", fontWeight: 800, margin: "0 0 10px 0", color: s.textColor || "#0f172a" }}
                          >
                            {p.title || "Transparent, Flexible Plans"}
                          </h2>
                          <p style={{ color: "#334155", fontSize: "15px", marginBottom: "36px" }}>
                            {p.subtitle || "No hidden fees. Change or cancel your subscription at any time."}
                          </p>
                          <div style={{ display: "grid", gridTemplateColumns: deviceMode === "mobile" ? "1fr" : "repeat(3, 1fr)", gap: "20px" }}>
                            {(p.tiers || [
                              { name: "Starter", price: "$19", description: "Essential tools for personal projects." },
                              { name: "Pro", price: "$49", description: "Advanced power for growing businesses." },
                              { name: "Enterprise", price: "$149", description: "Full white-glove setup and dedicated support." },
                            ]).map((tier: any, i: number) => (
                              <div
                                key={i}
                                style={{
                                  background: "#ffffff",
                                  border: i === 1 ? "2px solid #e11d2e" : "1px solid #cbd5e1",
                                  borderRadius: "14px",
                                  padding: "28px 24px",
                                  textAlign: "left",
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.03)",
                                }}
                              >
                                <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 6px 0", color: "#0f172a" }}>{tier.name}</h3>
                                <div style={{ fontSize: "32px", fontWeight: 800, color: "#0f172a", margin: "12px 0" }}>
                                  {tier.price}<span style={{ fontSize: "14px", color: "#64748b", fontWeight: 500 }}>/mo</span>
                                </div>
                                <p style={{ fontSize: "13.5px", color: "#334155", marginBottom: "20px" }}>{tier.description}</p>
                                <button
                                  type="button"
                                  className={i === 1 ? "button-primary" : "button-secondary"}
                                  style={{ width: "100%", padding: "10px", fontWeight: 600 }}
                                >
                                  Get Started
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 5. FAQ */}
                      {b.type === "faq" && (
                        <div style={{ maxWidth: "800px", margin: "0 auto", width: "100%" }}>
                          <h2
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                            style={{ fontSize: "28px", fontWeight: 800, textAlign: "center", margin: "0 0 24px 0", color: s.textColor || "#0f172a" }}
                          >
                            {p.title || "Frequently Asked Questions"}
                          </h2>
                          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            {(p.items || [
                              { question: "How does the visual builder work?", answer: "Click any section or text directly on the canvas to edit in place, or use the Properties panel on the right." },
                              { question: "Can I connect my custom domain?", answer: "Yes, you can link any custom domain with automated SSL configuration." },
                              { question: "Is hosting included?", answer: "Fast edge CDN hosting is included with all plans." },
                            ]).map((item: any, i: number) => (
                              <div key={i} style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "10px", padding: "16px 20px" }}>
                                <div style={{ fontWeight: 700, fontSize: "15px", color: "#0f172a", marginBottom: "6px" }}>{item.question}</div>
                                <div style={{ fontSize: "14px", color: "#334155", lineHeight: 1.5 }}>{item.answer}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 6. CTA */}
                      {b.type === "cta" && (
                        <div
                          style={{
                            maxWidth: "1140px",
                            margin: "0 auto",
                            width: "100%",
                            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
                            borderRadius: "20px",
                            padding: "48px 32px",
                            textAlign: "center",
                            color: "#ffffff",
                          }}
                        >
                          <h2
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                            style={{ fontSize: "32px", fontWeight: 800, margin: "0 0 12px 0", color: "#ffffff" }}
                          >
                            {p.title || "Ready to launch your website?"}
                          </h2>
                          <p
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("subtitle", e.currentTarget.textContent || "")}
                            style={{ fontSize: "16px", color: "#cbd5e1", maxWidth: "540px", margin: "0 auto 28px auto" }}
                          >
                            {p.subtitle || "Start building today with NPATI. No design or coding skills required."}
                          </p>
                          <button
                            type="button"
                            className="button-primary"
                            style={{ background: "#e11d2e", borderColor: "#e11d2e", padding: "12px 28px", fontSize: "15px", fontWeight: 700 }}
                          >
                            {p.primaryCtaText || "Get Started Free"} →
                          </button>
                        </div>
                      )}

                      {/* 7. FOOTER */}
                      {b.type === "footer" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", borderTop: "1px solid #e2e8f0", paddingTop: "24px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13.5px", color: "#475569" }}>
                          <div>© {new Date().getFullYear()} {p.brandName || doc?.name || "NPATI"}. All rights reserved.</div>
                          <div style={{ display: "flex", gap: "24px", fontWeight: 500 }}>
                            <span style={{ cursor: "pointer", color: "#0f172a" }}>Privacy Policy</span>
                            <span style={{ cursor: "pointer", color: "#0f172a" }}>Terms of Service</span>
                            <span style={{ cursor: "pointer", color: "#0f172a" }}>Contact</span>
                          </div>
                        </div>
                      )}

                      {/* 8. CUSTOM / FALLBACK */}
                      {b.type !== "navbar" && b.type !== "hero" && b.type !== "features" && b.type !== "pricing" && b.type !== "faq" && b.type !== "cta" && b.type !== "footer" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", padding: "28px", background: "#ffffff", borderRadius: "14px", border: "1px solid #cbd5e1" }}>
                          <h3 style={{ margin: "0 0 8px 0", color: "#0f172a", fontWeight: 700 }}>{b.name || def.title}</h3>
                          <p style={{ margin: 0, color: "#334155" }}>{p.title || p.text || p.subtitle || "Section content..."}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
  );
}
