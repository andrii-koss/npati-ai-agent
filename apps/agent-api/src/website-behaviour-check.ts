import type { BrowserQaAction, BrowserQaInteraction } from "@npati/workspace";
import type { BrowserQaReportResult } from "./project-browser-qa-service";

/**
 * Behaviour check for requests that must keep behaviour ("винеси картку в компонент без зміни поведінки", "refactor").
 *
 * V6 step 05: extracting ProductCard passed `onAdd={changeQty}` and called `onAdd(item.id)`; "Додати" stopped adding
 * to the cart. The build passed, self-review said clean, and the run reported "works as before". A build cannot see
 * behaviour, so before such a run the live app's buttons are clicked in a fixed order and what the page shows after
 * each click is recorded; after the run the same clicks are repeated and any difference is a finding the agent repairs.
 */

const BEHAVIOUR_KEEPING = new RegExp([
  "без\\s+змін\\p{L}*\\s+(?:поведінк|функціонал|логік)",
  "не\\s+змінюючи\\s+(?:поведінк|функціонал|логік)",
  "поведінк\\p{L}*\\s+(?:не\\s+змін|залиш|збереж)",
  "без\\s+изменени\\p{L}*\\s+(?:поведени|функционал|логик)",
  "не\\s+меняя\\s+(?:поведени|функционал|логик)",
  "рефактор\\p{L}*", "refactor\\p{L}*",
  "(?:вин(?:е|о)с\\p{L}*|виділ\\p{L}*|вынес\\p{L}*|выдел\\p{L}*|extract\\p{L}*|move)\\s+[^.!?\\n]{0,80}\\s+(?:в|у|into|to)\\s+(?:окрем\\p{L}*\\s+|отдельн\\p{L}*\\s+|нов\\p{L}*\\s+|a\\s+|its\\s+own\\s+|new\\s+)?(?:компонент|модуль|функці|файл|component|module|function|hook|хук)",
  "(?:keep|preserv\\p{L}*)\\s+(?:the\\s+)?(?:same\\s+)?behaviou?r", "without\\s+changing\\s+(?:the\\s+)?behaviou?r",
].join("|"), "iu");

export function requestsBehaviourKeeping(message: string): boolean {
  return BEHAVIOUR_KEEPING.test(message);
}

export interface BehaviourStep { label: string; selector: string; text: string; canvasHash?: string; status: string }
export interface BehaviourBaseline { steps: BehaviourStep[]; actions: BrowserQaAction[] }
export type BehaviourInspect = (actions: BrowserQaAction[]) => Promise<Pick<BrowserQaReportResult, "metrics">>;

const MAX_BUTTONS = 7;
const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

