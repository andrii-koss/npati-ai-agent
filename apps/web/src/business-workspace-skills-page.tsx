import { BusinessSettingsHeader } from "./business-settings-header";
import { PageGuideLink } from "./PageGuideLink";
import { useTranslation } from "./i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Skill, getCachedSkills, updateCachedSkills } from "./business-workspace-shared";
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
        if (!query)
            return localizedSkills;
        return localizedSkills.filter((skill) => skill.name.toLowerCase().includes(query)
            || skill.description.toLowerCase().includes(query)
            || skill.capabilities.some((capability) => capability.toLowerCase().includes(query)));
    }, [search, localizedSkills]);
    const capabilityCount = useMemo(() => new Set(skills.flatMap((skill) => skill.capabilities)).size, [skills]);
    return (<main className="automations-container skills-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("skillsPage.eyebrow")}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={t("skillsPage.backToSettings")} title={t("skillsPage.backToSettings")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
              </Link>
              <span>{t("skillsPage.title")}</span>
              <PageGuideLink guide="skills"/>
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
          <input type="text" role="searchbox" placeholder={t("skillsPage.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} className="inspector-search-input" aria-label={t("skillsPage.searchAria")}/>
          {search && <button type="button" className="search-clear-btn" onClick={() => setSearch("")} aria-label={t("skillsPage.clearSearch")}>×</button>}
        </div>
      </div>

      <div className="inspector-table-status">
        <div className="status-left"><span>{t("skillsPage.statusShowing.showing")} <strong>{filteredSkills.length}</strong> {t("skillsPage.statusShowing.of")} <strong>{skills.length}</strong> {t("skillsPage.statusShowing.skills")}</span></div>
      </div>

      {error ? <div className="workspace-notice error">{error}</div> : filteredSkills.length === 0 ? (<div className="automations-empty-card">
          <div className="automations-empty-icon">⌕</div><h3>{t("skillsPage.empty.title")}</h3>
          <p>{t("skillsPage.empty.description")}</p>
          <button type="button" className="button-secondary" onClick={() => setSearch("")}>{t("skillsPage.empty.clearSearch")}</button>
        </div>) : (<div className="skill-grid skills-catalog-grid">
          {filteredSkills.map((skill, index) => (<article key={skill.id} className="skills-catalog-card">
              <div className="skills-card-head">
                <span className="skills-card-icon" aria-hidden="true">{index + 1}</span>
                <span className="skills-card-status"><i /> {t("skillsPage.card.available")}</span>
              </div>
              <div className="skills-card-type">{t("skillsPage.card.builtinType")}</div>
              <h2>{skill.name}</h2><p>{skill.description}</p>
              <div className="skills-capabilities">{skill.capabilities.map((capability) => <i key={capability}>{capability}</i>)}</div>
            </article>))}
        </div>)}
    </main>);
}
