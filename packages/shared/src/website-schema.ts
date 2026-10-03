export type WebsiteBlockType =
  | "navbar"
  | "hero"
  | "features"
  | "pricing"
  | "cta"
  | "testimonials"
  | "faq"
  | "gallery"
  | "stats"
  | "team"
  | "contact"
  | "forms"
  | "footer"
  | "custom";

export interface BlockStyles {
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  paddingY?: "none" | "small" | "medium" | "large" | "xlarge";
  paddingX?: "none" | "small" | "medium" | "large";
  textAlign?: "left" | "center" | "right";
  maxWidth?: "small" | "medium" | "large" | "full";
  borderRadius?: "none" | "sm" | "md" | "lg" | "small" | "medium" | "large" | "full";
  borderWidth?: "none" | "thin" | "medium";
  borderColor?: string;
  customCss?: string;
}

export interface WebsiteBlock {
  id: string;
  type: WebsiteBlockType;
  name?: string;
  isHidden?: boolean;
  styles?: BlockStyles;
  props: Record<string, any>;
}

export interface WebsitePageSeo {
  title?: string;
  description?: string;
  keywords?: string[];
  ogImage?: string;
  canonicalUrl?: string;
}

export interface WebsitePage {
  id: string;
  title: string;
  slug: string; // e.g. "/" or "pricing" or "contact"
  seo?: WebsitePageSeo;
  blocks: WebsiteBlock[];
}

export interface WebsiteTheme {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  mutedColor: string;
  fontFamily: "system" | "inter" | "roboto" | "playfair" | "geist";
  borderRadius: "none" | "sm" | "md" | "lg" | "full";
}

export interface WebsiteAsset {
  id: string;
  name: string;
  url: string;
  type: "image" | "svg" | "icon" | "document";
  size?: number;
  uploadedAt: string;
}

export interface WebsiteDocument {
  version: "1.0";
  id: string;
  name: string;
  framework: "nextjs" | "vite" | "static";
  theme: WebsiteTheme;
  pages: WebsitePage[];
  assets?: WebsiteAsset[];
  globalHeaderCode?: string;
  globalFooterCode?: string;
  updatedAt: string;
}

export interface ComponentPropertySchema {
  key: string;
  label: string;
  type: "string" | "textarea" | "color" | "image" | "link" | "boolean" | "select" | "list";
  options?: Array<{ label: string; value: string }>;
  itemSchema?: Array<{ key: string; label: string; type: "string" | "textarea" | "link" | "image" | "color" }>;
  defaultValue?: any;
}

export interface ComponentDefinition {
  type: WebsiteBlockType;
  title: string;
  description: string;
  icon: string;
  defaultProps: Record<string, any>;
  defaultStyles: BlockStyles;
  propertySchema: ComponentPropertySchema[];
}

