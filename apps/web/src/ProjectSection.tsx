import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

export type Project = {
  id: string; companyId: string; name: string; description?: string;
  type: "website" | "web_app" | "landing_page"; status: string;
  framework?: string; repositoryBranch?: string; sandboxId?: string;
  previewUrl?: string; previewPort?: number; lastBuildStatus?: string;
  revision: number; updatedAt: string;
};

const copy = {
  en: {
    title: "Projects", newProject: "New Project", empty: "No projects yet",
    createWithAi: "Create with AI", recordOnly: "Website generation is coming soon. This creates the project record.",
    importRepository: "Import repository", uploadProject: "Upload project", comingSoon: "Coming soon",
    name: "Project name", description: "Description", type: "Type",
    website: "Website", webApp: "Web app", landingPage: "Landing page",
    create: "Create Project", cancel: "Cancel", open: "Open", rename: "Rename",
    archive: "Archive", delete: "Delete", includeArchived: "Show archived",
    updated: "Updated", framework: "Framework", notSet: "Not set",
    renamePrompt: "New project name", archivePrompt: "Archive this project?",
    deletePrompt: "Permanently delete this project?", loadError: "Could not load projects",
  },
  uk: {
    title: "Проєкти", newProject: "Новий проєкт", empty: "Проєктів ще немає",
    createWithAi: "Створити з AI", recordOnly: "Генерація сайту з’явиться пізніше. Зараз створюється запис проєкту.",
    importRepository: "Імпортувати репозиторій", uploadProject: "Завантажити проєкт", comingSoon: "Незабаром",
    name: "Назва проєкту", description: "Опис", type: "Тип",
    website: "Сайт", webApp: "Вебзастосунок", landingPage: "Лендінг",
    create: "Створити проєкт", cancel: "Скасувати", open: "Відкрити", rename: "Перейменувати",
    archive: "Архівувати", delete: "Видалити", includeArchived: "Показати архівні",
    updated: "Оновлено", framework: "Фреймворк", notSet: "Не вказано",
    renamePrompt: "Нова назва проєкту", archivePrompt: "Архівувати цей проєкт?",
    deletePrompt: "Назавжди видалити цей проєкт?", loadError: "Не вдалося завантажити проєкти",
  },
};

async function projectApi<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message || "Project request failed");
  return body;
}

export function ProjectSection({ companyId }: { companyId: string }) {
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;
  const [projects, setProjects] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<Project["type"]>("website");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const result = await projectApi<{ projects: Project[] }>("/companies/" + encodeURIComponent(companyId) + "/projects?includeArchived=" + showArchived);
      setProjects(result.projects);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.loadError); }
  }
  useEffect(() => { setProjects([]); void load(); }, [companyId, showArchived]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await projectApi<Project>("/companies/" + encodeURIComponent(companyId) + "/projects", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), type }),
      });
      setDialogOpen(false); setName(""); setDescription(""); setType("website");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.loadError); }
    finally { setBusy(false); }
  }

  async function rename(project: Project) {
    const next = await promptModal({ message: t.renamePrompt, defaultValue: project.name });
    if (next === null || !next.trim() || next.trim() === project.name) return;
    setBusy(true);
    try {
      await projectApi<Project>("/companies/" + encodeURIComponent(companyId) + "/projects/" + encodeURIComponent(project.id), {
        method: "PATCH", body: JSON.stringify({ name: next.trim(), expectedRevision: project.revision }),
      });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.loadError); }
    finally { setBusy(false); }
  }

  async function archive(project: Project) {
    if (!await confirmModal({ message: t.archivePrompt })) return;
    setBusy(true);
    try {
      await projectApi<Project>("/companies/" + encodeURIComponent(companyId) + "/projects/" + encodeURIComponent(project.id) + "/archive", {
        method: "POST", body: JSON.stringify({ expectedRevision: project.revision }),
      });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.loadError); }
    finally { setBusy(false); }
  }

  async function remove(project: Project) {
    if (!await confirmModal({ message: t.deletePrompt, isDanger: true })) return;
    setBusy(true);
    try {
      await projectApi<void>("/companies/" + encodeURIComponent(companyId) + "/projects/" + encodeURIComponent(project.id), { method: "DELETE" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.loadError); }
    finally { setBusy(false); }
  }

  return <section className="company-run-card project-section">
    <div className="project-section-header"><h2>{t.title}</h2><button type="button" className="button-primary" onClick={() => { setError(""); setDialogOpen(true); }}>{t.newProject}</button></div>
    <label className="project-archive-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{t.includeArchived}</label>
    {error && <p role="alert" className="project-error">{error}</p>}
    {projects.length === 0 ? <p>{t.empty}</p> : <div className="project-card-grid">{projects.map((project) => <article className="project-card" key={project.id}>
      <h3>{project.name}</h3>
      <div className="project-card-meta"><span>{project.type === "web_app" ? t.webApp : project.type === "landing_page" ? t.landingPage : t.website}</span><span>{project.status}</span></div>
      <small>{t.framework}: {project.framework || t.notSet}</small>
      <small>{t.updated}: {new Date(project.updatedAt).toLocaleDateString(language)}</small>
      <div className="project-card-actions">
        <Link className="button-secondary" to={"/projects/" + encodeURIComponent(companyId) + "/" + encodeURIComponent(project.id)}>{t.open}</Link>
        {project.status !== "archived" && <><button type="button" className="button-secondary" disabled={busy} onClick={() => void rename(project)}>{t.rename}</button>
          <button type="button" className="button-secondary" disabled={busy} onClick={() => void archive(project)}>{t.archive}</button></>}
        <button type="button" className="danger-button" disabled={busy} onClick={() => void remove(project)}>{t.delete}</button>
      </div>
    </article>)}</div>}
    {dialogOpen && <div className="company-drawer-backdrop" onMouseDown={() => setDialogOpen(false)}><aside className="company-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>{t.newProject}</h2><button type="button" className="company-drawer-close" onClick={() => setDialogOpen(false)} aria-label={t.cancel}>×</button></header>
      <form onSubmit={(event) => void create(event)}>
        {error && <p role="alert" className="project-error">{error}</p>}
        <section className="project-create-options"><div className="project-create-selected"><strong>{t.createWithAi}</strong><small>{t.recordOnly}</small></div>
          <button type="button" className="button-secondary" disabled>{t.importRepository} — {t.comingSoon}</button>
          <button type="button" className="button-secondary" disabled>{t.uploadProject} — {t.comingSoon}</button>
        </section>
        <section><label><span>{t.name}</span><input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>{t.description}</span><textarea maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label><span>{t.type}</span><select value={type} onChange={(event) => setType(event.target.value as Project["type"])}>
            <option value="website">{t.website}</option><option value="web_app">{t.webApp}</option><option value="landing_page">{t.landingPage}</option>
          </select></label></section>
        <footer><button type="button" className="button-secondary" onClick={() => setDialogOpen(false)}>{t.cancel}</button><button className="button-primary" disabled={busy}>{t.create}</button></footer>
      </form>
    </aside></div>}
  </section>;
}

