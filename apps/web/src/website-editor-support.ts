import { getStoredAuthToken } from "./AuthContext";
import { createDefaultWebsiteDocument, type WebsiteDocument } from "@npati/shared";

export type DeviceMode = "desktop" | "tablet" | "mobile";
export type LeftPanelTab = "pages" | "layers" | "assets";
export type InspectorTab = "properties" | "design" | "advanced";
export type InspectorSubTab = "content" | "style";
export type ActiveDrawer = null | "ai" | "files" | "history" | "seo";
export interface PreviewStatusResponse {
  status: string;
  previewUrl?: string | null;
  port?: number | null;
  framework?: string | null;
  lastBuildStatus?: string | null;
  isRunning: boolean;
  error: string | null;
  restartCount: number;
}
export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
}
export interface CheckpointItem {
  id: string;
  name: string;
  description?: string;
  trigger: string;
  fileCount: number;
  createdAt: string;
}
export function authHeaders() {
  const value = new Headers();
  const token = getStoredAuthToken();
  if (token) value.set("Authorization", "Bearer " + token);
  return value;
}
export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}
export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}
export function buildMockupDocument(name: string, framework: "nextjs" | "vite" = "nextjs"): WebsiteDocument {
  const doc = createDefaultWebsiteDocument(name, framework);

  const homePage = doc.pages[0];
  if (homePage) {
    homePage.blocks = [
      {
        id: "block-navbar",
        type: "navbar",
        name: "Header",
        props: {
          brandName: "NPATI",
          logoUrl: "",
          links: [
            { text: "Home", url: "/" },
            { text: "About", url: "#about" },
            { text: "Services", url: "#services" },
            { text: "Pricing", url: "#pricing" },
            { text: "Blog", url: "#blog" },
          ],
          ctaText: "Get Started",
          ctaUrl: "#pricing",
          sticky: true,
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "small",
          paddingX: "medium",
          maxWidth: "large",
        },
      },
      {
        id: "block-hero",
        type: "hero",
        name: "Hero Section",
        props: {
          badge: "Modern websites for modern businesses",
          title: "Build stunning websites with NPATI",
          subtitle: "Create professional, high-performing websites in minutes with our powerful no-code builder. No design or coding skills required.",
          primaryCtaText: "Get Started Free",
          primaryCtaUrl: "#",
          secondaryCtaText: "Watch Demo",
          secondaryCtaUrl: "#",
          layout: "split",
        },
        styles: {
          backgroundColor: "#F8FAFF",
          textColor: "#0F172A",
          textAlign: "center",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-features",
        type: "features",
        name: "Features",
        props: {
          badge: "FEATURES",
          title: "Everything you need to succeed",
          subtitle: "Powerful features to help you build, launch, and grow your online presence.",
          items: [
            {
              title: "Drag & Drop Builder",
              description: "Create beautiful websites without any coding. Just drag, drop, and customize.",
              icon: "drag",
            },
            {
              title: "Responsive Design",
              description: "Your website looks perfect on all devices, from desktop to mobile.",
              icon: "responsive",
            },
            {
              title: "Fast Performance",
              description: "Built with modern technology for lightning-fast loading speeds.",
              icon: "fast",
            },
          ],
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-how-it-works",
        type: "custom",
        name: "How It Works",
        props: {
          title: "Launch in 3 Simple Steps",
          subtitle: "Pick a template, customize components with instant live preview, and deploy to your custom domain in seconds.",
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "medium",
          maxWidth: "large",
        },
      },
      {
        id: "block-testimonials",
        type: "testimonials",
        name: "Testimonials",
        props: {
          title: "Loved by Founders & Creators",
          subtitle: "Join thousands of businesses that build their presence with NPATI AI.",
        },
        styles: {
          backgroundColor: "#F8FAFF",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-pricing",
        type: "pricing",
        name: "Pricing",
        props: {
          title: "Transparent, Flexible Plans",
          subtitle: "No hidden fees. Change or cancel your subscription at any time.",
          tiers: [
            { name: "Starter", price: "$19", description: "Essential tools for personal projects and early stage ventures." },
            { name: "Pro", price: "$49", description: "Advanced power, custom code, and priority support for growing teams." },
            { name: "Enterprise", price: "$149", description: "Full white-glove setup, custom integrations, and dedicated agent clusters." },
          ],
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-faq",
        type: "faq",
        name: "FAQ",
        props: {
          title: "Frequently Asked Questions",
          items: [
            { question: "How does the visual builder work?", answer: "Click any section or text directly on the canvas to edit in place, or use the Properties panel on the right." },
            { question: "Can I connect my custom domain?", answer: "Yes, you can easily link any domain with automated SSL configuration." },
            { question: "Is hosting and CDN included?", answer: "High-speed edge CDN hosting is included with automated global distribution." },
          ],
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-cta",
        type: "cta",
        name: "CTA Section",
        props: {
          title: "Ready to launch your website?",
          subtitle: "Start building today with NPATI. No design or coding skills required.",
          primaryCtaText: "Get Started Free",
          primaryCtaUrl: "#",
        },
        styles: {
          backgroundColor: "#0f172a",
          textColor: "#ffffff",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-footer",
        type: "footer",
        name: "Footer",
        props: {
          brandName: "NPATI",
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#64748b",
          paddingY: "medium",
          maxWidth: "large",
        },
      },
    ];
  }

  // Add remaining pages matching the mockup
  if (homePage) {
    homePage.icon = "home";
    doc.pages = [
      homePage,
      { id: "page-about", title: "About", slug: "/about", icon: "user", blocks: [] },
      { id: "page-services", title: "Services", slug: "/services", icon: "bag", blocks: [] },
      { id: "page-pricing", title: "Pricing", slug: "/pricing", icon: "tag", blocks: [] },
      { id: "page-blog", title: "Blog", slug: "/blog", icon: "file", blocks: [] },
      { id: "page-contact", title: "Contact", slug: "/contact", icon: "phone", blocks: [] },
    ];
  }

  return doc;
}
