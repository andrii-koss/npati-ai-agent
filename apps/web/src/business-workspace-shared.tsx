import { getStoredAuthToken, useAuth } from "./AuthContext";
import { readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { chatOpen, isChatPage } from "./chat-open";
import { api } from "./workspace-api";
import { openGoalsPage } from "./goals-page-read";
import { openMemoryPage } from "./memory-page-read";
import { openAutomationsPage } from "./automations-page-read";

const settingsRecordOpeners: Record<string, typeof openGoalsPage | typeof openMemoryPage | typeof openAutomationsPage> = {
  "/settings/goals": openGoalsPage, "/goals": openGoalsPage,
  "/settings/memory": openMemoryPage, "/memory": openMemoryPage,
  "/settings/automations": openAutomationsPage,
};

export type Business = {
  id: string; name: string; businessType?: string; industry?: string; niche?: string; country?: string;
  market?: string; website?: string; businessStage: string; teamType?: string; businessModel?: string;
  presenceType?: string; description?: string; audienceSummary?: string; productsServicesSummary?: string;
  legalName?: string; contactEmail?: string; contactPhone?: string; postalAddress?: string; registrationDetails?: string; logoFileId?: string;
  activationStatus?: "draft" | "active"; createdAt?: string; updatedAt?: string;
};
export type Goal = { id: string; title: string; description?: string; status: string; priority: number; targetDate?: string };
export type MemoryItem = { id: string; type: string; title: string; content: string; source: string; updatedAt: string };
export type Company = { id: string; name: string; businessId?: string; revision: number; status: string };
export { api } from "./workspace-api";
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
  const { token, isLoading: authLoading } = useAuth();
  const [overview, setOverview] = useState<WorkspaceOverview | null>(getInitialWorkspaceOverview);
  const [loading, setLoading] = useState(() => getInitialWorkspaceOverview() === null);
  const [error, setError] = useState("");
  async function refresh(initial = false) {
    const cached = getInitialWorkspaceOverview();
    if (cached) setOverview(previous => previous ?? cached);
    if (!overview && !cachedWorkspaceOverview) {
      setLoading(true);
    }
    try {
      // Opening a chat page reads the overview from its single open request instead of a request of its own.
      const opened = initial && isChatPage() ? await chatOpen().catch(() => null) : null;
      const path = window.location.pathname.replace(/\/$/, "");
      const scopeId = new URLSearchParams(window.location.search).get(path === "/settings/automations" ? "company" : "business");
      const openRecords = settingsRecordOpeners[path];
      const records = initial && openRecords
        ? await openRecords(scopeId && scopeId !== "all" ? scopeId : undefined, "workspace").catch(() => null)
        : null;
      const nextOverview = opened?.overview ?? records?.overview
        ?? await requestSettingsRead("business:overview", () => api<WorkspaceOverview>("/workspace/context"));
      if (getStoredAuthToken() !== token) return;
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
    if (authLoading || !token) return;
    void refresh(true);
    const handleBusinessChanged = () => { void refresh(); };
    window.addEventListener("npati:business-changed", handleBusinessChanged);
    return () => window.removeEventListener("npati:business-changed", handleBusinessChanged);
  }, [authLoading, token]);
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
  const cached = readSettingsSnapshot<WorkspaceOverview>("business:overview");
  cachedWorkspaceOverview = cached ?? null;
  return cachedWorkspaceOverview;
}
export function updateCachedWorkspaceOverview(data: WorkspaceOverview) {
  cachedWorkspaceOverview = data;
  writeSettingsSnapshot("business:overview", data);
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
