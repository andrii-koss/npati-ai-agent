import { Database, ExternalLink } from "lucide-react";
import type { DatabaseCardData } from "@npati/shared";
import { chatCardLabels } from "./chat-card-i18n";

/**
 * The block of a project database the agent created in a chat (owner, V6 step 14). It sits under the reply that created
 * the database, like the website block: the database name (shortened when long), "PostgreSQL · Data Studio", its status
 * and Open, which shows that database in Data Studio. Labels follow the language of the person's request.
 */
export function ChatDatabaseCard({ card, language }: { card: DatabaseCardData; language?: string }) {
  const L = chatCardLabels(language);
  const path = "/settings/data-studio/" + encodeURIComponent(card.name);
  const title = card.name?.trim() || L.database;
  const status = card.status === "ready" ? { key: "running", label: L.running } : card.status === "provisioning" ? { key: "starting", label: L.starting } : { key: "failed", label: L.failed };

  return (
    <div className="chat-project-preview-card chat-database-card" data-testid="chat-database-card">
      <div className="chat-preview-card-left">
        <div className="chat-preview-card-thumbnail chat-database-card-thumbnail" aria-hidden="true">
          <div className="ds-environment-icon"><Database size={36} strokeWidth={1.8} /></div>
        </div>
        <div className="chat-preview-card-info">
          <h4 className="chat-preview-card-title" title={title}>{title}</h4>
          <span className="chat-preview-card-subtitle">{card.engine} · Data Studio</span>
          <div className={`chat-preview-card-status status-${status.key}`}>
            <span className="chat-preview-status-dot" aria-hidden="true" />
            <span>{status.label}</span>
          </div>
        </div>
      </div>
      <div className="chat-preview-card-actions">
        <a href={path} target="_blank" rel="noopener" className="chat-preview-open-btn chat-database-open" aria-label={L.open + ": " + title}>
          <ExternalLink size={15} aria-hidden="true" strokeWidth={2.3} />
          <span>{L.open}</span>
        </a>
      </div>
    </div>
  );
}
