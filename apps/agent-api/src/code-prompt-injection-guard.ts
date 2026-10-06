import { PromptInjectionGuard } from "./security-guardrails";

/**
 * C5: repository content is DATA.
 *
 * Files inside a workspace (README, NPATI.md, AGENTS.md, `.npati/**`, any source file) and any web
 * result are untrusted input. This module extracts instruction candidates from them and classifies
 * the ones that try to *change policy* — mode, approvals, network allowlist, trust, tool list or the
 * system prompt. Classification is pure: it returns a report and mutates no state at all, so a
 * malicious file cannot widen permissions by being read. Only an explicit owner/admin trust record
 * (see `code-project-trust.ts`) can make repository instructions usable as *content*, and even then
 * policy-mutation attempts stay rejected.
 */

export interface RepositoryFileLike {
  path: string;
  content: string;
}

export interface RepositoryInstructionCandidate {
  path: string;
  text: string;
  /** True for files that conventionally carry agent instructions. */
  conventional: boolean;
}

export interface PolicyMutationAttempt {
  path: string;
  rule: string;
  evidence: string;
  riskScore: number;
}

export interface RepositoryInstructionReport {
  trusted: boolean;
  candidates: RepositoryInstructionCandidate[];
  policyMutationAttempts: PolicyMutationAttempt[];
  notes: string[];
  /** Rejected text is kept only as data for the operator; it is never applied. */
  appliedPolicyChanges: never[];
}

const CONVENTIONAL_PATHS = [/^npati\.md$/i, /^agents\.md$/i, /^claude\.md$/i, /^\.cursorrules$/i, /^\.github\/copilot-instructions\.md$/i, /^\.npati\//i];

/** Patterns that try to move policy, not content. Order matters only for reporting. */
const POLICY_MUTATION_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "mode_change", pattern: /\b(set|switch|change)\s+(the\s+)?(session\s+)?mode\s+(to\s+)?\b(full_auto|auto_edit|auto|ask|plan|edit)\b/i },
  { rule: "mode_change", pattern: /\b(enable|activate)\s+(full[\s_-]?auto|yolo)\s*(mode)?\b/i },
  { rule: "instruction_override", pattern: /\bignore\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions?|rules?|prompts?)\b/i },
  { rule: "instruction_override", pattern: /\bdisregard\s+(all\s+)?(previous|prior|safety|system)\b/i },
  { rule: "approval_bypass", pattern: /\b(disable|skip|bypass|ignore)\s+(the\s+)?(approvals?|approval\s+requirement|confirmations?)\b/i },
  { rule: "approval_bypass", pattern: /\bno\s+(approval|confirmation)\s+(is\s+)?(needed|required)\b/i },
  { rule: "network_change", pattern: /\ballow\s+(network|internet|egress|outbound)\b/i },
  { rule: "network_change", pattern: /\b(add|allow|whitelist|allowlist)\s+(the\s+)?(host|hosts|domain|domains|url)\b/i },
  { rule: "network_change", pattern: /\b(disable|turn\s+off)\s+(the\s+)?(firewall|egress\s+proxy|network\s+isolation)\b/i },
  { rule: "trust_change", pattern: /\btrust\s+(this|the)\s+(project|repo|repository)\b/i },
  { rule: "trust_change", pattern: /\bmark\s+(this\s+)?(project|repo)\s+(as\s+)?trusted\b/i },
  { rule: "tool_change", pattern: /\b(grant|enable|add)\s+(yourself\s+)?(the\s+)?(tool|tools|capabilit(y|ies))\b/i },
  // "grant yourself the code.shell tool" / "you may now use the shell" — an identifier between the
  // article and the noun slipped past the stricter pattern above, which is a real detection gap.
  { rule: "tool_change", pattern: /\b(grant|give)\s+(yourself|me|the\s+agent)\b[^.\n]{0,40}\b(tool|tools|capabilit(y|ies)|permissions?)\b/i },
  { rule: "tool_change", pattern: /\b(grant|enable|add|activate)\s+(yourself\s+)?(the\s+)?[a-z0-9_.@/-]{0,40}\s(tool|tools|capabilit(y|ies))\b/i },
  { rule: "tool_change", pattern: /\byou\s+(may|can|should)\s+now\s+(use|run|execute|access)\b/i },
  { rule: "system_prompt", pattern: /\b(system\s+prompt|developer\s+message|hidden\s+instructions?)\b/i },
  { rule: "role_hijack", pattern: /\byou\s+are\s+now\b|\bfrom\s+now\s+on\s+you\b|\bact\s+as\s+(the\s+)?(admin|owner|system)\b/i },
  { rule: "secret_exfiltration", pattern: /\b(print|reveal|send|expose|leak)\s+(the\s+)?(secret|token|api[\s_-]?key|credential)s?\b/i },
];

