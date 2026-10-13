export type MemoryType =
  | "business_fact"
  | "audience"
  | "brand"
  | "preference"
  | "decision"
  | "product"
  | "channel"
  | "experiment"
  | "result"
  | "other";

export interface MemoryItem {
  id: string;
  workspaceId: string;
  businessId: string;
  userId: string;
  type: MemoryType;
  title: string;
  content: string;
  source: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFormData {
  type: MemoryType;
  title: string;
  content: string;
  confidence: string;
}

export const initialForm: MemoryFormData = {
  type: "business_fact",
  title: "",
  content: "",
  confidence: "1.0",
};

export const MEMORY_TYPE_META: Record<
  MemoryType,
  { icon: string; badgeClass: string; categoryGroup: string }
> = {
  business_fact: {
    icon: "📌",
    badgeClass: "badge-fact",
    categoryGroup: "facts",
  },
  audience: {
    icon: "🎯",
    badgeClass: "badge-audience",
    categoryGroup: "audience",
  },
  brand: {
    icon: "✨",
    badgeClass: "badge-brand",
    categoryGroup: "brand",
  },
  decision: {
    icon: "⚖️",
    badgeClass: "badge-decision",
    categoryGroup: "decisions",
  },
  product: {
    icon: "📦",
    badgeClass: "badge-product",
    categoryGroup: "product",
  },
  channel: {
    icon: "📢",
    badgeClass: "badge-channel",
    categoryGroup: "audience",
  },
  preference: {
    icon: "⚙️",
    badgeClass: "badge-preference",
    categoryGroup: "brand",
  },
  experiment: {
    icon: "🧪",
    badgeClass: "badge-experiment",
    categoryGroup: "decisions",
  },
  result: {
    icon: "📈",
    badgeClass: "badge-result",
    categoryGroup: "decisions",
  },
  other: {
    icon: "📝",
    badgeClass: "badge-other",
    categoryGroup: "other",
  },
};