/** One click per distinct visible, enabled button label, each followed by a short wait; at most 16 actions in total. */
export function behaviourActions(buttons: ReadonlyArray<{ label: string; disabled?: boolean }>): { actions: BrowserQaAction[]; labels: string[] } {
  const labels: string[] = [];
  for (const button of buttons) {
    const label = button.label.trim();
    if (button.disabled || !label || label.length > 60 || /["\\\n]/.test(label) || labels.includes(label)) continue;
    labels.push(label);
    if (labels.length === MAX_BUTTONS) break;
  }
  const actions: BrowserQaAction[] = [];
  for (const label of labels) actions.push({ type: "click", selector: `:nth-match(button:has-text("${label}"), 1)` }, { type: "wait", durationMs: 300 });
  return { actions, labels };
}

function traceOf(result: Awaited<ReturnType<BehaviourInspect>>): BrowserQaInteraction[] {
  return (result.metrics as { interactionTrace?: BrowserQaInteraction[] } | undefined)?.interactionTrace ?? [];
}

function stepsOf(trace: BrowserQaInteraction[], labels: string[], actions: BrowserQaAction[]): BehaviourStep[] {
  const steps: BehaviourStep[] = [];
  trace.forEach((entry, index) => {
    if (actions[index]?.type !== "click") return;
    const after = (entry as { after?: { text?: string; canvasHash?: string } }).after ?? {};
    steps.push({ label: labels[steps.length] ?? String(index), selector: (actions[index] as { selector: string }).selector,
      text: normalise(after.text ?? ""), ...(after.canvasHash ? { canvasHash: after.canvasHash } : {}), status: String((entry as { status?: string }).status ?? "unknown") });
  });
  return steps;
}

/** Records the app's behaviour before the run: which buttons exist and what the page shows after clicking each one. */
export async function captureBehaviour(inspect: BehaviourInspect): Promise<BehaviourBaseline | undefined> {
  const discovery = traceOf(await inspect([{ type: "wait", durationMs: 200 }]));
  const buttons = (discovery[0] as { before?: { buttons?: Array<{ label: string; disabled?: boolean }> } } | undefined)?.before?.buttons ?? [];
  const { actions, labels } = behaviourActions(buttons);
  if (!actions.length) return undefined;
  const steps = stepsOf(traceOf(await inspect(actions)), labels, actions);
  return steps.length ? { steps, actions } : undefined;
}

/** The part of two texts that differs, with a little context, so a finding names what changed and not the whole page. */
export function textDifference(before: string, after: string, context = 40): { before: string; after: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const from = Math.max(0, start - context);
  return { before: before.slice(from, Math.min(before.length, endBefore + context)), after: after.slice(from, Math.min(after.length, endAfter + context)) };
}

/** Repeats the same clicks on the new version and names every button whose result differs from before the run. */
export interface BehaviourFinding { message: string; fix: string; label: string; before: string; after: string }

export async function compareBehaviour(baseline: BehaviourBaseline, inspect: BehaviourInspect): Promise<{ findings: BehaviourFinding[]; checked: number }> {
  const labels = baseline.steps.map((step) => step.label);
  const now = stepsOf(traceOf(await inspect(baseline.actions)), labels, baseline.actions);
  const findings: BehaviourFinding[] = [];
  baseline.steps.forEach((step, index) => {
    const current = now[index];
    if (!current || current.status !== step.status) {
      findings.push({ label: step.label, before: step.status, after: current?.status ?? "missing",
        message: `Behaviour changed: clicking the button "${step.label}" ${current ? "now ends with status " + current.status : "is no longer possible"} (before the change: ${step.status}).`,
        fix: "Restore the original behaviour of this control while keeping the requested refactor." });
      return;
    }
    if (current.text !== step.text || (step.canvasHash && current.canvasHash !== step.canvasHash)) {
      const diff = textDifference(step.text, current.text);
      findings.push({ label: step.label, before: diff.before, after: diff.after,
        message: `Behaviour changed: after clicking "${step.label}" the page showed "…${diff.before}…" before the change and now shows "…${diff.after}…".`,
        fix: "The request had to keep behaviour. Compare the moved code with the code it replaced (handlers, props and their arguments) and restore the original result of this click." });
    }
  });
  return { findings: findings.slice(0, 5), checked: baseline.steps.length };
}

/** What the user reads: which control behaves differently, in their language. */
export function behaviourMessage(language: string, outcome: { findings: BehaviourFinding[]; checked: number }): string {
  const uk = language === "uk", ru = language === "ru";
  if (!outcome.findings.length) {
    return uk ? `Перевірка поведінки: ${outcome.checked} кнопок після зміни працюють так само, як до неї.`
      : ru ? `Проверка поведения: ${outcome.checked} кнопок после изменения работают так же, как до него.`
      : `Behaviour check: ${outcome.checked} buttons work the same as before the change.`;
  }
  const head = uk ? "Зміна мала зберегти поведінку, але перевірка в браузері знайшла відмінності, які не вдалося виправити автоматично:"
    : ru ? "Изменение должно было сохранить поведение, но проверка в браузере нашла отличия, которые не удалось исправить автоматически:"
    : "The change had to keep behaviour, but the browser check found differences that could not be fixed automatically:";
  const line = (finding: BehaviourFinding) => uk ? `- Кнопка «${finding.label}»: до зміни після натискання було «…${finding.before}…», тепер «…${finding.after}…».`
    : ru ? `- Кнопка «${finding.label}»: до изменения после нажатия было «…${finding.before}…», теперь «…${finding.after}…».`
    : `- Button "${finding.label}": before the change a click showed "…${finding.before}…", now "…${finding.after}…".`;
  return [head, ...outcome.findings.map(line)].join("\n");
}
