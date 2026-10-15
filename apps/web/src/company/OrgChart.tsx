import { CSSProperties, useEffect, useMemo, useState } from "react";
import type { Model } from "../ai-marketplace-types";
import { useTranslation } from "../i18n";
import type { Agent, Edge } from "./types";

export function AgentModelIcon({ agent, model, working }: { agent: Agent; model?: Model; working: boolean }) {
  const [providerIconFailed, setProviderIconFailed] = useState(false);
  useEffect(() => setProviderIconFailed(false), [agent.modelId]);
  const providerId = model?.providerId ?? agent.modelId?.split("/")[0];
  const providerName = model?.providerName ?? providerId ?? "NPATI";
  const useProviderIcon = Boolean(agent.modelId && providerId && !providerIconFailed);
  const source = useProviderIcon
    ? `/api/ai/providers/${encodeURIComponent(providerId!)}/icon?surface=light-v2`
    : "/npati-auto.png";
  const { t } = useTranslation();
  return <span className={`company-agent-model-icon ${agent.modelId ? "provider" : "npati-auto"}`} title={`${agent.modelId ? t("companySettings.orgChart.modelVia", { model: model?.name ?? agent.modelId, provider: providerName }) : "NPATI Auto"} · ${working ? t("companySettings.orgChart.working") : t("companySettings.orgChart.idle")}`}>
    <img src={source} alt="" onError={(event) => {
      if (useProviderIcon) setProviderIconFailed(true);
      else event.currentTarget.style.visibility = "hidden";
    }} />
    <span className={`company-agent-activity-dot ${working ? "working" : "idle"}`} aria-label={working ? t("companySettings.orgChart.working") : t("companySettings.orgChart.idle")} />
  </span>;
}

export function AgentNode({ agent, main, model, working, onClick }: { agent: Agent; main: boolean; model?: Model; working: boolean; onClick(): void }) {
  const { t } = useTranslation();
  return <button className={`company-agent-node ${main ? "main" : ""} ${agent.isActive ? "" : "inactive"} ${working ? "working" : ""}`} onClick={onClick}>
    <AgentModelIcon agent={agent} model={model} working={working} />
    <span><strong>{agent.name}</strong><small>{agent.role}</small><em>{agent.modelId || t("companySettings.orgChart.auto")}</em></span>
    {main && <b>{t("companySettings.orgChart.main")}</b>}
  </button>;
}

export function OrgChart({ agents, edges, mainAgentId, models, workingAgentIds, onSelect }: { agents: Agent[]; edges: Edge[]; mainAgentId?: string; models: Model[]; workingAgentIds: Set<string>; onSelect(agent: Agent): void }) {
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const animationKey = useMemo(() => [
    ...agents.map((agent) => agent.id).sort(),
    "edges",
    ...edges.map((edge) => `${edge.parentAgentId}>${edge.childAgentId}`).sort(),
  ].join("|"), [agents, edges]);
  const levels = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const parentByChild = new Map(edges.map((edge) => [edge.childAgentId, edge.parentAgentId]));
    const children = new Map<string, string[]>();
    for (const edge of edges) children.set(edge.parentAgentId, [...(children.get(edge.parentAgentId) ?? []), edge.childAgentId]);
    const roots = agents.filter((agent) => !parentByChild.has(agent.id)).sort((a, b) => Number(b.id === mainAgentId) - Number(a.id === mainAgentId));
    const rows: Agent[][] = []; const visited = new Set<string>(); let current = roots;
    while (current.length) {
      rows.push(current); current.forEach((agent) => visited.add(agent.id));
      current = current.flatMap((agent) => children.get(agent.id) ?? []).map((id) => byId.get(id)).filter((agent): agent is Agent => Boolean(agent) && !visited.has(agent!.id));
    }
    const detached = agents.filter((agent) => !visited.has(agent.id));
    if (detached.length) rows.push(detached);
    return rows;
  }, [agents, edges, mainAgentId]);

  const { t } = useTranslation();
  if (!agents.length) return <div className="company-chart-empty"><strong>{t("companySettings.orgChart.emptyTitle")}</strong><p>{t("companySettings.orgChart.emptyDesc")}</p></div>;
  return <div className="company-org-chart" key={animationKey}>
    {levels.map((level, index) => <div className="company-chart-level" key={index} style={{ "--chart-level-delay": `${Math.max(0, index - 1) * 1.5}s`, "--chart-line-inset": `calc(${50 / level.length}% - ${((level.length - 1) * 24) / (2 * level.length)}px)` } as CSSProperties}>
      {index > 0 && <span className="company-chart-trunk" aria-hidden="true" />}
      <div className="company-chart-row">
        {index > 0 && level.map((agent, nodeIndex) => {
          const targetPercent = ((nodeIndex + .5) * 100) / level.length;
          const targetOffset = ((2 * nodeIndex - level.length + 1) * 24) / (2 * level.length);
          return <i className="company-chart-branch-pulse" key={`pulse-${agent.id}`} style={{ "--chart-pulse-target": `calc(${targetPercent}% + ${targetOffset}px)` } as CSSProperties} aria-hidden="true" />;
        })}
        {level.map((agent, nodeIndex) => {
          const precedingAgentCount = levels.slice(1, index).reduce((count, row) => count + row.length, 0);
          const cardDelay = Math.max(0, levels.length - 2) * 1.5 + 2.1 + (precedingAgentCount + nodeIndex) * .18;
          return <span className="company-chart-node-slot" key={agent.id} style={{ "--chart-card-delay": `${cardDelay}s` } as CSSProperties}><AgentNode agent={agent} main={agent.id === mainAgentId} model={agent.modelId ? modelById.get(agent.modelId) : undefined} working={workingAgentIds.has(agent.id)} onClick={() => onSelect(agent)} /></span>;
        })}
      </div>
    </div>)}
  </div>;
}
