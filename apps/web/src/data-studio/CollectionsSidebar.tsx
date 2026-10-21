import React from "react";

export interface CollectionsSidebarProps {
  isUk: boolean;
  environment: "dev" | "prod";
  isDrift: boolean;
  userCollections: { name: string; columns: unknown[] }[];
  selectedCollection: string;
  setSelectedCollection: (name: string) => void;
  setPageOffset: (offset: number) => void;
  activeTab: string;
  setActiveTab: (tab: any) => void;
  migrationsCount: number;
  onOpenCreateCollection: () => void;
}

export function CollectionsSidebar({
  isUk,
  environment,
  isDrift,
  userCollections,
  selectedCollection,
  setSelectedCollection,
  setPageOffset,
  activeTab,
  setActiveTab,
  migrationsCount,
  onOpenCreateCollection,
}: CollectionsSidebarProps) {
  return (
    <aside className="data-studio-sidebar" aria-label="Collections Sidebar">
      <div className="sidebar-header">
        <h3>{isUk ? "Колекції" : "Collections"}</h3>
        {environment === "dev" && !isDrift && (
          <button
            type="button"
            className="button-primary new-collection-btn"
            onClick={onOpenCreateCollection}
            title={isUk ? "Створити колекцію" : "New Collection"}
          >
            +
          </button>
        )}
      </div>

      <div className="collections-list">
        {userCollections.length === 0 ? (
          <div className="no-collections-hint">
            <p>{isUk ? "Колекцій ще немає." : "No collections yet."}</p>
            {environment === "dev" && (
              <button
                type="button"
                className="button-secondary"
                onClick={onOpenCreateCollection}
              >
                {isUk ? "+ Створити першу" : "+ Create first"}
              </button>
            )}
          </div>
        ) : (
          userCollections.map((col) => {
            const isSelected = col.name === selectedCollection;
            return (
              <button
                key={col.name}
                type="button"
                className={`collection-item ${isSelected ? "active" : ""}`}
                onClick={() => {
                  setSelectedCollection(col.name);
                  setPageOffset(0);
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="col-svg-icon" style={{ flexShrink: 0, opacity: isSelected ? 1 : 0.65 }}>
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
                </svg>
                <span className="col-name">{col.name}</span>
                <span className="col-count">{col.columns.length}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "api" ? "active" : ""}`}
          onClick={() => setActiveTab("api")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>API & SDK</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "auth" ? "active" : ""}`}
          onClick={() => setActiveTab("auth")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>{isUk ? "Автентифікація" : "Authentication"}</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "migrations" ? "active" : ""}`}
          onClick={() => setActiveTab("migrations")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span>{isUk ? "Історія міграцій" : "Migrations"}</span>
          <span className="col-count" style={{ marginLeft: "auto" }}>{migrationsCount}</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "backups" ? "active" : ""}`}
          onClick={() => setActiveTab("backups")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span>{isUk ? "Резервні копії" : "Backups"}</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "operations" ? "active" : ""}`}
          onClick={() => setActiveTab("operations")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M18 20V10M12 20V4M6 20v-6" />
          </svg>
          <span>{isUk ? "Promote та квоти" : "Promote & Quotas"}</span>
        </button>
      </div>
    </aside>
  );
}
