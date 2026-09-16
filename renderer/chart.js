/**
 * StockDesk 图表模块 — 纯 Canvas 绘制 K 线 / 分时，零外部依赖。
 * 高 DPI 适配、网格、坐标轴、MA 均线、成交量副图、十字光标。
 */
export class ChartRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.data = null;      // {kind:'kline'|'minute', candles, points, ...}
    this.crossIndex = -1;  // 十字光标
    this.theme = "dark";
    this.onCross = null;
    this._bindEvents();
    this._resize();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(50, r.width);
    this.h = Math.max(50, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  resize() { this._resize(); this.draw(); }

  _bindEvents() {
    this.canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoom(ev.deltaY < 0 ? .8 : 1.25, (ev.clientX - r.left) / r.width);
    }, { passive: false });
    this.canvas.addEventListener("dblclick", () => this.resetView());
    let drag = null;
    this.canvas.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !this.data) return;
      drag = { x: ev.clientX, start: this.start };
      this.canvas.setPointerCapture(ev.pointerId);
    });
    this.canvas.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      this.start = drag.start - Math.round((ev.clientX - drag.x) / this.w * this.count);
      this._view();
    });
    const endDrag = () => { drag = null; };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
    const find = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const x = ev.clientX - r.left;
      if (!this.data || !this.data.visible.length) return -1;
      const n = this.data.visible.length;
      const idx = Math.floor(x / (this.w / n));
      return Math.max(0, Math.min(n - 1, idx));
    };
    this.canvas.addEventListener("mousemove", (ev) => {
      this.crossIndex = find(ev);
      this.draw();
    });
    this.canvas.addEventListener("mouseleave", () => { this.crossIndex = -1; this.draw(); });
  }

  setTheme(t) { this.theme = t; this.draw(); }

  setKline(candles, period) {
    this.data = { kind: "kline", candles, visible: candles.slice(-140), period };
    this.resetView();
  }
  setMinute(points, prevClose) {
    const keep = this.data?.kind === "minute";
    const atEnd = keep && this.start + this.count >= this.data.points.length;
    this.data = { kind: "minute", points, prevClose, visible: points };
    if (!keep) this.resetView();
    else { if (atEnd) this.start = Math.max(0, points.length - this.count); this._view(); }
  }
  resetView() {
    if (!this.data) return;
    const n = (this.data.candles || this.data.points).length;
    this.count = this.data.kind === "kline" ? Math.min(140, n) : n;
    this.start = Math.max(0, n - this.count);
    this._view();
  }
  zoom(factor, anchor = .5) {
    if (!this.data) return;
    const n = (this.data.candles || this.data.points).length;
    const next = Math.min(n, Math.max(Math.min(10, n), Math.round(this.count * factor)));
    this.start += Math.round((this.count - next) * Math.max(0, Math.min(1, anchor)));
    this.count = next;
    this._view();
  }
  _view() {
    const rows = this.data.candles || this.data.points;
    this.count = Math.min(rows.length, this.count);
    this.start = Math.max(0, Math.min(rows.length - this.count, this.start));
    this.data.visible = rows.slice(this.start, this.start + this.count);
    this.crossIndex = -1;
    this.draw();
    this.onRange?.(this.data.visible.map(x => x.time), this.data.kind);
  }
  clear() { this.data = null; this.crossIndex = -1; this.draw(); }

  // ---- 颜色 ----
  _c(name) {
    const dark = this.theme === "dark";
    const map = {
      bg: dark ? "#1c2330" : "#ffffff",
      grid: dark ? "#2a3444" : "#e8ecf1",
      text: dark ? "#8b98a8" : "#6b7684",
      up: "#ff4d5e", down: "#00c853",
      ma5: "#f0b90b", ma10: "#4da3ff", ma20: "#c084fc",
      avg: "#f0b90b",
      cross: dark ? "#6b7684" : "#aab4c0",
      volUp: "rgba(255,77,94,.45)", volDown: "rgba(0,200,83,.45)",
    };
    return map[name];
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.data) return;
    if (this.data.kind === "kline") this._drawKline(ctx);
    else this._drawMinute(ctx);
  }

  // ================= K 线 =================
  _drawKline(ctx) {
    const { candles, visible } = this.data;
    const w = this.w, h = this.h;
    const volH = Math.floor(h * 0.2);
    const priceH = h - volH - 26; // 顶部留 18，间隔 8

    // 值域
    let hi = -Infinity, lo = Infinity, vmax = 0;
    for (const c of visible) {
      hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); vmax = Math.max(vmax, c.volume);
    }
    if (!Number.isFinite(hi)) return;
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    hi += pad; lo -= pad;

    const n = visible.length;
    const step = w / n;
    const y = (p) => 18 + (hi - p) / (hi - lo) * priceH;

    // 网格 + 纵轴价格（5 条）
    ctx.font = "10px 'Cascadia Code', Consolas, monospace";
    ctx.fillStyle = this._c("text");
    ctx.strokeStyle = this._c("grid");
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const yy = 18 + (priceH / 4) * i;
      const price = hi - (hi - lo) * (i / 4);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
      ctx.fillText(price.toFixed(2), 4, yy - 3);
    }
    // 时间轴
    if (n > 1) {
      const marks = 5;
      for (let i = 0; i <= marks; i++) {
        const idx = Math.min(n - 1, Math.round((n - 1) * i / marks));
        const t = visible[idx].time.slice(0, 10);
        ctx.fillText(t, Math.min(w - 62, idx * step + 2), h - 4);
      }
    }

    // MA 均线
    const ma = (period) => {
      const out = new Array(candles.length).fill(null);
      let sum = 0;
      for (let i = 0; i < candles.length; i++) {
        sum += candles[i].close;
        if (i >= period) sum -= candles[i - period].close;
        if (i >= period - 1) out[i] = sum / period;
      }
      return out;
    };
    const start = this.start;
    const maLines = { 5: ma(5), 10: ma(10), 20: ma(20) };
    const drawMa = (period, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = maLines[period][start + i];
        if (v == null) continue;
        const x = i * step + step / 2;
        if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
      }
      ctx.stroke();
    };
    drawMa(5, this._c("ma5")); drawMa(10, this._c("ma10")); drawMa(20, this._c("ma20"));

    // 蜡烛
    const bw = Math.max(2, Math.min(9, step * 0.62));
    for (let i = 0; i < n; i++) {
      const c = visible[i];
      const x = i * step + step / 2;
      const isUp = c.close >= c.open;
      const color = isUp ? this._c("up") : this._c("down");
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y(c.high)); ctx.lineTo(x, y(c.low)); ctx.stroke();
      const yo = y(c.open), yc = y(c.close);
      const top = Math.min(yo, yc), bh = Math.max(1.5, Math.abs(yo - yc));
      ctx.fillRect(x - bw / 2, top, bw, bh);
      // 成交量副图
      const vy = h - volH + (1 - c.volume / (vmax || 1)) * volH;
      ctx.fillStyle = isUp ? this._c("volUp") : this._c("volDown");
      ctx.fillRect(x - bw / 2, vy, bw, Math.max(0, h - vy));
    }

    // 十字光标
    if (this.crossIndex >= 0 && this.crossIndex < n) {
      const c = visible[this.crossIndex];
      const x = this.crossIndex * step + step / 2;
      ctx.strokeStyle = this._c("cross"); ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, h - 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y(c.close)); ctx.lineTo(w, y(c.close)); ctx.stroke();
      ctx.setLineDash([]);
      // 信息框
      const isUp = c.close >= c.open;
      const label = `${c.time.slice(0,10)}  开${c.open.toFixed(2)} 高${c.high.toFixed(2)} 低${c.low.toFixed(2)} 收${c.close.toFixed(2)}  ${((c.close-c.open)/c.open*100).toFixed(2)}%  量${(c.volume/10000).toFixed(0)}万手`;
      ctx.font = "11px 'Cascadia Code', Consolas, monospace";
      const tw = ctx.measureText(label).width + 14;
      const bx = x + tw > w ? x - tw - 8 : x + 8;
      ctx.fillStyle = "rgba(0,0,0,.75)";
      ctx.fillRect(bx, 4, tw, 20);
      ctx.fillStyle = isUp ? this._c("up") : this._c("down");
      ctx.fillText(label, bx + 7, 18);
    }
  }

  // ================= 分时 =================
  _drawMinute(ctx) {
    const points = this.data.visible;
    const prevClose = this.data.prevClose || points[0]?.p;
    const w = this.w, h = this.h;
    if (!points.length || !prevClose) return;
    const n = points.length;
    const step = w / n;
    let hi = -Infinity, lo = Infinity, vmax = 0;
    for (const p of points) { hi = Math.max(hi, p.p); lo = Math.min(lo, p.p); vmax = Math.max(vmax, p.v); }
    const pad = (hi - lo) * 0.08 || 0.01;
    hi += pad; lo -= pad;
    const y = (p) => 18 + (hi - p) / (hi - lo) * (h - 46);

    ctx.font = "10px 'Cascadia Code', Consolas, monospace";
    ctx.fillStyle = this._c("text");
    ctx.strokeStyle = this._c("grid");
    for (let i = 0; i <= 4; i++) {
      const yy = 18 + ((h - 46) / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
      ctx.fillText((hi - (hi - lo) * (i / 4)).toFixed(2), 4, yy - 3);
    }
    // 昨收虚线
    const yp = y(prevClose);
    ctx.strokeStyle = this._c("avg"); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(w, yp); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(`昨收 ${prevClose.toFixed(2)}`, w - 92, yp - 4);

    // 分时线
    const color = points[n - 1].p >= prevClose ? this._c("up") : this._c("down");
    const grad = ctx.createLinearGradient(0, 18, 0, h - 46);
    grad.addColorStop(0, color + "33"); grad.addColorStop(1, color + "00");
    ctx.beginPath();
    points.forEach((p, i) => { const x = i * step; i === 0 ? ctx.moveTo(x, y(p.p)) : ctx.lineTo(x, y(p.p)); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.lineTo(w, h - 46); ctx.lineTo(0, h - 46); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // 成交量（底部）
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const vh = p.v / (vmax || 1) * 24;
      ctx.fillStyle = p.p >= prevClose ? this._c("volUp") : this._c("volDown");
      ctx.fillRect(i * step, h - 20 - vh, Math.max(1, step * 0.6), vh + 16);
    }
    // 时间轴
    const marks = 4;
    for (let i = 0; i <= marks; i++) {
      const idx = Math.min(n - 1, Math.round((n - 1) * i / marks));
      const t = points[idx].t;
      const hh = String(Math.floor(t / 60)).padStart(2, "0");
      const mm = String(t % 60).padStart(2, "0");
      ctx.fillText(`${hh}:${mm}`, Math.min(w - 40, idx * step), h - 4);
    }

    // 十字
    if (this.crossIndex >= 0 && this.crossIndex < n) {
      const p = points[this.crossIndex];
      const x = this.crossIndex * step;
      ctx.strokeStyle = this._c("cross"); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, h - 24); ctx.stroke();
      ctx.setLineDash([]);
      const hh = String(Math.floor(p.t / 60)).padStart(2, "0");
      const mm = String(p.t % 60).padStart(2, "0");
      const chg = ((p.p - prevClose) / prevClose * 100).toFixed(2);
      const label = `${hh}:${mm}  ${p.p.toFixed(2)}  ${chg}%`;
      ctx.font = "11px 'Cascadia Code', Consolas, monospace";
      const tw = ctx.measureText(label).width + 14;
      const bx = x + tw > w ? x - tw - 8 : x + 8;
      ctx.fillStyle = "rgba(0,0,0,.75)"; ctx.fillRect(bx, 4, tw, 20);
      ctx.fillStyle = p.p >= prevClose ? this._c("up") : this._c("down");
      ctx.fillText(label, bx + 7, 18);
    }
  }
}
