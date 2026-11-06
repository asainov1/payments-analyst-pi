import { useEffect, useState } from "react";
import { api, readSse, type VersionRow } from "../api.ts";

const pct = (v?: number) => (v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const usd = (v?: number) => (v === undefined ? "—" : `$${v.toFixed(4)}`);

function Gate({ m }: { m: VersionRow["metrics"] }) {
  const g = m?.gate;
  if (!g) return <>{m?.reject_reason ?? "—"}</>;
  return (
    <>
      <strong>{g.decision}</strong>: {g.reason}
      {g.cand_correct !== undefined && (
        <div className="muted">
          {g.cand_correct.toFixed(1)} vs parent {g.parent_correct?.toFixed(1)} · wins {g.wins} / losses {g.losses} · confirmed {g.confirmed_wins} (T={g.threshold_T})
          {g.easy_regressions ? ` · easy regressions ${g.easy_regressions}` : ""}
          {g.cand_cost_per_task !== undefined && ` · $/task ${usd(g.cand_cost_per_task)} vs ${usd(g.parent_cost_per_task)}`}
        </div>
      )}
    </>
  );
}

export function Improvements() {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [best, setBest] = useState("");
  const [diff, setDiff] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generations, setGenerations] = useState(2);
  const [budgetUsd, setBudgetUsd] = useState(5);
  const [run, setRun] = useState<{ id: string; done: number; total: number; stage?: string; status: string } | null>(null);

  const load = () =>
    api.versions().then((r) => { setVersions(r.versions); setBest(r.best); setError(null); }).catch((e) => setError(String(e)));

  // Improve runs may be started from the CLI (another process), so the table refreshes on its own.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  async function showDiff(id: string) {
    try { setDiff({ id, text: await api.diff(id) }); } catch (e) { setError(String(e)); }
  }

  async function promote(id: string) {
    if (!confirm(`Serve ${id} as best? (manual promote / rollback)`)) return;
    try { setBest((await api.promote(id)).best); } catch (e) { setError(String(e)); }
  }

  async function improve() {
    try {
      const { run_id } = await api.improve(generations, budgetUsd);
      setRun({ id: run_id, done: 0, total: generations, status: "running" });
      const res = await fetch(`/api/runs/${run_id}/events`);
      for await (const ev of readSse(res)) {
        const d = ev.data as { done?: number; total?: number; stage?: string; status?: string };
        if (ev.type === "progress") setRun((r) => (r ? { ...r, done: d.done ?? r.done, total: d.total ?? r.total, stage: d.stage ?? r.stage } : r));
        if (ev.type === "run.end") setRun((r) => (r ? { ...r, status: d.status ?? "done" } : r));
      }
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="improvements">
      {error && <div className="bad">{error}</div>}

      <section className="card">
        <h3>Run improvement</h3>
        <label>Generations <input type="number" min={1} max={10} value={generations} onChange={(e) => setGenerations(Number(e.target.value))} /></label>
        <label>Budget, USD <input type="number" min={0.5} step={0.5} value={budgetUsd} onChange={(e) => setBudgetUsd(Number(e.target.value))} /></label>
        <button onClick={improve} disabled={run?.status === "running"} data-testid="improve">Start</button>
        {run && <span className="muted" data-testid="run-progress">run {run.id.slice(0, 8)}: {run.stage ? `${run.stage} ` : ""}{run.done}/{run.total} · {run.status}</span>}
      </section>

      <table className="versions" data-testid="versions">
        <thead>
          <tr>
            <th>Version</th><th>Status</th><th>Val</th><th>easy / hard</th><th>$/task</th><th>Cache hit</th>
            <th>p50 / p95</th><th>What changed</th><th>Gate</th><th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const m = v.metrics;
            return (
              <tr key={v.id} className={v.id === best ? "best" : ""}>
                <td><strong>{v.id}</strong>{v.id === best && <span className="tag">best</span>}<div className="muted">{v.parent ? `← ${v.parent}` : "root"}</div></td>
                <td><span className={`status ${v.status}`}>{v.status}</span></td>
                <td>
                  {m?.val ? `${m.val.correct}/${m.val.n} (${pct(m.val.accuracy)})` : "—"}
                  {m?.val?.runs && m.val.runs.length > 1 && <div className="muted">runs {m.val.runs.join(" / ")}</div>}
                </td>
                <td>{m?.val?.by_level ? `${pct(m.val.by_level.easy)} / ${pct(m.val.by_level.hard)}` : "—"}</td>
                <td>{usd(m?.cost_per_task_usd)}</td>
                <td>{pct(m?.cache_hit_rate)}</td>
                <td>{m?.latency_p50_s !== undefined ? `${m.latency_p50_s.toFixed(1)}s / ${m.latency_p95_s?.toFixed(1)}s` : "—"}</td>
                <td className="summary">{v.change_summary}<div className="muted">{v.models?.analyst}{v.thinking ? ` · thinking ${v.thinking}` : ""}</div></td>
                <td className="summary"><Gate m={m} /></td>
                <td className="actions">
                  <button onClick={() => showDiff(v.id)} disabled={!v.parent}>Diff</button>
                  <button onClick={() => promote(v.id)} disabled={v.id === best}>Serve</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {diff && (
        <section className="card">
          <h3>Diff {diff.id} vs parent <button onClick={() => setDiff(null)}>close</button></h3>
          <pre className="diff">
            {diff.text.split("\n").map((l, i) => (
              <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l + "\n"}</span>
            ))}
          </pre>
        </section>
      )}
    </div>
  );
}
