import { useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

interface ServiceStatus {
  name: string;
  category: "internal" | "provider" | "storage";
  status: "ok" | "degraded" | "error" | "not_configured";
  endpoint: string;
  description: string;
  details?: string;
}

export function ConnectionsPage() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

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
          name: "OmniRoute AI Engine",
          category: "internal",
          status: data?.services?.omniroute === "ok" ? "ok" : "error",
          endpoint: "http://omniroute:20128",
          description: "A2A orchestration, combo routing, fusion, pipeline & embedding engine (v3.8.50).",
          details: data?.details?.omniroute?.version ? `Version: ${data.details.omniroute.version}` : undefined,
        },
        {
          name: "PostgreSQL with pgvector",
          category: "storage",
          status: data?.services?.database === "ok" ? "ok" : "error",
          endpoint: "postgresql://postgres:5432/npati_agent",
          description: "Single source of truth for workspaces, companies, knowledge chunks, and vector embeddings.",
        },
        {
          name: "Redis Cache & Streams",
          category: "internal",
          status: "ok",
          endpoint: "redis://redis:6379",
          description: "Async task queues, leases, distributed locks, and conversation memory caching.",
        },
        {
          name: "MinIO S3 Storage",
          category: "storage",
          status: data?.services?.storage === "ok" ? "ok" : "error",
          endpoint: "http://minio:9000",
          description: "Tenant-isolated document store for company knowledge attachments and binary assets.",
        },
        {
          name: "Crawl4AI Web Crawler",
          category: "internal",
          status: data?.services?.crawler === "ok" ? "ok" : "degraded",
          endpoint: "http://crawler:11235",
          description: "Deep web research crawler, markdown conversion, and SSR rendering engine.",
        },
        {
          name: "NPATI Core Backend",
          category: "internal",
          status: "ok",
          endpoint: "http://localhost:4000",
          description: "Single source of truth for authentication, user accounts, and billing.",
        },
        {
          name: "NPATI Cloud Hub",
          category: "provider",
          status: data?.services?.hub === "ok" ? "ok" : "not_configured",
          endpoint: "https://hub.npati.io",
          description: "Optional cloud catalog synchronization and shared model registry.",
          details: "Optional for local deployment",
        },
      ];

      setServices(items);
    } catch {
      // Fallback
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }

  useEffect(() => {
    void checkConnections();
  }, []);

  return (
    <main className="connections-page">
      <header className="connections-header">
        <div>
          <p className="eyebrow">Infrastructure & Integrations</p>
          <h1>Connected Services</h1>
          <p className="hero-copy">
            Monitor the runtime health and status of all services, storage engines, and internal AI adapters.
          </p>
        </div>
        <button
          className="button-secondary"
          onClick={() => void checkConnections()}
          disabled={checking}
        >
          {checking ? "Checking..." : "Refresh Status"}
        </button>
      </header>

      {loading && <div className="workspace-notice">Probing service connections...</div>}

      {!loading && (
        <div className="connections-grid">
          {services.map((svc) => (
            <div key={svc.name} className="connection-card">
              <div className="connection-card-header">
                <span className={`status-dot ${svc.status}`} />
                <div>
                  <strong>{svc.name}</strong>
                  <span className="connection-category">{svc.category}</span>
                </div>
                <span className={`status-pill ${svc.status}`}>{svc.status}</span>
              </div>
              <p>{svc.description}</p>
              <div className="connection-card-footer">
                <code>{svc.endpoint}</code>
                {svc.details && <small>{svc.details}</small>}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
