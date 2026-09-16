// Persist ratios, not pixel widths, so a saved layout also fits smaller windows.
export function initLayout() {
  const main = document.querySelector('.main');
  const stack = document.querySelector('#chart-stack');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('stockdesk.layout') || '{}') || {}; } catch {}
  const clamp = (n, low, high, fallback) => Number.isFinite(Number(n)) ? Math.max(low, Math.min(high, Number(n))) : fallback;
  const ratios = { left: clamp(saved.left,.12,.30,.19), right: clamp(saved.right,.22,.48,.30), chart: clamp(saved.chart,.25,.80,.62) };
  const apply = () => {
    main.style.setProperty('--left-size', `${ratios.left * 100}%`);
    main.style.setProperty('--right-size', `${ratios.right * 100}%`);
    stack.style.setProperty('--chart-size', `${ratios.chart * 100}%`);
  };
  const persist = () => { try { localStorage.setItem('stockdesk.layout', JSON.stringify(ratios)); } catch {} };
  for (const [key, target, horizontal] of [['left', document.querySelector('.sidebar'), false], ['right', document.querySelector('.center'), false], ['chart', document.querySelector('#main-chart-wrap'), true]]) {
    const bar = document.createElement('div');
    bar.className = `splitter ${horizontal ? 'horizontal' : 'vertical'}`;
    bar.tabIndex = 0; bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
    bar.setAttribute('aria-label', horizontal ? '调整主图与副图比例' : '调整分区宽度');
    bar.title = '拖动调整大小；双击恢复默认；方向键微调';
    target.after(bar);
    let dragging = false;
    const update = (value) => {
      ratios[key] = key === 'chart' ? clamp(value,.25,.80,.62) : key === 'left' ? clamp(value,.12,Math.min(.30,.70-ratios.right),.19) : clamp(value,.22,Math.min(.48,.70-ratios.left),.30);
      bar.setAttribute('aria-valuenow', String(Math.round(ratios[key]*100)));
      apply();
    };
    bar.addEventListener('pointerdown', ev => { if (ev.button !== 0) return; dragging=true; bar.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    bar.addEventListener('pointermove', ev => {
      if (!dragging) return;
      const rect = (horizontal ? stack : main).getBoundingClientRect();
      update(horizontal ? (ev.clientY-rect.top)/rect.height : key === 'left' ? (ev.clientX-rect.left)/rect.width : (rect.right-ev.clientX)/rect.width);
    });
    const finish = () => { if (dragging) { dragging=false; persist(); } };
    bar.addEventListener('pointerup', finish); bar.addEventListener('pointercancel', finish);
    bar.addEventListener('dblclick', () => { update({left:.19,right:.30,chart:.62}[key]); persist(); });
    bar.addEventListener('keydown', ev => {
      const delta = {ArrowLeft:-.01,ArrowRight:.01,ArrowUp:-.01,ArrowDown:.01}[ev.key];
      if (delta == null) return;
      ev.preventDefault(); update(ratios[key] + delta * (key==='right' ? -1 : 1)); persist();
    });
  }
  apply();
}
