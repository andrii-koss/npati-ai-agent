import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Database, ExternalLink } from "lucide-react";
import type { DatabaseCardData } from "@npati/shared";
import { chatCardLabels } from "./chat-card-i18n";

/**
 * The block of a project database the agent created in a chat (owner, V6 step 14). It sits under the reply that created
 * the database, like the website block: the database name (shortened when long), "PostgreSQL · Data Studio", its status
 * and Open, which shows that database in Data Studio. Labels follow the language of the person's request.
 */
export function ChatDatabaseCard({ card, language }: { card: DatabaseCardData; language?: string }) {
  const L = chatCardLabels(language);
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const path = "/settings/data-studio/" + encodeURIComponent(card.name);
  const title = card.name?.trim() || L.database;
  const status = card.status === "ready" ? { key: "running", label: L.running } : card.status === "provisioning" ? { key: "starting", label: L.starting } : { key: "failed", label: L.failed };

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  return (
    <div className="chat-project-preview-card chat-database-card" data-testid="chat-database-card">
      <div className="chat-preview-card-left">
        <div className="chat-preview-card-thumbnail chat-database-card-icon" aria-hidden="true">
          <Database size={30} strokeWidth={2} />
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
      <div className="chat-preview-card-actions" ref={menuRef}>
        <button type="button" className="chat-preview-open-btn chat-database-open" onClick={() => navigate(path)} aria-label={L.open + ": " + title}>
          <ExternalLink size={15} aria-hidden="true" strokeWidth={2.3} />
          <span>{L.open}</span>
        </button>
        <button type="button" className="chat-preview-dropdown-btn" onClick={() => setMenuOpen((open) => !open)} aria-label={L.more} aria-haspopup="true" aria-expanded={menuOpen}>
          <ChevronDown size={16} aria-hidden="true" strokeWidth={2.5} />
        </button>
        {menuOpen && (
          <div className="chat-preview-dropdown-menu" role="menu">
            <button type="button" className="chat-preview-dropdown-item" role="menuitem" onClick={() => { setMenuOpen(false); window.open(path, "_blank", "noopener"); }}>
              <ExternalLink size={14} aria-hidden="true" />
              <span>{L.openNewTab}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
