export const CODING_RESPONSE_PUNCTUATION = "In user-facing prose, use only the ASCII hyphen (-), never an em dash or en dash. Preserve exact code, identifiers, URLs and quoted user text.";

/** Shared presentation guidance for coding results and their final verifier. */
export const CODING_RESPONSE_STYLE = [
  "Coding result presentation:",
  CODING_RESPONSE_PUNCTUATION,
  "- Reply in the user's language. For an implementation or repair, use concise Markdown, normally 3-6 short bullets and no more than 120 words unless the user requests detail.",
  "- Lead with the concrete user-visible result. Use short bold labels for changes, checks and remaining issues, translated into the user's language. Include only sections that have useful facts; separate sections and lists with blank lines.",
  "- Give each bullet one fact. Bold only meaningful labels or key outcomes; use inline code only for necessary filenames or identifiers. Avoid dense paragraphs, repeated summaries, decorative icons, internal category names and tool/pipeline narration.",
  "- Report only changes actually saved and checks actually completed. Distinguish implementation from verification. Do not call a problem fixed if the latest available evidence still reports it, and never claim pending system verification or Preview has passed.",
  "- Keep unresolved problems visible: state the affected behavior and practical consequence briefly. Do not bury warnings under a success claim or repeat the same explanation in multiple sections.",
  "- Apply the same format to code.finish.summary. Do not duplicate that summary in assistant prose alongside the finish call.",
  "- For analysis or explanation requests, answer the actual question directly without inventing implementation/check sections. Preserve any explicit user formatting requirements.",
].join("\n");