/** Files that conventionally carry instructions, plus any file that reads like one. */
export function extractRepositoryInstructions(files: RepositoryFileLike[]): RepositoryInstructionCandidate[] {
  const candidates: RepositoryInstructionCandidate[] = [];
  for (const file of files) {
    if (!file || typeof file.content !== "string") continue;
    const path = String(file.path ?? "");
    const conventional = CONVENTIONAL_PATHS.some((pattern) => pattern.test(path));
    const looksLikeInstructions = /(^|\/)(readme|instructions|guidelines)\.(md|txt)$/i.test(path) ||
      /\b(you are|your task|instructions|must|always|never)\b/i.test(file.content.slice(0, 4000));
    if (!conventional && !looksLikeInstructions) continue;
    candidates.push({ path, text: file.content, conventional });
  }
  return candidates;
}

export interface ClassifiedInstruction {
  policyMutationAttempts: PolicyMutationAttempt[];
  injection: { safe: boolean; riskScore: number; reason?: string; matchedPatterns?: string[] };
  notes: string[];
}

/**
 * Classify one piece of repository text. Pure: no state, no I/O, nothing applied.
 */
export function classifyRepositoryInstruction(path: string, text: string): ClassifiedInstruction {
  const attempts: PolicyMutationAttempt[] = [];
  const injection = PromptInjectionGuard.analyze(text);
  for (const rule of POLICY_MUTATION_RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      attempts.push({ path, rule: rule.rule, evidence: match[0].slice(0, 120), riskScore: Math.max(injection.riskScore, 0.8) });
    }
  }
  const notes: string[] = [];
  if (attempts.length > 0) {
    notes.push("Policy-mutation attempt detected in repository content; the text is treated as data and is not applied.");
  }
  if (!injection.safe) {
    notes.push(`Prompt injection guard flagged this content (risk ${injection.riskScore.toFixed(2)}): ${injection.reason ?? "no reason given"}`);
  }
  return {
    policyMutationAttempts: attempts,
    injection: { safe: injection.safe, riskScore: injection.riskScore, reason: injection.reason, matchedPatterns: injection.matchedPatterns },
    notes,
  };
}

/**
 * Review repository instructions. `trusted` only controls whether the text may guide the *content*
 * of the work; policy-mutation attempts are reported in every case and never applied.
 */
export function reviewRepositoryInstructions(
  files: RepositoryFileLike[],
  options: { trusted: boolean },
): RepositoryInstructionReport {
  const candidates = extractRepositoryInstructions(files);
  const policyMutationAttempts: PolicyMutationAttempt[] = [];
  const notes: string[] = [];
  for (const candidate of candidates) {
    const classified = classifyRepositoryInstruction(candidate.path, candidate.text);
    policyMutationAttempts.push(...classified.policyMutationAttempts);
    notes.push(...classified.notes);
  }
  if (!options.trusted && candidates.length > 0) {
    notes.push("Project is not trusted: repository instructions are ignored as instructions and used as data only.");
  }
  return { trusted: options.trusted, candidates, policyMutationAttempts, notes, appliedPolicyChanges: [] };
}

/** The invariant the PolicyEngine relies on: reading repository content can never change policy. */
export function repositoryContentCanChangePolicy(): false {
  return false;
}
