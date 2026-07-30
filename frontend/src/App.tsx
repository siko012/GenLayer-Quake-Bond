import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import * as d3 from "d3";
import {
  fundBond, fileClaim, adjudicate, autoSettle,
  getCase, getCounts, getPoolBalance, listAll,
  QuakeCaseView, QuakeRow,
} from "./contractService";
import { CONTRACT_ADDRESS } from "./chain";

type Hex = `0x${string}`;
const STATUS_LABEL = ["filed", "ruled", "settled"];
const SEVERE_THRESHOLD = 7; // MMI >= 7 = SEVERE_SHAKE
const MODERATE_THRESHOLD = 4;
const PREFERS_REDUCED = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;

function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a || "-";
}
async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); } catch { /* clipboard blocked */ }
}

// Seismograph-style trace: each ruling produces a sharp spike whose height = MMI.
// MMI threshold lines drawn across (4 = moderate trigger, 7 = severe payout trigger).
function SeismographTrace({ rows }: { rows: QuakeRow[] }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const ruled = useMemo(() => rows.filter((r) => r.verdict).slice().reverse(), [rows]);
  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    const W = 720;
    const H = 240;
    const PAD = { l: 38, r: 18, t: 12, b: 22 };
    const xs = d3.scaleLinear().domain([0, Math.max(1, ruled.length * 6 - 1)]).range([PAD.l, W - PAD.r]);
    const ys = d3.scaleLinear().domain([0, 12]).range([H - PAD.b, PAD.t]);

    // grid + threshold lines
    const g = svg.append("g").attr("class", "grid");
    [0, 4, 7, 12].forEach((v) => {
      g.append("line").attr("x1", PAD.l).attr("x2", W - PAD.r).attr("y1", ys(v)).attr("y2", ys(v))
        .attr("class", v === 4 || v === 7 ? "thr-mmi" : "g");
      g.append("text").attr("x", 6).attr("y", ys(v)).attr("dy", "0.35em").attr("class", "gl").text(`MMI ${v}`);
    });
    g.append("text").attr("x", W - PAD.r - 4).attr("y", ys(7) - 6).attr("class", "thrl").attr("text-anchor", "end").text("severe payout (>=7)");
    g.append("text").attr("x", W - PAD.r - 4).attr("y", ys(4) - 6).attr("class", "thrl-warn").attr("text-anchor", "end").text("moderate (>=4)");

    if (ruled.length === 0) {
      svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("class", "empty").attr("text-anchor", "middle")
        .text("No quakes recorded - file the first claim to start the trace.");
      return;
    }

    // Build the seismograph polyline: for each ruling, baseline-spike-baseline pattern.
    type P = { x: number; y: number };
    const pts: P[] = [];
    ruled.forEach((r, i) => {
      const cx = i * 6;
      pts.push({ x: xs(cx), y: ys(0) });
      pts.push({ x: xs(cx + 1), y: ys(0) });
      pts.push({ x: xs(cx + 2), y: ys(r.mmi * 0.7) });
      pts.push({ x: xs(cx + 3), y: ys(r.mmi) });
      pts.push({ x: xs(cx + 4), y: ys(r.mmi * 0.55) });
      pts.push({ x: xs(cx + 5), y: ys(0) });
    });
    const linePath = d3.line<P>().x((d) => d.x).y((d) => d.y).curve(d3.curveLinear);
    const p = svg.append("path").attr("d", linePath(pts) as string).attr("class", "seismo-line");
    const len = (p.node() as SVGPathElement).getTotalLength();
    if (PREFERS_REDUCED) {
      p.attr("stroke-dashoffset", 0);
    } else {
      p.attr("stroke-dasharray", `${len} ${len}`).attr("stroke-dashoffset", len)
        .transition().duration(1100).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0);
    }

    // Peak markers
    svg.append("g").selectAll("circle").data(ruled).join("circle")
      .attr("cx", (_, i) => xs(i * 6 + 3))
      .attr("cy", (d) => ys(d.mmi))
      .attr("r", 3.5)
      .attr("class", (d) => `peak v-${d.verdict}`);
  }, [ruled]);
  return <svg ref={ref} className="area" viewBox="0 0 720 240" preserveAspectRatio="xMidYMid meet" />;
}

