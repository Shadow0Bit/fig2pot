/** Self-contained HTML report (no external assets; images are relative paths in the out dir). */
import type { DiffResult } from './diff.ts';
import type { Renderer } from './penpot.ts';
import { boardPasses, metricValue, ruleOf, ruleText, type BoardReport, type MetricName, type Report, type Stats } from './run.ts';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const METRIC_LABEL: Record<MetricName, string> = { visual: 'visual accuracy', perceptual: 'perceptual accuracy', content: 'strict content accuracy', full: 'full accuracy' };

const pct = (v: number | undefined): string => (v === undefined ? '—' : `${(v * 100).toFixed(2)}%`);

function statRow(label: string, s: Stats): string {
  return `<tr><th>${esc(label)}</th><td>${pct(s.mean)}</td><td>${pct(s.median)}</td><td>${pct(s.min)}</td><td>${((s.shareAtLeastMin ?? s.shareAtLeast98) * 100).toFixed(0)}%</td></tr>`;
}

function img(path: string | undefined, alt: string): string {
  return path ? `<a href="${esc(path)}" target="_blank"><img src="${esc(path)}" alt="${esc(alt)}" loading="lazy"></a>` : '<span class="muted">—</span>';
}

function flags(m: DiffResult | undefined): string[] {
  if (!m) return [];
  const d = m.boundsDelta;
  return [
    m.boundsMismatch ? `bounds Δ l${d.left} t${d.top} r${d.right} b${d.bottom}` : '',
    m.sizeDelta.width || m.sizeDelta.height ? `Δsize ${m.sizeDelta.width},${m.sizeDelta.height}` : '',
    m.backgroundMismatch ? `bg ${m.reference.background} vs ${m.candidate.background}` : '',
    m.shiftedPixels ? `${m.shiftedPixels} px ≥1-px shift` : '',
    m.reference.croppedPadding ? `ref margin ${m.reference.croppedPadding.left} px cropped` : '',
    m.referencePaddingIrregular ? 'ref padding irregular (not cropped)' : '',
  ].filter(Boolean);
}

/** A metric cell; the rule's metric is coloured pass/fail (the whole rule), `data-v` drives the sorting (missing = −1). */
function cell(m: DiffResult | undefined, metric: MetricName, r: Report): string {
  const v = metricValue(m, metric);
  const cls = metric === r.metric ? (boardPasses(m, ruleOf(r)) ? 'pass' : 'fail') : '';
  return `<td class="num ${cls}" data-v="${v ?? -1}">${pct(v)}</td>`;
}

/** localAccuracy cell with the worst window's position (red when below the rule's threshold). */
function localCell(m: DiffResult | undefined, r: Report): string {
  const v = m?.localAccuracy;
  const w = m?.localWorst;
  const cls = v === undefined ? '' : v < ruleOf(r).minLocal ? 'fail' : '';
  return `<td class="num ${cls}" data-v="${v ?? -1}">${pct(v)}${w ? `<div class="muted">@${w.x},${w.y}</div>` : ''}${m?.trivial ? '<div class="muted">trivial</div>' : ''}</td>`;
}

