/** StockDesk v1.3 · 技术指标多副图 Canvas 渲染器 */
export class IndicatorPaneManager {
  constructor(container) {
    this.container = container;
    this.theme = "dark";
    this.times = [];
    this.rows = [];
    this.panes = [];
  }
  setTheme(theme) { this.theme = theme; this.redraw(); }
  setRange(times) { this.range = times || []; this.redraw(); }
  visibleBounds() {
    const first = this.times.indexOf(this.range?.[0]);
    const last = this.times.indexOf(this.range?.at(-1));
    return first >= 0 && last >= first ? [first,last+1] : [Math.max(0,this.times.length-140),this.times.length];
  }
  clear() { this.times = []; this.rows = []; this.container.innerHTML = ""; this.panes = []; }
  setData(times, rows) {
    this.times = times || [];
    this.rows = rows || [];
    this.render();
  }
  render() {
    this.container.innerHTML = "";
    this.panes = [];
    for (const row of this.rows) {
      const pane = document.createElement("div"); pane.className = "indicator-pane";
      const head = document.createElement("div"); head.className = "indicator-pane-head";
      const latest = (row.lines || []).map((s) => {
        const v = lastFinite(s.values); return `<span>${esc(s.name)} <b>${v == null ? "—" : fmtSmart(v)}</b></span>`;
      }).join("");
      const a=row.analysis||{}; const badge=Number.isFinite(Number(a.score)) ? `<span class="indicator-analysis-badge ${Number(a.score)>=20?"pos":Number(a.score)<=-20?"neg":"neu"}">${esc(a.state||"—")} ${Number(a.score)>0?"+":""}${Number(a.score)}</span>` : "";
      head.innerHTML = `<strong>${esc(row.id)}</strong><em>${esc(row.name)}</em>${badge}<div>${latest}</div>`;
      const canvas = document.createElement("canvas"); canvas.className = "indicator-canvas";
      const note = row.note ? document.createElement("div") : null;
      if (note) { note.className = "indicator-pane-note"; note.textContent = row.note; }
      pane.append(head, canvas); if (note) pane.append(note);
      this.container.appendChild(pane);
      const item = { pane, canvas, row, hover: -1 };
      canvas.addEventListener("mousemove", (ev) => {
        const rect = canvas.getBoundingClientRect(), bounds = this.visibleBounds(), n = bounds[1]-bounds[0];
        item.hover = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - rect.left) / Math.max(1, rect.width) * n)));
        this.drawOne(item);
      });
      canvas.addEventListener("mouseleave", () => { item.hover = -1; this.drawOne(item); });
      this.panes.push(item);
      this.drawOne(item);
    }
  }
  resize() { for (const p of this.panes) this.drawOne(p); }
  redraw() { for (const p of this.panes) this.drawOne(p); }

  drawOne(item) {
    const { canvas, row } = item;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height, padL = 5, padR = 44, padT = 5, padB = 18;
    ctx.clearRect(0, 0, w, h);
    const [start, end] = this.visibleBounds(), n = end - start;
    if (!n) return;
    const series = (row.lines || []).map((s) => ({ ...s, v: (s.values || []).slice(start, end) }));
    const vals = [];
    for (const s of series) for (const v of s.v) if (v != null && Number.isFinite(Number(v))) vals.push(Number(v));
    for (const g of row.guides || []) if (Number.isFinite(Number(g.value))) vals.push(Number(g.value));
    if (!vals.length) return;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) { lo -= Math.abs(lo || 1) * .05; hi += Math.abs(hi || 1) * .05; }
    const extra = (hi - lo) * .08 || 1; lo -= extra; hi += extra;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xOf = (i) => padL + (i + .5) / n * plotW;
    const yOf = (v) => padT + (hi - v) / (hi - lo) * plotH;
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue("--muted").trim() || "#8b98a8";
    const grid = css.getPropertyValue("--glass-border-soft").trim() || "rgba(128,128,128,.2)";
    const palette = [css.getPropertyValue("--accent").trim() || "#6ea8ff", css.getPropertyValue("--accent-2").trim() || "#b388ff", css.getPropertyValue("--gold").trim() || "#f0b90b", css.getPropertyValue("--down").trim() || "#00c853", css.getPropertyValue("--up").trim() || "#ff4d5e", "#66d9ef"];
    ctx.font = "10px 'Cascadia Code',Consolas,monospace";
    ctx.strokeStyle = grid; ctx.fillStyle = text; ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const y = padT + k / 3 * plotH, v = hi - k / 3 * (hi - lo);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(fmtSmart(v), w - padR + 4, y + 3);
    }
    for (const g of row.guides || []) {
      const gv = Number(g.value); if (!Number.isFinite(gv) || gv < lo || gv > hi) continue;
      ctx.setLineDash([3, 3]); ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(padL, yOf(gv)); ctx.lineTo(w - padR, yOf(gv)); ctx.stroke(); ctx.setLineDash([]);
    }
    series.forEach((s, si) => {
      const color = palette[si % palette.length];
      if (s.type === "bar") {
        const zero = (lo <= 0 && hi >= 0) ? yOf(0) : yOf(lo), bw = Math.max(1, plotW / n * .62);
        for (let i = 0; i < n; i++) {
          const v = s.v[i] == null ? NaN : Number(s.v[i]); if (!Number.isFinite(v)) continue;
          const y = yOf(v), top = Math.min(y, zero), bh = Math.max(1, Math.abs(zero - y));
          ctx.globalAlpha = .5; ctx.fillStyle = v >= 0 ? color : palette[(si + 4) % palette.length]; ctx.fillRect(xOf(i) - bw / 2, top, bw, bh); ctx.globalAlpha = 1;
        }
      } else {
        ctx.strokeStyle = color; ctx.lineWidth = si === 0 ? 1.6 : 1.2; ctx.beginPath(); let started = false;
        for (let i = 0; i < n; i++) {
          const v = s.v[i] == null ? NaN : Number(s.v[i]); if (!Number.isFinite(v)) { started = false; continue; }
          const x = xOf(i), y = yOf(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    });
    const marks = [0, Math.floor((n - 1) / 2), n - 1];
    ctx.fillStyle = text;
    for (const i of marks) { const t = String(this.times[start + i] || "").slice(2, 10); ctx.fillText(t, Math.min(w - padR - 45, xOf(i) - 12), h - 4); }
    if (item.hover >= 0 && item.hover < n) {
      const idx = item.hover, x = xOf(idx);
      ctx.strokeStyle = text; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); ctx.setLineDash([]);
      const chunks = [String(this.times[start + idx] || "").slice(0, 10)];
      series.forEach((s) => { const v = Number(s.v[idx]); if (Number.isFinite(v)) chunks.push(`${s.name}:${fmtSmart(v)}`); });
      const label = chunks.join("  "); ctx.font = "10px 'Cascadia Code',Consolas,monospace";
      const tw = Math.min(w - 8, ctx.measureText(label).width + 12), bx = Math.min(w - tw - 4, Math.max(4, x + 8));
      ctx.fillStyle = "rgba(0,0,0,.78)"; ctx.fillRect(bx, 4, tw, 18); ctx.fillStyle = "#fff"; ctx.fillText(label, bx + 6, 16);
    }
  }
}
function lastFinite(a) { for (let i = (a || []).length - 1; i >= 0; i--) if (Number.isFinite(Number(a[i]))) return Number(a[i]); return null; }
function fmtSmart(v) { const x = Number(v); if (!Number.isFinite(x)) return "—"; const a = Math.abs(x); return a >= 1e8 ? (x / 1e8).toFixed(2) + "亿" : a >= 1e4 ? (x / 1e4).toFixed(1) + "万" : a >= 1000 ? x.toFixed(0) : a >= 100 ? x.toFixed(1) : a >= 10 ? x.toFixed(2) : x.toFixed(3); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
