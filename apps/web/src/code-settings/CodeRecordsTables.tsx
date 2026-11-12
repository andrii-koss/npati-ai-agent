import React from "react";
import { Archive, FolderOpen, Info, ListTree, MessageSquare, ScanSearch, Trash2 } from "lucide-react";
import { CodeRecordsPanel, RecordIconButton, RecordSelection, type RecordsApi } from "./CodeRecordsPanel";
import type { CodeProject, CodeSession } from "./types";
import { classificationLabel, formatDate, projectStatusClass, retentionLabel, sessionModeLabel, sessionStatusClass, sessionStatusLabel } from "./labels";
import { ToolchainCell } from "./ToolchainCell";

interface CommonProps {
  companyId: string; isUk: boolean; readOnly: boolean; busyId: string | null;
  api: RecordsApi; onChanged(): void;
}
export function CodeProjectsTable(props: CommonProps & {
  items: CodeProject[]; onDetails(project: CodeProject): void; onDetect(project: CodeProject): void;
  onSessions(project: CodeProject): void; onArchive(project: CodeProject): void;
}) {
  const { isUk, readOnly, onDetails, onDetect, onSessions, onArchive } = props;
  return <CodeRecordsPanel {...props} kind="projects">{state => <table className="automations-table">
    <thead><tr>
      <th className="code-record-select" aria-label={isUk ? "Вибір записів" : "Record selection"} />
      <th>{isUk ? "Проєкт" : "Project"}</th><th>{isUk ? "Репозиторій" : "Repository"}</th><th>Toolchain</th>
      <th>{isUk ? "Класифікація" : "Classification"}</th><th>Retention</th><th>{isUk ? "Оновлено" : "Updated"}</th><th aria-label={isUk ? "Дії" : "Actions"} />
    </tr></thead>
    <tbody>{state.rows.map(project => <tr key={project.id}>
      <td className="code-record-select"><RecordSelection label={`${isUk ? "Вибрати" : "Select"} ${project.name}`} checked={state.selected.has(project.id)} disabled={state.busy} onChange={() => state.toggle(project.id)} /></td>
      <td className="automation-title-cell"><strong>{project.name}</strong><span className={`status-pill ${projectStatusClass(project.status)}`}>{project.status ?? "-"}</span></td>
      <td>{project.repositoryUrl ? <span className="code-repository"><span className="ds-muted">{project.repositoryUrl}</span>{(project.repositoryBranch || project.defaultBranch) && <span className="data-studio-badge">{project.repositoryBranch || project.defaultBranch}</span>}</span> : <span className="ds-muted">-</span>}</td>
      <td><ToolchainCell toolchain={project.toolchain} isUk={isUk} /></td>
      <td><span className="data-studio-badge">{classificationLabel(project.dataClassification, isUk)}</span></td>
      <td><span className="data-studio-badge">{retentionLabel(project.retentionClass, isUk)}</span></td>
      <td className="ds-muted">{formatDate(project.updatedAt, isUk)}</td>
      <td><div className="code-record-row-actions">
        <RecordIconButton label={isUk ? "Деталі" : "Details"} icon={Info} disabled={state.busy} onClick={() => onDetails(project)} />
        <RecordIconButton label={isUk ? "Визначити toolchain" : "Detect toolchain"} icon={ScanSearch} disabled={state.busy || readOnly} onClick={() => onDetect(project)} />
        <RecordIconButton label={isUk ? "Сесії" : "Sessions"} icon={ListTree} disabled={state.busy || readOnly} onClick={() => onSessions(project)} />
        {project.status !== "archived" && <RecordIconButton label={isUk ? "Архівувати" : "Archive"} icon={Archive} disabled={state.busy || readOnly} onClick={() => onArchive(project)} />}
        <RecordIconButton label={isUk ? "Видалити" : "Delete"} icon={Trash2} danger disabled={state.busy || readOnly} onClick={() => state.remove(project)} />
      </div></td>
    </tr>)}</tbody>
  </table>}</CodeRecordsPanel>;
}

export function CodeSessionsTable(props: CommonProps & {
  items: CodeSession[]; projects: CodeProject[];
  onOpen(session: CodeSession, inChat?: boolean): void; onArchive(session: CodeSession): void;
}) {
  const { isUk, readOnly, projects, onOpen, onArchive } = props;
  return <CodeRecordsPanel {...props} kind="sessions">{state => <table className="automations-table">
    <thead><tr>
      <th className="code-record-select" aria-label={isUk ? "Вибір записів" : "Record selection"} />
      <th>{isUk ? "Сесія" : "Session"}</th><th>{isUk ? "Проєкт" : "Project"}</th><th>{isUk ? "Режим" : "Mode"}</th><th>{isUk ? "Статус" : "Status"}</th>
      <th>{isUk ? "Класифікація" : "Classification"}</th><th>{isUk ? "Створено" : "Created"}</th><th aria-label={isUk ? "Дії" : "Actions"} />
    </tr></thead>
    <tbody>{state.rows.map(session => <tr key={session.id}>
      <td className="code-record-select"><RecordSelection label={`${isUk ? "Вибрати сесію" : "Select session"} ${session.id.slice(0, 8)}`} checked={state.selected.has(session.id)} disabled={state.busy} onChange={() => state.toggle(session.id)} /></td>
      <td><code>{session.id.slice(0, 8)}</code></td><td>{session.projectName ?? projects.find(project => project.id === session.projectId)?.name ?? "-"}</td>
      <td>{sessionModeLabel(session.mode, isUk)}</td><td><span className={`status-pill ${sessionStatusClass(session.status)}`}>{sessionStatusLabel(session.status, isUk)}</span></td>
      <td><span className="data-studio-badge">{classificationLabel(session.dataClassification, isUk)}</span></td><td className="ds-muted">{formatDate(session.createdAt, isUk)}</td>
      <td><div className="code-record-row-actions">
        <RecordIconButton label={isUk ? "Відкрити Workspace" : "Open Workspace"} icon={FolderOpen} disabled={state.busy} onClick={() => onOpen(session)} />
        <RecordIconButton label={isUk ? "У чаті" : "Open in chat"} icon={MessageSquare} disabled={state.busy || readOnly || session.status === "archived"} onClick={() => onOpen(session, true)} />
        {session.status !== "archived" && <RecordIconButton label={isUk ? "Архівувати" : "Archive"} icon={Archive} disabled={state.busy || readOnly} onClick={() => onArchive(session)} />}
        <RecordIconButton label={isUk ? "Видалити" : "Delete"} icon={Trash2} danger disabled={state.busy || readOnly} onClick={() => state.remove(session)} />
      </div></td>
    </tr>)}</tbody>
  </table>}</CodeRecordsPanel>;
}
