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
  icon?: string;
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

export interface WebsiteDomainConfig {
  domain: string;
  isTechnicalDomain?: boolean;
  path?: string; // defaults to "/"
  stripPath?: boolean;
  port: number; // e.g. 3000
  customEntrypoint?: boolean;
  entrypoints?: string[]; // e.g. ["web", "websecure"]
  sslCertificate: boolean;
  certificateProvider?: "letsencrypt" | "none";
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
  domainConfig?: WebsiteDomainConfig;
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
