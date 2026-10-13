/** Shared deterministic routing: creation requests only, never ordinary project edits. */
export type DevelopmentTarget = { name: string; kind: "website" | "blog" | "store" | "crm" | "mobile_app"; framework: "Next.js" | "HTML/CSS" | "Expo" };
export type DevelopmentProcessProgressItem = {
  id: string;
  stage: string;
  title: string;
  at: string;
  status?: "active" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_approval";
  tool?: string;
  command?: string;
  file?: string;
  cwd?: string;
  result?: string;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  errorCode?: string;
  agentId?: string;
};
export type DevelopmentProcess = {
  id: string; companyId: string; parentConversationId: string; conversationId?: string;
  projectId?: string; sessionId?: string; runId?: string; name: string; framework: string;
  status: "idle" | "queued" | "preparing" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted" | "awaiting_approval";
  progress?: DevelopmentProcessProgressItem[];
  inboxEnabled?: boolean; hidden: boolean; createdAt: string; updatedAt: string; detail?: string; previewUrl?: string;
};
export const developmentIsActive = (p: DevelopmentProcess) => ["queued", "preparing", "running", "stopping"].includes(p.status);
export function requestsDevelopmentRestore(message: string): boolean {
  return /(?:open|show|restore|відкри|покаж|віднов|открой).*(?:development processes|процеси.*розроб|процессы.*разраб)/iu.test(message);
}
export function planChatDevelopment(message: string): DevelopmentTarget[] {
  if (!/(?:\bcreate\b|\bbuild\s+(?:a\s+|an\s+|new\s+|[1-4]\s+)?(?:website|site|shop|store|blog|mobile|crm)|\bmake\b|створ|зроби|создай|создать)/iu.test(message)) return [];
  if (/(?:create|make|створ|зроби|создай).*(?:\bpage\b|\bcomponent\b|\bbutton\b|\bheader\b|сторінк|компонент|кнопк)/iu.test(message)
      && !/(?:new\s+(?:website|site)|новий\s+сайт)/iu.test(message)) return [];
  const kinds: DevelopmentTarget["kind"][] = [];
  if (/(?:website|\bsite\b|сайт|landing)/iu.test(message)) kinds.push("website");
  if (/(?:blog|блог)/iu.test(message)) kinds.push("blog");
  if (/(?:store|shop|магазин)/iu.test(message)) {
    // A 'website shop' is one project; explicitly separate company sites remain distinct.
    if (kinds.includes("website") && !/(?:company|компан)/iu.test(message)) kinds.splice(kinds.indexOf("website"), 1);
    kinds.push("store");
  }
  if (/(?:mobile\s+app|мобільн|мобильн)/iu.test(message)) kinds.push("mobile_app");
  if (/(?:\bcrm\b|срм)/iu.test(message)) kinds.push("crm");
  const names = { website: "Company website", blog: "Blog", store: "Online store", mobile_app: "Mobile app", crm: "CRM" };
  const count = kinds.length === 1 ? Number(/(?:create|build|make|створи|зроби|создай)\s+(?:мені\s+)?(\d+)/iu.exec(message)?.[1] ?? 1) : kinds.length;
  if (count > 4 || kinds.length > 4) throw new Error("A chat can start up to four development projects at once.");
  const targets = kinds.length === 1 ? Array.from({ length: Math.max(1, count) }, () => kinds[0]!) : kinds;
  return targets.map((kind, index) => ({ kind, name: names[kind] + (count > 1 && kinds.length === 1 ? " " + (index + 1) : ""), framework: kind === "mobile_app" ? "Expo" : /html\s*(?:\/|and|\+)\s*css/iu.test(message) ? "HTML/CSS" : "Next.js" }));
}
