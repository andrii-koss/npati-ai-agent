import React, { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, FolderOpen, Link2, Unlink, Search, Table2, ListChecks, Plus } from "lucide-react";
import type { ProjectSummary } from "./types";

function projectLabels(projects: ProjectSummary[]) {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const name = project.name.trim().toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (project: ProjectSummary) => counts.get(project.name.trim().toLowerCase())! > 1
    ? `${project.name} · ${project.id.slice(0, 8)}` : project.name;
}

interface ProjectsSectionProps {
  isUk: boolean;
  companyId: string;
  databaseId: string;
  databaseName: string;
  companyName: string;
  connectedProjects: ProjectSummary[];
  availableProjects: ProjectSummary[];
  busy: boolean;
  onAttach: (companyId: string, projectId: string, backendId: string | null) => Promise<void>;
}

export function DatabaseProjectsSection({
  isUk, companyId, databaseId, databaseName, companyName,
  connectedProjects, availableProjects, busy, onAttach,
}: ProjectsSectionProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const fieldId = useId();
  useEffect(() => { setQuery(""); setSelectedId(""); }, [databaseId]);
  const label = useMemo(() => projectLabels(availableProjects), [availableProjects]);
  const connectedLabel = useMemo(() => projectLabels(connectedProjects), [connectedProjects]);
  const filteredProjects = useMemo(() => availableProjects.filter(project =>
    project.name.toLowerCase().includes(query.trim().toLowerCase())), [availableProjects, query]);
  const selectedProject = availableProjects.find(project => project.id === selectedId);

  return (
    <div className="ds-db-project-sections">
      <section className="ds-db-panel" aria-labelledby={`${fieldId}-connected`}>
        <header className="ds-db-panel-heading">
          <FolderOpen size={20} aria-hidden="true" />
          <div>
            <h2 id={`${fieldId}-connected`}>{isUk ? "Підключені проєкти" : "Connected projects"} <span className="ds-db-count">{connectedProjects.length}</span></h2>
            <p>{isUk ? "Проєкти, які використовують цю базу даних." : "Projects that use this database."}</p>
          </div>
        </header>
        {connectedProjects.length ? (
          <div className="ds-db-project-list">
            {connectedProjects.map(project => (
              <div className="ds-db-project-row" key={project.id}>
                <div className="ds-db-project-info">
                  <FolderOpen size={18} aria-hidden="true" />
                  <div>
                    <strong title={project.name}>{connectedLabel(project)}</strong>
                    <small><i aria-hidden="true" />{isUk ? "Підключено" : "Connected"}</small>
                  </div>
                </div>
                <div className="ds-db-project-actions">
                  <Link className="ds-db-button" to={`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(project.id)}/data`}>
                    {isUk ? "Відкрити Data Studio" : "Open Data Studio"}<ArrowUpRight size={15} aria-hidden="true" />
                  </Link>
                  <button type="button" className="ds-db-button ds-db-button-quiet" disabled={busy}
                    title={isUk ? "Відключити від бази. Проєкт і його файли залишаться." : "Disconnect this database. The project and its files are kept."}
                    onClick={() => void onAttach(companyId, project.id, null)}>
                    <Unlink size={14} aria-hidden="true" />{isUk ? "Відключити" : "Detach"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="ds-db-empty">{isUk ? "До цієї бази ще не підключено жодного проєкту. Додайте проєкт нижче." : "No projects use this database yet. Attach a project below."}</p>}
      </section>

      <section className="ds-db-panel ds-db-attach-panel" aria-labelledby={`${fieldId}-attach`}>
        <header className="ds-db-panel-heading">
          <Link2 size={20} aria-hidden="true" />
          <div>
            <h2 id={`${fieldId}-attach`}>{isUk ? "Підключити проєкт" : "Attach a project"}</h2>
            <p>{isUk ? `Доступні проєкти компанії «${companyName}», які ще не мають бази.` : `Available projects from ${companyName} that do not have a database yet.`}</p>
          </div>
        </header>
        {availableProjects.length ? (
          <>
            <div className="ds-db-attach-controls">
              <label className="ds-db-field">
                <span>{isUk ? "Знайти проєкт" : "Find a project"}</span>
                <div className="ds-db-search">
                  <Search size={16} aria-hidden="true" />
                  <input type="search" value={query} disabled={busy}
                    placeholder={isUk ? "Пошук за назвою..." : "Search by name..."}
                    onChange={event => { setQuery(event.target.value); setSelectedId(""); }} />
                </div>
              </label>
              <label className="ds-db-field">
                <span>{isUk ? "Оберіть проєкт" : "Choose a project"}</span>
                <select value={selectedId} disabled={busy || !filteredProjects.length} onChange={event => setSelectedId(event.target.value)}>
                  <option value="">{filteredProjects.length ? (isUk ? "Оберіть доступний проєкт" : "Select an available project") : (isUk ? "Проєктів не знайдено" : "No matching projects")}</option>
                  {filteredProjects.map(project => <option value={project.id} key={project.id}>{label(project)}</option>)}
                </select>
              </label>
              <button type="button" className="button-primary automations-action-primary ds-db-button" disabled={busy || !selectedProject}
                onClick={() => {
                  if (!selectedProject) return;
                  void onAttach(companyId, selectedProject.id, databaseId).then(() => { setSelectedId(""); setQuery(""); });
                }}>
                <Link2 size={16} aria-hidden="true" />{isUk ? "Підключити проєкт" : "Attach project"}
              </button>
            </div>
            <div className="ds-db-attach-hint" role="status">
              <span>{selectedProject
                ? (isUk ? `«${selectedProject.name}» буде підключено до «${databaseName}».` : `${selectedProject.name} will use ${databaseName}.`)
                : (isUk ? "Оберіть проєкт і натисніть «Підключити проєкт»." : "Choose a project, then select Attach project.")}</span>
              <span>{isUk ? `Знайдено: ${filteredProjects.length} із ${availableProjects.length}` : `${filteredProjects.length} of ${availableProjects.length} projects`}</span>
            </div>
          </>
        ) : (
          <p className="ds-db-empty">{isUk ? "Немає вільних проєктів для підключення." : "No projects are available to attach."} <Link to="/settings/projects">{isUk ? "Створити проєкт" : "Create a project"}</Link></p>
        )}
      </section>
    </div>
  );
}

interface TablesToolbarProps {
  isUk: boolean;
  projects: ProjectSummary[];
  projectId: string;
  onProjectChange: (id: string) => void;
  environment: "dev" | "prod";
  onEnvironmentChange: (environment: "dev" | "prod") => void;
  tableCount: number;
  showTableCount: boolean;
  readOnly: boolean;
  countingRows: boolean;
  canCreate: boolean;
  onCountRows: () => Promise<void>;
  onNewTable: () => void;
}

export function DatabaseTablesToolbar({
  isUk, projects, projectId, onProjectChange, environment, onEnvironmentChange,
  tableCount, showTableCount, readOnly, countingRows, canCreate, onCountRows, onNewTable,
}: TablesToolbarProps) {
  const titleId = useId();
  const label = useMemo(() => projectLabels(projects), [projects]);
  return (
    <section className="ds-db-panel ds-db-tables-panel" aria-labelledby={titleId}>
      <header className="ds-db-panel-heading">
        <Table2 size={20} aria-hidden="true" />
        <div>
          <h2 id={titleId}>{isUk ? "Таблиці" : "Tables"}{showTableCount && <span className="ds-db-count">{tableCount}</span>}</h2>
          <p>{isUk ? "Оберіть проєкт і середовище для перегляду таблиць та правил доступу." : "Choose a project and environment to view tables and access rules."}</p>
        </div>
      </header>
      <div className="ds-db-table-controls">
        <label className="ds-db-field">
          <span>{isUk ? "Проєкт" : "Project"}</span>
          <select value={projectId} onChange={event => onProjectChange(event.target.value)} disabled={!projects.length}>
            <option value="" disabled={projects.length > 0}>{projects.length ? (isUk ? "Оберіть підключений проєкт" : "Select a connected project") : (isUk ? "Немає підключених проєктів" : "No connected projects")}</option>
            {projects.map(project => <option value={project.id} key={project.id}>{label(project)}</option>)}
          </select>
        </label>
        <div className="ds-db-field">
          <span>{isUk ? "Середовище" : "Environment"}</span>
          <div className="env-switcher" role="group" aria-label={isUk ? "Середовище" : "Environment"}>
            <button type="button" className={`env-btn ${environment === "dev" ? "active" : ""}`} aria-pressed={environment === "dev"} title={isUk ? "Середовище розробки" : "Development environment"} onClick={() => onEnvironmentChange("dev")}>dev</button>
            <button type="button" className={`env-btn ${environment === "prod" ? "active" : ""}`} aria-pressed={environment === "prod"} title={isUk ? "Робоче середовище" : "Production environment"} onClick={() => onEnvironmentChange("prod")}>prod</button>
          </div>
        </div>
        <div className="ds-db-toolbar-actions">
          <button type="button" className="ds-db-button" onClick={() => void onCountRows()} disabled={countingRows || !tableCount}>
            <ListChecks size={16} aria-hidden="true" />{countingRows ? (isUk ? "Рахуємо..." : "Counting...") : (isUk ? "Порахувати рядки" : "Count rows")}
          </button>
          {!readOnly && <button type="button" className="button-primary automations-action-primary ds-db-button" onClick={onNewTable} disabled={!canCreate}>
            <Plus size={16} aria-hidden="true" />{isUk ? "Нова таблиця" : "New table"}
          </button>}
        </div>
      </div>
      <p className="ds-db-context">{readOnly
        ? (isUk ? "prod: тут можна лише переглядати схему." : "prod: the schema is read-only here.")
        : (isUk ? "dev: зміни схеми застосовуються до середовища розробки." : "dev: schema changes apply to the development environment.")}</p>
    </section>
  );
}
