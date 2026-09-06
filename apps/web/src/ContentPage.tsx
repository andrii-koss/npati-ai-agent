import { useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

interface ContentItem {
  id: string;
  title: string;
  type: "article" | "seo_structure" | "social_post" | "brief";
  content: string;
  sourceRunId?: string;
  createdAt: string;
}

export function ContentPage() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState<ContentItem | null>(null);

  useEffect(() => {
    // Try to load completed run results as generated content
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    fetch("/api/companies?limit=10", { headers })
      .then((res) => (res.ok ? res.json() : { companies: [] }))
      .then(async (data: { companies?: Array<{ id: string }> }) => {
        const companies = data.companies ?? [];
        const contentRows: ContentItem[] = [];

        for (const company of companies.slice(0, 3)) {
          const runRes = await fetch(`/api/companies/${company.id}/runs?limit=10`, { headers });
          if (runRes.ok) {
            const runData = (await runRes.json()) as {
              runs?: Array<{ id: string; task: string; result?: string; createdAt: string; status: string }>;
            };
            for (const r of runData.runs ?? []) {
              if (r.result && r.status === "completed") {
                contentRows.push({
                  id: r.id,
                  title: r.task.slice(0, 50),
                  type: /seo/i.test(r.task) ? "seo_structure" : "article",
                  content: r.result,
                  sourceRunId: r.id,
                  createdAt: r.createdAt,
                });
              }
            }
          }
        }

        setItems(contentRows);
        if (contentRows.length > 0 && contentRows[0]) setSelectedItem(contentRows[0]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = items.filter(
    (i) => !search || i.title.toLowerCase().includes(search.toLowerCase()) || i.content.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <main className="content-page">
      <header className="content-header">
        <div>
          <p className="eyebrow">Marketing & Production</p>
          <h1>Content Hub</h1>
          <p className="hero-copy">
            Review and export drafts, articles, and SEO structures produced by your AI Company agents.
          </p>
        </div>
        <input
          type="search"
          placeholder="Search generated content..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
          aria-label="Search content"
        />
      </header>

      {loading && <div className="workspace-notice">Loading content library...</div>}

      {!loading && items.length === 0 && (
        <div className="placeholder-card">
          <span>No content generated yet</span>
          <h2>Your Content Hub is ready</h2>
          <p>When you run Company tasks to prepare drafts or articles, generated content will be organized here.</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="content-layout">
          <aside className="content-list" aria-label="Content list">
            {filtered.map((item) => (
              <button
                key={item.id}
                className={`content-item-btn ${selectedItem?.id === item.id ? "active" : ""}`}
                onClick={() => setSelectedItem(item)}
              >
                <span className={`type-badge ${item.type}`}>{item.type}</span>
                <strong>{item.title}</strong>
                <small>{new Date(item.createdAt).toLocaleDateString()}</small>
              </button>
            ))}
          </aside>

          <section className="content-detail">
            {selectedItem ? (
              <div className="content-detail-card">
                <header className="content-detail-header">
                  <div>
                    <span className={`type-badge ${selectedItem.type}`}>{selectedItem.type}</span>
                    <h2>{selectedItem.title}</h2>
                    <small>Created: {new Date(selectedItem.createdAt).toLocaleString()}</small>
                  </div>
                  <button
                    className="button-secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(selectedItem.content);
                      alert("Content copied to clipboard!");
                    }}
                  >
                    Copy Content
                  </button>
                </header>
                <div className="content-body">
                  <pre>{selectedItem.content}</pre>
                </div>
              </div>
            ) : (
              <div className="placeholder-card">
                <p>Select an article or draft from the left to view.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
