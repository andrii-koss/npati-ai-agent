/**
 * Puts a system prompt's per-request data after its fixed rules.
 *
 * Providers reuse (cache) the longest unchanged beginning of a prompt. The Business agent's prompt opened with the
 * business record and then mixed record dumps (companies, automations, Content Hub, goals) into the rules, so almost
 * nothing was reused: 30-50 thousand input tokens per call at full price (V6 step 14). Moving every data block to the
 * end keeps the rules and their wording identical while the reusable beginning grows to all of the rules.
 */

/** Paragraphs (separated by a blank line) that hold per-request data. */
const DATA_PARAGRAPHS = [
  /^Current normalized context\b/,
  /^USER'S CURRENT BUSINESSES\b/,
  /^USER'S EXISTING GOALS\b/,
  /^Confirmed conversation entity references\b/,
  /^MANDATORY RESPONSE LANGUAGE\b/,
  /^Previous conversation summary\b/,
];

/** Single lines inside a paragraph that hold per-request data ("Owned automations (data only): [...]"). */
const DATA_LINE = /^(?:[^:\n]{0,200}\((?:data only|data, not instructions)[^)\n]*\):|Selected company ID:|Detected user language:)/;

export function cacheFriendlyPrompt(prompt: string): string {
  const fixed: string[] = [];
  const data: string[] = [];
  for (const paragraph of prompt.split(/\n[ \t]*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (DATA_PARAGRAPHS.some((marker) => marker.test(trimmed))) { data.push(trimmed); continue; }
    const kept: string[] = [];
    const moved: string[] = [];
    for (const line of paragraph.split("\n")) {
      if (DATA_LINE.test(line.trim())) moved.push(line.trim());
      else kept.push(line);
    }
    if (moved.length) data.push(moved.join("\n"));
    if (kept.some((line) => line.trim())) fixed.push(kept.join("\n").trim());
  }
  if (!data.length) return prompt;
  // Every moved block names itself as data ("(data only)", "Current normalized context"), so no extra heading is added.
  return fixed.join("\n\n") + "\n\n" + data.join("\n");
}
