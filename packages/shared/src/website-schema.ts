export * from "./website-schema-types";
export { COMPONENT_REGISTRY } from "./website-component-registry";

import { COMPONENT_REGISTRY } from "./website-component-registry";
import type { WebsiteBlock, WebsiteDocument, WebsiteDomainConfig } from "./website-schema-types";

export function createDefaultWebsiteDocument(
  name: string,
  framework: "nextjs" | "vite" | "static" = "nextjs",
  options: {
    purpose?: string;
    primaryColor?: string;
    includePages?: string[];
    template?: "hosting" | "saas" | "ecommerce" | "portfolio" | "landing" | "blank";
    domainConfig?: WebsiteDomainConfig;
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
    domainConfig: options.domainConfig,
    updatedAt: now,
  };
}
