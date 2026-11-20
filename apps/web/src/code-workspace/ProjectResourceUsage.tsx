import { ChartNoAxesColumn } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { apiGet } from "../code-workspace-page-types";

type Sample = { at: number; cpu: number | null; memoryMiB: number | null; networkBps: number };
const ranges = [15, 60, 360, 1440] as const;
type Range = typeof ranges[number];
const memory = (value: number) => value >= 1024 ? `${+(value / 1024).toFixed(1)} GiB` : `${value} MiB`;
const network = (value: number) => value >= 1000000 ? `${+(value / 1000000).toFixed(1)} MB/s`
  : value >= 1000 ? `${+(value / 1000).toFixed(1)} KB/s` : `${value} B/s`;

function ResourceCard({ name, color, samples, field, format, max, range, note, centerNote, limit }: {
  name: string; color: string; samples: Sample[]; field: "cpu" | "memoryMiB" | "networkBps";
  format: (value: number) => string; max: number; range: Range; note: string | null; centerNote: boolean; limit?: number;
}) {
  const fillId = useId();
  const end = Date.now();
  const start = end - range * 60000;
  const maximumGap = (range === 1440 ? 15 : range === 360 ? 5 : 1) * 90000;
  const lines: [number, number][][] = [];
  let lastAt = 0;
  for (const sample of samples) {
    const value = sample[field];
    if (value === null) { lastAt = 0; continue; }
    if (sample.at - lastAt > maximumGap) lines.push([]);
    const x = Math.max(0, (sample.at - start) / (end - start)) * 300;
    lines.at(-1)?.push([x, 76 - (value / max) * 72]);
    lastAt = sample.at;
  }
  const latest = samples.at(-1)?.[field];
  return <article className={`overview-card workspace-production-card workspace-resource-card ${color}`} aria-label={name}>
    <h4>{name}</h4>
    <div className="workspace-resource-value">
      {latest == null ? "—" : format(latest)}
      {limit && latest != null ? <small> / {format(limit)}</small> : null}
    </div>
    {lines.length ? <div className="workspace-resource-plot">
      <svg viewBox="0 0 300 80" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity=".19" />
            <stop offset="100%" stopColor="currentColor" stopOpacity=".03" />
          </linearGradient>
        </defs>
        {[4, 40, 76].map(y => <line className="workspace-resource-gridline" key={y} x1="0" x2="300" y1={y} y2={y} />)}
        {lines.map((line, index) => {
          const points = line.map(([x, y]) => `${x},${y}`).join(" ");
          return <g key={index}>
            <polygon fill={`url(#${fillId})`} points={`${line[0]![0]},76 ${points} ${line.at(-1)![0]},76`} />
            <polyline points={points} vectorEffect="non-scaling-stroke" />
            {line.length === 1 && <circle cx={line[0]![0]} cy={line[0]![1]} r="2" />}
          </g>;
        })}
      </svg>
      <div className="workspace-resource-scale" aria-hidden="true">
        {[1, 0.5, 0].map(value => <span key={value}>{format(Math.round(max * value))}</span>)}
      </div>
    </div> : <div className="workspace-resource-empty">
      {note && <p className={centerNote ? "workspace-production-muted workspace-resource-note-centered" : "workspace-production-muted"}>{note}</p>}
    </div>}
  </article>;
}

export function ProjectResourceUsage({ base, kind, memoryLimit, isUk }: {
  base: string; kind?: "static" | "node" | null; memoryLimit?: number; isUk: boolean;
}) {
  const t = (uk: string, en: string) => isUk ? uk : en;
  const [range, setRange] = useState<Range>(15);
  const [reading, setReading] = useState<{ range: Range; samples: Sample[] }>();
  const [failure, setFailure] = useState<{ range: Range; message: string }>();
  useEffect(() => {
    if (!base || !kind) return;
    let active = true;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const data = await apiGet<{ points?: Sample[] }>(`${base}?metrics=${range}`);
        if (active) {
          setReading({ range, samples: data.points ?? [] });
          setFailure(undefined);
        }
      } catch (error) {
        if (active) setFailure({ range, message: String(error) });
      } finally { pending = false; }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [base, kind, range]);

  const displayed = kind ? reading : undefined;
  const shownRange = displayed?.range ?? range;
  const samples = displayed?.samples ?? [];
  const error = kind && failure?.range === range ? failure.message : null;
  const waiting = Boolean(kind && displayed?.range !== range && !error);
  const note = kind === null ? t("Дані з’являться після публікації.", "Metrics appear after publication.")
    : kind && displayed?.range === range && !error ? t("За цей період даних немає.", "No samples in this time range.") : null;
  const workloadNote = kind === "static" ? t("Статичний сайт не має окремого процесу.", "Static sites share the server process.") : note;
  const labels = isUk ? ["15 хв", "1 год", "6 год", "24 год"] : ["15 min", "1 hour", "6 hours", "24 hours"];
  const maxNetwork = Math.max(1000, 10 ** Math.ceil(Math.log10(Math.max(1, ...samples.map(sample => sample.networkBps)))));
  return <section className="workspace-resource-section" aria-labelledby="project-resource-heading">
    <div className="inspector-controls automations-controls workspace-resource-toolbar">
      <h3 id="project-resource-heading"><ChartNoAxesColumn aria-hidden="true" />{t("Використання ресурсів", "Resource usage")}</h3>
      <div className="inspector-tabs workspace-resource-ranges" role="group" aria-label={t("Період графіків", "Chart range")}>
        {ranges.map((minutes, index) => <button type="button" className={`inspector-tab workspace-production-button${range === minutes ? " active" : ""}`} key={minutes}
          aria-pressed={range === minutes} onClick={() => {
            if (range === minutes) return;
            setFailure(undefined);
            setRange(minutes);
          }}>{labels[index]}</button>)}
      </div>
    </div>
    {error && <p role="status" className="workspace-production-error">{error}</p>}
    <div className="workspace-resource-grid" aria-busy={waiting}>
      <ResourceCard name="CPU" color="cpu" samples={samples} field="cpu" format={value => `${value}%`}
        max={Math.max(100, ...samples.map(sample => sample.cpu ?? 0))} range={shownRange} note={workloadNote} centerNote={kind !== "node"} />
      <ResourceCard name={t("Пам’ять", "Memory")} color="memory" samples={samples} field="memoryMiB" format={memory}
        max={Math.max(memoryLimit ?? 1024, ...samples.map(sample => sample.memoryMiB ?? 0))} range={shownRange} note={workloadNote}
        centerNote={kind !== "node"} limit={memoryLimit} />
      <ResourceCard name={t("Мережа · вихідний HTTP", "Network · outbound HTTP")} color="network" samples={samples} field="networkBps" format={network}
        max={maxNetwork} range={shownRange} note={note} centerNote={kind === null} />
    </div>
  </section>;
}
