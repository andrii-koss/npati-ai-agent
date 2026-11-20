import { useEffect, useState } from "react";
import { apiGet } from "./code-workspace-page-types";
import { productionEndpoint, type ProductionLimits, type ProductionStatus } from "./code-workspace/project-production";

export type ProductionCapabilities = { enabled: false } | {
  enabled: true; defaults: ProductionLimits; tlsEnabled: boolean; automaticDomain: boolean; automaticDomainIsLocal: boolean;
};

export function projectDomain(value: string) {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!host || /[\s/:@\\?#%]/u.test(host)) return host;
  try { return new URL(`http://${host}`).hostname; } catch { return host; }
}

export function useProductionCapabilities(companyId: string) {
  const [result, setResult] = useState<{ companyId: string; value: ProductionCapabilities }>();
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    void apiGet<ProductionCapabilities>(`/api/companies/${encodeURIComponent(companyId)}/projects/production/capabilities`).then(value => {
      if (active) setResult({ companyId, value });
    }, () => { if (active) setResult({ companyId, value: { enabled: false } }); });
    return () => { active = false; };
  }, [companyId]);
  return companyId && result?.companyId === companyId ? result.value : null;
}

export function ProductionDomainProof({ companyId, projectId, domain, currentDomains, automaticDomain, isUk }: {
  companyId: string; projectId: string; domain: string; currentDomains: (string | undefined)[]; automaticDomain?: string; isUk: boolean;
}) {
  const host = projectDomain(domain);
  const scope = productionEndpoint(companyId, projectId);
  const [record, setRecord] = useState<{ key: string; name: string; value: string }>();
  const key = `${scope}:${host}`;
  const hasDomain = currentDomains.includes(host) || host === automaticDomain;
  useEffect(() => {
    if (!projectId || !host || hasDomain || host.endsWith(".localhost")) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGet<ProductionStatus>(`${scope}?domain=${encodeURIComponent(host)}`).then(result => {
        if (active && result.enabled && result.proof) setRecord({ key, ...result.proof });
      }, () => {});
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [hasDomain, host, key, projectId, scope]);
  if (record?.key !== key || hasDomain) return null;
  return <p className="ds-muted code-production-proof">
    {isUk ? "Підтвердьте домен через DNS TXT" : "Verify the domain with a DNS TXT record"} <code>{record.name}</code> = <code>{record.value}</code>
  </p>;
}
