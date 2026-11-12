import { dailySeries, formatDuration, type HomeMetrics as Metrics } from '../domain/home';
import type { WorkflowRun } from '../platform/wire';
import { isActiveRun } from '../domain/work';

function Spark(props: { values: readonly number[]; tone: 'accent' | 'warning' | 'muted' }) {
  const max = Math.max(...props.values, 1);
  const pts = props.values.map((v, i) => `${(i / Math.max(props.values.length - 1, 1)) * 200},${24 - (v / max) * 20}`).join(' ');
  return (
    <svg className="spark" data-tone={props.tone} viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" strokeWidth="2" />
    </svg>
  );
}

/** Four figures from real run records, each with a 7-day line drawn from the runs' own timestamps. */
export function HomeMetrics(props: { metrics: Metrics; runs: readonly WorkflowRun[] }) {
  const m = props.metrics;
  const finished = (d: readonly WorkflowRun[]) => d.filter((r) => !isActiveRun(r));
  const perDay = dailySeries(props.runs, (d) => d.length);
  const okPerDay = dailySeries(props.runs, (d) =>
    finished(d).length === 0 ? 0 : finished(d).filter((r) => r.status === 'succeeded').length / finished(d).length,
  );
  const waitPerDay = dailySeries(props.runs, (d) => d.filter((r) => r.status === 'waiting_for_human').length);
  const msPerDay = dailySeries(props.runs, (d) => {
    const xs = finished(d)
      .flatMap((r) => (r.completedAt === undefined ? [] : [Date.parse(r.completedAt) - Date.parse(r.createdAt)]))
      .filter((n) => n >= 0);
    return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  });
  const items = [
    { label: 'Runs', value: String(m.total), note: 'Last 7 days below', series: perDay, tone: 'accent' as const },
    {
      label: 'Success rate',
      value: m.successPercent === undefined ? '—' : `${m.successPercent}%`,
      note: m.successPercent === undefined ? 'No finished runs yet' : `${m.succeeded} of ${m.finished} finished`,
      series: okPerDay,
      tone: 'accent' as const,
    },
    {
      label: 'Median duration',
      value: m.medianMs === undefined ? '—' : formatDuration(m.medianMs),
      note: m.medianMs === undefined ? 'No finished runs yet' : 'Start to finish',
      series: msPerDay,
      tone: 'warning' as const,
    },
    { label: 'Awaiting a decision', value: String(m.waiting), note: 'Need a person', series: waitPerDay, tone: 'muted' as const },
  ];
  return (
    <ul className="metrics plain" aria-label="Activity at a glance">
      {items.map((i) => (
        <li key={i.label} className="metric">
          <span className="metric-label">{i.label}</span>
          <span className="metric-value">{i.value}</span>
          <span className="metric-note">{i.note}</span>
          <Spark values={i.series} tone={i.tone} />
        </li>
      ))}
    </ul>
  );
}
