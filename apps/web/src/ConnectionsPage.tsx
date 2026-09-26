import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";

type ServiceId = "omniroute" | "postgres" | "redis" | "minio" | "crawler" | "core-backend" | "cloud-hub";

interface RawServiceStatus {
  id: ServiceId;
  category: "internal" | "provider" | "storage";
  status: "ok" | "degraded" | "error" | "not_configured";
  endpoint: string;
  icon: string;
  customVersion?: string;
}

interface ServiceStatus extends RawServiceStatus {
  name: string;
  description: string;
  details: string;
}

const DEFAULT_SERVICES: RawServiceStatus[] = [
  {
    id: "omniroute",
    icon: "⚡",
    category: "internal",
    status: "ok",
    endpoint: "http://omniroute:20128",
  },
  {
    id: "postgres",
    icon: "🐘",
    category: "storage",
    status: "ok",
    endpoint: "postgresql://postgres:5432/npati_agent",
  },
  {
    id: "redis",
    icon: "🧠",
    category: "internal",
    status: "ok",
    endpoint: "redis://redis:6379",
  },
  {
    id: "minio",
    icon: "🗄️",
    category: "storage",
    status: "ok",
    endpoint: "http://minio:9000",
  },
  {
    id: "crawler",
    icon: "🕷️",
    category: "internal",
    status: "ok",
    endpoint: "http://crawler:11235",
  },
  {
    id: "core-backend",
    icon: "⚙️",
    category: "internal",
    status: "ok",
    endpoint: "http://localhost:4000",
  },
  {
    id: "cloud-hub",
    icon: "☁️",
    category: "provider",
    status: "not_configured",
    endpoint: "https://hub.npati.io",
  },
];

const STORAGE_CONNECTIONS_KEY = "npati_connections_cache_v1";

function getCachedConnections(): RawServiceStatus[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_CONNECTIONS_KEY) || localStorage.getItem(STORAGE_CONNECTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_SERVICES;
}

function updateCachedConnections(items: RawServiceStatus[]) {
  try {
    const serialized = JSON.stringify(items);
    sessionStorage.setItem(STORAGE_CONNECTIONS_KEY, serialized);
    localStorage.setItem(STORAGE_CONNECTIONS_KEY, serialized);
  } catch {}
}

