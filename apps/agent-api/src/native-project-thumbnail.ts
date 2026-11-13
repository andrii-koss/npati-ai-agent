import { isDesktopProjectFramework } from "@npati/shared";

/**
 * Projects page thumbnails come from the latest visual Browser QA screenshot. A website or browser game gets one after
 * every chat run (its runtime check), but a mobile app (Expo Web, Flutter web) and a Pygame game (streamed window) never
 * had a check, so their cards stayed empty (V6 step 09). After a run that changed them, their Preview is started and
 * photographed in the background; the reply does not wait (a first Flutter web compile takes minutes).
 */
export function needsNativeThumbnail(
  project: { type?: string | null; kind?: string | null; framework?: string | null },
  result: unknown,
): boolean {
  const view = result as { status?: unknown; summary?: { filesChanged?: unknown } } | null;
  if (view?.status !== "completed") return false;
  if (!Array.isArray(view.summary?.filesChanged) || view.summary!.filesChanged.length === 0) return false;
  return project.type === "mobile_app" || project.kind === "mobile_app" || isDesktopProjectFramework(project.framework);
}

export function captureNativeThumbnail(input: {
  project: { status?: string | null };
  startPreview(): Promise<unknown>;
  screenshot(): Promise<unknown>;
  warn(error: unknown): void;
}): Promise<void> {
  return (async () => {
    if (input.project.status !== "previewing") await input.startPreview();
    await input.screenshot();
  })().catch(error => input.warn(error));
}