export const COMPONENT_REGISTRY: Record<WebsiteBlockType, ComponentDefinition> = {
  navbar: {
    type: "navbar",
    title: "Navbar",
    description: "Header navigation with brand logo, links, and action button",
    icon: "🧭",
    defaultStyles: {
      backgroundColor: "#090d16",
      textColor: "#ffffff",
      paddingY: "small",
      paddingX: "medium",
      maxWidth: "large",
    },
    defaultProps: {
      brandName: "NPATI",
      logoUrl: "",
      links: [
        { text: "Home", url: "/" },
        { text: "Features", url: "#features" },
        { text: "Pricing", url: "#pricing" },
        { text: "Contact", url: "#contact" },
      ],
      ctaText: "Get Started",
      ctaUrl: "#pricing",
      sticky: true,
    },
    propertySchema: [
      { key: "brandName", label: "Brand Name", type: "string" },
      { key: "logoUrl", label: "Logo Image URL", type: "image" },
      { key: "ctaText", label: "CTA Button Text", type: "string" },
      { key: "ctaUrl", label: "CTA Button URL", type: "link" },
      { key: "sticky", label: "Sticky Header", type: "boolean" },
      {
        key: "links",
        label: "Navigation Links",
        type: "list",
        itemSchema: [
          { key: "text", label: "Link Text", type: "string" },
          { key: "url", label: "Link URL", type: "link" },
        ],
      },
    ],
  },
  hero: {
    type: "hero",
    title: "Hero Section",
    description: "High-impact introduction with badge, heading, description, buttons, and media",
    icon: "⚡",
    defaultStyles: {
      backgroundColor: "transparent",
      textColor: "#ffffff",
      textAlign: "center",
      paddingY: "xlarge",
      maxWidth: "large",
    },
    defaultProps: {
      badge: "🚀 Next-Generation Platform",
      title: "Build, Launch and Scale with NPATI AI",
      subtitle: "The all-in-one platform for modern businesses. Empower your workflows with autonomous AI agents and responsive website experiences.",
      primaryCtaText: "Start Free Trial",
      primaryCtaUrl: "#pricing",
      secondaryCtaText: "Live Demo",
      secondaryCtaUrl: "#demo",
      imageUrl: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1200&q=80",
      layout: "split",
    },
    propertySchema: [
      { key: "badge", label: "Badge Tag", type: "string" },
      { key: "title", label: "Heading Title", type: "string" },
      { key: "subtitle", label: "Subtitle Description", type: "textarea" },
      { key: "primaryCtaText", label: "Primary Button Text", type: "string" },
      { key: "primaryCtaUrl", label: "Primary Button URL", type: "link" },
      { key: "secondaryCtaText", label: "Secondary Button Text", type: "string" },
      { key: "secondaryCtaUrl", label: "Secondary Button URL", type: "link" },
      { key: "imageUrl", label: "Hero Image / Media URL", type: "image" },
      {
        key: "layout",
        label: "Layout Style",
        type: "select",
        options: [
          { label: "Side by Side (Split)", value: "split" },
          { label: "Centered Stack", value: "stacked" },
        ],
      },
    ],
  },
  features: {
    type: "features",
    title: "Features Grid",
    description: "Grid showcasing key benefits, capabilities, and features",
    icon: "✨",
    defaultStyles: {
      backgroundColor: "#0d1117",
      textColor: "#f0f6fc",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "center",
    },
    defaultProps: {
      title: "Powerful Features Built for Growth",
      subtitle: "Everything you need to deliver high-performing web solutions in record time.",
      columns: 3,
      items: [
        { icon: "⚡", title: "Ultra Fast Performance", description: "Built with Next.js App Router for optimal lighthouse scores and instant page transitions." },
        { icon: "🛡️", title: "Enterprise Grade Security", description: "Multi-tenant sandboxing and role-based permissions protecting your business assets." },
        { icon: "🤖", title: "AI-Powered Automation", description: "Seamless dual-mode editing: collaborate with AI in chat or customize visually." },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "columns",
        label: "Grid Columns",
        type: "select",
        options: [
          { label: "2 Columns", value: "2" },
          { label: "3 Columns", value: "3" },
          { label: "4 Columns", value: "4" },
        ],
      },
      {
        key: "items",
        label: "Feature Cards",
        type: "list",
        itemSchema: [
          { key: "icon", label: "Icon or Emoji", type: "string" },
          { key: "title", label: "Card Title", type: "string" },
          { key: "description", label: "Card Description", type: "textarea" },
        ],
      },
    ],
  },
  pricing: {
    type: "pricing",
    title: "Pricing Tables",
    description: "Comparison tiers with feature lists, price points, and signup actions",
    icon: "💳",
    defaultStyles: {
      backgroundColor: "transparent",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "center",
    },
    defaultProps: {
      title: "Simple, Transparent Pricing",
      subtitle: "Choose the perfect plan for your business needs. Upgrade or cancel anytime.",
      billingPeriod: "/month",
      tiers: [
        {
          name: "Starter",
          price: "$19",
          description: "Essential tools for personal projects and small sites.",
          features: ["1 Website", "Standard Preview", "Community Support", "Free SSL"],
          isPopular: false,
          buttonText: "Get Started",
          buttonUrl: "#signup",
        },
        {
          name: "Professional",
          price: "$49",
          description: "Full AI power and custom domain deployment for growing teams.",
          features: ["Unlimited Websites", "AI Agent Assistant", "Custom Domains", "Priority 24/7 Support", "Automated Backups"],
          isPopular: true,
          buttonText: "Start Pro Trial",
          buttonUrl: "#signup",
        },
        {
          name: "Enterprise",
          price: "$149",
          description: "Dedicated infrastructure, SLA guarantees, and VIP onboarding.",
          features: ["Dedicated Sandboxes", "Custom Integrations", "Audit Logs", "SLA 99.99%", "Account Manager"],
          isPopular: false,
          buttonText: "Contact Sales",
          buttonUrl: "#contact",
        },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      { key: "billingPeriod", label: "Billing Frequency Label", type: "string" },
      {
        key: "tiers",
        label: "Pricing Tiers",
        type: "list",
        itemSchema: [
          { key: "name", label: "Plan Name", type: "string" },
          { key: "price", label: "Price (e.g. $49)", type: "string" },
          { key: "description", label: "Short Description", type: "string" },
          { key: "buttonText", label: "Button Label", type: "string" },
          { key: "buttonUrl", label: "Button Link", type: "link" },
        ],
      },
    ],
  },
  cta: {
    type: "cta",
    title: "Call To Action",
    description: "High-conversion banner with prompt heading and action buttons",
    icon: "🎯",
    defaultStyles: {
      backgroundColor: "#161b22",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "center",
      borderRadius: "lg",
    },
    defaultProps: {
      title: "Ready to launch your next project?",
      subtitle: "Join thousands of creators building modern web applications with NPATI.",
      primaryText: "Start Building Now",
      primaryUrl: "#pricing",
      secondaryText: "Talk to an Expert",
      secondaryUrl: "#contact",
    },
    propertySchema: [
      { key: "title", label: "Headline Title", type: "string" },
      { key: "subtitle", label: "Subtitle Text", type: "textarea" },
      { key: "primaryText", label: "Primary Button Text", type: "string" },
      { key: "primaryUrl", label: "Primary Button URL", type: "link" },
      { key: "secondaryText", label: "Secondary Button Text", type: "string" },
      { key: "secondaryUrl", label: "Secondary Button URL", type: "link" },
    ],
  },
  testimonials: {
    type: "testimonials",
    title: "Testimonials & Reviews",
    description: "Social proof cards with client quotes, names, avatars, and ratings",
    icon: "💬",
    defaultStyles: {
      backgroundColor: "transparent",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "center",
    },
    defaultProps: {
      title: "Loved by teams worldwide",
      subtitle: "Here is what our clients say about launching websites with our platform.",
      items: [
        {
          quote: "NPATI cut our website development time from three weeks down to twenty minutes. The combination of AI chat and visual builder is brilliant.",
          author: "Alex Morgan",
          role: "CTO, CloudScale Inc.",
          avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80",
          rating: 5,
        },
        {
          quote: "Being able to visually swap blocks and then ask the AI to write custom backend logic is the future of web development.",
          author: "Oleh Shevchenko",
          role: "Founder, HostingHub",
          avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&q=80",
          rating: 5,
        },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "items",
        label: "Reviews",
        type: "list",
        itemSchema: [
          { key: "quote", label: "Quote Text", type: "textarea" },
          { key: "author", label: "Author Name", type: "string" },
          { key: "role", label: "Role / Company", type: "string" },
          { key: "avatar", label: "Avatar Image URL", type: "image" },
        ],
      },
    ],
  },
  faq: {
    type: "faq",
    title: "FAQ Accordion",
    description: "Frequently asked questions with expandable or clean answer cards",
    icon: "❓",
    defaultStyles: {
      backgroundColor: "#0d1117",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "medium",
      textAlign: "left",
    },
    defaultProps: {
      title: "Frequently Asked Questions",
      subtitle: "Got questions? We have answers. If you cannot find what you are looking for, contact our support.",
      items: [
        { question: "How does the Live Preview work?", answer: "Each website runs in an isolated sandbox runner container. When you make changes in the visual builder or chat, they are synchronized and hot-reloaded in the live preview iframe." },
        { question: "Can I export pure Next.js code?", answer: "Yes! Your website is a 100% valid Next.js App Router repository with TypeScript and Tailwind CSS. You can download the code or deploy directly to Vercel and Netlify." },
        { question: "Can I edit both visually and with code?", answer: "Absolutely. You can switch between Visual Builder mode, AI Chat, and raw Code Explorer at any time without losing edits." },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "items",
        label: "Questions & Answers",
        type: "list",
        itemSchema: [
          { key: "question", label: "Question", type: "string" },
          { key: "answer", label: "Answer", type: "textarea" },
        ],
      },
    ],
  },
  gallery: {
    type: "gallery",
    title: "Gallery & Portfolio",
    description: "Visual grid of project screenshots or product photography",
    icon: "🖼️",
    defaultStyles: {
      backgroundColor: "transparent",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "center",
    },
    defaultProps: {
      title: "Our Work & Showcase",
      subtitle: "Explore high-performing websites and digital experiences built on NPATI.",
      columns: 3,
      items: [
        { url: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=600&q=80", caption: "Analytics Dashboard" },
        { url: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=600&q=80", caption: "Team Collaboration Hub" },
        { url: "https://images.unsplash.com/photo-1556742049-0a67e5572241?auto=format&fit=crop&w=600&q=80", caption: "Fintech Platform" },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "items",
        label: "Gallery Images",
        type: "list",
        itemSchema: [
          { key: "url", label: "Image URL", type: "image" },
          { key: "caption", label: "Caption", type: "string" },
        ],
      },
    ],
  },
  stats: {
    type: "stats",
    title: "Statistics & Metrics",
    description: "Key numerical achievements, milestones, and metrics",
    icon: "📊",
    defaultStyles: {
      backgroundColor: "#161b22",
      textColor: "#ffffff",
      paddingY: "medium",
      maxWidth: "large",
      textAlign: "center",
      borderRadius: "md",
    },
    defaultProps: {
      title: "Proven Results Across the Globe",
      items: [
        { value: "99.99%", label: "Uptime SLA", description: "Enterprise stability" },
        { value: "10x", label: "Faster Deployment", description: "Automated pipelines" },
        { value: "50k+", label: "Websites Launched", description: "Active installations" },
        { value: "24/7", label: "Agent Monitoring", description: "Real-time health" },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      {
        key: "items",
        label: "Metric Items",
        type: "list",
        itemSchema: [
          { key: "value", label: "Number / Metric (e.g. 99.9%)", type: "string" },
          { key: "label", label: "Label Title", type: "string" },
          { key: "description", label: "Subtext", type: "string" },
        ],
      },
    ],
  },
  team: {
    type: "team",
    title: "Team Members",
    description: "Highlight team leadership, bios, and social handles",
    icon: "👥",
    defaultStyles: {
      backgroundColor: "transparent",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "center",
    },
    defaultProps: {
      title: "Meet the Leadership Team",
      subtitle: "World-class engineers, designers, and AI specialists driving the revolution.",
      items: [
        { name: "Andrii Koss", role: "CEO & Founder", image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=300&q=80", bio: "Leading AI agents and product architecture." },
        { name: "Elena Rostova", role: "Head of Product Design", image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=80", bio: "Creating intuitive visual builder and responsive UI." },
      ],
    },
    propertySchema: [
      { key: "title", label: "Section Title", type: "string" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "items",
        label: "Team Members",
        type: "list",
        itemSchema: [
          { key: "name", label: "Full Name", type: "string" },
          { key: "role", label: "Job Title", type: "string" },
          { key: "image", label: "Photo URL", type: "image" },
          { key: "bio", label: "Short Bio", type: "textarea" },
        ],
      },
    ],
  },
  contact: {
    type: "contact",
    title: "Contact Section",
    description: "Get in touch with contact details, address, and interactive form",
    icon: "✉️",
    defaultStyles: {
      backgroundColor: "#0d1117",
      textColor: "#ffffff",
      paddingY: "large",
      maxWidth: "medium",
      textAlign: "center",
    },
    defaultProps: {
      title: "Get In Touch",
      subtitle: "Have a project in mind or need assistance? Reach out to our team directly.",
      email: "support@npati.com",
      phone: "+380 (44) 123-4567",
      address: "Kyiv, Ukraine",
      showForm: true,
      buttonText: "Send Message",
    },
    propertySchema: [
      { key: "title", label: "Heading Title", type: "string" },
      { key: "subtitle", label: "Subtitle Text", type: "textarea" },
      { key: "email", label: "Email Address", type: "string" },
      { key: "phone", label: "Phone Number", type: "string" },
      { key: "address", label: "Location Address", type: "string" },
      { key: "showForm", label: "Include Interactive Form", type: "boolean" },
      { key: "buttonText", label: "Submit Button Text", type: "string" },
    ],
  },
  forms: {
    type: "forms",
    title: "Lead Generation Form",
    description: "Custom input form for inquiries, newsletter signups, or bookings",
    icon: "📝",
    defaultStyles: {
      backgroundColor: "#161b22",
      textColor: "#ffffff",
      paddingY: "medium",
      maxWidth: "small",
      textAlign: "left",
      borderRadius: "md",
    },
    defaultProps: {
      title: "Subscribe to Updates",
      subtitle: "Receive regular product news and early feature access.",
      submitButtonText: "Subscribe Now",
      fields: [
        { name: "name", label: "Full Name", type: "text", required: true },
        { name: "email", label: "Email Address", type: "email", required: true },
      ],
    },
    propertySchema: [
      { key: "title", label: "Form Title", type: "string" },
      { key: "subtitle", label: "Form Subtitle", type: "textarea" },
      { key: "submitButtonText", label: "Submit Button Label", type: "string" },
    ],
  },
  footer: {
    type: "footer",
    title: "Page Footer",
    description: "Site closing with copyright, navigation columns, and social links",
    icon: "⚓",
    defaultStyles: {
      backgroundColor: "#05080f",
      textColor: "#8b949e",
      paddingY: "large",
      maxWidth: "large",
      textAlign: "left",
    },
    defaultProps: {
      brandName: "NPATI",
      brandDescription: "Empowering businesses worldwide with autonomous AI agents and responsive web builder experiences.",
      copyright: "© 2026 NPATI Inc. All rights reserved.",
      columns: [
        {
          title: "Product",
          links: [
            { text: "Features", url: "#features" },
            { text: "Pricing", url: "#pricing" },
            { text: "Templates", url: "#templates" },
          ],
        },
        {
          title: "Company",
          links: [
            { text: "About Us", url: "#about" },
            { text: "Careers", url: "#careers" },
            { text: "Contact", url: "#contact" },
          ],
        },
        {
          title: "Legal",
          links: [
            { text: "Privacy Policy", url: "/privacy" },
            { text: "Terms of Service", url: "/terms" },
          ],
        },
      ],
    },
    propertySchema: [
      { key: "brandName", label: "Brand Name", type: "string" },
      { key: "brandDescription", label: "Brand Tagline", type: "textarea" },
      { key: "copyright", label: "Copyright Notice", type: "string" },
    ],
  },
  custom: {
    type: "custom",
    title: "Custom Section",
    description: "Custom HTML, Markdown, or embedded widget content",
    icon: "🛠️",
    defaultStyles: {
      backgroundColor: "transparent",
      textColor: "#ffffff",
      paddingY: "medium",
      maxWidth: "large",
    },
    defaultProps: {
      title: "Custom Section",
      htmlContent: "<div style='padding: 2rem; border: 1px dashed rgba(255,255,255,0.2); border-radius: 8px; text-align: center;'><p>Custom content or embed widget goes here.</p></div>",
    },
    propertySchema: [
      { key: "title", label: "Internal Title", type: "string" },
      { key: "htmlContent", label: "HTML / Embed Content", type: "textarea" },
    ],
  },
};

export function createDefaultWebsiteDocument(
  name: string,
  framework: "nextjs" | "vite" | "static" = "nextjs",
  options: {
    purpose?: string;
    primaryColor?: string;
    includePages?: string[];
    template?: "hosting" | "saas" | "ecommerce" | "portfolio" | "landing" | "blank";
  } = {}
): WebsiteDocument {
  const primary = options.primaryColor || (options.template === "hosting" ? "#2563eb" : "#e11d2e");
  const now = new Date().toISOString();
  const template = options.template || "hosting";

  const makeNavbar = (links = [
    { label: "Home", url: "/" },
    { label: "Hosting", url: "/hosting" },
    { label: "Domains", url: "/domains" },
    { label: "Pricing", url: "/pricing" },
    { label: "Contact", url: "/contact" },
  ]): WebsiteBlock => ({
    id: "block-navbar",
    type: "navbar",
    name: "Header Navigation",
    props: {
      ...COMPONENT_REGISTRY.navbar.defaultProps,
      brandName: name,
      links,
      ctaText: "Get Started",
      ctaUrl: "#pricing",
    },
    styles: { ...COMPONENT_REGISTRY.navbar.defaultStyles },
  });

  const makeFooter = (): WebsiteBlock => ({
    id: "block-footer",
    type: "footer",
    name: "Footer",
    props: {
      ...COMPONENT_REGISTRY.footer.defaultProps,
      brandName: name,
      description: options.purpose || `${name} — modern cloud infrastructure and websites.`,
    },
    styles: { ...COMPONENT_REGISTRY.footer.defaultStyles },
  });

  if (template === "hosting") {
    const heroBlock: WebsiteBlock = {
      id: "block-hero",
      type: "hero",
      name: "Hosting Hero Banner",
      props: {
        ...COMPONENT_REGISTRY.hero.defaultProps,
        badge: "⚡ 99.99% UPTIME CLOUD SERVERS",
        title: name,
        subtitle: options.purpose || "Deploy high-performance servers, manage domains, and scale your web applications with zero downtime.",
        primaryCtaText: "Find Your Domain",
        primaryCtaUrl: "/domains",
        secondaryCtaText: "View Hosting Plans",
        secondaryCtaUrl: "/pricing",
      },
      styles: {
        ...COMPONENT_REGISTRY.hero.defaultStyles,
        accentColor: primary,
        paddingY: "xlarge",
      },
    };

    const featuresBlock: WebsiteBlock = {
      id: "block-features",
      type: "features",
      name: "Infrastructure Highlights",
      props: {
        title: "Enterprise-Grade Performance & Reliability",
        subtitle: "Designed from the silicon up for maximum throughput and ultra-low latency worldwide.",
        columns: 3,
        items: [
          { icon: "⚡", title: "Pure NVMe SSD Storage", description: "Blazing fast read/write speeds up to 10x faster than traditional SSDs." },
          { icon: "🛡️", title: "Advanced DDoS Mitigation", description: "Multi-layered scrubbing network filtering malicious attacks before reaching your site." },
          { icon: "🌐", title: "Global Anycast DNS", description: "Sub-millisecond resolution times across 30+ regional edge points of presence." },
          { icon: "🔄", title: "Automated Daily Backups", description: "Point-in-time recovery snapshots ensuring your data is always protected." },
          { icon: "🚀", title: "1-Click App Deployment", description: "Install Next.js, WordPress, Node.js, and databases with a single click." },
          { icon: "👨‍💻", title: "24/7 Expert Support", description: "Dedicated systems engineers ready to resolve complex queries in minutes." },
        ],
      },
      styles: { ...COMPONENT_REGISTRY.features.defaultStyles },
    };

    const pricingBlock: WebsiteBlock = {
      id: "block-pricing",
      type: "pricing",
      name: "Hosting Pricing Plans",
      props: {
        title: "Transparent Hosting Tiers",
        subtitle: "Pick the right plan for your application. Upgrade smoothly as your traffic scales.",
        billingPeriod: "/month",
        tiers: [
          {
            name: "Cloud Starter",
            price: "$4.99",
            description: "Perfect for single websites and personal landing pages.",
            features: ["1 Website", "25 GB NVMe Storage", "Unmetered Bandwidth", "Free SSL Certificate", "Daily Backups"],
            isPopular: false,
            buttonText: "Order Starter",
            buttonUrl: "#order-starter",
          },
          {
            name: "Cloud VPS Pro",
            price: "$19.99",
            description: "Dedicated resources for growing SaaS, e-commerce and high-traffic sites.",
            features: ["Unlimited Sites", "4 vCPU / 8 GB RAM", "100 GB NVMe Storage", "Dedicated IPv4", "Automated Snapshots", "Priority 24/7 Support"],
            isPopular: true,
            buttonText: "Deploy VPS Pro",
            buttonUrl: "#order-vps",
          },
          {
            name: "Dedicated Enterprise",
            price: "$89.99",
            description: "Isolated bare-metal hardware with customized private networking.",
            features: ["Dedicated Intel Xeon", "32 GB ECC RAM", "1 TB NVMe RAID", "Custom Firewall Rules", "99.99% SLA Guarantee", "Account Manager"],
            isPopular: false,
            buttonText: "Contact Enterprise",
            buttonUrl: "/contact",
          },
        ],
      },
      styles: { ...COMPONENT_REGISTRY.pricing.defaultStyles },
    };

    const faqBlock: WebsiteBlock = {
      id: "block-faq",
      type: "faq",
      name: "Hosting FAQ",
      props: {
        title: "Frequently Asked Questions",
        subtitle: "Clear answers to common questions about our cloud platform and migrations.",
        items: [
          { question: "How does free website migration work?", answer: "Our migration team moves your files, databases, and DNS configurations with zero downtime guaranteed." },
          { question: "Can I upgrade or downgrade my plan anytime?", answer: "Yes, resources can be scaled up or down in seconds from your dashboard with prorated billing." },
          { question: "Do you offer money-back guarantees?", answer: "We provide a full 30-day money-back guarantee on all shared and cloud VPS hosting plans." },
        ],
      },
      styles: { ...COMPONENT_REGISTRY.faq.defaultStyles },
    };

    const ctaBlock: WebsiteBlock = {
      id: "block-cta",
      type: "cta",
      name: "Launch CTA",
      props: {
        title: "Ready to launch your high-performance server?",
        subtitle: "Get your website online in under 60 seconds with our automated cloud provisioning.",
        buttonText: "Get Started Now →",
        buttonUrl: "/pricing",
        secondaryButtonText: "Talk to Sales",
        secondaryButtonUrl: "/contact",
      },
      styles: { ...COMPONENT_REGISTRY.cta.defaultStyles },
    };

    const contactBlock: WebsiteBlock = {
      id: "block-contact",
      type: "contact",
      name: "Contact Information",
      props: {
        title: "Get in Touch with Our Cloud Engineers",
        subtitle: "Have technical questions? Our server architects are available around the clock.",
        email: "support@" + name.toLowerCase().replace(/\s+/g, "") + ".com",
        phone: "+1 (800) 555-HOST",
        address: "100 Cloud Parkway, Suite 400, San Francisco, CA",
      },
      styles: { ...COMPONENT_REGISTRY.contact.defaultStyles },
    };

    const homeBlocks: WebsiteBlock[] = [
      makeNavbar(),
      heroBlock,
      featuresBlock,
      pricingBlock,
      faqBlock,
      ctaBlock,
      contactBlock,
      makeFooter(),
    ];

    const hostingBlocks: WebsiteBlock[] = [
      makeNavbar(),
      {
        id: "block-hosting-hero",
        type: "hero",
        name: "Cloud Hosting Overview",
        props: {
          badge: "MANAGED INFRASTRUCTURE",
          title: "Reliable Cloud Hosting Built for Speed",
          subtitle: "Lightning-fast page loading with isolated environments and automatic scaling.",
          primaryCtaText: "Choose a Server",
          primaryCtaUrl: "#pricing",
          secondaryCtaText: "Learn More",
          secondaryCtaUrl: "#features",
        },
        styles: { ...COMPONENT_REGISTRY.hero.defaultStyles, accentColor: primary },
      },
      featuresBlock,
      pricingBlock,
      makeFooter(),
    ];

    const domainsBlocks: WebsiteBlock[] = [
      makeNavbar(),
      {
        id: "block-domains-hero",
        type: "hero",
        name: "Domain Registration Hero",
        props: {
          badge: "DOMAIN NAMES",
          title: "Find and Register Your Perfect Domain Name",
          subtitle: "Secure your brand identity with hundreds of domain extensions at competitive annual pricing.",
          primaryCtaText: "Search Domains",
          primaryCtaUrl: "#search",
          secondaryCtaText: "Transfer Domain",
          secondaryCtaUrl: "#transfer",
        },
        styles: { ...COMPONENT_REGISTRY.hero.defaultStyles, accentColor: primary },
      },
      faqBlock,
      makeFooter(),
    ];

    const pricingBlocks: WebsiteBlock[] = [
      makeNavbar(),
      pricingBlock,
      faqBlock,
      ctaBlock,
      makeFooter(),
    ];

    const contactBlocks: WebsiteBlock[] = [
      makeNavbar(),
      contactBlock,
      faqBlock,
      makeFooter(),
    ];

    return {
      version: "1.0",
      id: `web_${Math.random().toString(36).slice(2, 10)}`,
      name,
      framework,
      theme: {
        primaryColor: primary,
        secondaryColor: "#1e293b",
        accentColor: "#60a5fa",
        backgroundColor: "#090d16",
        textColor: "#f8fafc",
        mutedColor: "#94a3b8",
        fontFamily: "system",
        borderRadius: "md",
      },
      pages: [
        {
          id: "page-home",
          title: "Home",
          slug: "/",
          seo: {
            title: `${name} | High-Performance Cloud & VPS Hosting`,
            description: options.purpose || `${name} - Ultra-fast cloud hosting, servers, and domain management.`,
            keywords: ["hosting", "vps", "cloud", "servers", "domains", name.toLowerCase()],
          },
          blocks: homeBlocks,
        },
        {
          id: "page-hosting",
          title: "Hosting",
          slug: "/hosting",
          seo: { title: `Cloud Hosting Plans | ${name}`, description: "Explore cloud hosting plans." },
          blocks: hostingBlocks,
        },
        {
          id: "page-domains",
          title: "Domains",
          slug: "/domains",
          seo: { title: `Domain Registration | ${name}`, description: "Register and transfer domains." },
          blocks: domainsBlocks,
        },
        {
          id: "page-pricing",
          title: "Pricing",
          slug: "/pricing",
          seo: { title: `Pricing & Plans | ${name}`, description: "Transparent cloud hosting pricing." },
          blocks: pricingBlocks,
        },
        {
          id: "page-contact",
          title: "Contact",
          slug: "/contact",
          seo: { title: `Contact Support | ${name}`, description: "Get in touch with 24/7 cloud support." },
          blocks: contactBlocks,
        },
      ],
      assets: [],
      updatedAt: now,
    };
  }

  // Generic / SaaS / Other templates
  const homeBlocks: WebsiteBlock[] = [
    makeNavbar(),
    {
      id: "block-hero",
      type: "hero",
      name: "Hero Section",
      props: {
        ...COMPONENT_REGISTRY.hero.defaultProps,
        title: name,
        subtitle: options.purpose || "Modern high-performing website built with NPATI AI Agent.",
      },
      styles: {
        ...COMPONENT_REGISTRY.hero.defaultStyles,
        accentColor: primary,
      },
    },
    {
      id: "block-features",
      type: "features",
      name: "Key Features",
      props: { ...COMPONENT_REGISTRY.features.defaultProps },
      styles: { ...COMPONENT_REGISTRY.features.defaultStyles },
    },
    {
      id: "block-pricing",
      type: "pricing",
      name: "Pricing Plans",
      props: { ...COMPONENT_REGISTRY.pricing.defaultProps },
      styles: { ...COMPONENT_REGISTRY.pricing.defaultStyles },
    },
    {
      id: "block-testimonials",
      type: "testimonials",
      name: "Customer Reviews",
      props: { ...COMPONENT_REGISTRY.testimonials.defaultProps },
      styles: { ...COMPONENT_REGISTRY.testimonials.defaultStyles },
    },
    {
      id: "block-faq",
      type: "faq",
      name: "Frequently Asked Questions",
      props: { ...COMPONENT_REGISTRY.faq.defaultProps },
      styles: { ...COMPONENT_REGISTRY.faq.defaultStyles },
    },
    {
      id: "block-cta",
      type: "cta",
      name: "Call to Action",
      props: { ...COMPONENT_REGISTRY.cta.defaultProps },
      styles: { ...COMPONENT_REGISTRY.cta.defaultStyles },
    },
    {
      id: "block-contact",
      type: "contact",
      name: "Contact Information",
      props: { ...COMPONENT_REGISTRY.contact.defaultProps },
      styles: { ...COMPONENT_REGISTRY.contact.defaultStyles },
    },
    makeFooter(),
  ];

  return {
    version: "1.0",
    id: `web_${Math.random().toString(36).slice(2, 10)}`,
    name,
    framework,
    theme: {
      primaryColor: primary,
      secondaryColor: "#1e293b",
      accentColor: "#60a5fa",
      backgroundColor: "#090d16",
      textColor: "#f8fafc",
      mutedColor: "#94a3b8",
      fontFamily: "system",
      borderRadius: "md",
    },
    pages: [
      {
        id: "page-home",
        title: "Home",
        slug: "/",
        seo: {
          title: `${name} | Official Website`,
          description: options.purpose || `${name} - Modern website built with NPATI AI`,
          keywords: ["website", name.toLowerCase(), "npati", "nextjs"],
        },
        blocks: homeBlocks,
      },
    ],
    assets: [],
    updatedAt: now,
  };
}
