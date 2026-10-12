import { useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";

export interface Company {
  id: string;
  name: string;
}
export interface EmailAccount {
  id: string;
  emailAddress: string;
  displayName?: string | null;
  agentId?: string | null;
  mode: "manual" | "approval" | "autopilot";
  status?: "connected" | "pending" | "auth_error" | "imap_error" | "smtp_error" | "dns_error" | "disabled";
  testMode: boolean;
}
export interface EmailThread {
  id: string;
  subject: string;
  customerEmail: string;
  customerName?: string | null;
  customerCompany?: string | null;
  customerPhone?: string | null;
  status: "new" | "ai_processing" | "draft_ready" | "waiting_approval" | "waiting_customer" | "waiting_human" | "answered" | "closed" | "failed";
  priority: "low" | "normal" | "high" | "urgent";
  folder: "inbox" | "sent" | "drafts" | "archived" | "spam";
  assignedAgentId?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  isHumanTakeover: boolean;
  lockedByUserId?: string | null;
  lockedAt?: string | null;
  lastMessageAt: string;
  unreadCount: number;
  messagesCount?: number;
  aiConfidenceScore?: number | null;
  aiClassificationSummary?: string | null;
  detectedLanguage?: string | null;
}
export interface EmailAttachmentView {
  filename: string;
  contentType: string;
  sizeBytes: number;
  url?: string;
  contentBase64?: string;
}
export interface EmailMessage {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  fromName?: string | null;
  toAddresses: string[];
  ccAddresses?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: EmailAttachmentView[];
  isDraft: boolean;
  isAiGenerated: boolean;
  deliveryStatus: string;
  createdAt: string;
}
export interface ContactDetails {
  email: string;
  name?: string | null;
  companyName?: string | null;
  phone?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  notes?: string | null;
  lastActivityAt?: string | null;
  previousThreadsCount?: number;
}
export function getStatusLabel(status: EmailThread["status"], t: (key: string) => string): string {
  switch (status) {
    case "draft_ready":
      return t("emailInbox.statuses.draft_ready");
    case "waiting_approval":
      return t("emailInbox.statuses.waiting_approval");
    case "waiting_customer":
      return t("emailInbox.statuses.waiting_customer");
    case "waiting_human":
      return t("emailInbox.statuses.waiting_human");
    case "ai_processing":
      return t("emailInbox.statuses.ai_processing");
    case "answered":
      return t("emailInbox.statuses.answered");
    case "closed":
      return t("emailInbox.statuses.closed");
    case "failed":
      return t("emailInbox.statuses.failed");
    case "new":
      return t("emailInbox.statuses.new");
    default:
      return (status as string).replace("_", " ");
  }
}
export function sanitizeEmailHtml(rawHtml: string): string {
  const source = new DOMParser().parseFromString(rawHtml, "text/html");
  const target = document.implementation.createHTMLDocument("");
  const allowedTags = new Set([
    "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "li", "ol", "p", "pre", "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
  ]);
  const blockedTags = new Set(["base", "embed", "form", "iframe", "input", "link", "math", "meta", "object", "script", "style", "svg", "textarea"]);

  const copyNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return target.createTextNode(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (blockedTags.has(tag)) return null;
    const children = Array.from(element.childNodes).map(copyNode).filter((child): child is Node => child !== null);
    if (!allowedTags.has(tag)) {
      const fragment = target.createDocumentFragment();
      children.forEach((child) => fragment.appendChild(child));
      return fragment;
    }
    const clean = target.createElement(tag);
    if (tag === "a") {
      const href = element.getAttribute("href")?.trim();
      if (href && /^https?:\/\//i.test(href)) {
        clean.setAttribute("href", "#");
        clean.setAttribute("data-email-url", href);
        clean.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
    if ((tag === "td" || tag === "th") && /^\d{1,2}$/.test(element.getAttribute("colspan") || "")) {
      clean.setAttribute("colspan", element.getAttribute("colspan")!);
    }
    children.forEach((child) => clean.appendChild(child));
    return clean;
  };

  Array.from(source.body.childNodes).map(copyNode).filter((node): node is Node => node !== null)
    .forEach((node) => target.body.appendChild(node));
  return target.body.innerHTML;
}
export interface CustomerContext {
  previousThreads: Array<{ id: string; subject: string; status: string; priority: string; lastMessageAt: string }>;
  tasks: Array<{ id: string; task: string; status: string; createdAt: string }>;
}
export interface EmailNotification {
  id: string;
  threadId?: string | null;
  notificationType: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}
export interface EmailAuditEntry {
  id: string;
  action: string;
  userId: string;
  details: Record<string, unknown>;
  createdAt: string;
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const method = (init?.method || "GET").toUpperCase();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    cache: init?.cache || (method === "GET" ? "no-store" : undefined),
  });
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } | string; message?: string };
  if (!response.ok) {
    const apiMessage = typeof body?.error === "string" ? body?.message || body.error : body?.error?.message || body?.message;
    const deploymentHint = response.status === 404 && (!apiMessage || /^Route .* not found$/i.test(apiMessage))
      ? `${apiMessage ? `${apiMessage} ` : ""}Deploy/restart both the web and agent-api services from the same revision.`
      : undefined;
    throw new Error(apiMessage || deploymentHint || `Request failed (${response.status})`);
  }
  return body;
}
export async function fileToEmailAttachment(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  return {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}
export function EmailImageAttachment({
  attachment,
  onPreview,
  onFallbackOpen,
}: {
  attachment: EmailAttachmentView;
  onPreview: (source: string, filename: string) => void;
  onFallbackOpen: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(
    attachment.contentBase64 ? `data:${attachment.contentType};base64,${attachment.contentBase64}` : null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (attachment.contentBase64 || !attachment.url) return;
    let active = true;
    let objectUrl: string | null = null;
    const headers = new Headers();
    const token = getStoredAuthToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    fetch(attachment.url, { headers, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Image load failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.contentBase64, attachment.url]);

  if (failed || (!source && !attachment.url)) {
    return (
      <button type="button" className="automation-cron-pill" onClick={onFallbackOpen}>
        📎 {attachment.filename}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="email-image-attachment"
      onClick={() => source && onPreview(source, attachment.filename)}
      disabled={!source}
      title={source ? `${t("emailInbox.messagesTimeline.openImagePrefix")}${attachment.filename}` : t("emailInbox.messagesTimeline.loadingImage")}
    >
      {source ? <img src={source} alt={attachment.filename} /> : <span>{t("emailInbox.messagesTimeline.loadingImage")}</span>}
      <small>{attachment.filename}</small>
    </button>
  );
}
