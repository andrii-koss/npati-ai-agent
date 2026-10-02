import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import type { Project } from "./ProjectSection";

type FileEntry = { path: string; name: string; type: "file" | "directory"; size?: number; revision?: string };
type FileContent = { path: string; content: string; size: number; revision: string };
type TerminalEvent = { id: string; commandSummary: string; riskLevel: string; status: string; output: string; errorCode?: string; createdAt: string };
type ProjectTab = "files" | "terminal" | "logs";
function headers() {
  const value = new Headers();
  const token = getStoredAuthToken();
  if (token) value.set("Authorization", "Bearer " + token);
  return value;
}
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) throw new Error(response.status === 403 || response.status === 404 ? "Project not found or access denied" : "Project files unavailable");
  return response.json() as Promise<T>;
}
export function ProjectPage() {
  const { companyId = "", projectId = "" } = useParams();
  const { language } = useTranslation();
  const [project, setProject] = useState<Project>();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileContent>();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<ProjectTab>("files");
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [logs, setLogs] = useState("");
  const [sandboxStatus, setSandboxStatus] = useState("unavailable");
  const [error, setError] = useState("");
  const base = "/api/companies/" + encodeURIComponent(companyId) + "/projects/" + encodeURIComponent(projectId);
  useEffect(() => {
    setProject(undefined); setFiles([]); setSelected(undefined); setError("");
    let active = true;
    Promise.all([getJson<Project>(base), getJson<{ files: FileEntry[] }>(base + "/files/tree")])
      .then(([current, tree]) => { if (active) { setProject(current); setFiles(tree.files); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Project unavailable"); });
    return () => { active = false; };
  }, [base]);
  async function refreshTerminal() {
    try {
      const [history, runtime] = await Promise.all([getJson<{ events: TerminalEvent[] }>(base + "/terminal/events"), getJson<{ logs: string; status: { state: string } | null }>(base + "/terminal/logs")]);
      setEvents(history.events); setLogs(runtime.logs); setSandboxStatus(runtime.status?.state ?? "not started"); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Terminal unavailable"); }
  }
  useEffect(() => { if (tab !== "files" && project) void refreshTerminal(); }, [tab, project?.id]);
  async function search() {
    try {
      setError("");
      const result = query.trim()
        ? await getJson<{ files: FileEntry[] }>(base + "/files/search?query=" + encodeURIComponent(query.trim()))
        : await getJson<{ files: FileEntry[] }>(base + "/files/tree");
      setFiles(result.files);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Search unavailable"); }
  }
  async function open(filePath: string) {
    try { setError(""); setSelected(await getJson<FileContent>(base + "/files/read?path=" + encodeURIComponent(filePath))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "File unavailable"); }
  }
  return <main className="company-page project-page">
    <Link to={"/settings/company?company=" + encodeURIComponent(companyId)}>{language === "uk" ? "← До компанії" : "← Back to Company"}</Link>
    {project ? <header><h1>{project.name}</h1><span className={"company-status " + project.status}>{project.status}</span></header> : !error && <p>{language === "uk" ? "Завантаження проєкту…" : "Loading project…"}</p>}
    {error && <p role="alert">{error}</p>}
    {project && <><div role="tablist" aria-label="Project sections" className="project-tabs">
      {(["files", "terminal", "logs"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item === "files" ? "Files" : item === "terminal" ? "Terminal" : "Logs"}</button>)}
    </div>{tab === "files" && <section role="tabpanel" id="project-files-panel" aria-labelledby="project-files-tab" className="project-files">
      <h2>{language === "uk" ? "Файли" : "Files"}</h2>
      <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label htmlFor="project-file-search">{language === "uk" ? "Пошук файлів" : "Search files"}</label>
        <input id="project-file-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={language === "uk" ? "Шлях або назва файлу" : "Path or file name"} />
        <button type="submit" className="button-secondary">{language === "uk" ? "Шукати" : "Search"}</button>
      </form>
      <div className="project-file-browser">
        <nav aria-label={language === "uk" ? "Дерево файлів" : "File tree"}>
          {!files.length && <p>{language === "uk" ? "Файлів поки немає" : "No files yet"}</p>}
          {files.map((entry) => entry.type === "file"
            ? <button type="button" key={entry.path} onClick={() => void open(entry.path)} aria-current={selected?.path === entry.path ? "page" : undefined} style={{ paddingInlineStart: `${Math.min(entry.path.split("/").length, 12)}rem` }}>{entry.name}</button>
            : <div key={entry.path} style={{ paddingInlineStart: `${Math.min(entry.path.split("/").length, 12)}rem` }}>{entry.name}/</div>)}
        </nav>
        <section aria-label={language === "uk" ? "Перегляд файлу" : "File preview"}>
          {selected ? <><h3>{selected.path}</h3><pre><code>{selected.content}</code></pre></> : <p>{language === "uk" ? "Виберіть файл для перегляду" : "Select a file to preview"}</p>}
        </section>
      </div>
    </section>}
    {tab === "terminal" && <section role="tabpanel" className="project-files"><h2>Terminal</h2><p>Sandbox: {sandboxStatus}</p><button type="button" className="button-secondary" onClick={() => void refreshTerminal()}>Refresh</button>{events.length === 0 ? <p>No agent commands yet</p> : events.map((event) => <article key={event.id}><h3>{event.commandSummary}</h3><p>{event.status} · {event.riskLevel} · {new Date(event.createdAt).toLocaleString()}</p>{event.errorCode && <p role="alert">{event.errorCode}</p>}<pre><code>{event.output}</code></pre></article>)}</section>}
    {tab === "logs" && <section role="tabpanel" className="project-files"><h2>Logs</h2><p>Sandbox: {sandboxStatus}</p><button type="button" className="button-secondary" onClick={() => void refreshTerminal()}>Refresh</button><pre><code>{logs || "No sandbox logs yet"}</code></pre></section>}</>}
  </main>;
}
