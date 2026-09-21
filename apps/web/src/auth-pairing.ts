export async function waitForPairingCompletion(
  poll: () => Promise<boolean>,
  intervalMs: number,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await poll()) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(intervalMs, 100), remainingMs)));
  }
}
