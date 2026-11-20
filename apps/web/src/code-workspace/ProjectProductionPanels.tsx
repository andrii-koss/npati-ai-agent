import { CodeXml, Copy, EllipsisVertical, ExternalLink, Globe2, Info, Pencil, Play, Plus, RefreshCw, RotateCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "@npati/workspace";
import { apiGet, safeExternalUrl } from "../code-workspace-page-types";
import { confirmModal } from "../ConfirmDialog";
import { projectDomain, ProductionDomainProof } from "../website-builder-production";
import type { ProductionController } from "./project-production";
import { ProjectResourceUsage } from "./ProjectResourceUsage";
import "./project-production-panels.css";

export function ProjectProductionPanels({ controller, companyId, projectId, isUk }: {
  controller: ProductionController; companyId: string; projectId: string; isUk: boolean;
}) {
  const t = (uk: string, en: string) => isUk ? uk : en;
  const [project, setProject] = useState<Project>();
  const [projectError, setProjectError] = useState("");
  const [editingDomain, setEditingDomain] = useState(false);
  const [domain, setDomain] = useState("");
  const [domainError, setDomainError] = useState("");
  const [clipboardNotice, setClipboardNotice] = useState("");
  const { status, busy, running, issue, publish, control } = controller;
  const production = status?.enabled ? status : null;
  const release = production?.release;
  const siteUrl = safeExternalUrl(release?.url);
  const domains = release?.domains ?? [];
  const runtime = release?.runtime;
  const disabled = busy || running || !project;
  const state = running ? t("Публікація…", "Publishing…")
    : busy ? t("Виконується…", "Working…")
    : runtime === "running" ? t("Працює", "Running")
    : runtime === "stopped" ? t("Зупинено", "Stopped")
    : runtime === "starting" ? t("Запускається", "Starting")
    : runtime === "unavailable" || (!production && (issue || status?.enabled === false)) ? t("Недоступно", "Unavailable")
    : production ? t("Не опубліковано", "Unpublished") : t("Завантаження…", "Loading…");

  useEffect(() => {
    let active = true;
    void apiGet<Project>(`/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`)
      .then(data => { if (active) setProject(data); }, error => {
        if (active) setProjectError(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [companyId, projectId]);

  useEffect(() => {
    if (!clipboardNotice) return;
    const timer = window.setTimeout(() => setClipboardNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);

  useEffect(() => {
    if (!domainError) return;
    const timer = window.setTimeout(() => setDomainError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [domainError]);

  const date = (value?: string, time = false) => value ? new Intl.DateTimeFormat(isUk ? "uk-UA" : "en-US", {
    dateStyle: "medium", ...(time ? { timeStyle: "short" } : {}),
  }).format(new Date(value)) : "—";
  const statusClass = runtime === "running" && !busy && !running ? "is-running"
    : busy || running || runtime === "starting" ? "is-pending" : "";
  const rows = [
    [t("Назва", "Name"), project?.name || "—"],
    [t("Статус", "Status"), <span className={`workspace-production-indicator ${statusClass}`}>{state}</span>],
    [t("Оновлено", "Updated"), date(release?.createdAt && release.createdAt > (project?.updatedAt ?? "") ? release.createdAt : project?.updatedAt, true)],
    [t("Версія релізу", "Release version"), release?.id?.slice(0, 8) ?? "—"],
    [t("Середовище", "Environment"), <span className="workspace-production-status">Production</span>],
  ];

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setClipboardNotice(t("Скопійовано", "Copied"));
    } catch {
      setClipboardNotice(t("Не вдалося скопіювати", "Could not copy"));
    }
  }

  function openDomainForm() {
    setDomainError("");
    setDomain(release?.settings.aliasDomain ?? production?.suggested?.domain ?? "");
    setEditingDomain(true);
  }

  async function stop() {
    if (await confirmModal({
      title: t("Зупинити Production?", "Stop Production?"),
      message: t("Сайт буде недоступним до повторного запуску.", "The site will be unavailable until you start it again."),
      confirmText: t("Зупинити", "Stop"), cancelText: t("Скасувати", "Cancel"), isDanger: true,
    })) await control({ action: "stop" });
  }

  async function saveDomain() {
    if (!production || disabled) return;
    setDomainError("");
    const host = projectDomain(domain);
    const suggested = production.suggested;
    const tls = production.tlsEnabled && !(host || production.automaticDomain).endsWith(".localhost") && suggested?.tls !== false;
    const saved = release ? await control({ action: "domain", domain: host }, setDomainError) : await publish({
      domain: host, path: suggested?.path ?? "/", port: suggested?.port ?? 3000,
      stripPath: suggested?.stripPath ?? false, tls, entrypoint: tls && suggested?.entrypoint === "websecure" ? "websecure" : "auto",
    }, setDomainError);
    if (saved) setEditingDomain(false);
  }

  return <div className="workspace-production">
    <section className="overview-card workspace-production-card workspace-production-header" aria-label={t("Проєкт", "Project")}>
      <span className="workspace-production-project-icon" aria-hidden="true"><CodeXml /></span>
      <div className="workspace-production-name">
        <h2>{project?.name || t("Проєкт", "Project")}</h2>
        <span title={projectId}>ID {projectId.slice(0, 8)}{project?.createdAt && <> · {t("Створено", "Created")} {date(project.createdAt)}</>}</span>
      </div>
      <span className={`workspace-production-status workspace-production-indicator workspace-production-header-status ${statusClass}`} aria-live="polite">{state}</span>
      <div className="workspace-production-actions">
        <button type="button" className="inspector-tab workspace-production-button" disabled={disabled || !release?.id || runtime === "starting"}
          onClick={() => void control({ action: runtime === "stopped" ? "start" : "restart" })}>
          {runtime === "stopped" ? <Play aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
          {runtime === "stopped" ? t("Запустити", "Start") : t("Перезапустити", "Restart")}
        </button>
        <button type="button" className="inspector-tab workspace-production-button" disabled={disabled || !production || project?.type === "mobile_app"}
          onClick={() => release ? void publish(release.settings) : openDomainForm()}>
          {release ? <RefreshCw aria-hidden="true" /> : <Plus aria-hidden="true" />}
          {release ? t("Оновити", "Update") : t("Опублікувати", "Publish")}
        </button>
        <button type="button" className="inspector-tab workspace-production-button" disabled={disabled || !release?.id || runtime === "stopped"}
          onClick={() => void stop()}><Square className="workspace-production-stop-icon" aria-hidden="true" />{t("Зупинити", "Stop")}</button>
        <details className="workspace-production-menu" onKeyDown={event => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}>
          <summary className="inspector-tab workspace-production-button workspace-production-menu-trigger" aria-label={t("Дії проєкту", "Project actions")}>
            <EllipsisVertical aria-hidden="true" />
          </summary>
          <div className="workspace-production-popover">
            {siteUrl && <a className="inspector-tab" href={siteUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />{t("Відкрити сайт", "Open site")}</a>}
            <button type="button" className="inspector-tab" onClick={event => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              void copy(projectId);
            }}><Copy aria-hidden="true" />{t("Копіювати ID", "Copy project ID")}</button>
          </div>
        </details>
      </div>
    </section>
    <p role="status" className="workspace-production-copy-notice">{clipboardNotice}</p>
    {(projectError || issue || production?.job?.error) && <p role="alert" className="workspace-production-error">
      {[projectError, issue, production?.job?.error].filter(Boolean).join(" · ")}
    </p>}

    <div className="workspace-production-grid">
      <section className="overview-card workspace-production-card">
        <h3><Info aria-hidden="true" />{t("Деталі проєкту", "Project details")}</h3>
        <dl className="workspace-production-details">
          {rows.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </section>
      <section className="overview-card workspace-production-card">
        <div className="workspace-production-card-heading">
          <h3><Globe2 aria-hidden="true" />{t("Домени", "Domains")} ({domains.length})</h3>
          <button type="button" className="inspector-tab workspace-production-button"
            disabled={disabled || !production || project?.type === "mobile_app" || Boolean(release && !release.id)}
            onClick={openDomainForm}>{domains.length > 1 ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {domains.length > 1 ? t("Змінити домен", "Edit domain") : t("Додати домен", "Add domain")}</button>
        </div>
        {domains.length > 0 ? <ul className="workspace-production-domains">
          {domains.map(item => {
            const url = safeExternalUrl(item.url);
            const label = item.certificate === "pending" ? t("Очікує HTTPS", "HTTPS pending")
              : runtime === "running" ? t("Активний", "Active") : t("Підключений", "Connected");
            return <li key={item.host}>
              <div className="workspace-production-domain-identity">
                <ExternalLink aria-hidden="true" />
                {url ? <a href={url} target="_blank" rel="noreferrer">{item.host}</a> : <span>{item.host}</span>}
              </div>
              <div className="workspace-production-domain-badges">
                {item.primary && <span className="workspace-production-status">{t("Основний", "Primary")}</span>}
                <span className={`workspace-production-status ${item.certificate === "pending" ? "is-pending" : runtime === "running" ? "is-running" : ""}`}>{label}</span>
              </div>
              {url && <div className="workspace-production-domain-actions">
                <button type="button" className="inspector-tab" onClick={() => void copy(url)} aria-label={`${t("Копіювати посилання", "Copy URL")} · ${item.host}`} title={t("Копіювати посилання", "Copy URL")}>
                  <Copy aria-hidden="true" />
                </button>
                <a className="inspector-tab" href={url} target="_blank" rel="noreferrer" aria-label={`${t("Відкрити домен", "Open domain")} · ${item.host}`} title={t("Відкрити домен", "Open domain")}>
                  <ExternalLink aria-hidden="true" />
                </a>
              </div>}
            </li>;
          })}
        </ul> : <p className="workspace-production-muted">{t("Домени ще не підключено.", "No domains connected yet.")}</p>}
        {editingDomain && production && <form className="workspace-production-domain-form" onSubmit={event => {
          event.preventDefault();
          void saveDomain();
        }}>
          <label>{release ? t("Додатковий домен", "Additional domain") : t("Основний домен", "Primary domain")}
            <input value={domain} onChange={event => { setDomain(event.target.value); setDomainError(""); }} autoFocus
              required={Boolean(release || !production.automaticDomain)} placeholder={release ? "app.example.com" : production.automaticDomain} />
          </label>
          <ProductionDomainProof companyId={companyId} projectId={projectId} domain={domain} currentDomains={domains.map(item => item.host)}
            automaticDomain={production.automaticDomain} isUk={isUk} />
          {domainError && <p role="alert" className="workspace-production-error">{domainError}</p>}
          <div className="workspace-production-actions">
            <button className="inspector-tab workspace-production-button" type="submit" disabled={disabled}>
              {release ? t("Зберегти", "Save") : t("Опублікувати", "Publish")}
            </button>
            <button className="inspector-tab workspace-production-button" type="button" onClick={() => {
              setEditingDomain(false);
              setDomainError("");
            }}>{t("Скасувати", "Cancel")}</button>
          </div>
        </form>}
      </section>
    </div>

    <ProjectResourceUsage base={controller.base} kind={release?.kind} memoryLimit={release?.settings.limits.memoryMiB} isUk={isUk} />
  </div>;
}
