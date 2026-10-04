import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal } from "./ConfirmDialog";
import type { Project } from "./ProjectSection";

type Backend = { id: string; name: string; status: string; provider: string };
type Environment = { environment: string; status: string; syncStatus: string };

async function dataRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || "Data Studio request failed");
  return result as T;
}

export function DataBackendSection({ companyId }: { companyId: string }) {
  const [backends, setBackends] = useState<Backend[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Record<string, Environment[]>>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = "/companies/" + encodeURIComponent(companyId);
  const load = async () => {
    try {
      const [data, sites] = await Promise.all([
        dataRequest<{ backends: Backend[] }>(base + "/data-backends"),
        dataRequest<{ projects: Project[] }>(base + "/projects"),
      ]);
      setBackends(data.backends); setProjects(sites.projects);
      const details = await Promise.all(data.backends.map((backend) => dataRequest<{ environments: Environment[] }>(base + "/data-backends/" + backend.id).catch(() => ({ environments: [] }))));
      setEnvironments(Object.fromEntries(data.backends.map((backend, index) => [backend.id, details[index]!.environments])));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Data Studio unavailable"); }
  };
  useEffect(() => { void load(); }, [companyId]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await dataRequest(base + "/data-backends", { method: "POST", body: JSON.stringify({ name: name.trim() }) }); setName(""); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create DataBackend"); }
    finally { setBusy(false); }
  };
  const attach = async (project: Project, backendId: string) => {
    setBusy(true);
    try {
      await dataRequest(base + "/projects/" + project.id + "/data-backend", backendId ? { method: "PUT", body: JSON.stringify({ dataBackendId: backendId }) } : { method: "DELETE" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not attach DataBackend"); }
    finally { setBusy(false); }
  };
  const archive = async (backend: Backend) => {
    if (!await confirmModal({ message: `Archive ${backend.name}? Data access will stop.` })) return;
    setBusy(true);
    try { await dataRequest(base + "/data-backends/" + backend.id + "/archive", { method: "POST" }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not archive DataBackend"); }
    finally { setBusy(false); }
  };
  return <section className="company-run-card data-studio-section" aria-label="Company Data">
    <div className="project-section-header"><div><h2>Data</h2><p>One DataBackend can serve several projects in this Company.</p></div></div>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="data-studio-create"><input aria-label="DataBackend name" placeholder="DataBackend name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
      <button type="button" className="button-primary" disabled={busy || !name.trim()} onClick={() => void create()}>Create DataBackend</button></div>
    {backends.length === 0 && <p>No DataBackend yet. Create one to manage project data.</p>}
    {backends.map((backend) => <article className="data-studio-backend" key={backend.id}>
      <div><strong>{backend.name}</strong> <span className="data-studio-badge">{backend.status}</span>
        {(environments[backend.id] ?? []).map((env) => <span className="data-studio-badge" key={env.environment}>{env.environment}: {env.syncStatus}</span>)}</div>
      <div className="data-studio-backend-projects">{projects.filter((project) => project.dataBackendId === backend.id).map((project) =>
        <Link key={project.id} to={`/companies/${companyId}/projects/${project.id}/data`}>{project.name} ↗</Link>)}</div>
      {backend.status === "ready" && <button type="button" className="button-secondary" disabled={busy} onClick={() => void archive(backend)}>Archive</button>}
    </article>)}
    {projects.length > 0 && <div className="data-studio-attachments"><h3>Project attachments</h3>{projects.map((project) => <label key={project.id}>
      <span>{project.name}</span><select aria-label={`DataBackend for ${project.name}`} value={project.dataBackendId ?? ""} disabled={busy} onChange={(event) => void attach(project, event.target.value)}>
        <option value="">No DataBackend</option>{backends.filter((backend) => backend.status === "ready").map((backend) => <option key={backend.id} value={backend.id}>{backend.name}</option>)}
      </select>{project.dataBackendId && <Link to={`/companies/${companyId}/projects/${project.id}/data`}>Open Data Studio</Link>}
    </label>)}</div>}
  </section>;
}
