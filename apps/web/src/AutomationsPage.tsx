import { readSettingsSnapshot, writeSettingsSnapshot } from "./settings-page-cache";
import { ALL_COMPANIES, loadCompanyScopes } from "./company-scope";
import { listProjectCompanies } from "./website-builder-cache";
import { CompanyScopeSelect } from "./CompanyScopeSelect";
import { PageGuideLink } from "./PageGuideLink";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  chooseAvailableCompanyId,
  readCachedCompanies,
  writeActiveCompanyId,
  writeCachedCompanies,
} from "./active-company";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  type Company,
  type Agent,
  type CompanyAutomation,
  type CompanyAutomationRun,
  type BrowserCampaignTarget,
  type BrowserEmailAccount,
  type TargetFormState,
  PRESET_CRONS,
  api,
  getCachedAutomations,
  updateCachedAutomations,
  getCachedAgents,
  updateCachedAgents,
  AutomationEditorDrawer,
  AutomationHistoryDrawer,
  BrowserCampaignPanel,
  AutomationsTable,
} from "./automations";

export function AutomationsPage() {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCompanyId = searchParams.get("company") ?? "";
  const cachedCompanies = useMemo(() => readCachedCompanies<Company>(), []);
  const [companies, setCompanies] = useState<Company[]>(cachedCompanies);
  const companyIdsKey = companies.map(company => company.id).join("\0");
  const initialCompanyId = useMemo(() => {
    return requestedCompanyId || ALL_COMPANIES;
  }, [cachedCompanies, requestedCompanyId]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(initialCompanyId);
  const initialAutomations = useMemo(() => readSettingsSnapshot<CompanyAutomation[]>(`automations:${initialCompanyId}`) ?? getCachedAutomations(initialCompanyId), [initialCompanyId]);
  const [automations, setAutomations] = useState<CompanyAutomation[]>(initialAutomations);
  const [agents, setAgents] = useState<Agent[]>(() => getCachedAgents(initialCompanyId));
  const [loading, setLoading] = useState(() => initialAutomations.length === 0);
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
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");
  const [browserTargets, setBrowserTargets] = useState<BrowserCampaignTarget[]>([]);
  const [browserEmails, setBrowserEmails] = useState<BrowserEmailAccount[]>([]);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState<Record<string, Record<string, string>>>({});
  const [targetForm, setTargetForm] = useState({
    siteName: "", registrationUrl: "", publishUrl: "", automationId: "", emailAccountId: "",
    articleTitle: "", articleBody: "",
  });

  const handleCompanyChange = (companyId: string) => {
    setSelectedCompanyId(companyId);
    if (companyId !== ALL_COMPANIES) writeActiveCompanyId(companyId);
    const cachedAuto = getCachedAutomations(companyId);
    const cachedAg = getCachedAgents(companyId);
    setAutomations(cachedAuto);
    setAgents(cachedAg);
    if (cachedAuto.length === 0) {
      setLoading(true);
    }
  };

  // Load companies
  useEffect(() => {
    let active = true;
    listProjectCompanies()
      .then((list) => {
        if (!active) return;
        setCompanies(list);
        writeCachedCompanies(list);
        const requested = searchParams.get("company");
        const selected = requested ? chooseAvailableCompanyId(list, { requested }) : ALL_COMPANIES;
        if (selected && selected !== selectedCompanyId) {
          setSelectedCompanyId(selected);
          if (selected !== ALL_COMPANIES) writeActiveCompanyId(selected);
        }
        if (requested) {
          const next = new URLSearchParams(searchParams);
          next.delete("company");
          setSearchParams(next, { replace: true });
        }
      })
      .catch((e) => {
        if (active) setNotice(e.message);
      });

    return () => {
      active = false;
    };
  }, []);

  // Load automations & agents when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    let active = true;
    if (selectedCompanyId === ALL_COMPANIES) {
      const cached = readSettingsSnapshot<CompanyAutomation[]>("automations:all");
      if (cached) setAutomations(cached);
      setLoading(!cached); setBrowserTargets([]); setBrowserEmails([]);
      const publish = (pages: Array<{ automations: CompanyAutomation[] }>) => {
        if (!active) return;
        const records = pages.flatMap(page => page.automations);
        setAutomations(records); writeSettingsSnapshot("automations:all", records);
        if (records.length) setLoading(false);
      };
      void loadCompanyScopes(companies.map(company => company.id), async id => {
        const auto = await api<{ automations: CompanyAutomation[] }>(`/companies/${id}/automations`);
        return { automations: auto.automations.map(item => ({ ...item, companyId: id })) };
      }, { key: "automations", initial: cached ? companies.map(company => ({ automations: cached.filter(item => item.companyId === company.id) })) : undefined, isActive: () => active, onProgress: publish }).then(pages => {
        if (!active) return;
        publish(pages);
        const ids = [...new Set(pages.flatMap(page => page.automations).filter(item => item.agentId).map(item => item.companyId))];
        void loadCompanyScopes(ids, id => api<{ agents: Agent[] }>(`/companies/${id}/agents`), { key: "agents", isActive: () => active })
          .then(pages => { if (active) setAgents(pages.flatMap(page => page.agents)); }).catch(() => undefined);
      }).catch(error => { if (active) setNotice(error.message); })
        .finally(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }
    const cachedAuto = getCachedAutomations(selectedCompanyId);
    if (cachedAuto.length === 0 && automations.length === 0) {
      setLoading(true);
    }

    Promise.all([
      api<{ automations: CompanyAutomation[] }>(`/companies/${selectedCompanyId}/automations`),
      api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
      api<{ targets: BrowserCampaignTarget[]; emailAccounts: BrowserEmailAccount[] }>(`/companies/${selectedCompanyId}/browser-targets`),
    ])
      .then(([autoRes, agentsRes, browserRes]) => {
        if (!active) return;
        setAutomations(autoRes.automations);
        setAgents(agentsRes.agents);
        setBrowserTargets(browserRes.targets);
        setBrowserEmails(browserRes.emailAccounts);
        updateCachedAutomations(selectedCompanyId, autoRes.automations);
        updateCachedAgents(selectedCompanyId, agentsRes.agents);
        setTargetForm((curr) => ({
          ...curr,
          automationId: curr.automationId || autoRes.automations[0]?.id || "",
          emailAccountId: curr.emailAccountId || browserRes.emailAccounts[0]?.id || "",
        }));
      })
      .catch((e) => {
        if (active) setNotice(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedCompanyId, companyIdsKey]);

  const selectedCompany = useMemo(
    () => companies.find((c) => c.id === selectedCompanyId),
    [companies, selectedCompanyId]
  );

  const filteredAutomations = useMemo(() => {
    return automations.filter((auto) => {
      if (statusFilter !== "all" && auto.status !== statusFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const agentName = agents.find((a) => a.id === auto.agentId)?.name.toLowerCase() || "main agent";
      return (
        auto.name.toLowerCase().includes(q) ||
        (auto.description && auto.description.toLowerCase().includes(q)) ||
        auto.prompt.toLowerCase().includes(q) ||
        auto.cronExpression.toLowerCase().includes(q) ||
        agentName.includes(q)
      );
    });
  }, [automations, searchQuery, statusFilter, agents]);

  const stats = useMemo(() => {
    const total = automations.length;
    const active = automations.filter((a) => a.status === "active").length;
    const paused = automations.filter((a) => a.status === "paused").length;
    const assignedAgentIds = new Set(automations.map((a) => a.agentId).filter(Boolean));
    const agentsCount = assignedAgentIds.size || (automations.length > 0 ? 1 : 0);
    return { total, active, paused, agentsCount };
  }, [automations]);

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
        const updated = await api<CompanyAutomation>(
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
        setAutomations((prev) => {
          const next = prev.map((a) => (a.id === updated.id ? updated : a));
          if (selectedCompanyId !== ALL_COMPANIES) updateCachedAutomations(selectedCompanyId, next);
          return next;
        });
      } else {
        const created = await api<CompanyAutomation>(
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
        setAutomations((prev) => {
          const next = [created, ...prev];
          if (selectedCompanyId !== ALL_COMPANIES) updateCachedAutomations(selectedCompanyId, next);
          return next;
        });
      }
      setDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (auto: CompanyAutomation) => {
    const nextStatus = auto.status === "active" ? "paused" : "active";
    try {
      const updated = await api<CompanyAutomation>(
        `/companies/${auto.companyId || selectedCompanyId}/automations/${auto.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        }
      );
      setAutomations((prev) => {
        const next = prev.map((a) => (a.id === updated.id ? updated : a));
        if (selectedCompanyId !== ALL_COMPANIES) updateCachedAutomations(selectedCompanyId, next);
        return next;
      });
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
      setAutomations((prev) => {
        const next = prev.filter((a) => a.id !== id);
        if (selectedCompanyId !== ALL_COMPANIES) updateCachedAutomations(selectedCompanyId, next);
        return next;
      });
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
      setRunningNowId(null);
    }
  };

  // A scheduled run can start while the page is open: the list is refreshed so its Stop button appears (V6 step 12).
  useEffect(() => {
    if (!selectedCompanyId || selectedCompanyId === ALL_COMPANIES) return;
    const timer = setInterval(() => {
      void api<{ automations: CompanyAutomation[] }>(`/companies/${selectedCompanyId}/automations`)
        .then((res) => setAutomations(res.automations))
        .catch(() => undefined);
    }, 15000);
    return () => clearInterval(timer);
  }, [selectedCompanyId]);

  // Stop the run in progress (V6 step 12, owner decision): the run ends as cancelled and the Run Now request returns.
  const stopRun = async (auto: CompanyAutomation) => {
    try {
      stoppedIds.current.add(auto.id);
      await api<{ stopped: number }>(`/companies/${auto.companyId || selectedCompanyId}/automations/${auto.id}/stop`, { method: "POST" });
      setNotice(t("automations.notifications.stopped", { name: auto.name }));
      setAutomations((prev) => prev.map((item) => (item.id === auto.id ? { ...item, isRunning: false } : item)));
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

  const seedDemoTitle = !automations.length
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
          <strong>{stats.total}</strong>
          <span>{t("automations.stats.total")}</span>
          <small>{t("automations.stats.totalDesc")}</small>
        </div>
        <div>
          <strong>{stats.active}</strong>
          <span>{t("automations.stats.active")}</span>
          <small>{t("automations.stats.activeDesc")}</small>
        </div>
        <div>
          <strong>{stats.paused}</strong>
          <span>{t("automations.stats.paused")}</span>
          <small>{t("automations.stats.pausedDesc")}</small>
        </div>
        <div>
          <strong>{stats.agentsCount}</strong>
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
            <small className="tab-count">{automations.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "active"}
            className={`inspector-tab ${statusFilter === "active" ? "active" : ""}`}
            onClick={() => setStatusFilter("active")}
          >
            <span>{t("automations.controls.tabActive")}</span>
            <small className="tab-count">{stats.active}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "paused"}
            className={`inspector-tab ${statusFilter === "paused" ? "active" : ""}`}
            onClick={() => setStatusFilter("paused")}
          >
            <span>{t("automations.controls.tabPaused")}</span>
            <small className="tab-count">{stats.paused}</small>
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
            {t("automations.showingStatus", { count: filteredAutomations.length, total: automations.length })}
            {searchQuery ? ` ${t("automations.matchingQuery", { query: searchQuery })}` : ""}
          </span>
        </div>
      </div>

      <AutomationsTable
        loading={loading}
        automations={automations}
        filteredAutomations={filteredAutomations}
        agents={agents}
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
      />

      {selectedCompanyId !== ALL_COMPANIES && <BrowserCampaignPanel
        automations={automations}
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
