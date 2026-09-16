const {app, BrowserWindow} = require('electron');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false,width:1260,height:800,webPreferences:{contextIsolation:true}});
  win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({cancel:d.url.endsWith('/renderer/app.js')}));
  try {
    await win.loadFile(path.join(__dirname,'../renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${async function() {
      const assert = (ok, why) => {if (!ok) throw new Error(why);};
      const {initLayout} = await import('./layout.js');
      const {ChartRenderer} = await import('./chart.js');
      const {IndicatorPaneManager} = await import('./indicator-chart.js');
      localStorage.removeItem('stockdesk.layout');
      if (!document.querySelector('.splitter')) initLayout();
      const bars = document.querySelectorAll('.splitter');
      assert(bars.length===3,'three splitters');
      const sidebar = document.querySelector('.sidebar'), before = sidebar.getBoundingClientRect().width;
      bars[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      assert(sidebar.getBoundingClientRect().width>before,'separator changes width');
      assert(JSON.parse(localStorage.getItem('stockdesk.layout')).left>.19,'layout persists');
      const chart = new ChartRenderer(document.querySelector('#chart'));
      const panes = new IndicatorPaneManager(document.querySelector('#indicator-grid'));
      const rows = Array.from({length:180},(_,i)=>({time:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),open:10+i/10,close:11+i/10,high:12+i/10,low:9+i/10,volume:100+i}));
      chart.onRange=times=>panes.setRange(times);
      panes.setData(rows.map(x=>x.time),[]);
      chart.setKline(rows,'day'); assert(chart.data.visible.length===140,'default range');
      chart.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:400,cancelable:true}));
      assert(chart.data.visible.length===112,'wheel zoom');
      assert(panes.visibleBounds()[1]-panes.visibleBounds()[0]===112,'indicator range follows');
      for(let i=0;i<30;i++)chart.zoom(.8);
      assert(chart.count===10,'zoom minimum');
      chart.start=-999; chart._view(); assert(chart.start===0,'pan left bound');
      chart.start=999; chart._view(); assert(chart.start===170,'pan right bound');
      chart.canvas.dispatchEvent(new MouseEvent('dblclick')); assert(chart.count===140,'double click reset');
      chart.setMinute(Array.from({length:241},(_,i)=>({t:570+i,p:10+i/100,v:10})),null);
      chart.zoom(.5); assert(chart.data.visible.length===121,'minute zoom without previous close');
      return {splitters:bars.length,klineZoom:true,minuteZoom:true,indicatorSync:true,persisted:true};
    }.toString()})()`);
    console.log('UI interaction PASS',JSON.stringify(result));
    const drag = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.splitter.vertical').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+40),width:document.querySelector('.sidebar').getBoundingClientRect().width};})()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'mouseMove',x:drag.x,y:drag.y});
    await new Promise(r=>setTimeout(r,80));
    win.webContents.sendInputEvent({type:'mouseDown',x:drag.x,y:drag.y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,80));
    win.webContents.sendInputEvent({type:'mouseMove',x:drag.x+40,y:drag.y});
    await new Promise(r=>setTimeout(r,80));
    win.webContents.sendInputEvent({type:'mouseUp',x:drag.x+40,y:drag.y,button:'left',clickCount:1});
    const afterDrag=await win.webContents.executeJavaScript(`document.querySelector('.sidebar').getBoundingClientRect().width`);
    if(afterDrag<=drag.width)throw new Error('mouse drag did not resize sidebar');
    console.log('Mouse drag PASS');
    for(const [width,height] of [[960,640],[1600,900]]) {
      win.setSize(width,height);
      const sizes=await win.webContents.executeJavaScript(`({scroll:document.querySelector('.main').scrollWidth,width:document.querySelector('.main').clientWidth})`);
      if(sizes.scroll>sizes.width+2)throw new Error('layout overflows at '+width+': '+JSON.stringify(sizes));
    }
    win.destroy(); app.exit(0);
  } catch(e) {console.error(e); win.destroy(); app.exit(1);}
});
