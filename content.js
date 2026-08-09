/**
 * content.js — PageAgent 内容脚本
 *
 * 职责：
 *  1. 页面加载完成后向 background 广播 AGENT_READY（用于跨页面续跑）。
 *  2. 响应 GET_SNAPSHOT：把当前页面抽象成"可交互元素快照 + 正文摘要"。
 *  3. 响应 EXECUTE_ACTION：执行点击 / 输入 / 选择 / 滚动 / 读取 / 按键等动作。
 *
 * 快照与执行之间用 ref 关联：构建快照时记录 ref -> {el, selector}，
 * 执行时优先用缓存元素，失效则回退到 CSS 选择器重新查询。
 */
(() => {
  if (window.__PAGE_AGENT__) return;
  window.__PAGE_AGENT__ = true;
  // 是否顶层 frame：content.js 现在注入【所有 frame】（manifest all_frames）。
  // 子窗口只被动参与教学录制（TEACH_START/TEACH_STOP）与 background 按 frameId 单独寻址的快照/动作，
  // 不广播 AGENT_READY、不抢主循环（避免 iframe 刷屏/重复续跑）。
  const IS_TOP_FRAME = (() => { try { return window.top === window; } catch (_) { return false; } })();

  const MAX_ELEMENTS = 60;   // 快照中可交互元素数量上限
  const TEXT_LIMIT = 1500;   // 正文摘要长度上限
  const READ_LIMIT = 6000;   // read 动作单次返回文本上限

  const INTERACTIVE = [
    'a', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="menuitem"]', '[role="tab"]', '[role="option"]', '[role="switch"]',
    '[role="combobox"]', '[role="slider"]', '[role="searchbox"]', '[role="textbox"]',
    '[contenteditable]', '[onclick]', '[tabindex]', '[data-testid]',
    '[aria-label]', '[aria-haspopup]', '[aria-expanded]', '[aria-selected]'
  ].join(',');

  let refMap = new Map(); // ref -> { el, selector }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 拟人化节奏：点击随机间隔 0.5s~2s（避免连点）；输入逐字、15ms~45ms/字（快但逐字）
  const humanClickGap = () => sleep(500 + Math.random() * 1500);
  const humanTypeGap = () => sleep(15 + Math.random() * 30);

  // 向 background 回报调试日志（有任务时才被记录到任务日志/面板）
  const logDebug = (m) => chrome.runtime.sendMessage({ type: 'AGENT_DEBUG', text: String(m) }).catch(() => {});
  if (IS_TOP_FRAME) {
    logDebug('内容脚本已注入 ' + location.href + ' · readyState=' + document.readyState);
  } else {
    // 子窗口注入不进任务日志（避免 iframe 刷屏淹没任务日志），只进页面控制台，便于排查 iframe 录制
    console.log('[PageAgent] 内容脚本已注入子窗口 ' + location.href + ' · readyState=' + document.readyState);
  }

  // ---------------- 可见性判断 ----------------
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  // ---------------- 动态可点元素识别 ----------------
  // JS 绑定的动态按钮（div/span/li…）没有 role/onclick/tabindex 等属性，快照默认看不到。
  // 判定"可点"不以 computed cursor 为准（:hover 才出手型、样式被覆盖都会误判），而是看元素上
  // 是否真的绑了点击处理器：
  //   ① 语义可点元素（a[href]/button/select/[role=…] 等）——已在主列表 INTERACTIVE 选择器覆盖；
  //   ② 内联 onclick（属性或 el.onclick property）——直接可测；
  //   ③ React 绑定的 onClick props——React 把 props 以 __reactProps$*/__reactEventHandler$* 标记
  //      挂在元素自身上（自有可枚举键），content script 能读到，这是现代动态 app 的"事件绑定"形态。
  //   ④ cursor:pointer 只作兜底候选：纯 addEventListener（老式 jQuery 页）无法从页面外探测监听器
  //      （getEventListeners 是 DevTools 专用）；委托绑定的卡片（单卡无处理器）同理。这类只能靠手型识别。
  // 候选集分三层：①整棵 DOM 的有界扫描（找带 React 标记/onclick 的元素，靠 Object.keys 前缀快筛）；
  // ②样式表显式声明 cursor:pointer 的选择器命中（pointerSelectors，缓存 3s）——避免对整棵 DOM
  // 逐个 getComputedStyle。类名本身不稳定（随机后缀），但"哪个选择器声明了手型"是稳定的；
  // ③样式表跨域读不到时，直接按运行时静止手型（严格 pointer）有界扫描兜底。
  let pointerSelCache = null;
  let pointerSelAt = 0;
  function pointerSelectors() {
    const now = Date.now();
    if (pointerSelCache && now - pointerSelAt < 3000) return pointerSelCache;
    pointerSelAt = now;
    const out = [];
    const seenSel = new Set();
    const stripPseudo = /:(?:hover|active|focus|focus-visible|focus-within|visited|disabled|checked)\s*/g;
    try {
      const walk = (rules) => {
        for (const r of rules) {
          if (!r) continue;
          if (r.cssRules) { walk(r.cssRules); continue; } // @media/@supports 嵌套
          if (!r.selectorText || !/cursor\s*:\s*pointer/.test(r.cssText)) continue;
          const sel = r.selectorText.replace(stripPseudo, '').trim();
          if (!sel || seenSel.has(sel)) continue;
          // 只收"类/属性"选择器（动态 app 靠 class/data-* 命中），跳过通配、纯 tag/id、兄弟组合
          if (sel === '*' || /[+~]/.test(sel) || !/[.\[]/.test(sel)) continue;
          seenSel.add(sel);
          out.push(sel);
          if (out.length >= 100) return;
        }
      };
      for (const sheet of document.styleSheets) {
        if (out.length >= 100) break;
        let rules = null;
        try { rules = sheet.cssRules; } catch (e) { continue; } // 跨域样式表读不到，跳过
        if (rules) walk(rules);
      }
    } catch (e) {}
    pointerSelCache = out;
    return out;
  }

  // 元素上是否绑了点击处理器：内联 onclick（属性或 property 赋值）/ React 挂载的 props 标记。
  // 注意 addEventListener 绑定从页面外无法枚举（无 getEventListeners），这类交给 cursor:pointer 兜底。
  function hasClickHandler(el) {
    try {
      if (el.onclick || el.hasAttribute('onclick')) return true;
      const ks = Object.keys(el); // 自有可枚举键：React 的 __reactProps$/__reactEventHandler$ 等在此
      for (const k of ks) {
        if (k.indexOf('__reactProps$') === 0) {
          const p = el[k];
          if (p && (p.onClick || p.onPointerDown || p.onMouseDown || p.onTouchStart)) return true;
        } else if (k.indexOf('__reactEventHandler$') === 0) {
          return true; // React 19 独立 handler 标记
        }
      }
    } catch (e) {}
    return false;
  }

  // ---------------- CSS 选择器生成 ----------------
  // 定位优先级：id → data-testid → input[name] → 纯位置(nth-of-type)。
  // 不用 class：动态 app 的类名常带随机后缀（如 home-layout--3rDKa），跨渲染不稳定；
  // 动态构建的可点元素改由快照按渲染后样式识别进 ref 列表（见 pointerSelectors），定位走 live ref → 位置兜底。
  function cssPath(el, maxDepth = 6) {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
    if (el.id) return '#' + esc(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < maxDepth) {
      if (cur.id) {
        parts.unshift('#' + esc(cur.id));
        break;
      }
      const testid = cur.getAttribute && cur.getAttribute('data-testid');
      if (testid) {
        parts.unshift(cur.tagName.toLowerCase() + '[data-testid="' + testid + '"]');
        break;
      }
      let sel = cur.tagName.toLowerCase();
      if (cur.getAttribute && cur.getAttribute('name') && cur.tagName === 'INPUT') {
        sel += '[name="' + cur.getAttribute('name') + '"]';
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(
          parent.children,
          (c) => c.tagName === cur.tagName
        );
        if (siblings.length > 1) {
          sel += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ---------------- 元素描述 ----------------
  // 是否"可输入内容的编辑器"：contenteditable / role=textbox|searchbox / textarea。
  // 文档平台的写作区基本是这类元素，Agent 需要能认出"这就是要打字的地方"。
  function isEditor(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return /(?:^|\s)(?:textbox|searchbox)(?:\s|$)/i.test(el.getAttribute('role') || '');
  }

  // 编辑器占位文字：占位符常不在标准 placeholder 属性里（文档平台多用 CSS ::before、
  // data-placeholder 等非标准属性、或子元素放提示文案），逐层尝试读出来，
  // 保证"空编辑器"也能让 Agent 认出它是写作区、不是某个不知道干嘛的空白 div。
  function placeholderOf(el) {
    const attrs = ['aria-label', 'placeholder', 'data-placeholder', 'data-placeholder-text', 'data-placeholder-content', 'aria-placeholder', 'title'];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && String(v).trim()) return String(v).trim();
    }
    // CSS 伪元素占位：getComputedStyle 可读 ::before/::after 的 content（如 content:"请输入正文"）
    for (const p of ['::before', '::after']) {
      try {
        const c = getComputedStyle(el, p).content;
        if (c && c !== 'none' && c !== 'normal') {
          const t = String(c).replace(/^["']|["']$/g, '').trim();
          if (t) return t;
        }
      } catch (_) {}
    }
    // 子元素占位：部分实现用带 data-placeholder 的 span / .placeholder 存提示
    try {
      const ph = el.querySelector('[data-placeholder], [data-placeholder-text], .placeholder, [contenteditable="false"]');
      if (ph) {
        const t = (ph.textContent || ph.getAttribute('data-placeholder') || '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    } catch (_) {}
    return '';
  }

  function describe(el, ref) {
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'button') role = 'button';
      else if (tag === 'a') role = 'link';
      else if (tag === 'select') role = 'select';
      else if (tag === 'textarea') role = 'textarea';
      else if (tag === 'input') role = el.type || 'text';
      else if (el.isContentEditable) role = 'editable';
      else if (el.hasAttribute('onclick')) role = 'clickable';
    }
    const text = (el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    let hint = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.alt ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    // 编辑器没写出标准 hint 时补占位文字；仍是空的编辑器明确标"(空编辑区)"，
    // 让 Agent 知道"这是个空的可写区域"，不会把它当无用的空白元素跳过或拿不准是不是写作区
    if (isEditor(el)) {
      if (!hint) hint = placeholderOf(el).slice(0, 80);
      if (!hint && !text) hint = '(空编辑区)';
    }
    const value =
      tag === 'input' || tag === 'select' || tag === 'textarea'
        ? String(el.value || '').slice(0, 40)
        : '';
    return {
      ref,
      role,
      tag,
      text,
      hint,
      value,
      disabled: !!el.disabled,
      selector: cssPath(el)
    };
  }

  // ---------------- 构建页面快照 ----------------
  // mapOut 可选：排查模式传临时 Map，收集"ref -> 元素"映射而不覆盖 agent 正在用的 refMap，
  // 避免诊断时把 agent 已生成的 ref 编号冲掉、导致它下一步动作定位错元素。
  function buildSnapshot(mapOut) {
    const map = mapOut instanceof Map ? mapOut : refMap;
    const items = [];
    const seen = new Set();
    let ref = 0;

    const nodes = document.querySelectorAll(INTERACTIVE);
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (seen.has(el)) continue;

      // 父级已被收录（嵌套可点元素，如 button 里的 a），跳过以去噪
      let p = el.parentElement;
      let nested = false;
      while (p && p !== document.body) {
        if (seen.has(p)) { nested = true; break; }
        p = p.parentElement;
      }
      if (nested) continue;

      if (ref >= MAX_ELEMENTS) break;
      seen.add(el);
      const item = describe(el, ++ref);
      map.set(ref, { el, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
      items.push(item);
    }

    // 动态构建的可点元素（无 role/onclick/tabindex 属性的 div/span 按钮等）：
    // 主列表没填满时补扫，让 agent 在纯 JS 动态 app（如腾讯文档）里也能看到并点击这类元素。
    // 判定"可点"看是否绑了点击处理器（见 hasClickHandler：内联 onclick / React props），
    // cursor:pointer 样式只作兜底候选（纯 addEventListener 的旧页面无法从外部探测处理器）。
    if (ref < MAX_ELEMENTS) {
      let checked = 0;
      const maxCheck = 1500;
      // 收录判定：可见 + 自带文字/aria + 父级未收录（避免整块容器重复收进来）
      const tryAdd = (el) => {
        if (ref >= MAX_ELEMENTS || checked >= maxCheck) return false;
        checked++;
        if (seen.has(el) || !isVisible(el)) return true;
        if (!(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.alt) return true;
        let p = el.parentElement;
        while (p && p !== document.body) {
          if (seen.has(p)) return true;
          p = p.parentElement;
        }
        seen.add(el);
        const item = describe(el, ++ref);
        item.dynamic = true; // 标记：动态识别进列表的元素
        map.set(ref, { el, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
        items.push(item);
        return true;
      };
      // 候选 1：整棵 DOM 有界扫描，收"确实绑了点击处理器"的元素（React 绑定是现代 app 主流，
      // 只有这类元素才带 __reactProps$/__reactEventHandler$ 标记，普通元素 Object.keys 为空、开销小）。
      let walked = 0;
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let n = tw.currentNode;
      while ((n = tw.nextNode()) && ref < MAX_ELEMENTS && checked < maxCheck && walked < maxCheck) {
        walked++;
        if (!hasClickHandler(n)) continue;
        if (!tryAdd(n)) break;
      }
      // 候选 2：样式表显式声明 cursor:pointer 的选择器命中 + 内联 cursor（兜底 addEventListener 老页面）。
      // 命中即说明作者标了手型，不再逐个校验 computed cursor（:hover 才出手型、被覆盖等情况都照收）。
      const dynSel = pointerSelectors().concat('[style*="cursor"]').join(',');
      if (dynSel) {
        for (const el of document.querySelectorAll(dynSel)) {
          if (ref >= MAX_ELEMENTS || checked >= maxCheck) break;
          if (seen.has(el)) continue;
          if (!tryAdd(el)) break;
        }
      }
      // 候选 3：样式表跨域读不到（CDN 托管无 CORS）时的兜底——直接按运行时手型找，不依赖样式表。
      // 只收确凿的静止手型 pointer（不收 auto），避免重演 hover-only 才出手型的误判；有界扫描防止大页卡顿。
      // cursor 至此是最后一层信号：前有语义元素、真实处理器、样式表声明三层优先。
      if (ref < MAX_ELEMENTS) {
        let c3 = 0;
        const tw3 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let n3 = tw3.currentNode;
        while ((n3 = tw3.nextNode()) && ref < MAX_ELEMENTS && c3 < 800 && checked < maxCheck) {
          c3++;
          if (seen.has(n3)) continue;
          const t3 = n3.tagName;
          if (t3 === 'HTML' || t3 === 'BODY' || t3 === 'SCRIPT' || t3 === 'STYLE' || t3 === 'HEAD' || t3 === 'LINK' || t3 === 'META' || t3 === 'TITLE') continue;
          if (!(n3.textContent || '').trim() && !n3.getAttribute('aria-label') && !n3.getAttribute('title') && !n3.alt) continue;
          let cur;
          try { cur = getComputedStyle(n3).cursor; } catch (e) { continue; }
          if (cur !== 'pointer') continue;
          if (!tryAdd(n3)) break;
        }
      }
    }

    const bodyText = (document.body ? document.body.innerText : '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TEXT_LIMIT);

    // 主窗口 DOM 里的直接子 iframe 清单（src 前缀）：供 background 用 getAllFrames 交叉校验枚举是否完整。
    // 弹层/卡片常是动态后插的 iframe，webNavigation.getAllFrames 偶尔读漏，DOM 清单是"该窗口确实存在"的硬证据，
    // background 据此触发枚举重试，避免"弹层其实开着但快照只显示 1 个窗口 → Agent 误以为没开而反复重按按钮"。
    const iframeSrcs = [];
    try {
      const nodes = document.querySelectorAll('iframe');
      for (const f of nodes) {
        if (iframeSrcs.length >= 20) break;
        const src = (f.getAttribute && f.getAttribute('src')) || f.src || '';
        if (src) iframeSrcs.push(String(src).slice(0, 200));
        else if (f.hasAttribute && f.hasAttribute('srcdoc')) iframeSrcs.push('[srcdoc]');
      }
    } catch (e) {}
    return {
      url: location.href,
      title: document.title,
      elements: items,
      excerpt: bodyText,
      iframes: iframeSrcs
    };
  }

  // ---------------- 通过 ref 定位元素 ----------------
  function findTarget(ref) {
    const entry = refMap.get(ref);
    if (!entry) return null;
    if (document.contains(entry.el)) return entry.el;
    try {
      return document.querySelector(entry.selector);
    } catch (e) {
      return null;
    }
  }

  // 找不到目标时的友好提示：带上快照时的元素描述，而不是只给裸 ref 编号
  function notFoundMsg(ref) {
    const entry = refMap.get(ref);
    const desc = entry && entry.desc ? entry.desc : null;
    return desc ? '未找到「' + desc + '」' : ('未找到目标 ref=' + ref);
  }

  // ---------------- 按文字找元素（clickText 兜底用） ----------------
  // 大模型对页面文字做语义判断、直接试点列表外元素时，用文字在 DOM 里定位最具体的元素。
  // 先扫文本节点做包含匹配（只走字符串判断、开销小），找不到再退回元素 textContent 扫描
  // （目标文字跨了多个文本节点/容器边界时兜底）。命中取"文本最短且可见"者——最短的通常
  // 是最贴近文字的那个叶子（按钮/链接/卡片），而不是包住整页的容器。
  function findElementByText(text) {
    const target = String(text || '').replace(/\s+/g, ' ').trim();
    if (!target || !document.body) return null;
    const cands = [];
    let checked = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode()) && checked++ < 3000) {
      const s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (s.indexOf(target) !== -1) {
        const p = n.parentElement;
        if (p) cands.push({ el: p, len: s.length });
      }
    }
    checked = 0;
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let m;
    while ((m = w2.nextNode()) && checked++ < 3000) {
      const s = String(m.textContent || '').replace(/\s+/g, ' ').trim();
      if (s.indexOf(target) !== -1) cands.push({ el: m, len: s.length });
    }
    cands.sort((x, y) => x.len - y.len); // 文本最短的命中优先（最贴近文字本身）
    for (const c of cands) {
      if (c.len > Math.max(target.length * 3, 20)) break; // 匹配文本太长≈命中整块容器，放弃
      if (isVisible(c.el)) return c.el;
    }
    return cands.length ? cands[0].el : null; // 没有可见命中也退回最短匹配，兜底允许赌一把
  }

  // 元素是否"像可点的"：语义可点标签 / 角色 / 绑了点击处理器 / 手型。供 clickText 从命中文字向上找可点元素。
  function isLikelyClickable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return true;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (/button|link|menuitem|option|tab|checkbox|radio|switch/.test(role)) return true;
    if (hasClickHandler(el)) return true;
    try { return getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; }
  }

  // ---------------- 动作执行 ----------------
  // 从 aria-label / role / input type / id / class / name 推断元素的"功能名"（如「搜索框」「登录按钮」）。
  // 功能名优先于框内文字/占位文字——后者可能是输入的内容或默认值，不是元素本身的称呼。
  function functionalLabel(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    const isBox = tag === 'input' || tag === 'textarea' || el.isContentEditable;
    const isBtn = tag === 'button' || role === 'button';

    const roleMap = {
      search: '搜索框', textbox: '输入框', combobox: '下拉框', checkbox: '复选框',
      radio: '单选框', switch: '开关', slider: '滑块', button: '按钮', link: '链接',
      tab: '标签页', menuitem: '菜单项', option: '选项'
    };
    if (roleMap[role]) return roleMap[role];

    if (tag === 'input') {
      const typeMap = {
        search: '搜索框', password: '密码输入框', email: '邮箱输入框', tel: '手机号输入框',
        number: '数字输入框', url: '网址输入框', date: '日期', time: '时间', file: '上传',
        checkbox: '复选框', radio: '单选框', range: '滑块'
      };
      const it = String(el.type || 'text').toLowerCase();
      if (typeMap[it]) return typeMap[it];
    }

    // 拆 id/class/name 的驼峰与分隔符得到候选词，再查中英词典（靠前的优先级高）
    const raw = [el.id, (el.getAttribute && el.getAttribute('class')), (el.getAttribute && el.getAttribute('name'))]
      .filter((s) => s && String(s).trim())
      .map((s) => String(s))
      .join(' ')
      .toLowerCase();
    if (!raw.trim()) return '';
    const tokens = new Set(
      raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')       // camelCase 拆词，如 searchInput → search input
        .replace(/[^a-z0-9一-龥]+/g, ' ')     // 分隔符转空格，如 search-box → search box
        .split(/\s+/)
        .filter(Boolean)
    );
    const dict = [
      ['search', '搜索'], ['sousuo', '搜索'], ['kw', '搜索'], ['wd', '搜索'], ['q', '搜索'], ['搜索', '搜索'],
      ['username', '用户名'], ['account', '账号'],
      ['password', '密码'], ['passwd', '密码'], ['pwd', '密码'],
      ['email', '邮箱'], ['mail', '邮箱'],
      ['phone', '手机号'], ['mobile', '手机号'], ['tel', '手机号'],
      ['address', '地址'], ['city', '城市'], ['province', '省份'], ['country', '国家'],
      ['keyword', '关键词'], ['query', '关键词'],
      ['login', '登录'], ['signin', '登录'], ['logout', '退出登录'], ['登录', '登录'],
      ['submit', '提交'], ['confirm', '确认'], ['save', '保存'],
      ['send', '发送'], ['share', '分享'], ['copy', '复制'], ['paste', '粘贴'],
      ['delete', '删除'], ['remove', '删除'], ['cancel', '取消'],
      ['edit', '编辑'], ['add', '添加'], ['create', '创建'],
      ['download', '下载'], ['upload', '上传'],
      ['comment', '评论'], ['reply', '回复'], ['message', '消息'],
      ['filter', '筛选'], ['sort', '排序'], ['menu', '菜单'],
      ['settings', '设置'], ['setting', '设置'], ['config', '设置'],
      ['next', '下一页'], ['prev', '上一页'], ['previous', '上一页'], ['back', '返回'],
      ['close', '关闭'], ['open', '打开'],
      ['title', '标题'], ['name', '名称'], ['price', '价格'], ['amount', '金额'],
      ['date', '日期'], ['time', '时间'], ['avatar', '头像'], ['photo', '照片'], ['image', '图片']
    ];
    for (const [kw, zh] of dict) {
      if (tokens.has(kw)) {
        if (isBox) return zh === '搜索' ? '搜索框' : zh + '输入框';
        if (isBtn) return zh + '按钮';
        return zh;
      }
    }
    return '';
  }

  // 给使用者看的元素标签（点击/输入目标的名称），简短即可。
  // 优先 aria-label 与功能名，其次才是框内文字/占位文字。
  function elementLabel(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && String(aria).trim()) return String(aria).trim().replace(/\s+/g, ' ').slice(0, 30);
    const fn = functionalLabel(el);
    if (fn) return fn;
    const t = (el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.slice(0, 30);
  }

  function setNativeValue(el, value, withChange) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (withChange !== false) el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 合成"鼠标移入"事件序列：把元素滚动到视野内，然后朝它的中心按 pointer + mouse 两套
  // （pointerover/enter/move + mouseover/enter/move）派发，覆盖 React（onMouseEnter/onPointerEnter）、
  // jQuery、原生监听等主流绑定方式，让悬浮才展开的菜单/操作项显示出来。
  // 注意：纯 CSS `:hover`（display:none → :hover 才显示）无法被合成事件触发，这类元素 Agent 会看到
  // 快照里没有对应项，需用 ask_user/teach 兜底；绝大多数 JS 框架的悬浮菜单都靠事件监听，可正常触发。
  function dispatchHover(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 0,
      clientX: r.left + Math.max(1, Math.min(4, r.width / 2)),
      clientY: r.top + Math.max(1, Math.min(4, r.height / 2))
    };
    const fire = (type) => {
      const Ctor = (typeof PointerEvent !== 'undefined' && type.indexOf('pointer') === 0) ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, opts)); } catch (e) {}
    };
    fire('pointerover'); fire('pointerenter'); fire('mouseover'); fire('mouseenter');
    fire('mousemove'); fire('pointermove');
  }

  function keyCode(key) {
    const map = {
      Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32
    };
    return map[key] || 0;
  }

  // 找页面主滚动容器（window 滚动失败时的兜底）：取 overflow 可滚动且滚动空间最大的元素
  function findMainScrollable() {
    let best = null, bestLen = 0, scanned = 0;
    for (const el of document.querySelectorAll('main, section, article, div')) {
      if (++scanned > 2000) break;
      const s = getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
      const len = el.scrollHeight - el.clientHeight;
      if (len > 40 && len > bestLen) { bestLen = len; best = el; }
    }
    return best;
  }

  async function executeAction(a) {
    return executeActionInner(a);
  }

  async function executeActionInner(a) {
    switch (a.action) {
      case 'click': {
        const el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };

        // 点击"会新开页面"的链接（target="_blank"）时，浏览器默认会新开标签并抢前台焦点。
        // 这里不真正点击，而是把 href 交给 background 用后台标签打开并纳入 @T（Agent 自开），
        // 与 open_tab 语义一致：不抢焦点、不打扰使用者浏览。
        const anchor = el.closest ? el.closest('a') : null;
        if (anchor) {
          const tgt = String(anchor.target || anchor.getAttribute('target') || '').trim().toLowerCase();
          const href = anchor.getAttribute('href');
          if (tgt === '_blank' && href && /^(https?|file):/i.test(href)) {
            return { ok: true, openTab: new URL(href, location.href).href, label: elementLabel(el) };
          }
        }

        await humanClickGap(); // 拟人：随机 0.5s~2s，避免快速连点
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        el.click();
        el.focus();
        return { ok: true, label: elementLabel(el) };
      }

      case 'clickText': { // 兜底：元素列表解决不了时，大模型对页面文字做语义判断、直接试点"可能可点"的文字
        const raw = String(a.text || '').trim();
        if (!raw) return { ok: false, message: 'clickText 缺少要点的文字 text' };
        const el = findElementByText(raw);
        if (!el) return { ok: false, message: '页面上没找到文字「' + raw.slice(0, 30) + '」' };
        // 从命中文字向上找最近的"可点"元素（自身或祖先：a/button/[role]/绑了点击处理器/手型），
        // 找不到可点的就点命中元素本身——兜底本就允许赌一把。
        let target = el;
        for (let d = 0; d < 6; d++) {
          if (isLikelyClickable(target)) break;
          target = target.parentElement;
          if (!target || target === document.body) break;
        }
        if (!target || !target.tagName || target === document.body || target === document.documentElement) target = el;
        // 命中"会新开页面"的链接时同样截获，交给 background 后台打开（不抢焦点），与 click 一致
        const anchor = target.closest ? target.closest('a') : null;
        if (anchor) {
          const tgt = String(anchor.target || anchor.getAttribute('target') || '').trim().toLowerCase();
          const href = anchor.getAttribute('href');
          if (tgt === '_blank' && href && /^(https?|file):/i.test(href)) {
            return { ok: true, openTab: new URL(href, location.href).href, label: elementLabel(el) };
          }
        }
        await humanClickGap(); // 拟人：随机 0.5s~2s，避免快速连点
        try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
        target.click();
        target.focus();
        return { ok: true, label: elementLabel(el), byText: true };
      }

      case 'hover': { // 悬浮在元素上（不点击），用于让"悬浮才出现"的元素显示出来；发完合成事件等渲染
        const el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };
        dispatchHover(el);
        await sleep(600); // 等悬浮展开的菜单/操作项渲染完，background 下一步快照才能看到
        return { ok: true, label: elementLabel(el), hovered: true };
      }

      case 'type': {
        const t0 = performance.now(); // 记录开始时间，用于判定"输入卡住超过 10 秒"
        const el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };
        el.focus();
        const text = String(a.text ?? '');
        if (el.isContentEditable) {
          // 富文本编辑器（ProseMirror/Slate/Quill/腾讯文档等）不走 textContent，
          // 直接赋 textContent 进不了它们的内部模型、内容不渲染，看起来就像"没开始写"。
          // 正路是走 document.execCommand('insertText')，它会进编辑器内部状态、触发它们自己的
          // 事件；全选（覆盖语义）后再逐字插入，模拟真人打字节奏。
          try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          let insertedAll = true;
          for (const ch of text) {
            let ok = false;
            try { ok = document.execCommand('insertText', false, ch); } catch (e) { ok = false; }
            if (!ok) { insertedAll = false; break; } // 不支持 insertText：退回下面整段兜底
            await humanTypeGap(); // 逐字输入
          }
          if (!insertedAll) {
            // 兜底：不认 execCommand 的编辑器，直接整段替换 DOM + 派发 input
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
          }
        } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          setNativeValue(el, '', false); // 覆盖原内容
          for (const ch of text) {
            setNativeValue(el, el.value + ch, false);
            await humanTypeGap(); // 逐字输入
          }
          setNativeValue(el, el.value, true); // 收尾触发 change
        } else {
          return { ok: false, message: '目标不是可输入元素（' + el.tagName + '）' };
        }
        // 输入落地校验 + 超时判定：后台标签常被浏览器节流、或网站没接受合成输入（打进去又回退），
        // 此时 inputStuck=true 让后台非阻塞地提醒使用者介入（Agent 不等待、继续执行）。
        let inputStuck = false;
        if (text.trim() !== '') {
          await sleep(350); // 等一拍，让网站处理合成 input 事件 / 受控组件回写后再验
          const got = el.isContentEditable ? (el.textContent || '') : (el.value || '');
          inputStuck = got.trim() === '';
        }
        if (performance.now() - t0 > 10000) inputStuck = true;
        return { ok: true, label: elementLabel(el), inputStuck, ms: Math.round(performance.now() - t0) };
      }

      case 'select': {
        const el = findTarget(a.target);
        if (!el || el.tagName !== 'SELECT') return { ok: false, message: '目标不是下拉框' };
        el.value = a.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value, label: elementLabel(el) };
      }

      case 'scroll': {
        const dir = a.direction || 'down';
        const amount = a.amount || Math.floor(window.innerHeight * 0.8);
        const delta = dir === 'down' ? amount : -amount;
        const before = window.scrollY;
        window.scrollBy({ top: delta, behavior: 'instant' });
        const moved = Math.abs(window.scrollY - before);
        if (moved === 0) {
          // window 没动 → 页面滚动容器是内层 div（overflow:auto），找主滚动容器兜底
          const el = findMainScrollable();
          if (el) {
            const eb = el.scrollTop;
            el.scrollBy({ top: delta, behavior: 'instant' });
            return { ok: true, moved: Math.abs(el.scrollTop - eb) };
          }
        }
        return { ok: true, moved };
      }

      case 'read': {
        let el;
        if (a.target === 'page' || a.target == null) el = document.body;
        else el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };
        const text = (el.innerText || el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          ok: true,
          text: text.slice(0, READ_LIMIT),
          length: text.length,
          truncated: text.length > READ_LIMIT
        };
      }

      case 'keypress': {
        const el = document.activeElement || document.body;
        for (const k of String(a.keys || '').split(',').map((s) => s.trim())) {
          const code = keyCode(k);
          el.dispatchEvent(new KeyboardEvent('keydown', { key: k, keyCode: code, which: code, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: k, keyCode: code, which: code, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: k, keyCode: code, which: code, bubbles: true }));
        }
        // 只有真正聚焦了可交互元素时才报元素标签；聚焦 body 则留空，让面板显示按键本身
        const focused = document.activeElement;
        const hasTarget = focused && focused !== document.body && focused !== document.documentElement;
        return { ok: true, label: hasTarget ? elementLabel(focused) : '' };
      }

      default:
        return { ok: false, message: '内容脚本不支持的动作：' + a.action };
    }
  }

  // ---------------- 教我模式：页面事件录制 ----------------
  // 使用者在页面上手把手演示时，录制可信用户事件（点击/输入/下拉/回车提交），
  // 供 Agent 学习并沉淀成该站操作技巧。仅录 e.isTrusted（真实用户操作，滤掉脚本/扩展派发的事件）。
  let teachOn = false;
  let teachBuf = [];         // 待上报事件缓冲
  let teachTimer = null;     // 批量上报定时器
  let teachVals = new Map(); // sel -> {label, value}，尚未提交的输入值（input 只记最新值，change/回车才落账）
  let teachHover = null;     // 最近悬浮过的"可悬浮区域"：{el, sel, label, time, clicked}，用于把"悬浮才出现"的元素记成一步
  const TEACH_MAX = 100;     // 单次教学录制条数上限，防刷爆
  const TEACH_HOVER_WINDOW = 5000; // 悬浮后多久内的点击/输入算"靠这次悬浮揭示"，超过视为无关

  // 元素所属的"浮层容器"（门户弹层）：position:fixed 或挂在 body/viewport 上的 absolute（AntD/Element 等
  // React 下拉菜单渲染在 body 下的 portal 里，点中的菜单项不在悬浮区域 DOM 树里，靠浮层与悬浮区域重叠识别）
  function floatingOverlayOf(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if (st.position === 'fixed' || (st.position === 'absolute' && cur.offsetParent === null)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function boxesIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  // 悬浮区域与浮层的"紧邻覆盖"判定：React 下拉 portal 常紧贴悬浮元素下方/附近（之间可能有一小段间隙），
  // 把悬浮区域 H 的框外扩 240px 再与浮层判重叠，覆盖"下拉与触发点有小间隙"的情况
  function overlayOverlapsRegion(regionEl, ov) {
    try {
      const hb = regionEl.getBoundingClientRect();
      const ob = ov.getBoundingClientRect();
      const infl = 240;
      return boxesIntersect(
        { left: hb.left - infl, right: hb.right + infl, top: hb.top - infl, bottom: hb.bottom + infl },
        ob
      );
    } catch (_) { return false; }
  }

  // 悬浮区域的"可悬浮根"：从鼠标下最内层元素向上找，优先命中有可交互标记的元素（按钮/链接/role 等），
  // 否则取最外层手型（cursor:pointer）祖先——这样悬浮在"行"上时 region 落在整行而非行内文本 span，
  // 悬浮才出现的行内操作按钮才能被识别为"这个 region 展开的后代"。
  function nearestHoverable(el) {
    let cur = el;
    let outer = null;
    let depth = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
      if (cur.matches && cur.matches(INTERACTIVE)) return cur;
      try { if (getComputedStyle(cur).cursor === 'pointer') outer = cur; } catch (_) {}
      cur = cur.parentElement;
      depth++;
    }
    return outer;
  }

  // 悬浮跟踪：只记录"看起来可悬浮"的区域（可交互标记或 cursor:pointer，见 nearestHoverable），
  // 在区域内移动（含悬浮进它展开的下拉菜单）保持区域根不变，移出到其它区域才换。
  function teachOnMouseover(e) {
    if (!teachOn || !e.isTrusted) return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    const reg = nearestHoverable(el);
    if (!reg) return; // 悬在纯文本/空白容器上，不构成可悬浮区域
    const H = teachHover;
    if (H && H.el) {
      if (H.el === reg || (H.el.contains && H.el.contains(reg))) { H.time = Date.now(); return; } // 区域/其展开内容内移动
      // 移进了 H 揭示的门户浮层（React 下拉）：仍算 H 的揭示范围，保持 H 不换，否则会丢掉"是谁悬浮出来的"
      const ov = floatingOverlayOf(reg);
      if (ov && overlayOverlapsRegion(H.el, ov)) { H.time = Date.now(); return; }
    }
    teachHover = { el: reg, sel: cssPath(reg), label: teachLabel(reg), time: Date.now(), clicked: false };
  }

  // 交互落账前判断：这次交互的目标 Y 是不是"靠悬浮才出现的"——悬浮区域 H 是 Y 的祖先（行内展开），
  // 或 Y 在门户浮层里且浮层与 H 重叠（React 下拉）。是的话，把这次悬浮补记成一步，回放时先悬浮再操作。
  function teachMaybeHover(Y) {
    if (!teachOn) return;
    const H = teachHover;
    if (!H || !H.el) return;
    if (Date.now() - H.time > TEACH_HOVER_WINDOW) { teachHover = null; return; } // 悬浮太久前的动作，无关
    if (H.el === Y) { H.clicked = true; return; } // 直接点悬浮区域本身 → 揭示来自那次点击（开关按钮），不算悬浮步
    if (H.clicked) return;                        // 区域本身已被点过 → 揭示来自点击而非悬浮
    let revealed = false;
    if (H.el.contains && H.el.contains(Y)) {
      revealed = true; // 悬浮展开的后代（行内悬浮才出现的操作按钮/下拉菜单）
    } else {
      const ov = floatingOverlayOf(Y);
      if (ov && overlayOverlapsRegion(H.el, ov)) revealed = true; // 门户浮层（React 下拉）里且紧邻悬浮区域
    }
    if (!revealed) return;
    teachPush({ t: 'hover', sel: H.sel, label: H.label });
    teachLog('HOVER 记录 悬浮「' + H.label + '」(' + (H.el.contains(Y) ? '展开后代' : '门户浮层') + ') → 先记一步');
    teachHover = null; // 已消费，避免下个交互重复补悬浮
  }



  // 教我模式调试日志：同时进【页面控制台】与【SW 控制台】（AGENT_DEBUG 转发），排查"漏录步骤"用。
  // 每一条都带 [Teach] 前缀，方便在控制台里过滤。
  function teachLog(...args) {
    const line = args.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(' ');
    console.log('[Teach] ' + line);
    chrome.runtime.sendMessage({ type: 'AGENT_DEBUG', text: '教录 ' + line }).catch(() => {});
  }

  // 调试用：值的隐私化摘要（密码框只显示框名不显示内容，其它值截断到 40 字符）
  function teachValSummary(el, val) {
    const v = String(val == null ? '' : val);
    if ((el && el.type === 'password') || /密码|password/i.test(v)) return '[密码]';
    return v.length > 40 ? v.slice(0, 40) + '…(' + v.length + '字)' : v;
  }

  // 事件的"控件名"（给使用者/Agent 看），复用快照的 elementLabel；
  // 可点击控件优先用【可见文字】（如菜单项"空白文档"——比从 id/class 推出的功能名"创建按钮"更贴近使用者点的那一下），
  // 图标按钮等无字时再退回功能名，避免回放里两个不同按钮重名、让"某一步"看起来像没记录。
  function teachLabel(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    const clickable = tag === 'button' || tag === 'a' || role === 'button' || role === 'menuitem' ||
      role === 'link' || role === 'tab' || (el.getAttribute && el.getAttribute('onclick')) ||
      !!(el.closest && el.closest('button, a, [role=button], [role=menuitem], [onclick]'));
    if (clickable) {
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt && txt.length <= 30) return txt;
    }
    return elementLabel(el) || tag;
  }

  function teachPush(rec) {
    if (!teachOn) {
      teachLog('PUSH被忽略（录制已关闭） rec=' + JSON.stringify(rec));
      return;
    }
    if (teachBuf.length >= TEACH_MAX) {
      if (teachBuf.length === TEACH_MAX) {
        logDebug('教我模式：录制已达 ' + TEACH_MAX + ' 条上限，忽略后续事件');
        teachLog('PUSH被忽略（达上限） rec=' + JSON.stringify(rec));
      }
      return;
    }
    teachBuf.push(rec);
    teachLog('PUSH ' + rec.t + ' sel=' + rec.sel + ' label=' + (rec.label || '') + ' value=' + (rec.value != null ? rec.value : (rec.text || '')) + ' → 缓冲=' + teachBuf.length + ' 条');
  }

  function teachFlush() {
    if (!teachBuf.length) return;
    const batch = teachBuf;
    teachBuf = [];
    teachLog('FLUSH 上报 ' + batch.length + ' 条 [' + batch.map((r) => r.t).join(',') + '] → background');
    chrome.runtime.sendMessage({ type: 'TEACH_EVENT', events: batch }).catch(() => {});
  }

  function teachScheduleFlush() {
    if (teachTimer) return;
    teachLog('SCHEDULE 800ms 后批量上报');
    teachTimer = setTimeout(() => { teachTimer = null; teachFlush(); }, 800);
  }

  // 点按的"目标归属"：e.target 常是最内层文本/图标（span/svg/i），向上归到最近的有明确可交互标记的
  // 祖先（复用 INTERACTIVE，只会命中 a/button/[role]/[onclick]/[tabindex] 等真可点控件，
  // 不会误爬到 role="dialog"/"main" 这类容器），让录制步骤指向"用户感知里被点的那一下"，复现更稳。
  function clickableAncestor(el) {
    let cur = el.parentElement;
    let depth = 0;
    while (cur && cur !== document.body && depth < 6) {
      if (cur.matches && cur.matches(INTERACTIVE)) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return el;
  }

  function teachOnClick(e) {
    if (!e.isTrusted) {
      teachLog('CLICK 忽略（e.isTrusted=false，脚本派发） tag=' + (e.target && e.target.tagName));
      return;
    }
    const el = e.target;
    if (el === document.body || el === document.documentElement) {
      teachLog('CLICK 忽略（点空白） tag=' + el.tagName);
      return; // 点空白不构成步骤
    }
    // 按钮型 input（submit/button/reset，如"登录/搜索"按钮）是明确的点击动作，必须记录
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase())) {
      const a = el.closest && el.closest('a');
      teachLog('CLICK 记录（按钮型 input） tag=' + el.tagName + ' type=' + el.type + ' value=' + (el.value || ''));
      teachMaybeHover(el); // 悬浮揭示出的按钮：先补记悬浮步
      teachPush({ t: 'click', sel: cssPath(el), label: teachLabel(el), href: (a && a.href) || '' });
      teachScheduleFlush();
      return;
    }
    // 其它输入控件上的点击由输入/选择/回车提交事件体现，不构成独立步骤
    const inInput = el.closest && el.closest('input, textarea, select, [contenteditable]');
    if (inInput) {
      teachLog('CLICK 跳过（落在输入控件 ' + inInput.tagName + '#' + inInput.type + ' 上 = 聚焦动作，由输入/提交体现） tag=' + el.tagName);
      return;
    }
    const tgt = clickableAncestor(el); // 内层文本/图标 → 归到真正承载点击的控件
    const a = tgt.closest && tgt.closest('a');
    teachLog('CLICK 记录（' + (tgt === el ? '原生可点' : '内层 ' + el.tagName + ' 上归到 ' + tgt.tagName) + '） sel=' + cssPath(tgt) + ' label=' + teachLabel(tgt) + (a && a.href ? ' href=' + a.href : ''));
    teachMaybeHover(tgt); // 悬浮揭示出的目标：先补记悬浮步，回放时先悬浮再点
    teachPush({ t: 'click', sel: cssPath(tgt), label: teachLabel(tgt), href: (a && a.href) || '' });
    teachScheduleFlush();
  }

  function teachOnInput(e) {
    if (!e.isTrusted) {
      teachLog('INPUT 忽略（非可信） tag=' + (e.target && e.target.tagName));
      return;
    }
    if (!e.target || e.target.tagName === 'SELECT') return;
    const el = e.target;
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) {
      teachLog('INPUT 忽略（非输入控件） tag=' + el.tagName);
      return;
    }
    const sel = cssPath(el);
    teachVals.set(sel, { label: teachLabel(el), value: el.value });
    teachLog('INPUT 暂存 sel=' + sel + ' label=' + teachLabel(el) + ' value=' + teachValSummary(el, el.value) + ' → 待定输入 ' + teachVals.size + ' 个');
    teachScheduleFlush();
  }

  // 输入提交（blur/失焦）与下拉选择：最终值落账，避免逐键噪声
  function teachOnChange(e) {
    if (!e.isTrusted) {
      teachLog('CHANGE 忽略（非可信） tag=' + (e.target && e.target.tagName));
      return;
    }
    if (!e.target) return;
    const el = e.target;
    const sel = cssPath(el);
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      teachLog('CHANGE 记录 select sel=' + sel + ' label=' + teachLabel(el) + ' 选中=' + ((opt && opt.text) || '') + ' value=' + el.value);
      teachMaybeHover(el); // 悬浮揭示出的下拉：先补记悬浮步
      teachPush({ t: 'select', sel, label: teachLabel(el), value: el.value, text: (opt && opt.text) || '' });
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
      teachVals.delete(sel); // 已提交，移出待定输入
      teachLog('CHANGE 落账 type sel=' + sel + ' label=' + teachLabel(el) + ' value=' + teachValSummary(el, el.value));
      teachMaybeHover(el); // 悬浮揭示出的输入框：先补记悬浮步
      teachPush({ t: 'type', sel, label: teachLabel(el), value: el.value });
    } else {
      teachLog('CHANGE 忽略（非输入/选择控件） tag=' + el.tagName);
    }
    teachScheduleFlush();
  }

  // 输入框上按回车 = 提交动作；若此前没失焦过，把未落账的输入值一并补记
  function teachOnKeydown(e) {
    if (!e.isTrusted || e.key !== 'Enter' || !e.target) return;
    const el = e.target;
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) {
      teachLog('KEYDOWN 忽略（Enter 但目标非输入框） tag=' + el.tagName);
      return;
    }
    const sel = cssPath(el);
    const pending = teachVals.get(sel);
    teachLog('KEYDOWN Enter tag=' + el.tagName + ' sel=' + sel + ' 有待定输入=' + !!pending + ' value=' + (pending ? teachValSummary(el, pending.value) : '-'));
    teachMaybeHover(el); // 悬浮揭示出的输入框上回车：先补记悬浮步
    if (pending) {
      teachVals.delete(sel);
      teachPush({ t: 'type', sel, label: pending.label, value: pending.value });
    }
    teachPush({ t: 'submit', sel, label: teachLabel(el) });
    teachScheduleFlush();
  }

  // 页面离开（演示中导航到新页）时兜底：补记未落账输入并上报缓冲，避免丢步骤
  function teachOnPagehide() {
    if (!teachOn) return;
    const pend = Array.from(teachVals.entries());
    teachLog('PAGEHIDE 兜底：待定输入 ' + pend.length + ' 个 → ' + pend.map(([s]) => s).join(','));
    for (const [sel, rec] of teachVals) teachBuf.push({ t: 'type', sel, label: rec.label, value: rec.value });
    teachVals.clear();
    teachFlush();
  }

  function teachStart() {
    if (teachOn) {
      // 重复开启（页面重挂载 / 后台重发 TEACH_START / onUpdated 因 iframe 导航误触发）：
      // 已开录就【不重置缓冲】——重置会丢掉该窗口最近未上报的几步。
      // 导航后的全新页面是新上下文（teachOn=false），本来就走正常开录，不走这里。
      teachLog('START 重复开启（已在录制）：保持缓冲继续录制');
      return;
    }
    teachOn = true;
    teachBuf = [];
    teachVals.clear();
    teachHover = null;
    document.addEventListener('click', teachOnClick, true);
    document.addEventListener('input', teachOnInput, true);
    document.addEventListener('change', teachOnChange, true);
    document.addEventListener('keydown', teachOnKeydown, true);
    document.addEventListener('mouseover', teachOnMouseover, true);
    window.addEventListener('pagehide', teachOnPagehide);
    logDebug('教我模式：开始录制页面事件');
    teachLog('START 开始录制 @ ' + location.href);
  }

  function teachStop() {
    if (!teachOn) {
      teachLog('STOP 录制本未开启，返回空');
      return [];
    }
    teachOn = false;
    if (teachTimer) { clearTimeout(teachTimer); teachTimer = null; }
    const pend = Array.from(teachVals.entries());
    if (pend.length) teachLog('STOP 兜底补记待定输入 ' + pend.length + ' 个 → ' + pend.map(([s]) => s).join(','));
    for (const [sel, rec] of teachVals) teachBuf.push({ t: 'type', sel, label: rec.label, value: rec.value });
    teachVals.clear();
    teachHover = null;
    document.removeEventListener('click', teachOnClick, true);
    document.removeEventListener('input', teachOnInput, true);
    document.removeEventListener('change', teachOnChange, true);
    document.removeEventListener('keydown', teachOnKeydown, true);
    document.removeEventListener('mouseover', teachOnMouseover, true);
    window.removeEventListener('pagehide', teachOnPagehide);
    const batch = teachBuf;
    teachBuf = [];
    logDebug('教我模式：停止录制');
    teachLog('STOP 结束录制，随响应带回剩余 ' + batch.length + ' 条 [' + batch.map((r) => r.t).join(',') + ']');
    return batch; // 剩余缓冲直接随消息响应带回（避免与 TEACH_EVENT 重复上报，也防止最后几步被竞态吞掉）
  }

  // ---------------- 元素排查模式（面板调试工具） ----------------
  // 面板点「排查」→ 页面进入"选择元素"模式（DevTools 式）：鼠标悬停高亮目标，
  // 点击元素即用【真实的快照收集逻辑】判定"在当前 Agent 浏览能力下，这个元素能不能被看到"，
  // 并给出原因（是否可见 / 是否语义可点 / 是否绑点击处理器 / 是否被祖先收录 / 是否超上限），
  // 方便快速定位"浏览侧 bug"（元素 Agent 根本看不到）还是模型/决策问题。
  // 支持所有 frame（content.js 全 frame 注入）：iframe 弹层里的卡片也能悬停/点击诊断。
  let pickOn = false;
  let pickHoverEl = null;
  let pickOverlay = null;

  function pickEnsureOverlay() {
    if (pickOverlay && pickOverlay.isConnected) return pickOverlay;
    const d = document.createElement('div');
    d.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483647',
      'background:rgba(79,140,255,.18)', 'outline:2px solid #4f8cff',
      'outline-offset:-2px', 'box-sizing:border-box', 'display:none'
    ].join(';');
    (document.body || document.documentElement).appendChild(d);
    pickOverlay = d;
    return d;
  }

  function pickMove(e) {
    if (!pickOn) return;
    const el = e.target;
    if (!el || el.nodeType !== 1 || el === pickHoverEl) return;
    pickHoverEl = el;
    const r = el.getBoundingClientRect();
    const ov = pickEnsureOverlay();
    ov.style.left = r.left + 'px';
    ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    ov.style.display = 'block';
  }

  function pickOut(e) {
    if (pickOn && !e.relatedTarget) pickClear(); // 指针离开文档才隐藏高亮
  }

  function pickClear() {
    pickHoverEl = null;
    if (pickOverlay) pickOverlay.style.display = 'none';
  }

  function pickClick(e) {
    if (!pickOn) return;
    e.preventDefault(); // 截断默认动作（导航/提交），排查时点错不会真的触发页面行为
    e.stopImmediatePropagation();
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    chrome.runtime.sendMessage({ type: 'DEBUG_PICK_RESULT', result: diagnosePick(el) }).catch(() => {});
  }

  function pickKeydown(e) {
    if (pickOn && e.key === 'Escape') { e.preventDefault(); exitPickMode('esc'); }
  }

  function enterPickMode() {
    if (pickOn) return;
    pickOn = true;
    document.addEventListener('mouseover', pickMove, true);
    document.addEventListener('mouseout', pickOut, true);
    document.addEventListener('click', pickClick, true);
    document.addEventListener('keydown', pickKeydown, true);
  }

  // reason='esc'：页面按键退出，通知 background 广播关闭其它 frame 并同步面板按钮
  function exitPickMode(reason) {
    if (!pickOn) return;
    pickOn = false;
    document.removeEventListener('mouseover', pickMove, true);
    document.removeEventListener('mouseout', pickOut, true);
    document.removeEventListener('click', pickClick, true);
    document.removeEventListener('keydown', pickKeydown, true);
    pickClear();
    if (reason === 'esc') chrome.runtime.sendMessage({ type: 'DEBUG_PICK_ESCAPE' }).catch(() => {});
  }

  // 元素是否有 cursor:pointer（样式表声明命中，或运行时静止手型）
  function cursorPointer(el) {
    try {
      if (getComputedStyle(el).cursor === 'pointer') return true;
      const sels = pointerSelectors();
      for (const s of sels) { if (el.matches && el.matches(s)) return true; }
    } catch (_) {}
    return false;
  }

  // 排查辅助：点在"自身不可见"的元素上时，找它附近【已被快照收录】的可输入区（祖先链 + 自身子树）。
  // 文档平台的正文里，你点到的多半是输入区内部/外层的内容块（div/p/空段落），自身不被收录是正常的；
  // 关键看真正能写字的区在不在快照里——在，Agent 就能通过它点进编辑器打字。
  function collectedEditorNear(el, dbgMap) {
    const isInputEntry = (entry) => isEditor(entry.el);
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      for (const [ref, entry] of dbgMap) {
        if (entry.el === cur && isInputEntry(entry)) return { ref, where: 'ancestor', label: elementLabel(cur) };
      }
      cur = cur.parentElement;
    }
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let n = tw.currentNode, i = 0;
    while ((n = tw.nextNode()) && i < 500) {
      i++;
      for (const [ref, entry] of dbgMap) {
        if (entry.el === n && isInputEntry(entry)) return { ref, where: 'descendant', label: elementLabel(n) };
      }
    }
    return null;
  }

  // 排查辅助：找附近【存在于 DOM 中】的输入区（不管有没有被收录）。返回 null 说明这附近真没有任何可写区。
  // 与 collectedEditorNear 的区别：它只看快照里有没有；这个看 DOM 里存不存在。两者结合能区分
  // "输入区在快照里但 Agent 够得着"和"输入区存在但浏览侧收录漏了"（如画布渲染、0 尺寸隐藏 textarea）。
  function anyEditorNear(el) {
    try {
      const sel = 'textarea, [contenteditable], [role~="textbox"], [role~="searchbox"]';
      const anc = el.closest && el.closest(sel);
      if (anc && anc !== el) return { el: anc, where: 'ancestor' };
      const desc = el.querySelector && el.querySelector(sel);
      if (desc) return { el: desc, where: 'descendant' };
    } catch (_) {}
    return null;
  }

  // 判定"Agent 当前能否看到该元素"：跑一遍真实的快照收集（传临时 map，不影响 agent 的 refMap），
  // 再沿自身→祖先找第一个被收录的元素。三种结论：
  //   self     = 元素自身被收录 → Agent 直接看到它（给出 ref）
  //   ancestor = 自身未被收录，但最近的可点祖先被收录 → Agent 看到的是那个祖先（常见"点在内层文字/图标上"）
  //   none     = 完全看不到 → 给出具体原因，判断是否为浏览侧 bug
  function diagnosePick(el) {
    const dbgMap = new Map();
    const snap = buildSnapshot(dbgMap);
    const selfLabel = elementLabel(el);
    const selfTag = el.tagName ? el.tagName.toLowerCase() : '';
    const windowName = IS_TOP_FRAME ? '主窗口' : ('子窗口' + (document.title ? '「' + document.title.slice(0, 20) + '」' : ''));

    let hitRef = null, hitEl = null, depth = 0, cur = el;
    while (cur && cur !== document.documentElement && depth < 12) {
      for (const [ref, entry] of dbgMap) {
        if (entry.el === cur) { hitRef = ref; hitEl = cur; break; }
      }
      if (hitRef != null) break;
      cur = cur.parentElement;
      depth++;
    }

    const itemOf = (ref) => snap.elements.find((x) => x.ref === ref);
    if (hitRef != null && hitEl === el) {
      const item = itemOf(hitRef);
      return {
        seen: true, matched: 'self', ref: hitRef,
        label: item ? (item.text || item.hint || item.role || item.tag) : selfLabel,
        tag: selfTag, selector: cssPath(el), dynamic: !!(item && item.dynamic),
        windowName
      };
    }
    if (hitRef != null) {
      const item = itemOf(hitRef);
      return {
        seen: true, matched: 'ancestor', ref: hitRef,
        label: item ? (item.text || item.hint || item.role || item.tag) : '',
        tag: selfTag, ancestorTag: hitEl.tagName ? hitEl.tagName.toLowerCase() : '',
        selector: cssPath(hitEl), dynamic: !!(item && item.dynamic), windowName
      };
    }
    // 自身与祖先都没被收录。但对编辑器场景，用户常点到输入区内部/外壳的内容块——真正能写字的
    // 元素（contenteditable/textbox/textarea）可能在祖先链或子树里且已被收录；也可能 DOM 里存在但
    // 快照没收进来（画布渲染、0 尺寸隐藏 textarea），那才是浏览侧收集逻辑的真缺口。两种都单独给结论：
    const collectedEditor = collectedEditorNear(el, dbgMap);
    if (collectedEditor) {
      const item = itemOf(collectedEditor.ref);
      return {
        seen: true, matched: 'editor', ref: collectedEditor.ref,
        where: collectedEditor.where,
        label: item ? (item.text || item.hint || item.role || item.tag) : collectedEditor.label,
        tag: selfTag, selector: cssPath(el), windowName
      };
    }
    const anyEditor = anyEditorNear(el);
    if (anyEditor) {
      return {
        seen: false, matched: 'editor-uncollected', ref: null,
        where: anyEditor.where,
        label: elementLabel(anyEditor.el),
        tag: anyEditor.el.tagName ? anyEditor.el.tagName.toLowerCase() : '',
        selector: cssPath(el), windowName,
        reasons: whyNotSeen(anyEditor.el, dbgMap)
      };
    }
    return {
      seen: false, matched: 'none', ref: null, label: selfLabel, tag: selfTag,
      selector: cssPath(el), windowName,
      reasons: whyNotSeen(el, dbgMap)
    };
  }

  // 完全看不到时的原因拆解（对照 buildSnapshot 的收录规则，逐条说明卡在哪一步）
  function whyNotSeen(el, dbgMap) {
    const reasons = [];
    if (!isVisible(el)) reasons.push('不可见：display/visibility/opacity 为隐藏，或宽高为 0');
    const itv = !!(el.matches && el.matches(INTERACTIVE));
    const clickable = hasClickHandler(el) || cursorPointer(el);
    if (!itv && !clickable) {
      reasons.push('不在可点判定内：非 a/button/[role=…] 等语义元素，无 onclick/React 处理器，也无 cursor:pointer');
    }
    const textAria = !!(el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.alt;
    if (!textAria) reasons.push('没有文字/可访问名：缺 text、aria-label、title、alt（动态候选必须带其一）');
    if (isVisible(el) && (itv || clickable) && textAria && !reasons.length) {
      if (dbgMap.size >= MAX_ELEMENTS) reasons.push('快照元素已达上限 ' + MAX_ELEMENTS + ' 个，此元素排在候选之外');
      else reasons.push('符合可点判定但未被收录（可能命中父级去重或扫描截断）');
    }
    return reasons;
  }

  // ---------------- 消息通信 ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'PING':
          return { pong: true };
        case 'GET_SNAPSHOT':
          return buildSnapshot();
        case 'EXECUTE_ACTION':
          return executeAction(msg.action || {});
        case 'TEACH_START':
          teachStart();
          return { ok: true };
        case 'TEACH_STOP': {
          const flushed = teachStop();
          teachLog('MSG TEACH_STOP 收到，返回 events=' + (Array.isArray(flushed) ? flushed.length : 0) + ' 条');
          return { ok: true, events: flushed }; // 把剩余缓冲随响应带回，background 合并进本轮步骤
        }
        case 'DEBUG_PICK_START':
          enterPickMode();
          return { ok: true };
        case 'DEBUG_PICK_STOP':
          exitPickMode('stop');
          return { ok: true };
        default:
          return { ok: false, error: '未知消息类型 ' + msg.type };
      }
    })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步响应
  });

  if (IS_TOP_FRAME) {
    // 顶层 frame 加载完成，通知 background（跨页面续跑的关键信号）
    chrome.runtime.sendMessage({ type: 'AGENT_READY' }).catch(() => {});
  } else {
    // 子窗口就绪（可能是 JS 动态新开的 iframe）：通知 background，若正处教学录制则单独给本窗口挂上录制
    chrome.runtime.sendMessage({ type: 'FRAME_READY' }).catch(() => {});
  }
})();
