import { authFetch } from "./auth-helpers";

export type SidebarConversation = {
  id: string;
  title: string;
  updatedAt: string;
  businessId: string | null;
  businessName: string;
};

export const legacyChatStorageResetMarker = "npati_legacy_chat_storage_removed_2026_09_06_v1";

export function clearLegacyLocalChatsOnce() {
  try {
    if (localStorage.getItem(legacyChatStorageResetMarker) === "done") return;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key === "npati_saved_chats" || key === "npati_free_chats" || key?.startsWith("npati_chat_messages:")) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem(legacyChatStorageResetMarker, "done");
  } catch {
    /* storage can be unavailable in restricted browser contexts */
  }
}

export const SIDEBAR_CONVERSATIONS_CACHE_KEY = "npati_sidebar_conversations_cache_v1";
let cachedSidebarConversations: SidebarConversation[] | null = null;
let isSidebarConversationsLoaded = false;
let activeSidebarConversationsFetch: Promise<SidebarConversation[]> | null = null;

let cachedChatOpen = true;
let cachedBusinessOpen = true;

export function getCachedChatOpen(): boolean {
  return cachedChatOpen;
}

export function setCachedChatOpen(value: boolean): void {
  cachedChatOpen = value;
}

export function getCachedBusinessOpen(): boolean {
  return cachedBusinessOpen;
}

export function setCachedBusinessOpen(value: boolean): void {
  cachedBusinessOpen = value;
}

export function getCachedSidebarConversations(): SidebarConversation[] | null {
  return cachedSidebarConversations;
}

export function getIsSidebarConversationsLoaded(): boolean {
  return isSidebarConversationsLoaded;
}

export function getActiveSidebarConversationsFetch(): Promise<SidebarConversation[]> | null {
  return activeSidebarConversationsFetch;
}

export function setActiveSidebarConversationsFetch(fetchPromise: Promise<SidebarConversation[]> | null): void {
  activeSidebarConversationsFetch = fetchPromise;
}

export function getInitialSidebarConversations(): SidebarConversation[] {
  if (cachedSidebarConversations !== null) {
    return cachedSidebarConversations;
  }
  try {
    const raw = sessionStorage.getItem(SIDEBAR_CONVERSATIONS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedSidebarConversations = parsed;
        return parsed;
      }
    }
  } catch {
    /* storage may be restricted */
  }
  return [];
}

export function updateCachedSidebarConversations(items: SidebarConversation[]) {
  cachedSidebarConversations = items;
  isSidebarConversationsLoaded = true;
  try {
    sessionStorage.setItem(SIDEBAR_CONVERSATIONS_CACHE_KEY, JSON.stringify(items));
  } catch {
    /* storage may be restricted */
  }
}

export const SIDEBAR_BUSINESSES_CACHE_KEY = "npati_sidebar_businesses_cache_v1";

export type CachedBusinessDraft = {
  businessId: string;
  business: { name: string };
  conversationId?: string;
};

export type CachedBusinessItem = {
  id: string;
  name: string;
};

let cachedSidebarDrafts: CachedBusinessDraft[] | null = null;
let cachedSidebarBusinesses: CachedBusinessItem[] | null = null;
let isSidebarBusinessesLoaded = false;

export function getCachedSidebarDrafts(): CachedBusinessDraft[] | null {
  return cachedSidebarDrafts;
}

export function getCachedSidebarBusinesses(): CachedBusinessItem[] | null {
  return cachedSidebarBusinesses;
}

export function getIsSidebarBusinessesLoaded(): boolean {
  return isSidebarBusinessesLoaded;
}

export function getInitialSidebarBusinesses(): { drafts: CachedBusinessDraft[]; businesses: CachedBusinessItem[] } {
  if (cachedSidebarDrafts !== null && cachedSidebarBusinesses !== null) {
    return { drafts: cachedSidebarDrafts, businesses: cachedSidebarBusinesses };
  }
  try {
    const raw = sessionStorage.getItem(SIDEBAR_BUSINESSES_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.drafts) && Array.isArray(parsed.businesses)) {
        cachedSidebarDrafts = parsed.drafts;
        cachedSidebarBusinesses = parsed.businesses;
        return parsed;
      }
    }
  } catch {
    /* storage may be restricted */
  }
  return { drafts: [], businesses: [] };
}

export function updateCachedSidebarBusinesses(drafts: CachedBusinessDraft[], businesses: CachedBusinessItem[]) {
  cachedSidebarDrafts = drafts;
  cachedSidebarBusinesses = businesses;
  isSidebarBusinessesLoaded = true;
  try {
    sessionStorage.setItem(SIDEBAR_BUSINESSES_CACHE_KEY, JSON.stringify({ drafts, businesses }));
  } catch {
    /* storage may be restricted */
  }
}

export function areSidebarConversationsEqual(a: SidebarConversation[], b: SidebarConversation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (!itemA || !itemB) return false;
    if (
      itemA.id !== itemB.id ||
      itemA.title !== itemB.title ||
      itemA.updatedAt !== itemB.updatedAt ||
      itemA.businessId !== itemB.businessId ||
      itemA.businessName !== itemB.businessName
    ) {
      return false;
    }
  }
  return true;
}

export async function fetchAllSidebarConversations(
  businesses: Array<{ id: string; name: string }>
): Promise<SidebarConversation[]> {
  const neutralRequest = authFetch("/api/conversations", { cache: "no-store" });
  const businessRequests = businesses.map(async (business) => {
    const response = await authFetch(`/api/businesses/${business.id}/conversations`, { cache: "no-store" });
    if (!response.ok) return [] as SidebarConversation[];
    return ((await response.json()) as Omit<SidebarConversation, "businessId" | "businessName">[]).map(
      (conversation) => ({ ...conversation, businessId: business.id, businessName: business.name })
    );
  });
  const [neutralResponse, ...businessRows] = await Promise.all([neutralRequest, ...businessRequests]);
  const neutralRows = neutralResponse.ok
    ? ((await neutralResponse.json()) as Omit<SidebarConversation, "businessId" | "businessName">[]).map(
        (conversation) => ({ ...conversation, businessId: null, businessName: "" })
      )
    : [];
  return [...neutralRows, ...businessRows.flat()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}
