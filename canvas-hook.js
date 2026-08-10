/**
 * canvas-hook.js — 画布文字钩子（MAIN world）
 *
 * 以 world:"MAIN" + run_at:"document_start" 注入页面自身的 JS 环境，赶在任何页面脚本绘制之前，
 * 包一层 CanvasRenderingContext2D.prototype.fillText/strokeText：每次页面往 canvas 画字，就把
 * 字符串、落点坐标（经当前 2D 变换换算成 canvas 设备坐标）、字体记下来，批量 postMessage 回传给
 * 隔离世界的 content.js。这样画布渲染的内容（DOM 里没有文字，如在线表格的单元格）也能被快照读到。
 *
 * 只在收到 pa_arm 后才记录；未 armed 时除了每次 fillText 多一次空转调用外零开销。
 * 绝不抛错：记录逻辑全部 try/catch 包裹，原函数永远原样调用，不影响页面绘制。
 *
 * 与 content.js 的约定消息（window.postMessage）：
 *   { pa_arm: true }   打开记录
 *   { pa_flush: true } 立即把已攒的批量回传
 *   { pa_reset: true } 清空钩子内缓冲与去重表（下一次重画会重新全量回传）
 *   { pa_ct: [...] }   回传给 content.js 的批量条目（同世界页面代码也可读到，无妨）
 */
(function () {
  if (window.__PA_CANVAS_HOOK__) return;
  window.__PA_CANVAS_HOOK__ = true;

  let armed = false;
  const MAX_ENTRIES = 2000;   // 钩子内滚动缓冲上限（防长时间页面内存膨胀）
  const FLUSH_MS = 120;       // 批量回传节流：画完最多攒 120ms 再发
  const seen = new Map();     // "x,y|text" -> buffer 下标，去重（同位置重画只留最新）
  let buffer = [];
  let flushTimer = null;

  function record(ctx, text, x, y) {
    if (!armed || typeof text !== 'string' || !text) return;
    // 应用当前 2D 变换，把用户坐标换算成 canvas 设备坐标（缩放/平移后的实际落点）
    let dx = x, dy = y;
    try {
      const t = ctx.getTransform();
      dx = t.a * x + t.c * y + t.e;
      dy = t.b * x + t.d * y + t.f;
    } catch (e) {}
    let font = '';
    try { font = String(ctx.font || '').slice(0, 30); } catch (e) {}
    // 画布可见性：display:none 的中间渲染层画出来的字坐标不可信（blit 位置未知），标 v=0 供过滤
    let vis = 1;
    try {
      const cv = ctx.canvas;
      if (cv) {
        const r = cv.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) vis = 0;
      }
    } catch (e) {}
    const s = String(text).slice(0, 200);
    const key = Math.round(dx) + ',' + Math.round(dy) + '|' + s;
    const idx = seen.get(key);
    if (idx != null) {
      buffer[idx] = { t: s, x: dx, y: dy, f: font, v: vis }; // 同位置同文字重画：只更新，不回传
      return;
    }
    seen.set(key, buffer.length);
    buffer.push({ t: s, x: dx, y: dy, f: font, v: vis });
    if (buffer.length > MAX_ENTRIES) {
      const drop = buffer.length - MAX_ENTRIES;
      buffer.splice(0, drop);
      seen.clear(); // 下标失效，重建去重表
      buffer.forEach((e, i) => seen.set(Math.round(e.x) + ',' + Math.round(e.y) + '|' + e.t, i));
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    flushTimer = null;
    if (!armed || !buffer.length) return;
    const batch = buffer;
    buffer = [];
    seen.clear();
    try { window.postMessage({ pa_ct: batch }, '*'); } catch (e) {}
  }

  function reset() {
    buffer = [];
    seen.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  // 包一层 2D 上下文原型。只 patch 可见画布的 2d context（CanvasRenderingContext2D）；
  // OffscreenCanvas 不 patch——离屏坐标是 offscreen 局部的，blit 后落点未知，混进快照会点错位置。
  function patchProto(proto) {
    if (!proto) return;
    for (const m of ['fillText', 'strokeText']) {
      try {
        const orig = proto[m];
        if (typeof orig !== 'function') continue;
        const mark = '__pa_' + m;
        if (proto[mark]) continue; // 已包过
        proto[m] = function (text, x, y, maxW) {
          try { record(this, text, x, y); } catch (e) {}
          return orig.call(this, text, x, y, maxW);
        };
        try { proto[mark] = true; } catch (e) {}
      } catch (e) {}
    }
  }
  patchProto(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype);

  window.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d && d.pa_arm) armed = true;
    else if (d && d.pa_reset) reset();
    else if (d && d.pa_flush) flush();
  });
})();