function row(b: BoardReport, r: Report): string {
  const m = b.metrics;
  const others = r.renderers.slice(1);
  const cls = b.status === 'ok' ? 'ok' : 'bad';
  const notes = [...flags(m).map((f) => (others.length ? `${r.renderer}: ${f}` : f))];
  for (const o of others) {
    notes.push(...flags(b.metricsByRenderer?.[o]).map((f) => `${o}: ${f}`));
    if (b.errorsByRenderer?.[o]) notes.push(`${o}: export failed`);
  }
  if (b.matchedBy === 'name') notes.push('matched by name');
  if (b.attempts && b.attempts > 1) notes.push(`${b.attempts} attempts`);
  const reg = m ? ` · offset ${m.offset.x},${m.offset.y} · union ${m.width}×${m.height}` : '';
  return `<tr class="${cls}">
  ${cell(m, 'visual', r)}
  ${localCell(m, r)}
  ${cell(m, 'perceptual', r)}
  ${cell(m, 'content', r)}
  ${cell(m, 'full', r)}
  ${others.map((o) => cell(b.metricsByRenderer?.[o], r.metric, r)).join('')}
  <td class="num" data-v="${m ? m.ssim : -1}">${m ? m.ssim.toFixed(3) : '—'}</td>
  <td><div class="name">${esc(b.name)}</div><div class="muted">${esc(b.page)} · <code>${esc(b.nodeId ?? '')}</code> · <code>${esc(b.shapeId ?? '')}</code></div>
    <div class="muted">${esc(b.status)}${m ? ` · ref ${m.reference.width}×${m.reference.height} / cand ${m.candidate.width}×${m.candidate.height} @${b.scale}x${reg} · ${m.perceptualMismatchedPixels ?? '?'} perceptual / ${m.contentMismatchedPixels} strict of ${m.contentPixels} content px off · ${m.visualMismatchedPixels ?? '?'} of ${m.salientPixels ?? '?'} salient px (edge ${m.edgeMismatchedPixels ?? '?'}, flat ${m.flatMismatchedPixels ?? '?'}, ink ${m.inkMismatchedPixels ?? '?'}) · regional ${pct(m.regionalAccuracy)}` : ''}${b.exportMs ? ` · export ${b.exportMs} ms` : ''}</div>
    ${notes.length ? `<div class="flags">${notes.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
    ${b.error ? `<pre>${esc(b.error)}</pre>` : ''}
    ${others.map((o) => (b.errorsByRenderer?.[o] ? `<pre>${esc(o)}: ${esc(b.errorsByRenderer[o])}</pre>` : '')).join('')}</td>
  <td>${img(b.files?.reference, 'reference')}</td>
  ${[r.renderer, ...others]
    .map((x: Renderer) => {
      const f = x === r.renderer ? b.files : b.filesByRenderer?.[x];
      return `<td>${img(f?.candidate, `candidate ${x}`)}</td><td>${img(f?.diff, `diff ${x}`)}</td>`;
    })
    .join('')}
</tr>`;
}

export function renderHtmlReport(r: Report): string {
  const s = r.summary;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual diff report</title>
<style>
  :root { --bg:#fff; --fg:#1b1b1f; --muted:#6b6b76; --line:#e4e4e8; --ok:#1a7f37; --bad:#cf222e; --chip:#f2f2f5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#ececf0; --muted:#9a9aa6; --line:#2c2c33; --ok:#3fb950; --bad:#f85149; --chip:#24242a; } }
  body { margin:0; padding:16px 24px 48px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } .muted { color:var(--muted); font-size:12px; }
  table { border-collapse:collapse; width:100%; } th, td { border-bottom:1px solid var(--line); padding:8px; text-align:left; vertical-align:top; }
  .summary { width:auto; margin:16px 0 24px; } .summary td, .summary th { padding:4px 16px 4px 0; }
  .num { font-variant-numeric:tabular-nums; white-space:nowrap; } .pass { color:var(--ok); } .fail { color:var(--bad); font-weight:600; }
  img { max-width:240px; max-height:240px; border:1px solid var(--line); background:repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/16px 16px; }
  .name { font-weight:600; } code { font-size:11px; } pre { white-space:pre-wrap; color:var(--bad); font-size:12px; max-width:520px; }
  .flags span { display:inline-block; background:var(--chip); border-radius:4px; padding:0 6px; margin:2px 4px 0 0; font-size:12px; }
  .scroll { overflow-x:auto; }
  th.sort { cursor:pointer; text-decoration:underline dotted; } th.sort.active { text-decoration:underline; }
  .sw { display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:baseline; }
</style></head><body>
<h1>Visual diff report</h1>
<div class="muted">${esc(r.input)} · Penpot ${esc(r.penpotVersion)} · ${esc(r.renderers.join(' + '))} renderer${r.renderers.length > 1 ? `s (pass/fail on ${esc(r.renderer)})` : ''} · import ${r.timings.importMs} ms · exports ${r.timings.exportsMs} ms${r.workspaceUrl ? ` · <a href="${esc(r.workspaceUrl)}">open in Penpot</a>` : ''}</div>
<table class="summary">
  <tr><th></th><th>mean</th><th>median</th><th>min</th><th>≥ ${pct(r.min)}</th></tr>
  ${(r.renderers.length > 1 ? r.renderers : [r.renderer])
    .map((x) => {
      const sx = r.summaryByRenderer?.[x] ?? s;
      const tag = r.renderers.length > 1 ? ` (${x})` : '';
      return [
        sx.visualAccuracy ? statRow(`visual accuracy${tag}`, sx.visualAccuracy) : '',
        sx.localAccuracy ? statRow(`local accuracy${tag}`, sx.localAccuracy) : '',
        sx.perceptualAccuracy ? statRow(`perceptual accuracy${tag}`, sx.perceptualAccuracy) : '',
        statRow(`strict content accuracy${tag}`, sx.contentAccuracy),
        statRow(`full accuracy${tag}`, sx.accuracy),
      ].join('\n  ');
    })
    .join('\n  ')}
  <tr><th>boards</th><td colspan="4">${s.compared} compared / ${s.boards} total · ${s.passed ?? '?'} pass · ${s.trivial ?? 0} trivial (excluded from the visual / local means) · ${s.failed} failed or missing · pass rule: ${esc(r.metric === 'visual' ? ruleText(ruleOf(r)) : `${pct(r.min)} ${METRIC_LABEL[r.metric ?? 'content']}`)}${r.tolerancePx !== undefined ? ` · perceptual tolerance ${r.tolerancePx} px` : ''}</td></tr>
</table>
${r.warnings.length ? `<details><summary>${r.warnings.length} exporter warning(s)</summary><pre>${esc(r.warnings.join('\n'))}</pre></details>` : ''}
<p class="muted">Diff image: reference | candidate | perceptual highlight | salience. Highlight panel: <span class="sw" style="background:#f00"></span> perceptual mismatch ·
<span class="sw" style="background:#0078ff"></span> strict-only mismatch ·
<span class="sw" style="background:#ffc800"></span> anti-aliasing forgiven by both. Salience panel (what the visual metric looked at): <span class="sw" style="background:#5ac8eb"></span> matched edge zone ·
<span class="sw" style="background:#f00"></span> edge mismatch · <span class="sw" style="background:#e600e6"></span> flat mismatch · <span class="sw" style="background:#ff7800"></span> ink mismatch · <span class="sw" style="background:#00aa00"></span> worst local window (also on the highlight panel). Click a metric header to sort (worst first, again for best first).</p>
<div class="scroll"><table id="boards">
<thead><tr><th class="sort" data-col="0">visual${r.renderers.length > 1 ? ` ${esc(r.renderer)}` : ''}</th><th class="sort" data-col="1">local</th><th class="sort" data-col="2">perceptual</th><th class="sort" data-col="3">strict content</th><th class="sort" data-col="4">full</th>${r.renderers
  .slice(1)
  .map((x, i) => `<th class="sort" data-col="${5 + i}">${esc(r.metric ?? 'content')} ${esc(x)}</th>`)
  .join('')}<th class="sort" data-col="${4 + r.renderers.length}">ssim</th><th>board</th><th>reference (Figma)</th>${r.renderers
  .map((x) => `<th>candidate (Penpot${r.renderers.length > 1 ? ` ${esc(x)}` : ''})</th><th>diff${r.renderers.length > 1 ? ` ${esc(x)}` : ''}</th>`)
  .join('')}</tr></thead>
<tbody>
${r.boards.map((b) => row(b, r)).join('\n')}
</tbody>
</table></div>
<script>
(() => {
  const table = document.getElementById('boards');
  const body = table.tBodies[0];
  let last = -1, dir = 1;
  const sort = (col) => {
    dir = col === last ? -dir : 1;
    last = col;
    const rows = [...body.rows];
    rows.sort((a, b) => dir * (Number(a.cells[col].dataset.v) - Number(b.cells[col].dataset.v)));
    for (const tr of rows) body.appendChild(tr);
    for (const th of table.tHead.rows[0].cells) th.classList.toggle('active', Number(th.dataset.col) === col);
  };
  for (const th of table.querySelectorAll('th.sort')) th.addEventListener('click', () => sort(Number(th.dataset.col)));
  // Rows arrive worst-first under the run's pass rule (run.ts compareBoards); headers re-sort.
})();
</script>
</body></html>
`;
}
