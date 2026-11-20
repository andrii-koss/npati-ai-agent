import { useEffect, useRef, useState } from "react";
import { apiGet } from "./code-workspace-page-types";
import { productionEndpoint, type ProductionDomainProofRecord, type ProductionLimits, type ProductionStatus } from "./code-workspace/project-production";

export type ProductionCapabilities = { enabled: false } | {
  enabled: true; defaults: ProductionLimits; tlsEnabled: boolean; automaticDomain: boolean; automaticDomainIsLocal: boolean;
};

export function projectDomain(value: string) {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!host || /[\s/:@\\?#%]/u.test(host)) return host;
  try { return new URL(`http://${host}`).hostname; } catch { return host; }
}

export function useProductionCapabilities(companyId: string, session: number) {
  const [result, setResult] = useState<{ companyId: string; session: number; value: ProductionCapabilities }>();
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    void apiGet<ProductionCapabilities>(`/api/companies/${encodeURIComponent(companyId)}/projects/production/capabilities`).then(value => {
      if (active) setResult({ companyId, session, value });
    }, () => { if (active) setResult({ companyId, session, value: { enabled: false } }); });
    return () => { active = false; };
  }, [companyId, session]);
  const current = result?.session === session ? result : undefined;
  return {
    capabilities: companyId ? current?.value ?? null : null,
    pending: Boolean(companyId && current?.companyId !== companyId),
  };
}

export function ProductionDomainProof({ companyId, projectId, domain, currentDomains, automaticDomain, isUk, editorProofs }: {
  companyId: string; projectId: string; domain: string; currentDomains: (string | undefined)[]; automaticDomain?: string; isUk: boolean;
  editorProofs?: Record<string, ProductionDomainProofRecord>;
}) {
  const host = projectDomain(domain);
  const initialHost = useRef(host);
  const preloaded = editorProofs?.[host];
  const skipLookup = editorProofs !== undefined && (initialHost.current === host || Boolean(preloaded));
  const scope = productionEndpoint(companyId, projectId);
  const [record, setRecord] = useState<{ key: string; name: string; value: string }>();
  const key = `${scope}:${host}`;
  const hasDomain = currentDomains.includes(host) || host === automaticDomain;
  useEffect(() => {
    if (!projectId || !host || hasDomain || skipLookup || host.endsWith(".localhost")) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGet<ProductionStatus>(`${scope}?domain=${encodeURIComponent(host)}`).then(result => {
        if (active && result.enabled && result.proof) setRecord({ key, ...result.proof });
      }, () => {});
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [hasDomain, host, key, projectId, scope, skipLookup]);
  const proof = preloaded ?? (record?.key === key ? record : undefined);
  if (!proof || hasDomain) return null;
  return <p className="ds-muted code-production-proof">
    {isUk ? "Підтвердьте домен через DNS TXT" : "Verify the domain with a DNS TXT record"} <code>{proof.name}</code> = <code>{proof.value}</code>
  </p>;
}
