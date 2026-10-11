import { useTranslation } from "./i18n";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { confirmModal, alertModal } from "./ConfirmDialog";
import { Business, Goal, MemoryItem, api, Notice, useWorkspace, Skill, getCachedSkills, updateCachedSkills, PageIntro, EmptyBusiness } from "./business-workspace-shared";
import { BusinessForm } from "./business-workspace-cards";

export function BusinessPage() {
  const { overview, loading, error, refresh, switchBusiness } = useWorkspace();
  const { businessId: editBusinessId } = useParams();
  const navigate = useNavigate();
  const [creatingManually, setCreatingManually] = useState(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const current = overview?.currentBusiness;
  const editDraft = editBusinessId ? overview?.onboardings.find((session) => session.businessId === editBusinessId) ?? null : null;
  const editTarget = editBusinessId ? overview?.businesses.find((business) => business.id === editBusinessId) : undefined;
  const { t } = useTranslation();

  useEffect(() => {
    if (!editTarget || current?.id === editTarget.id) return;
    void switchBusiness(editTarget.id);
  }, [editTarget?.id, current?.id]);

  function createBusinessIdea() {
    navigate("/b/new", { state: { newBusiness: Date.now() } });
  }

  async function removeBusiness(id: string, name: string) {
    if (!await confirmModal({
      title: t("businessSettings.dialogs.deleteTitle"),
      message: t("businessSettings.dialogs.deleteMessage", { name }),
      confirmText: t("businessSettings.dialogs.deleteConfirm"),
      cancelText: t("businessSettings.dialogs.deleteCancel"),
      isDanger: true,
    })) return;
    await api(`/businesses/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function convertToCompany(business: Business) {
    if (!await confirmModal({
      title: t("businessSettings.dialogs.createCompanyTitle"),
      message: t("businessSettings.dialogs.createCompanyMessage", { name: business.name }),
      confirmText: t("businessSettings.dialogs.createCompanyConfirm"),
      cancelText: t("businessSettings.dialogs.createCompanyCancel"),
      isDanger: false,
    })) return;
    setConvertingId(business.id);
    try {
      await api(`/businesses/${business.id}/convert-to-company`, {
        method: "POST",
        headers: { "idempotency-key": `business-convert-${business.id}` },
        body: JSON.stringify({
          companyName: business.name,
          includeConfirmedMemory: true,
          includeGoals: true,
          includeResearchSummary: true,
          includeInstructions: true,
        }),
      });
      navigate("/company");
    } catch (reason) {
      await alertModal({
        title: t("businessSettings.dialogs.companyCreationFailed"),
        message: reason instanceof Error ? reason.message : t("businessSettings.dialogs.companyCreationError"),
        isDanger: true,
      });
    } finally {
      setConvertingId(null);
    }
  }

  if (loading && editBusinessId) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy={t("businessSettings.loadingCopy")} backTo="/settings/business" /></main>;
  if (error) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy={t("businessSettings.loadingCopy")} backTo={editBusinessId ? "/settings/business" : "/settings"} /><Notice tone="error">{error}</Notice></main>;

  if (creatingManually) {
    return (
      <main className="automations-container business-settings-page">
        <BusinessSettingsHeader title={t("businessSettings.newBusinessTitle")} copy={t("businessSettings.newBusinessCopy")} onBack={() => setCreatingManually(false)} />
        <BusinessForm
          mode="existing"
          onCancel={() => setCreatingManually(false)}
          onSaved={async () => { await refresh(); setCreatingManually(false); }}
        />
      </main>
    );
  }

  if (editDraft) {
    return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editDraft.business.name} copy={t("businessSettings.editDraftCopy")} backTo="/settings/business" /><BusinessForm initial={editDraft.business} mode={editDraft.scenario} onSaved={refresh} /></main>;
  }
  if (editTarget && current?.id !== editTarget.id) return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editTarget.name} copy={t("businessSettings.openingCopy")} backTo="/settings/business" /><div className="workspace-loading">{t("businessSettings.openingProfile")}</div></main>;
  if (editTarget) {
    return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editTarget.name} copy={t("businessSettings.editCopy")} backTo="/settings/business" /><BusinessForm initial={editTarget} mode={editTarget.businessType ?? "existing"} onSaved={refresh} /></main>;
  }
  if (editBusinessId) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy={t("businessSettings.loadingCopy")} backTo="/settings/business" /><Notice tone="error">{t("businessSettings.notFoundError")}</Notice></main>;

  const businesses = overview?.businesses ?? [];
  const drafts = overview?.onboardings ?? [];
  const ideaCount = businesses.length + drafts.length;
  return (
    <main className="automations-container business-settings-page">
      <BusinessSettingsHeader
        copy={t("businessSettings.description")}
        action={<button className="button-primary automations-action-primary" onClick={() => setCreatingManually(true)}>{t("businessSettings.addBusiness")}</button>}
      />

      <section className="overview-grid inspector-stats-grid business-stats-grid">
        <div><strong>{ideaCount}</strong><span>{t("businessSettings.stats.businessProfiles")}</span><small>{t("businessSettings.stats.allActiveDesc")}</small></div>
        <div><strong>{businesses.length}</strong><span>{t("businessSettings.stats.activeBusinesses")}</span><small>{t("businessSettings.stats.readyToUse")}</small></div>
        <div><strong>{drafts.length}</strong><span>{t("businessSettings.stats.setupDrafts")}</span><small>{t("businessSettings.stats.awaitingCompletion")}</small></div>
        <div><strong>{current ? 1 : 0}</strong><span>{t("businessSettings.stats.currentContext")}</span><small>{current?.name || t("businessSettings.stats.noBusinessSelected")}</small></div>
      </section>

      <div className="inspector-table-status business-list-status">
        <div className="status-left"><span>{t("businessSettings.list.showingProfiles")} <strong>{ideaCount}</strong> {ideaCount === 1 ? t("businessSettings.list.profile") : t("businessSettings.list.profiles")}</span></div>
      </div>

      {ideaCount === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">B</div>
          <h3>{t("businessSettings.empty.title")}</h3>
          <p>{t("businessSettings.empty.description")}</p>
          <button className="button-primary automations-action-primary" onClick={() => setCreatingManually(true)}>{t("businessSettings.createFirstBusiness")}</button>
        </div>
      ) : (
        <div className="record-list business-profile-list">
          {drafts.map((draft) => (
            <article className="record-card business-profile-card" key={draft.businessId} onClick={() => navigate(`/b/${draft.businessId}`)}>
              <div className="business-card-main">
                <span className="business-card-icon">{draft.business.name.charAt(0).toUpperCase() || "B"}</span>
                <div><span className="record-status">{t("businessSettings.card.setupDraft")}</span><h3>{draft.business.name}</h3><p>{t("businessSettings.card.stepsCompleted", { completed: String(draft.completedFields.length), total: String(draft.totalFields) })}</p></div>
              </div>
              <div className="record-actions">
                <button onClick={(event) => { event.stopPropagation(); navigate(`/b/${draft.businessId}`); }}>{t("businessSettings.card.continueSetup")}</button>
                <button onClick={(event) => { event.stopPropagation(); navigate(`/settings/business/${draft.businessId}`); }}>{t("businessSettings.card.edit")}</button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); void removeBusiness(draft.businessId, draft.business.name); }}>{t("businessSettings.card.delete")}</button>
              </div>
            </article>
          ))}
          {businesses.map((business) => (
            <article className="record-card business-profile-card" key={business.id} onClick={() => navigate(`/settings/business/${business.id}`)}>
              <div className="business-card-main">
                <span className="business-card-icon">{business.name.charAt(0).toUpperCase() || "B"}</span>
                <div>
                  <span className={`record-status${business.id === current?.id ? " active" : ""}`}>{business.id === current?.id ? t("businessSettings.card.current") : business.businessStage}</span>
                  <h3>{business.name}</h3>
                  <p>{business.description || business.industry || t("businessSettings.card.businessProfile")}</p>
                  <div className="business-card-meta">
                    {business.industry && <span>{business.industry}</span>}
                    {business.market && <span>{business.market}</span>}
                    {business.country && <span>{business.country}</span>}
                  </div>
                </div>
              </div>
              <div className="record-actions">
                <button onClick={(event) => { event.stopPropagation(); navigate(`/settings/business/${business.id}`); }}>{t("businessSettings.card.edit")}</button>
                <button disabled={convertingId === business.id} onClick={(event) => { event.stopPropagation(); void convertToCompany(business); }}>{convertingId === business.id ? t("businessSettings.card.converting") : t("businessSettings.card.createCompany")}</button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); void removeBusiness(business.id, business.name); }}>{t("businessSettings.card.delete")}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
export function SkillsPage() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>(getCachedSkills);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<Skill[]>("/skills")
      .then((data) => {
        setSkills(data);
        updateCachedSkills(data);
        setError("");
      })
      .catch((reason) => {
        if (skills.length === 0) {
          setError(reason instanceof Error ? reason.message : t("skillsPage.errorLoading"));
        }
      })
      .finally(() => setLoading(false));
  }, [t]);

  const getSkillInfo = useCallback((skill: Skill) => {
    switch (skill.id) {
      case "competitor-analysis":
        return {
          name: t("skillsPage.skills.competitorAnalysis.name"),
          description: t("skillsPage.skills.competitorAnalysis.desc"),
        };
      case "web-research":
        return {
          name: t("skillsPage.skills.webResearch.name"),
          description: t("skillsPage.skills.webResearch.desc"),
        };
      case "business-startup":
        return {
          name: t("skillsPage.skills.businessStartup.name"),
          description: t("skillsPage.skills.businessStartup.desc"),
        };
      case "business-growth":
        return {
          name: t("skillsPage.skills.businessGrowth.name"),
          description: t("skillsPage.skills.businessGrowth.desc"),
        };
      case "sell-product":
        return {
          name: t("skillsPage.skills.sellProduct.name"),
          description: t("skillsPage.skills.sellProduct.desc"),
        };
      default:
        return {
          name: skill.name,
          description: skill.description,
        };
    }
  }, [t]);

  const localizedSkills = useMemo(() => {
    return skills.map((skill) => {
      const info = getSkillInfo(skill);
      return {
        ...skill,
        name: info.name,
        description: info.description,
      };
    });
  }, [skills, getSkillInfo]);

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return localizedSkills;
    return localizedSkills.filter((skill) => skill.name.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
      || skill.capabilities.some((capability) => capability.toLowerCase().includes(query)));
  }, [search, localizedSkills]);
  const capabilityCount = useMemo(() => new Set(skills.flatMap((skill) => skill.capabilities)).size, [skills]);

  return (
    <main className="automations-container skills-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("skillsPage.eyebrow")}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={t("skillsPage.backToSettings")} title={t("skillsPage.backToSettings")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("skillsPage.title")}</span>
            </h1>
            <p className="hero-copy">{t("skillsPage.heroCopy")}</p>
          </div>
          <span className="skills-readonly-badge">{t("skillsPage.badgeBuiltin")}</span>
        </div>
      </header>

      <section className="overview-grid inspector-stats-grid skills-stats-grid">
        <div><strong>{skills.length}</strong><span>{t("skillsPage.stats.availableSkills")}</span><small>{t("skillsPage.stats.availableSkillsDesc")}</small></div>
        <div><strong>{capabilityCount}</strong><span>{t("skillsPage.stats.capabilities")}</span><small>{t("skillsPage.stats.capabilitiesDesc")}</small></div>
        <div><strong>{t("skillsPage.stats.autoValue")}</strong><span>{t("skillsPage.stats.skillSelection")}</span><small>{t("skillsPage.stats.skillSelectionDesc")}</small></div>
      </section>

      <div className="inspector-controls skills-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input type="text" role="searchbox" placeholder={t("skillsPage.searchPlaceholder")} value={search}
            onChange={(event) => setSearch(event.target.value)} className="inspector-search-input" aria-label={t("skillsPage.searchAria")} />
          {search && <button type="button" className="search-clear-btn" onClick={() => setSearch("")} aria-label={t("skillsPage.clearSearch")}>×</button>}
        </div>
      </div>

      <div className="inspector-table-status">
        <div className="status-left"><span>{t("skillsPage.statusShowing.showing")} <strong>{filteredSkills.length}</strong> {t("skillsPage.statusShowing.of")} <strong>{skills.length}</strong> {t("skillsPage.statusShowing.skills")}</span></div>
      </div>

      {error ? <div className="workspace-notice error">{error}</div> : filteredSkills.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">⌕</div><h3>{t("skillsPage.empty.title")}</h3>
          <p>{t("skillsPage.empty.description")}</p>
          <button type="button" className="button-secondary" onClick={() => setSearch("")}>{t("skillsPage.empty.clearSearch")}</button>
        </div>
      ) : (
        <div className="skill-grid skills-catalog-grid">
          {filteredSkills.map((skill, index) => (
            <article key={skill.id} className="skills-catalog-card">
              <div className="skills-card-head">
                <span className="skills-card-icon" aria-hidden="true">{index + 1}</span>
                <span className="skills-card-status"><i /> {t("skillsPage.card.available")}</span>
              </div>
              <div className="skills-card-type">{t("skillsPage.card.builtinType")}</div>
              <h2>{skill.name}</h2><p>{skill.description}</p>
              <div className="skills-capabilities">{skill.capabilities.map((capability) => <i key={capability}>{capability}</i>)}</div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
export function GoalsPage() {
  const { overview } = useWorkspace(); const business = overview?.currentBusiness;
  const [goals, setGoals] = useState<Goal[]>([]); const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState({ title: "", description: "", targetDate: "", priority: "2" }); const [error, setError] = useState("");
  async function load() { if (business) setGoals(await api<Goal[]>(`/businesses/${business.id}/goals`)); }
  useEffect(() => {
    void load().catch((reason) => setError(String(reason)));
    const handleGoalsChanged = () => { void load().catch(() => {}); };
    window.addEventListener("npati:goals-changed", handleGoalsChanged);
    return () => window.removeEventListener("npati:goals-changed", handleGoalsChanged);
  }, [business?.id]);
  if (!business) return <><PageIntro eyebrow="Execution" title="Goals" copy="Define measurable outcomes for the current business." /><EmptyBusiness feature="Goals" /></>;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    await api(editing ? `/businesses/${business.id}/goals/${editing.id}` : `/businesses/${business.id}/goals`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...form, priority: Number(form.priority), targetDate: form.targetDate || undefined }) });
    setForm({ title: "", description: "", targetDate: "", priority: "2" }); setEditing(null); await load();
  }
  function startEdit(goal: Goal) { setEditing(goal); setForm({ title: goal.title, description: goal.description ?? "", targetDate: goal.targetDate?.slice(0, 10) ?? "", priority: String(goal.priority) }); }
  return (
    <>
      <PageIntro eyebrow={business.name} title="Goals" copy="Give NPATI concrete outcomes to prioritize in chat and recommendations." />
      {error && <Notice tone="error">{error}</Notice>}
      <form className="compact-form" onSubmit={(event) => void save(event)}>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Goal title" required />
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does success look like?" />
        <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="1">High priority</option><option value="2">Normal priority</option><option value="3">Low priority</option></select>
        <button className="button-primary">{editing ? "Save goal" : "Add goal"}</button>{editing && <button type="button" className="button-secondary" onClick={() => { setEditing(null); setForm({ title: "", description: "", targetDate: "", priority: "2" }); }}>Cancel</button>}
      </form>
      <div className="record-list">{goals.length === 0 ? <div className="empty-record">No goals yet. Add the first outcome you want NPATI to help with.</div> : goals.map((goal) => (
        <article className="record-card" key={goal.id}><div><span className={`record-status ${goal.status}`}>{goal.status}</span><h3>{goal.title}</h3><p>{goal.description || "No description"}{goal.targetDate ? ` · Due ${new Date(goal.targetDate).toLocaleDateString()}` : ""}</p></div><div className="record-actions">{goal.status !== "completed" && <button onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) }).then(load)}>Complete</button>}{goal.status === "active" && <button onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) }).then(load)}>Pause</button>}{goal.status === "paused" && <button onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }).then(load)}>Resume</button>}<button onClick={() => startEdit(goal)}>Edit</button><button className="danger" onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "DELETE" }).then(load)}>Delete</button></div></article>
      ))}</div>
    </>
  );
}
export function MemoryPage() {
  const { overview } = useWorkspace(); const business = overview?.currentBusiness;
  const [items, setItems] = useState<MemoryItem[]>([]); const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [form, setForm] = useState({ type: "business_fact", title: "", content: "" }); const [error, setError] = useState("");
  async function load() { if (business) setItems(await api<MemoryItem[]>(`/businesses/${business.id}/memory`)); }
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [business?.id]);
  if (!business) return <><PageIntro eyebrow="Business context" title="Memory" copy="Control the durable facts NPATI may use." /><EmptyBusiness feature="Memory items" /></>;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    await api(editing ? `/businesses/${business.id}/memory/${editing.id}` : `/businesses/${business.id}/memory`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...form, source: "user" }) });
    setForm({ type: "business_fact", title: "", content: "" }); setEditing(null); await load();
  }
  return (
    <>
      <PageIntro eyebrow={business.name} title="Memory" copy="Only confirmed business facts live here. Credentials and API keys are rejected." />
      {error && <Notice tone="error">{error}</Notice>}
      <form className="compact-form memory-form" onSubmit={(event) => void save(event)}>
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{["business_fact","audience","brand","preference","decision","product","channel","experiment","result","other"].map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}</select>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Memory title" required />
        <input value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Fact NPATI should remember" required />
        <button className="button-primary">{editing ? "Save memory" : "Add memory"}</button>{editing && <button type="button" className="button-secondary" onClick={() => { setEditing(null); setForm({ type: "business_fact", title: "", content: "" }); }}>Cancel</button>}
      </form>
      <div className="record-list">{items.length === 0 ? <div className="empty-record">No confirmed memory yet. Add an audience, preference, decision, or business fact.</div> : items.map((item) => <article className="record-card" key={item.id}><div><span className="record-status">{item.type.replace("_", " ")}</span><h3>{item.title}</h3><p>{item.content}</p></div><div className="record-actions"><button onClick={() => { setEditing(item); setForm({ type: item.type, title: item.title, content: item.content }); }}>Edit</button><button className="danger" onClick={() => void api(`/businesses/${business.id}/memory/${item.id}`, { method: "DELETE" }).then(load)}>Forget</button></div></article>)}</div>
    </>
  );
}
export function BusinessSettingsHeader({ title, copy, action, backTo = "/settings", onBack }: { title?: string; copy: string; action?: ReactNode; backTo?: string; onBack?: () => void }) {
  const { t } = useTranslation();
  const displayTitle = title || t("businessSettings.title");
  return (
    <header className="inspector-header automations-header business-settings-header">
      <div className="automations-header-top">
        <div>
          <p className="eyebrow">{t("businessSettings.eyebrow")}</p>
          <h1>
            {onBack ? <button type="button" className="marketplace-back-button" aria-label={t("businessSettings.backToProfiles")} title={t("businessSettings.backToProfiles")} onClick={onBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button> : <Link to={backTo} className="marketplace-back-button" aria-label={backTo === "/settings" ? t("businessSettings.backToSettings") : t("businessSettings.backToProfiles")} title={backTo === "/settings" ? t("businessSettings.backToSettings") : t("businessSettings.backToProfiles")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>}
            <span>{displayTitle}</span>
          </h1>
          <p className="hero-copy">{copy}</p>
        </div>
        {action && <div className="automations-header-actions">{action}</div>}
      </div>
    </header>
  );
}
