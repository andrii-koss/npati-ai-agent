const minute = 60000;
const day = 1440 * minute;

export function sampleMetrics(record, app, now = Date.now()) {
  const previous = record.lastSample;
  const usage = app?.isRunning() ? app.usage() : null;
  record.lastSample = { app, usage, at: now, bytes: record.responseBytes };
  const elapsed = now - (previous?.at ?? now);
  if (elapsed <= 0 || elapsed > minute) return;

  const at = Math.floor(now / minute) * minute;
  const bucket = record.metrics[at] ??= { seconds: 0, bytes: 0, cpuMs: 0, cpuCapacityMs: 0, memorySum: 0, memorySamples: 0 };
  bucket.seconds += elapsed / 1000;
  bucket.bytes += record.responseBytes - previous.bytes;
  if (usage && previous.usage && app === previous.app) {
    bucket.cpuMs += usage.cpuUsed - previous.usage.cpuUsed;
    bucket.cpuCapacityMs += elapsed * record.release.settings.limits.cpu;
    bucket.memorySum += usage.rss / 1048576;
    bucket.memorySamples++;
  }
  for (const time of Object.keys(record.metrics)) {
    if (+time > now - day) break;
    delete record.metrics[time];
  }
}

export function metricHistory(metrics, minutes, now = Date.now()) {
  const interval = (minutes === 1440 ? 15 : minutes === 360 ? 5 : 1) * minute;
  const start = Math.floor((now - minutes * minute) / minute) * minute;
  const groups = new Map();
  for (const [time, bucket] of Object.entries(metrics)) {
    if (+time < start) continue;
    const at = start + Math.floor((+time - start) / interval) * interval;
    const group = groups.get(at) ?? {};
    for (const [key, value] of Object.entries(bucket)) group[key] = (group[key] ?? 0) + value;
    groups.set(at, group);
  }
  return [...groups].map(([at, bucket]) => ({
    at,
    cpu: bucket.cpuCapacityMs ? Math.round(1000 * bucket.cpuMs / bucket.cpuCapacityMs) / 10 : null,
    memoryMiB: bucket.memorySamples ? Math.round(bucket.memorySum / bucket.memorySamples) : null,
    networkBps: Math.round(bucket.bytes / bucket.seconds),
  }));
}
