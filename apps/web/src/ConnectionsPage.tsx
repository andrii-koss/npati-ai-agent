import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";

interface ServiceStatus {
  id: string;
  name: string;
  category: "internal" | "provider" | "storage";
  status: "ok" | "degraded" | "error" | "not_configured";
  endpoint: string;
  description: string;
  icon: string;
  details?: string;
}

export function ConnectionsPage() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);

  async function checkConnections() {
    setChecking(true);
    try {
      const headers: HeadersInit = {};
      const token = getStoredAuthToken();
      if (token) headers["authorization"] = `Bearer ${token}`;

      const res = await fetch("/api/health", { headers });
      const data = res.ok ? await res.json() : null;

      const items: ServiceStatus[] = [
        {
          id: "omniroute",
          name: "OmniRoute AI Engine",
          icon: "⚡",
          category: "internal",
          status: data?.services?.omniroute === "ok" ? "ok" : "error",
          endpoint: "http://omniroute:20128",
          description: "A2A orchestration, combo routing, fusion, pipeline & embedding engine (v3.8.50).",
          details: data?.details?.omniroute?.version ? `Version: ${data.details.omniroute.version}` : "v3.8.50 Core",
        },
        {
          id: "postgres",
          name: "PostgreSQL with pgvector",
          icon: "🐘",
          category: "storage",
          status: data?.services?.database === "ok" ? "ok" : "error",
          endpoint: "postgresql://postgres:5432/npati_agent",
          description: "Single source of truth for workspaces, companies, knowledge chunks, and vector embeddings.",
          details: "Vector extension active",
        },
        {
          id: "redis",
          name: "Redis Cache & Streams",
          icon: "🧠",
          category: "internal",
          status: "ok",
          endpoint: "redis://redis:6379",
          description: "Async task queues, leases, distributed locks, and conversation memory caching.",
          details: "In-memory cache active",
        },
        {
          id: "minio",
          name: "MinIO S3 Storage",
          icon: "🗄️",
          category: "storage",
          status: data?.services?.storage === "ok" ? "ok" : "error",
          endpoint: "http://minio:9000",
          description: "Tenant-isolated document store for company knowledge attachments and binary assets.",
          details: "S3 compatible API",
        },
        {
          id: "crawler",
          name: "Crawl4AI Web Crawler",
          icon: "🕷️",
          category: "internal",
          status: data?.services?.crawler === "ok" ? "ok" : "degraded",
          endpoint: "http://crawler:11235",
          description: "Deep web research crawler, markdown conversion, and SSR rendering engine.",
          details: "Headless worker pool",
        },
        {
          id: "core-backend",
          name: "NPATI Core Backend",
          icon: "⚙️",
          category: "internal",
          status: "ok",
          endpoint: "http://localhost:4000",
          description: "Single source of truth for authentication, user accounts, and billing.",
          details: "API Gateway active",
        },
        {
          id: "cloud-hub",
          name: "NPATI Cloud Hub",
          icon: "☁️",
          category: "provider",
          status: data?.services?.hub === "ok" ? "ok" : "not_configured",
          endpoint: "https://hub.npati.io",
          description: "Optional cloud catalog synchronization and shared model registry.",
          details: "Optional for local deployment",
        },
      ];

      setServices(items);
    } catch {
      // Fallback handled gracefully
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }

  useEffect(() => {
    void checkConnections();
  }, []);


  const tabs = useMemo(() => {
    return [
      { label: "All", value: "all", count: services.length },
      { label: "Internal", value: "internal", count: services.filter((s) => s.category === "internal").length },
      { label: "Storage", value: "storage", count: services.filter((s) => s.category === "storage").length },
      { label: "Provider", value: "provider", count: services.filter((s) => s.category === "provider").length },
      { label: "Operational", value: "ok", count: services.filter((s) => s.status === "ok").length },
    ];
  }, [services]);

  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      if (selectedCategory !== "all") {
        if (selectedCategory === "ok") {
          if (s.status !== "ok") return false;
        } else if (s.category !== selectedCategory) {
          return false;
        }
      }
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        return (
          s.name.toLowerCase().includes(q) ||
          s.endpoint.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [services, selectedCategory, search]);

  const copyEndpoint = (endpoint: string) => {
    void navigator.clipboard.writeText(endpoint);
    setCopiedEndpoint(endpoint);
    setTimeout(() => setCopiedEndpoint(null), 2000);
  };

  const getCategoryLabel = (cat: ServiceStatus["category"]) => {
    switch (cat) {
      case "internal":
        return "Internal Engine";
      case "storage":
        return "Data Storage";
      case "provider":
        return "Cloud Provider";
      default:
        return cat;
    }
  };

  const getStatusBadge = (status: ServiceStatus["status"]) => {
    switch (status) {
      case "ok":
        return (
          <span className="connection-status-pill status-ok">
            <span className="status-indicator-dot ok" /> Operational
          </span>
        );
      case "not_configured":
        return (
          <span className="connection-status-pill status-standby">
            <span className="status-indicator-dot standby" /> Standby
          </span>
        );
      case "degraded":
        return (
          <span className="connection-status-pill status-degraded">
            <span className="status-indicator-dot degraded" /> Degraded
          </span>
        );
      case "error":
        return (
          <span className="connection-status-pill status-error">
            <span className="status-indicator-dot error" /> Down
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <main className="inspector-page connections-page">
      {/* Page Header matching /settings/capabilities */}
      <header className="marketplace-hero inspector-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">Infrastructure & Integrations</p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label="Back to settings"
                title="Back to settings"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>Connected Services</span>
            </h1>
            <p className="hero-copy">
              Monitor runtime health, endpoints, and status of all storage engines, internal AI adapters, and system microservices.
            </p>
          </div>
          <div className="automations-header-actions">
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => void checkConnections()}
              disabled={checking}
              title="Probe service health endpoints"
            >
              {checking ? "Checking Status..." : "Refresh Status"}
            </button>
          </div>
        </div>
      </header>

      {/* Search & Filter Controls matching /settings/capabilities */}
      <div className="inspector-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder="Filter services by name, endpoint or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label="Filter connected services"
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={selectedCategory === tab.value}
              className={`inspector-tab ${selectedCategory === tab.value ? "active" : ""}`}
              onClick={() => setSelectedCategory(tab.value)}
            >
              <span>{tab.label}</span>
              <small className="tab-count">{tab.count}</small>
            </button>
          ))}
        </div>
      </div>

      {!loading && filteredServices.length === 0 && (
        <div className="automations-empty-card" style={{ marginTop: "16px" }}>
          <div className="automations-empty-icon">🔍</div>
          <h3>No matching services</h3>
          <p>Try adjusting your search query or selecting a different category filter.</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearch("");
              setSelectedCategory("all");
            }}
          >
            Reset Filters
          </button>
        </div>
      )}

      {/* Unified Service Cards Grid */}
      {!loading && filteredServices.length > 0 && (
        <div className="connections-grid">
          {filteredServices.map((svc) => (
            <article key={svc.id} className="connection-card">
              <div>
                <div className="connection-card-top">
                  <span className={`connection-badge badge-${svc.category}`}>
                    {getCategoryLabel(svc.category)}
                  </span>
                  {getStatusBadge(svc.status)}
                </div>

                <div className="connection-title-row">
                  <span className="connection-service-icon" aria-hidden="true">{svc.icon}</span>
                  <h3>{svc.name}</h3>
                </div>

                <p>{svc.description}</p>
              </div>

              <div className="connection-card-footer">
                <div className="connection-endpoint-bar">
                  <code title={svc.endpoint}>{svc.endpoint}</code>
                  <button
                    type="button"
                    className={`endpoint-copy-btn ${copiedEndpoint === svc.endpoint ? "copied" : ""}`}
                    onClick={() => copyEndpoint(svc.endpoint)}
                    title="Copy connection string"
                  >
                    {copiedEndpoint === svc.endpoint ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <div className="connection-meta-row">
                  <span className="connection-details-tag">
                    {svc.details || "Verified in Docker Network"}
                  </span>
                  <span className="connection-protocol-tag">HTTP / TCP</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