function Spark({ values }: { values: number[] }) {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (values.length === 0) return;
    const W = 88, H = 22;
    const xs = d3.scaleLinear().domain([0, Math.max(1, values.length - 1)]).range([0, W]);
    const ys = d3.scaleLinear().domain([0, Math.max(1, d3.max(values) || 1)]).range([H - 1, 1]);
    const a = d3.area<number>().x((_, i) => xs(i)).y0(H).y1((d) => ys(d)).curve(d3.curveMonotoneX);
    svg.append("path").attr("d", a(values) as string).attr("class", "sp-a");
    svg.append("path").attr("d", d3.line<number>().x((_, i) => xs(i)).y((d) => ys(d)).curve(d3.curveMonotoneX)(values) as string).attr("class", "sp-l");
  }, [values]);
  return <svg ref={ref} className="spark" viewBox="0 0 88 22" preserveAspectRatio="none" />;
}

export function App() {
  const { address, isConnected } = useAccount();
  const acct = address as Hex | undefined;

  const [epicenter, setEpicenter] = useState("");
  const [evidence, setEvidence] = useState("");
  const [requested, setRequested] = useState("100");
  const [bondAmt, setBondAmt] = useState("100");
  const [rows, setRows] = useState<QuakeRow[]>([]);
  const [counts, setCounts] = useState({ next: 0, ruled: 0, severe: 0 });
  const [pool, setPool] = useState("0");
  const [selId, setSelId] = useState<number | null>(null);
  const [sel, setSel] = useState<QuakeCaseView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [netErr, setNetErr] = useState(false);

  async function refreshAll() {
    if (typeof document !== "undefined" && document.hidden) return; // pause when tab hidden
    try {
      const [c, p, list] = await Promise.all([getCounts(), getPoolBalance(), listAll(50)]);
      setCounts(c); setPool(p.split("||")[0] || "0"); setRows(list);
      if (selId != null) { try { setSel(await getCase(selId)); } catch { /* keep */ } }
      setNetErr(false);
    } catch { setNetErr(true); /* surfaced, not silent */ }
  }
  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 12000);
    const onVis = () => { if (!document.hidden) refreshAll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  async function pick(id: number) {
    setSelId(id);
    try { setSel(await getCase(id)); } catch { setSel(null); }
  }
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setNote("");
    try { return await fn(); } catch (e) { setNote(String((e as Error).message || e).slice(0, 220)); return undefined; }
    finally { setBusy(null); refreshAll(); }
  }

  async function onFile() {
    if (!acct) return;
    if (epicenter.trim().length < 2) return setNote("Epicenter is required.");
    if (!/^https?:\/\//.test(evidence.trim())) return setNote("Evidence URL must be http(s)://...");
    const id = await run("Filing the quake claim", () =>
      fileClaim(acct, { epicenter, evidenceUrl: evidence, requestedWei: BigInt(Math.max(1, Math.floor(Number(requested) || 0))) }));
    if (id != null) { setSelId(id); setNote(`Claim #${id} filed. Run adjudication to read the trace.`); }
  }
  async function onFundBond() {
    if (!acct) return;
    await run("Funding the catastrophe bond", () => fundBond(acct, BigInt(Math.max(1, Math.floor(Number(bondAmt) || 1)))));
  }
  async function onAdjudicate() {
    if (!acct || selId == null) return;
    await run("Validators reading the seismograph", () => adjudicate(acct, selId));
  }
  async function onAutoSettle() {
    if (!acct || selId == null) return;
    await run("Auto-settling the bond", () => autoSettle(acct, selId));
  }

  const sparkRuled = useMemo(() => { let acc = 0; return rows.slice().reverse().map((r) => (acc += r.verdict ? 1 : 0)); }, [rows]);
  const sparkSevere = useMemo(() => { let acc = 0; return rows.slice().reverse().map((r) => (acc += r.verdict === "SEVERE_SHAKE" ? 1 : 0)); }, [rows]);
  const sparkSettled = useMemo(() => { let acc = 0; return rows.slice().reverse().map((r) => (acc += r.status === 2 ? 1 : 0)); }, [rows]);
  const sparkMmi = useMemo(() => rows.slice().reverse().map((r) => r.mmi), [rows]);

  return (
    <div className="page">
      <header className="bar">
        <div className="brand">
          <span className="wm">Tremorline</span>
          <em className="tag">catastrophe bond desk</em>
        </div>
        <div className="bar-r">
          <span className="chip"><i className="dot" /> GenLayer · studionet · {netErr ? "reconnecting…" : "live"}</span>
          <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
        </div>
      </header>

      <section className="hero">
        <div className="hcopy">
          <p className="kicker">Tremorline · catastrophe quake bond</p>
          <h1>When the ground moves<br />past the trigger,<br />the bond settles itself.</h1>
          <p className="lede">
            Stake the catastrophe bond. File a claim with the epicenter and a USGS evidence URL.
            A panel of GenLayer validators reads the seismograph and rules the{" "}
            <em>Modified Mercalli Intensity</em> - MMI ≥ 7 triggers a payout, MMI 4-6 holds, MMI &lt; 4 returns the bond.
          </p>
          <div className="meta">
            <span>contract</span><button type="button" className="copybtn" aria-label="Copier l'adresse du contrat" onClick={() => copyText(CONTRACT_ADDRESS)}><code>{shortAddr(CONTRACT_ADDRESS)}</code> ⧉</button>
            <span className="sep">·</span>
            <span>verdicts</span><code>SEVERE_SHAKE · MODERATE · NO_EVENT</code>
          </div>
        </div>
        <div className="hviz">
          <div className="hviz-h">
            <span>Seismograph trace</span>
            <span className="muted">MMI per ruling, severe payout above 7</span>
          </div>
          <SeismographTrace rows={rows} />
        </div>
      </section>

      <section className="stats">
        <div className="stat"><span className="lbl">Claims filed</span><span className="num">{counts.next}</span><Spark values={Array.from({ length: counts.next + 1 }, (_, i) => i)} /></div>
        <div className="stat"><span className="lbl">Adjudicated</span><span className="num">{counts.ruled}</span><Spark values={sparkRuled} /></div>
        <div className="stat"><span className="lbl">Severe shake</span><span className="num">{counts.severe}</span><Spark values={sparkSevere} /></div>
        <div className="stat"><span className="lbl">Settled</span><span className="num">{sparkSettled.length ? sparkSettled[sparkSettled.length - 1] : 0}</span><Spark values={sparkSettled} /></div>
        <div className="stat"><span className="lbl">Bond pool</span><span className="num">{pool}</span><Spark values={sparkMmi} /></div>
      </section>

      <nav className="rule">
        <span><i>1</i> Stake the catastrophe bond</span>
        <span><i>2</i> File the epicenter claim</span>
        <span><i>3</i> Validators read the seismograph</span>
        <span><i>4</i> Auto-settle the bond</span>
      </nav>

      <section className="work">
        <div className="ledger">
          <div className="ledger-h">
            <h2>Quake ledger</h2>
            <span className="muted">{rows.length} on-chain · severe shakes highlighted</span>
          </div>
          {rows.length === 0 ? (<p className="empty-row">No quake claims yet. File the first one.</p>) : (
            <table className="tbl">
              <thead><tr><th>claim</th><th>status</th><th>MMI reading</th><th>verdict</th><th>epicenter &amp; claimant</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`${selId === r.id ? "sel" : ""} ${r.verdict === "SEVERE_SHAKE" ? "severe" : ""}`} onClick={() => pick(r.id)} tabIndex={0} role="button" aria-label={`Claim ${r.id}, ${r.epicenter || "epicenter"}, ${r.verdict || "pending"}`} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(r.id); } }}>
                    <td><code>#{r.id}</code></td>
                    <td><span className={`pill s${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                    <td className="bar-cell">
                      <div className="fb mmi"><i style={{ width: `${(r.mmi / 12) * 100}%` }} className={r.mmi >= SEVERE_THRESHOLD ? "fill-severe" : r.mmi >= MODERATE_THRESHOLD ? "fill-moderate" : "fill-low"} /></div>
                      <code className="bv">MMI {r.mmi || "-"} / 12</code>
                    </td>
                    <td><span className={`vd v-${r.verdict || "none"}`}>{r.verdict || "pending"}</span></td>
                    <td>
                      <code className="zone">{r.epicenter || "-"}</code>
                      <span className="vs">·</span>
                      <code className="addr">{shortAddr(r.claimant)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <aside className="side">
          <div className="panel">
            <h3>File a quake claim</h3>
            <label>Epicenter</label>
            <input value={epicenter} onChange={(e) => setEpicenter(e.target.value)} placeholder="e.g. Kahramanmaras region" />
            <label>USGS evidence URL</label>
            <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://earthquake.usgs.gov/earthquakes/eventpage/..." />
            <label>Requested (wei)</label>
            <input value={requested} onChange={(e) => setRequested(e.target.value)} placeholder="100" />
            <button className="go" disabled={!isConnected || !!busy || epicenter.trim().length < 2 || !/^https?:\/\//.test(evidence.trim())} onClick={onFile}>
              {isConnected ? "File the quake claim" : "Connect a wallet to file"}
            </button>
          </div>

          <div className="panel">
            <h3>Stake the bond</h3>
            <div className="row2">
              <div><label>Amount (wei)</label><input value={bondAmt} onChange={(e) => setBondAmt(e.target.value)} placeholder="100" /></div>
              <div className="alignend"><button className="ghost" disabled={!isConnected || !!busy} onClick={onFundBond}>Fund bond</button></div>
            </div>
          </div>

          {sel && selId != null && (
            <div className="panel selpanel">
              <h3>Selected · claim <code>#{selId}</code></h3>
              <div className="kv"><span>status</span><b>{STATUS_LABEL[sel.status] || sel.status}</b></div>
              <div className="kv"><span>epicenter</span><code>{sel.epicenter}</code></div>
              <div className="kv"><span>evidence</span><a className="link" href={sel.evidenceUrl} target="_blank" rel="noreferrer noopener">USGS source</a></div>
              <div className="kv"><span>requested</span><code>{sel.requested}</code></div>
              {sel.verdict ? (
                <>
                  <div className={`verdict v-${sel.verdict}`}>{sel.verdict.replace("_", " ")}</div>
                  <div className="kv"><span>MMI</span><code>{sel.mmi} / 12</code></div>
                  <div className="kv"><span>paid</span><code>{sel.paid}</code></div>
                  {sel.rationale && <p className="rationale">{sel.rationale}</p>}
                </>
              ) : (<p className="muted">Awaiting adjudication.</p>)}
              {sel.status === 0 && (<button className="go" disabled={!isConnected || !!busy} onClick={onAdjudicate}>Read seismograph &amp; rule</button>)}
              {sel.status === 1 && (<button className="go" disabled={!isConnected || !!busy} onClick={onAutoSettle}>Auto-settle bond</button>)}
              {sel.status === 2 && (<p className="muted">Settled. Bond closed.</p>)}
            </div>
          )}
        </aside>
      </section>

      {(busy || note) && <div className="toast">{busy ? `${busy}...` : note}</div>}

      <footer className="foot">
        <span>contract <code>{shortAddr(CONTRACT_ADDRESS)}</code></span>
        <span>bond pool {pool}</span>
        <span>quake verdicts reproduced by independent GenLayer validators on studionet</span>
      </footer>
    </div>
  );
}
