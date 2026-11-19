import { readSettingsSnapshot } from "./settings-page-cache";
import { ALL_COMPANIES } from "./company-scope";
import { automationsPageKey, fetchAutomationsPage, openAutomationsPage, type AutomationsPageData } from "./automations-page-read";
import { useSettingsRecordsPage } from "./use-settings-records-page";
import { CompanyScopeSelect } from "./CompanyScopeSelect";
import { PageGuideLink } from "./PageGuideLink";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { writeActiveCompanyId, writeCachedCompanies } from "./active-company";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  type CompanyAutomation,
  type Company,
  type CompanyAutomationRun,
  type BrowserCampaignTarget,
  type BrowserEmailAccount,
  type TargetFormState,
  PRESET_CRONS,
  api,
  AutomationEditorDrawer,
  AutomationHistoryDrawer,
  BrowserCampaignPanel,
  AutomationsTable,
} from "./automations";

export function AutomationsPage() {
  const { t, language } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCompanyId = searchParams.get("company") || ALL_COMPANIES;
  const companyId = selectedCompanyId === ALL_COMPANIES ? undefined : selectedCompanyId;
  const [notice, setNotice] = useState<string | null>(null);

  // Editor Drawer State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formCron, setFormCron] = useState("0 9 * * *");
  const [formAgentId, setFormAgentId] = useState("");
  const [saving, setSaving] = useState(false);

  // Run History Drawer State
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyAutomation, setHistoryAutomation] = useState<CompanyAutomation | null>(null);
  const [runs, setRuns] = useState<CompanyAutomationRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runningNowId, setRunningNowId] = useState<string | null>(null);
  // Automations stopped with Stop: their pending Run Now request ends with 409 and must not overwrite the Stop notice.
  const stoppedIds = useRef(new Set<string>());

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");
  const [browserTargets, setBrowserTargets] = useState<BrowserCampaignTarget[]>([]);
  const [browserEmails, setBrowserEmails] = useState<BrowserEmailAccount[]>([]);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState<Record<string, Record<string, string>>>({});
  const [targetForm, setTargetForm] = useState({
    siteName: "", registrationUrl: "", publishUrl: "", automationId: "", emailAccountId: "",
    articleTitle: "", articleBody: "",
  });

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) { setDebouncedSearch(""); return; }
    const timer = setTimeout(() => setDebouncedSearch(query), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const search = searchQuery.trim() ? debouncedSearch : "";
  const filters = { companyId, status: statusFilter === "all" ? undefined : statusFilter, search: search || undefined };
  const scope = automationsPageKey(companyId);
  const { page, counts: stats, bottom, failed, reload: reloadAutomations } = useSettingsRecordsPage(filters, {
    scope,
    unfiltered: !filters.status && !filters.search,
    open: () => openAutomationsPage(companyId),
    fetch: fetchAutomationsPage,
    append: (current, next) => ({ ...current, items: [...current.items, ...next.items], nextCursor: next.nextCursor }),
    onError: setNotice,
  });
  const metadata = page ?? readSettingsSnapshot<AutomationsPageData>(scope);
  const [knownCompanies, setKnownCompanies] = useState<Company[]>([]);
  const companies = metadata?.companies ?? knownCompanies;
  const agents = metadata?.agents ?? [];
  const campaignOptions = metadata?.campaignOptions ?? [];
  const selectedCompany = companies.find(company => company.id === companyId);
  const [liveSchedule, setLiveSchedule] = useState<{ companyId: string; records: Map<string, CompanyAutomation> }>();
  const automations = (page?.items ?? []).map(item => {
    const live = liveSchedule?.companyId === item.companyId ? liveSchedule.records.get(item.id) : undefined;
    return live ? { ...item, isRunning: live.isRunning, nextRunAt: live.nextRunAt } : item;
  });

  useEffect(() => {
    if (metadata?.companies) {
      setKnownCompanies(metadata.companies);
      writeCachedCompanies(metadata.companies);
    }
  }, [metadata?.companies]);

  useEffect(() => {
    setLiveSchedule(undefined);
    setRevealedCredentials({});
  }, [companyId]);

  useEffect(() => {
    const targets = metadata?.browser?.targets ?? [];
    const emailAccounts = metadata?.browser?.emailAccounts ?? [];
    const options = metadata?.campaignOptions ?? [];
    setBrowserTargets(targets);
    setBrowserEmails(emailAccounts);
    setTargetForm(current => ({
      ...current,
      automationId: options.some(item => item.id === current.automationId) ? current.automationId : options[0]?.id ?? "",
      emailAccountId: emailAccounts.some(item => item.id === current.emailAccountId) ? current.emailAccountId : emailAccounts[0]?.id ?? "",
    }));
  }, [companyId, metadata?.browser, metadata?.campaignOptions]);

  const handleCompanyChange = (value: string) => {
    if (value !== ALL_COMPANIES) writeActiveCompanyId(value);
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (value === ALL_COMPANIES) next.delete("company");
      else next.set("company", value);
      return next;
    }, { replace: true });
  };

  const presets = useMemo(
    () => [
      { label: t("automations.presets.daily9"), cron: "0 9 * * *" },
      { label: t("automations.presets.daily18"), cron: "0 18 * * *" },
      { label: t("automations.presets.mondays9"), cron: "0 9 * * 1" },
      { label: t("automations.presets.fridays17"), cron: "0 17 * * 5" },
      { label: t("automations.presets.hourly"), cron: "0 * * * *" },
    ],
    [t]
  );

  const getCronDescription = (cron: string) => {
    const matched = PRESET_CRONS.find((p) => p.cron === cron);
    if (matched) return t(`automations.presets.${matched.key}`);
    if (cron === "0 0 * * *") return t("automations.presets.daily0");
    if (cron === "0 * * * *") return t("automations.presets.hourly");
    return cron;
  };

  const openCreateDrawer = () => {
    if (selectedCompanyId === ALL_COMPANIES) return;
    setEditingId(null);
    setFormName("");
    setFormDescription("");
    setFormPrompt("");
    setFormCron("0 9 * * *");
    setFormAgentId(selectedCompany?.mainAgentId || "");
    setDrawerOpen(true);
  };

  const openEditDrawer = (auto: CompanyAutomation) => {
    if (auto.companyId !== selectedCompanyId) handleCompanyChange(auto.companyId);
    setEditingId(auto.id);
    setFormName(auto.name);
    setFormDescription(auto.description || "");
    setFormPrompt(auto.prompt);
    setFormCron(auto.cronExpression);
    setFormAgentId(auto.agentId || "");
    setDrawerOpen(true);
  };

  const saveAutomation = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setSaving(true);
    setNotice(null);

    try {
      if (editingId) {
        await api(
          `/companies/${selectedCompanyId}/automations/${editingId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: formName,
              description: formDescription,
              prompt: formPrompt,
              cronExpression: formCron,
              agentId: formAgentId || null,
            }),
          }
        );
      } else {
        await api(
          `/companies/${selectedCompanyId}/automations`,
          {
            method: "POST",
            body: JSON.stringify({
              name: formName,
              description: formDescription,
              prompt: formPrompt,
              cronExpression: formCron,
              agentId: formAgentId || undefined,
            }),
          }
        );
      }
      setDrawerOpen(false);
      await reloadAutomations();
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (auto: CompanyAutomation) => {
    const nextStatus = auto.status === "active" ? "paused" : "active";
    try {
      await api(
        `/companies/${auto.companyId || selectedCompanyId}/automations/${auto.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        }
      );
      await reloadAutomations();
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const deleteAutomation = async (id: string) => {
    const ownerId = automations.find(item => item.id === id)?.companyId || selectedCompanyId;
    const confirmed = await confirmModal({
      title: t("automations.dialogs.deleteTitle"),
      message: t("automations.dialogs.deleteMessage"),
      confirmText: t("automations.dialogs.deleteConfirm"),
      cancelText: t("automations.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/companies/${ownerId}/automations/${id}`, { method: "DELETE" });
      await reloadAutomations();
      if (editingId === id) setDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const triggerRunNow = async (auto: CompanyAutomation) => {
    setRunningNowId(auto.id);
    setNotice(null);
    try {
      const res = await api<{ message?: string; result?: string }>(
        `/companies/${auto.companyId || selectedCompanyId}/automations/${auto.id}/run`,
        { method: "POST" }
      );
      setNotice(
        `${t("automations.notifications.runInitiated", { name: auto.name })}${
          res.result ? ` ${t("automations.notifications.resultReceived")}` : ""
        }`
      );
    } catch (err: any) {
      // A run stopped with Stop ends as cancelled; the Stop notice stays.
      if (!stoppedIds.current.delete(auto.id)) setNotice(t("automations.notifications.runError", { error: err.message }));
    } finally {
      setLiveSchedule(undefined);
      setRunningNowId(null);
    }
  };

  // Keep the Stop action current for the selected company.
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    const timer = setInterval(() => {
      void api<{ automations: CompanyAutomation[] }>(`/companies/${companyId}/automations`)
        .then(({ automations }) => {
          if (active) setLiveSchedule({ companyId, records: new Map(automations.map(item => [item.id, item])) });
        })
        .catch(() => undefined);
    }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [companyId]);

  // Stop the run in progress (V6 step 12, owner decision): the run ends as cancelled and the Run Now request returns.
  const stopRun = async (auto: CompanyAutomation) => {
    try {
      stoppedIds.current.add(auto.id);
      await api<{ stopped: number }>(`/companies/${auto.companyId || selectedCompanyId}/automations/${auto.id}/stop`, { method: "POST" });
      setNotice(t("automations.notifications.stopped", { name: auto.name }));
      setLiveSchedule(undefined);
      await reloadAutomations();
    } catch (err: any) {
      setNotice(t("automations.notifications.runError", { error: err.message }));
    }
  };

  const openHistory = async (auto: CompanyAutomation) => {
    setHistoryAutomation(auto);
    setHistoryDrawerOpen(true);
    setHistoryLoading(true);
    try {
      const res = await api<{ runs: CompanyAutomationRun[] }>(
        `/companies/${auto.companyId || selectedCompanyId}/automations/${auto.id}/runs`
      );
      setRuns(res.runs);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const reloadBrowserTargets = async () => {
    const result = await api<{ targets: BrowserCampaignTarget[]; emailAccounts: BrowserEmailAccount[] }>(
      `/companies/${selectedCompanyId}/browser-targets`,
    );
    setBrowserTargets(result.targets);
    setBrowserEmails(result.emailAccounts);
  };

  const createBrowserTarget = async (event: FormEvent) => {
    event.preventDefault();
    if (!targetForm.automationId || !targetForm.emailAccountId) {
      setNotice("Select an automation and a connected Company email.");
      return;
    }
    setBrowserSaving(true);
    try {
      await api(`/companies/${selectedCompanyId}/browser-targets`, {
        method: "POST",
        body: JSON.stringify(targetForm),
      });
      setTargetForm((current) => ({ ...current, siteName: "", registrationUrl: "", publishUrl: "", articleTitle: "", articleBody: "" }));
      await reloadBrowserTargets();
      setNotice("Website added to the browser campaign queue.");
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setBrowserSaving(false);
    }
  };

  const seedBrowserTargets = async () => {
    setBrowserSaving(true);
    try {
      await api(`/companies/${selectedCompanyId}/browser-targets/seed-demo`, {
        method: "POST",
        body: JSON.stringify({ automationId: targetForm.automationId || null, emailAccountId: targetForm.emailAccountId || null }),
      });
      await reloadBrowserTargets();
      setNotice("Two paused demo websites were added. Review them before activating.");
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setBrowserSaving(false);
    }
  };

  const toggleBrowserTarget = async (target: BrowserCampaignTarget) => {
    try {
      const shouldActivate = target.status === "paused" || target.status === "failed" || target.status === "registered" || target.status === "published";
      await api(`/companies/${selectedCompanyId}/browser-targets/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: shouldActivate ? "pending" : "paused" }),
      });
      await reloadBrowserTargets();
    } catch (error: any) {
      setNotice(error.message);
    }
  };

  const deleteBrowserTarget = async (target: BrowserCampaignTarget) => {
    if (!(await confirmModal({ title: "Delete website", message: `Remove ${target.siteName} from the campaign?`, confirmText: "Delete", isDanger: true }))) return;
    try {
      await api(`/companies/${selectedCompanyId}/browser-targets/${target.id}`, { method: "DELETE" });
      await reloadBrowserTargets();
    } catch (error: any) {
      setNotice(error.message);
    }
  };

  const revealBrowserCredential = async (target: BrowserCampaignTarget) => {
    if (!target.credentialId) return;
    try {
      const result = await api<{ fields: Record<string, string> }>(
        `/companies/${selectedCompanyId}/browser-credentials/${target.credentialId}/reveal`, { method: "POST" },
      );
      setRevealedCredentials((current) => ({ ...current, [target.id]: result.fields }));
      window.setTimeout(() => setRevealedCredentials((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      }), 30_000);
    } catch (error: any) {
      setNotice(error.message);
    }
  };

  const seedDemoTitle = !campaignOptions.length
    ? "Create an automation above first"
    : !browserEmails.length
    ? "Connect an email in Email Settings first"
    : !targetForm.automationId || !targetForm.emailAccountId
    ? "Select an Automation and Company email to add demo sites"
    : "Add 2 paused demo websites for testing";

  return (
    <main className="automations-container">
      {/* Header matching /settings/capabilities */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("automations.eyebrow")}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={t("automations.backAria")} title={t("automations.backAria")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("automations.title")}</span>
              <PageGuideLink guide="automations" />
            </h1>
            <p className="hero-copy">
              {t("automations.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            {(
              <CompanyScopeSelect
                aria-label={t("automations.selectCompanyAria")}
                value={selectedCompanyId}
                onValueChange={(value) => handleCompanyChange(value)}
                className="page-size-select"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </CompanyScopeSelect>
            )}
            <button type="button" className="button-primary automations-action-primary" onClick={openCreateDrawer} disabled={selectedCompanyId === ALL_COMPANIES} title={selectedCompanyId === ALL_COMPANIES ? (language === "uk" ? "Виберіть компанію" : "Select a company") : undefined}>
              {t("automations.newAutomationBtn")}
            </button>
          </div>
        </div>
      </header>

      {/* 4 Stat Overview Cards matching /settings/capabilities */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid">
        <div>
          <strong>{stats?.total}</strong>
          <span>{t("automations.stats.total")}</span>
          <small>{t("automations.stats.totalDesc")}</small>
        </div>
        <div>
          <strong>{stats?.active}</strong>
          <span>{t("automations.stats.active")}</span>
          <small>{t("automations.stats.activeDesc")}</small>
        </div>
        <div>
          <strong>{stats?.paused}</strong>
          <span>{t("automations.stats.paused")}</span>
          <small>{t("automations.stats.pausedDesc")}</small>
        </div>
        <div>
          <strong>{stats?.agentsCount}</strong>
          <span>{t("automations.stats.assignedAgents")}</span>
          <small>{t("automations.stats.assignedAgentsDesc")}</small>
        </div>
      </section>

      {/* Search & Tabs Controls bar matching /settings/capabilities */}
      <div className="inspector-controls automations-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("automations.controls.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label={t("automations.controls.searchAriaLabel")}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label={t("automations.controls.clearSearch")}
              title={t("automations.controls.clearSearch")}
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "all"}
            className={`inspector-tab ${statusFilter === "all" ? "active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            <span>{t("automations.controls.tabAll")}</span>
            <small className="tab-count">{stats?.total}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "active"}
            className={`inspector-tab ${statusFilter === "active" ? "active" : ""}`}
            onClick={() => setStatusFilter("active")}
          >
            <span>{t("automations.controls.tabActive")}</span>
            <small className="tab-count">{stats?.active}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "paused"}
            className={`inspector-tab ${statusFilter === "paused" ? "active" : ""}`}
            onClick={() => setStatusFilter("paused")}
          >
            <span>{t("automations.controls.tabPaused")}</span>
            <small className="tab-count">{stats?.paused}</small>
          </button>
        </div>
      </div>

      {notice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      {/* Status summary */}
      <div className="inspector-table-status">
        <div className="status-left">
          <span>
            {page && stats && t("automations.showingStatus", { count: automations.length, total: stats.total })}
            {searchQuery ? ` ${t("automations.matchingQuery", { query: searchQuery })}` : ""}
          </span>
        </div>
      </div>

      {(!failed || page) && <AutomationsTable
        loading={!page}
        total={stats?.total}
        filteredAutomations={automations}
        runningNowId={runningNowId}
        language={language}
        getCronDescription={getCronDescription}
        openCreateDrawer={openCreateDrawer}
        setSearchQuery={setSearchQuery}
        setStatusFilter={setStatusFilter}
        toggleStatus={toggleStatus}
        triggerRunNow={triggerRunNow}
        stopRun={stopRun}
        openHistory={openHistory}
        openEditDrawer={openEditDrawer}
        deleteAutomation={deleteAutomation}
      />}
      {page?.nextCursor && <div ref={bottom} aria-hidden="true" style={{ height: 1 }} />}

      {companyId && metadata && <BrowserCampaignPanel key={companyId}
        automations={campaignOptions}
        browserTargets={browserTargets}
        browserEmails={browserEmails}
        browserSaving={browserSaving}
        targetForm={targetForm}
        setTargetForm={setTargetForm}
        revealedCredentials={revealedCredentials}
        seedBrowserTargets={seedBrowserTargets}
        seedDemoTitle={seedDemoTitle}
        createBrowserTarget={createBrowserTarget}
        revealBrowserCredential={revealBrowserCredential}
        toggleBrowserTarget={toggleBrowserTarget}
        deleteBrowserTarget={deleteBrowserTarget}
      />}

      <AutomationEditorDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        editingId={editingId}
        formName={formName}
        setFormName={setFormName}
        formDescription={formDescription}
        setFormDescription={setFormDescription}
        formAgentId={formAgentId}
        setFormAgentId={setFormAgentId}
        formCron={formCron}
        setFormCron={setFormCron}
        formPrompt={formPrompt}
        setFormPrompt={setFormPrompt}
        agents={agents}
        presets={presets}
        saving={saving}
        onSave={saveAutomation}
        onDelete={(id) => void deleteAutomation(id)}
      />

      <AutomationHistoryDrawer
        isOpen={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        automation={historyAutomation}
        runs={runs}
        loading={historyLoading}
        language={language}
      />
    </main>
  );
}
