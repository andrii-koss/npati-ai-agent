import React from "react";

export interface ActivityStatsCardsProps {
  totalRunsCount: number;
  completedRunsCount: number;
  activeRunsCount: number;
  totalSecurityDecisions: number;
  t: (key: string, options?: any) => string;
}

export function ActivityStatsCards({
  totalRunsCount,
  completedRunsCount,
  activeRunsCount,
  totalSecurityDecisions,
  t,
}: ActivityStatsCardsProps) {
  return (
    <section className="overview-grid activity-stats-grid">
      <div>
        <strong>{totalRunsCount}</strong>
        <span>{t("activity.stats.totalRuns")}</span>
        <small>{t("activity.stats.totalRunsDesc")}</small>
      </div>
      <div>
        <strong>{completedRunsCount}</strong>
        <span>{t("activity.stats.completed")}</span>
        <small>{t("activity.stats.completedDesc")}</small>
      </div>
      <div>
        <strong>{activeRunsCount}</strong>
        <span>{t("activity.stats.inProgress")}</span>
        <small>{t("activity.stats.inProgressDesc")}</small>
      </div>
      <div>
        <strong>{totalSecurityDecisions}</strong>
        <span>{t("activity.stats.securityDecisions")}</span>
        <small>{t("activity.stats.securityDecisionsDesc")}</small>
      </div>
    </section>
  );
}
