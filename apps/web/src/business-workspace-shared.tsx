import { getStoredAuthToken } from "./AuthContext";
import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";

export type Business = {
  id: string; name: string; businessType?: string; industry?: string; niche?: string; country?: string;
  market?: string; website?: string; businessStage: string; teamType?: string; businessModel?: string;
  presenceType?: string; description?: string; audienceSummary?: string; productsServicesSummary?: string;
  legalName?: string; contactEmail?: string; contactPhone?: string; postalAddress?: string; registrationDetails?: string; logoFileId?: string;
  activationStatus?: "draft" | "active";
};
export type Goal = { id: string; title: string; description?: string; status: string; priority: number; targetDate?: string };
export type MemoryItem = { id: string; type: string; title: string; content: string; source: string; updatedAt: string };
export type Company = { id: string; name: string; businessId?: string; revision: number; status: string };
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`/api${url}`, {
    ...init,
    headers,
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("npati:unauthorized"));
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    Object.assign(error, { code: payload?.error?.code, status: response.status });
    throw error;
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export const blankBusiness = {
  name: "", businessType: "", industry: "", niche: "", country: "", market: "", website: "",
  businessStage: "starting", teamType: "solo", businessModel: "", presenceType: "online",
  description: "", audienceSummary: "", productsServicesSummary: "", legalName: "", contactEmail: "",
  contactPhone: "", postalAddress: "", registrationDetails: "", logoFileId: "",
};
export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "error" | "success" }) {
  return <div className={`workspace-notice ${tone}`}>{children}</div>;
}
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider is missing");
  return value;
}
export type Skill = { id: string; name: string; description: string; capabilities: string[] };
export function getCachedSkills(): Skill[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_SKILLS_KEY) || localStorage.getItem(STORAGE_SKILLS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_SKILLS;
}
export function updateCachedSkills(items: Skill[]) {
  try {
    const serialized = JSON.stringify(items);
    sessionStorage.setItem(STORAGE_SKILLS_KEY, serialized);
    localStorage.setItem(STORAGE_SKILLS_KEY, serialized);
  } catch {}
}
export function PageIntro({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: ReactNode }) {
  return <div className="workspace-page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>{action}</div>;
}
export function EmptyBusiness({ feature }: { feature: string }) {
  return <Notice><strong>Set up a business first.</strong><span>{feature} are isolated per business, so NPATI needs an active business workspace.</span><Link to="/business">Set up business →</Link></Notice>;
}
export const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<WorkspaceOverview | null>(getInitialWorkspaceOverview);
  const [loading, setLoading] = useState(() => getInitialWorkspaceOverview() === null);
  const [error, setError] = useState("");
  async function refresh() {
    if (!overview && !cachedWorkspaceOverview) {
      setLoading(true);
    }
    try {
      const nextOverview = await api<WorkspaceOverview>("/workspace/context");
      updateCachedWorkspaceOverview(nextOverview);
      setOverview((prev) => {
        if (prev && JSON.stringify(prev) === JSON.stringify(nextOverview)) {
          return prev;
        }
        return nextOverview;
      });
      setError("");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Workspace is unavailable"); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    const handleBusinessChanged = () => { void refresh(); };
    window.addEventListener("npati:business-changed", handleBusinessChanged);
    return () => window.removeEventListener("npati:business-changed", handleBusinessChanged);
  }, []);
  async function switchBusiness(id: string) {
    await api("/workspace/current-business", { method: "PUT", body: JSON.stringify({ businessId: id }) });
    await refresh();
  }
  return <WorkspaceContext.Provider value={{ overview, loading, error, refresh, switchBusiness }}>{children}</WorkspaceContext.Provider>;
}
export const DEFAULT_SKILLS: Skill[] = [
  {
    id: "competitor-analysis",
    name: "Competitor Analysis",
    description: "Finds relevant competitors and compares public evidence with the current Business context.",
    capabilities: ["competitors.discover", "competitors.compare", "web.search", "web.fetch", "web.crawl"],
  },
  {
    id: "web-research",
    name: "Web Research",
    description: "Searches and reads public web sources through the protected NPATI Web Research boundary.",
    capabilities: ["web.search", "web.fetch", "web.crawl"],
  },
  {
    id: "business-startup",
    name: "Business Startup",
    description: "Shape a business idea, audience, offer, and first validation plan.",
    capabilities: ["business-idea", "niche", "audience", "validation"],
  },
  {
    id: "business-growth",
    name: "Business Growth",
    description: "Find practical acquisition, retention, positioning, and growth opportunities.",
    capabilities: ["growth-plan", "customer-acquisition", "retention", "metrics"],
  },
  {
    id: "sell-product",
    name: "Sell Product",
    description: "Turn a product or service into a clear offer and sales plan.",
    capabilities: ["offer", "positioning", "pricing", "sales-channel"],
  },
];
export const STORAGE_SKILLS_KEY = "npati_skills_cache_v1";
export type WorkspaceValue = {
  overview: WorkspaceOverview | null;
  loading: boolean;
  error: string;
  refresh(): Promise<void>;
  switchBusiness(id: string): Promise<void>;
};
export type WorkspaceOverview = {
  user: { id: string; displayName: string };
  workspace: { id: string; name: string; role: string };
  businesses: Business[];
  currentBusiness: Business | null;
  onboarding: OnboardingSession | null;
  onboardings: OnboardingSession[];
};
export let cachedWorkspaceOverview: WorkspaceOverview | null = null;
export function getInitialWorkspaceOverview(): WorkspaceOverview | null {
  if (cachedWorkspaceOverview) return cachedWorkspaceOverview;
  try {
    const raw = sessionStorage.getItem(WORKSPACE_OVERVIEW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.businesses)) {
        cachedWorkspaceOverview = parsed as WorkspaceOverview;
        return cachedWorkspaceOverview;
      }
    }
  } catch { /* storage may be restricted */ }
  return null;
}
export function updateCachedWorkspaceOverview(data: WorkspaceOverview) {
  cachedWorkspaceOverview = data;
  try {
    sessionStorage.setItem(WORKSPACE_OVERVIEW_STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage may be restricted */ }
}
export type OnboardingSession = {
  id: string; businessId: string; conversationId: string; scenario: "existing" | "starting" | "seller";
  status: "active" | "paused" | "awaiting_confirmation" | "completed"; currentStep: number; totalFields: number;
  completedFields: string[]; skippedFields: string[]; currentField?: string; business: Business;
  updatedAt: string;
};
export const WORKSPACE_OVERVIEW_STORAGE_KEY = "npati_workspace_overview_cache_v1";
