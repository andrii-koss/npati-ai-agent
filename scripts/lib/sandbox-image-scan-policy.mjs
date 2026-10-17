/** Strict scanner output parsing: malformed or unknown reports are never evidence of a clean image. */
export function parseScanJson(tool, raw) {
  const report = JSON.parse(raw);
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Invalid scan report");
  const counts = { critical: 0, high: 0 };
  const add = value => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Missing vulnerability severity");
    const severity = value.toUpperCase();
    if (severity === "CRITICAL") counts.critical++;
    if (severity === "HIGH") counts.high++;
  };
  if (tool === "trivy") {
    if (!Array.isArray(report.Results)) throw new Error("Missing Trivy Results array");
    for (const result of report.Results) {
      if (!result || typeof result !== "object") throw new Error("Invalid Trivy result");
      if (result.Vulnerabilities == null) continue;
      if (!Array.isArray(result.Vulnerabilities)) throw new Error("Invalid Trivy vulnerabilities");
      for (const vulnerability of result.Vulnerabilities) add(vulnerability?.Severity);
    }
  } else if (tool === "grype") {
    if (!Array.isArray(report.matches)) throw new Error("Missing Grype matches array");
    for (const match of report.matches) add(match?.vulnerability?.severity);
  } else throw new Error("Unsupported vulnerability scanner");
  return counts;
}

/** Common publication gate for scan, sign and catalog verification scripts. */
export function imageScanPolicyErrors(scan, waiver, now = Date.now(), maxAgeDays = 14) {
  const problems = [];
  if (!scan || !Number.isSafeInteger(scan.critical) || scan.critical < 0 ||
      !Number.isSafeInteger(scan.high) || scan.high < 0) return ["invalid_scan_counts"];
  if (typeof scan.tool !== "string" || !scan.tool.trim()) problems.push("missing_scan_tool");
  const scannedAt = typeof scan.at === "string" ? Date.parse(scan.at) : NaN;
  const age = (now - scannedAt) / 86_400_000;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeDays) problems.push("invalid_scan_age");
  if (scan.critical > 0) problems.push("critical_findings");
  if (scan.high > 0) {
    const expiry = typeof waiver?.expiresAt === "string" ? Date.parse(waiver.expiresAt) : NaN;
    if (typeof waiver?.owner !== "string" || !waiver.owner.trim() ||
        typeof waiver?.reason !== "string" || !waiver.reason.trim() || !Number.isFinite(expiry))
      problems.push("incomplete_high_waiver");
    else if (expiry <= now) problems.push("expired_high_waiver");
  }
  return problems;
}