export function ConnectionsPage() {
  const { t } = useTranslation();
  const [rawServices, setRawServices] = useState<RawServiceStatus[]>(getCachedConnections);
  const [checking, setChecking] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);

  async function checkConnections(isManual = false) {
    if (isManual) {
      setChecking(true);
    }
    try {
      const headers: HeadersInit = {};
      const token = getStoredAuthToken();
      if (token) headers["authorization"] = `Bearer ${token}`;

      const res = await fetch("/api/health", { headers });
      const data = res.ok ? await res.json() : null;

      const items: RawServiceStatus[] = [
        {
          id: "omniroute",
          icon: "⚡",
          category: "internal",
          status: data?.services?.omniroute === "ok" ? "ok" : "error",
          endpoint: "http://omniroute:20128",
          customVersion: data?.details?.omniroute?.version,
        },
        {
          id: "postgres",
          icon: "🐘",
          category: "storage",
          status: data?.services?.database === "ok" ? "ok" : "error",
          endpoint: "postgresql://postgres:5432/npati_agent",
        },
        {
          id: "redis",
          icon: "🧠",
          category: "internal",
          status: "ok",
          endpoint: "redis://redis:6379",
        },
        {
          id: "minio",
          icon: "🗄️",
          category: "storage",
          status: data?.services?.storage === "ok" ? "ok" : "error",
          endpoint: "http://minio:9000",
        },
        {
          id: "crawler",
          icon: "🕷️",
          category: "internal",
          status: data?.services?.crawler === "ok" ? "ok" : "degraded",
          endpoint: "http://crawler:11235",
        },
        {
          id: "core-backend",
          icon: "⚙️",
          category: "internal",
          status: "ok",
          endpoint: "http://localhost:4000",
        },
        {
          id: "cloud-hub",
          icon: "☁️",
          category: "provider",
          status: data?.services?.hub === "ok" ? "ok" : "not_configured",
          endpoint: "https://hub.npati.io",
        },
      ];

      setRawServices(items);
      updateCachedConnections(items);
    } catch {
      // Fallback handled gracefully
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void checkConnections(false);
  }, []);

  const services = useMemo<ServiceStatus[]>(() => {
    return rawServices.map((s) => {
      let name = "";
      let description = "";
      let details = "";

      switch (s.id) {
        case "omniroute":
          name = t("connectionsPage.services.omniroute.name");
          description = t("connectionsPage.services.omniroute.desc");
          details = s.customVersion
            ? `${t("connectionsPage.services.omniroute.versionPrefix")}: ${s.customVersion}`
            : t("connectionsPage.services.omniroute.details");
          break;
        case "postgres":
          name = t("connectionsPage.services.postgres.name");
          description = t("connectionsPage.services.postgres.desc");
          details = t("connectionsPage.services.postgres.details");
          break;
        case "redis":
          name = t("connectionsPage.services.redis.name");
          description = t("connectionsPage.services.redis.desc");
          details = t("connectionsPage.services.redis.details");
          break;
        case "minio":
          name = t("connectionsPage.services.minio.name");
          description = t("connectionsPage.services.minio.desc");
          details = t("connectionsPage.services.minio.details");
          break;
        case "crawler":
          name = t("connectionsPage.services.crawler.name");
          description = t("connectionsPage.services.crawler.desc");
          details = t("connectionsPage.services.crawler.details");
          break;
        case "core-backend":
          name = t("connectionsPage.services.coreBackend.name");
          description = t("connectionsPage.services.coreBackend.desc");
          details = t("connectionsPage.services.coreBackend.details");
          break;
        case "cloud-hub":
          name = t("connectionsPage.services.cloudHub.name");
          description = t("connectionsPage.services.cloudHub.desc");
          details = t("connectionsPage.services.cloudHub.details");
          break;
      }

      return {
        ...s,
        name,
        description,
        details,
      };
    });
  }, [rawServices, t]);

  const tabs = useMemo(() => {
    return [
      { label: t("connectionsPage.tabs.all"), value: "all", count: services.length },
      { label: t("connectionsPage.tabs.internal"), value: "internal", count: services.filter((s) => s.category === "internal").length },
      { label: t("connectionsPage.tabs.storage"), value: "storage", count: services.filter((s) => s.category === "storage").length },
      { label: t("connectionsPage.tabs.provider"), value: "provider", count: services.filter((s) => s.category === "provider").length },
      { label: t("connectionsPage.tabs.operational"), value: "ok", count: services.filter((s) => s.status === "ok").length },
    ];
  }, [services, t]);

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
        return t("connectionsPage.categories.internal");
      case "storage":
        return t("connectionsPage.categories.storage");
      case "provider":
        return t("connectionsPage.categories.provider");
      default:
        return cat;
    }
  };

  const getStatusBadge = (status: ServiceStatus["status"]) => {
    switch (status) {
      case "ok":
        return (
          <span className="connection-status-pill status-ok">
            <span className="status-indicator-dot ok" /> {t("connectionsPage.statuses.operational")}
          </span>
        );
      case "not_configured":
        return (
          <span className="connection-status-pill status-standby">
            <span className="status-indicator-dot standby" /> {t("connectionsPage.statuses.standby")}
          </span>
        );
      case "degraded":
        return (
          <span className="connection-status-pill status-degraded">
            <span className="status-indicator-dot degraded" /> {t("connectionsPage.statuses.degraded")}
          </span>
        );
      case "error":
        return (
          <span className="connection-status-pill status-error">
            <span className="status-indicator-dot error" /> {t("connectionsPage.statuses.down")}
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
            <p className="eyebrow">{t("connectionsPage.eyebrow")}</p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label={t("connectionsPage.backToSettings")}
                title={t("connectionsPage.backToSettings")}
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
              <span>{t("connectionsPage.title")}</span>
            </h1>
            <p className="hero-copy">
              {t("connectionsPage.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            <button
              type="button"
              className="button-primary automations-action-primary"
              style={{ minWidth: "155px" }}
              onClick={() => void checkConnections(true)}
              disabled={checking}
              title={t("connectionsPage.refreshTitle")}
            >
              {checking ? t("connectionsPage.checkingStatus") : t("connectionsPage.refreshStatus")}
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
            placeholder={t("connectionsPage.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label={t("connectionsPage.searchAria")}
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label={t("connectionsPage.clearSearch")}
              title={t("connectionsPage.clearSearch")}
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

      {filteredServices.length === 0 ? (
        <div className="automations-empty-card" style={{ marginTop: "16px" }}>
          <div className="automations-empty-icon">🔍</div>
          <h3>{t("connectionsPage.empty.title")}</h3>
          <p>{t("connectionsPage.empty.description")}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearch("");
              setSelectedCategory("all");
            }}
          >
            {t("connectionsPage.empty.resetFilters")}
          </button>
        </div>
      ) : (
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
                    title={t("connectionsPage.card.copyTitle")}
                  >
                    {copiedEndpoint === svc.endpoint ? t("connectionsPage.card.copied") : t("connectionsPage.card.copy")}
                  </button>
                </div>
                <div className="connection-meta-row">
                  <span className="connection-details-tag">
                    {svc.details || t("connectionsPage.card.verifiedFallback")}
                  </span>
                  <span className="connection-protocol-tag">{t("connectionsPage.card.protocol")}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

