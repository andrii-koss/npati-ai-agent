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
                <span className="col-icon">📁</span>
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
          API & SDK
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "auth" ? "active" : ""}`}
          onClick={() => setActiveTab("auth")}
        >
          {isUk ? "🔐 Автентифікація" : "🔐 Authentication"}
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "migrations" ? "active" : ""}`}
          onClick={() => setActiveTab("migrations")}
        >
          {isUk ? "📜 Історія міграцій" : "📜 Migrations"} ({migrationsCount})
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "backups" ? "active" : ""}`}
          onClick={() => setActiveTab("backups")}
        >
          {isUk ? "💾 Бекапи" : "💾 Backups"}
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeTab === "operations" ? "active" : ""}`}
          onClick={() => setActiveTab("operations")}
        >
          {isUk ? "🚀 Promote та квоти" : "🚀 Promote & Quotas"}
        </button>
      </div>
    </aside>
  );
}
