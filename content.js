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

  const MAX_ELEMENTS = 100;  // 每批快照的可交互元素数量上限（每批一个窗口；普通页面远用不满、零成本，密集/长页面按 offset 翻页逐批取；与 background REF_WINDOW_SIZE 保持一致，合并上限 MAX_MERGED_ELEMENTS ≥ 它）
  const TEXT_LIMIT = 6000;   // 正文摘要长度上限
  const READ_LIMIT = 6000;   // read 动作单次返回文本上限

  // ---- 页脚税过滤 ----
  // 快照正文摘要 / read 默认去掉"站点恒定导航/页脚/法务备案"这类跨站噪音：它们每张快照都重复出现、
  // 信息量极低却白白吃掉上下文（如小红书超长 ICP 备案块一次 ~800 字符）。判断信号全通用、不特判站点：
  // ①结构信号——<footer> 容器；②文案信号——"备案/经营许可/举报/算法备案"类硬特征法务块（几乎不会出现在正文里）。
  // 页脚并非完全无用：read 动作带 raw:true 可取完整原文（见 read 动作实现）。
  const FOOTER_LEGAL_RE = /ICP备案|ICP备|公网安备|增值电信业务经营许可证|违法不良信息举报|网上有害信息举报|互联网药品信息服务|网络文化经营许可证|医疗器械网络交易服务第三方平台备案|个性化推荐算法|网信算备/;
  const FOOTER_LEGAL_MAX = 2000; // 法务块文本上限：超过视为正文（正文偶尔提一句备案/许可，不应整块丢弃）

  // 去掉根元素内的页脚税：删 <footer> 容器 + 叶子级"法务块"。只测叶子（无元素子节点）避免 O(子树) 的重复判读。
  function stripFooterTax(root) {
    root.querySelectorAll('footer').forEach((n) => n.remove());
    const nodes = root.querySelectorAll('*');
    for (const el of nodes) {
      if (el.children.length) continue;
      const t = (el.textContent || '').replace(/\s+/g, '');
      if (t && t.length < FOOTER_LEGAL_MAX && FOOTER_LEGAL_RE.test(t)) el.remove();
    }
  }

  // 剥掉程序性内容（脚本/样式/模板/注释）：innerText 本就不含它们，但 innerText 为空时会回退 textContent，
  // 把扩展注入的桥接 <script> 源码当正文捞进来（第一张快照拍到 iframe 页时即如此）。脚本源码永远不是要读的正文。
  function stripNonText(root) {
    root.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
    return root;
  }

  // 取元素/页面文本：默认去页脚税+程序性内容（raw=false）；raw=true 返回含页脚的完整原文（同样剥脚本源码）。
  // 两条路径都从 clone 提取：统一剥脚本后，即使 innerText 为空回退 textContent 也不会捞进脚本。
  function pageText(el, raw) {
    if (!el) return '';
    try {
      const clone = el.cloneNode(true);
      stripNonText(clone);
      if (!raw) stripFooterTax(clone);
      return (clone.innerText || clone.textContent || '');
    } catch (e) {
      return (el.innerText || el.textContent || '');
    }
  }

  const INTERACTIVE = [
    'a', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="menuitem"]', '[role="tab"]', '[role="option"]', '[role="switch"]',
    '[role="combobox"]', '[role="slider"]', '[role="searchbox"]', '[role="textbox"]',
    '[contenteditable]', '[onclick]', '[tabindex]', '[data-testid]',
    '[aria-label]', '[aria-haspopup]', '[aria-expanded]', '[aria-selected]'
  ].join(',');

  let refMap = new Map(); // ref -> { el, selector }

  // ---------------- 画布文字钩子接收端 ----------------
  // canvas-hook.js 在 document_start + MAIN world 拦截页面画布绘制（fillText/strokeText），armed 后把
  // 画到 canvas 上的文字批量 postMessage 回传（pa_ct）。这里接收进缓冲区，快照时由 collectCanvasText
  // 取走并重置钩子状态：每次快照只反映"当前可见内容"（画布应用交互后重画，重画完才有新字），
  // 旧视图的文字不会串进下一次快照。
  let canvasTextBuffer = [];
  window.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d && Array.isArray(d.pa_ct)) {
      for (const e of d.pa_ct) {
        if (e && typeof e.t === 'string' && e.t) canvasTextBuffer.push(e);
      }
      if (canvasTextBuffer.length > 6000) canvasTextBuffer.splice(0, canvasTextBuffer.length - 6000);
    }
  });

  // 让 MAIN world 钩子开始记录，收走"自上次快照以来画上的文字"，随后重置钩子状态。
  // 返回条目数组（钩子坐标：canvas 设备坐标 + 可见标记 v）。
  async function collectCanvasText() {
    let hasCanvas = false;
    try { hasCanvas = !!document.querySelector('canvas'); } catch (e) {}
    if (!hasCanvas) return [];
    try { window.postMessage({ pa_arm: true }, '*'); } catch (e) {}
    try { window.postMessage({ pa_flush: true }, '*'); } catch (e) {}
    await sleep(60); // 等 MAIN world 把已画内容批量回传（postMessage 跨世界异步送达）
    const got = canvasTextBuffer;
    canvasTextBuffer = [];
    try { window.postMessage({ pa_reset: true }, '*'); } catch (e) {}
    return got;
  }

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
    // 链接地址：<a>/<area> 的 el.href 是解析后的绝对地址（相对路径/锚点也会解析）。快照据此给列表元素带 →地址，
    // 模型攒详情 URL 批量 open_tab 用。非链接元素留空。
    const href = (tag === 'a' || tag === 'area') && el.href ? String(el.href) : '';
    return {
      ref,
      role,
      tag,
      text,
      hint,
      value,
      href,
      disabled: !!el.disabled,
      selector: cssPath(el)
    };
  }

  // 隐藏输入捕获架构（如腾讯文档）：可见的"编辑器框"是一堆 div 渲染层，真正可编辑的只有一个
  // 角落里 tiny 的 contenteditable（实测是 5×1 的 div#melo-hidden-editor[role=textbox]）。
  // 输入进那个隐藏编辑器、由引擎重渲染到可见层。findVisibleEditorHost 从隐藏编辑器向上找
  // "可见的编辑框"：最深的、够大且有可见文本的祖先——即用户看到的、快照要展示给大模型的宿主。
  function findVisibleEditorHost(hiddenEl) {
    let fallback = null;
    let cur = hiddenEl.parentElement;
    while (cur && cur !== document.body) {
      const r = cur.getBoundingClientRect();
      const text = (cur.innerText || '').replace(/\s+/g, '').trim();
      if (r.width > 150 && r.height > 80 && text.length > 0) {
        if (!fallback) fallback = cur;
        // 跳过悬浮层（position:absolute/fixed）：文档平台的提示浮层（如腾讯文档"control+~ 无障碍"
        // 提示）也是够大够深的祖先，选它当宿主会误报输入卡住（打字内容渲染在 surface 上、不在浮层里）。
        // 优先取"够大且有文字"的祖先里最深的非悬浮层——真正承载正文的 surface；全悬浮时退回最深的。
        const pos = getComputedStyle(cur).position;
        if (pos !== 'absolute' && pos !== 'fixed') return cur;
      }
      cur = cur.parentElement;
    }
    return fallback;
  }

  // 画布渲染宿主：从隐藏编辑器向上走祖先链，找"最深的、内含尺寸≈自身的大画布"的容器。
  // 文档/表格的内容真正画在 canvas 上（melo-page-main-view / 网格 canvas），画布所在且尺寸匹配的
  // 容器才是要展示给大模型的宿主。比 findVisibleEditorHost 更准：那种"找有文字的祖先"在表格页会一路
  // 升到整页 workbench（标题栏/工具条文字），画布 1044×270 对不上它的尺寸，画布渲染就识别不出来、
  // 界面文案全当正文。注意每层要遍历全部 canvas：网格页用 0×0 假 canvas 占位（group_col_canvas/
  // group_row_canvas），只取第一个会漏掉真正画网格的画布。非画布页面返回 null，退回 findVisibleEditorHost。
  function findCanvasHost(hiddenEl) {
    const near = (a, b) => b > 0 && a > 100 && Math.abs(a - b) < b * 0.25;
    let cur = hiddenEl.parentElement;
    for (let i = 0; cur && cur !== document.body && i < 8; cur = cur.parentElement, i++) {
      const r = cur.getBoundingClientRect();
      for (const cv of cur.querySelectorAll('canvas')) {
        const cr = cv.getBoundingClientRect();
        if (near(cr.width, r.width) && near(cr.height, r.height)) return cur; // 从深到浅，第一个命中即最深
      }
    }
    return null;
  }

  // el 的祖先里是否已有收录（宿主被更大的已收录容器包住时，编辑面已被覆盖，不再重复提升宿主）
  function hasSeenAncestor(el, seenSet) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (seenSet.has(p)) return true;
    }
    return false;
  }

  // ---------------- 构建页面快照 ----------------
  // 浮层识别：弹层/遮罩通常是"盖住大半视口的 fixed/absolute 容器"，且 DOM 里排在正文之后——
  // 纯文档顺序会把 ref 名额先分给正文元素，弹层里的按钮（如关闭 ×）永远轮不到。这里用
  // elementsFromPoint 采样视口几个点、向上找大容器，得到"浮层根"，供 buildSnapshot 优先分配 ref。
  function overlayRoots() {
    const roots = new Set();
    const vw = window.innerWidth, vh = window.innerHeight;
    const isRootish = (el) => {
      try {
        const st = getComputedStyle(el);
        if (st.position !== 'fixed' && st.position !== 'absolute') return false;
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > vw * 0.35 && r.height > vh * 0.35;
      } catch (e) { return false; }
    };
    const sample = (x, y) => {
      let els;
      try { els = document.elementsFromPoint(x, y); } catch (e) { return; }
      for (const el of els) {
        if (!el || el === document.body || el === document.documentElement) break;
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          if (isRootish(cur)) roots.add(cur);
          cur = cur.parentElement;
        }
      }
    };
    sample(vw / 2, vh / 2);       // 中心：居中弹层/遮罩
    sample(vw * 0.15, vh * 0.15); // 四角内缩采样：角落/偏置弹层
    sample(vw * 0.85, vh * 0.15);
    sample(vw * 0.15, vh * 0.85);
    sample(vw * 0.85, vh * 0.85);
    return roots;
  }

  // 重复链接去重键：同 tag+文本+href 视为导航/页脚镜像（同一目标），只收第一处，省 ref 名额。
  // 只对有文字的链接去重；空 A 多为图标按钮（如关闭 × 是包着 svg 的空链接），每个都可能有独立
  // 动作，不能按 'A||' 全折叠成一个。
  function dupKeyOf(el) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text) return '';
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    return 'A|' + text + '|' + href;
  }

  // 把画布钩子条目换算成"主画布范围内 + 可见"的 {rect,text}（含视口坐标），供快照与 read 共用。
  // 坐标换算：钩子给的是 canvas 设备坐标（bitmap 像素），先按主画布 bitmap/CSS 缩放比转成 CSS 像素，
  // 再加画布左上角视口偏移，得到可直接用于 clickAt 的视口坐标。中间渲染层（display:none）画的坐标
  // 不可信、小画布（滚动条/占位）画的不算正文，都滤掉。
  function canvasBlockFrom(entries) {
    if (!Array.isArray(entries) || !entries.length) return null;
    try {
      let main = null, mainArea = 0;
      for (const cv of document.querySelectorAll('canvas')) {
        const r = cv.getBoundingClientRect();
        if (r.width > 60 && r.height > 60 && r.width * r.height > mainArea) { main = cv; mainArea = r.width * r.height; }
      }
      if (!main) return null;
      const r = main.getBoundingClientRect();
      const sx = main.width > 0 ? r.width / main.width : 1;
      const sy = main.height > 0 ? r.height / main.height : 1;
      const text = [];
      for (const e of entries) {
        if (e.v === 0) continue;
        if (e.x < 0 || e.y < 0 || e.x > main.width || e.y > main.height) continue;
        if (text.length >= 400) break;
        text.push({ t: e.t.slice(0, 120), x: Math.round(r.left + e.x * sx), y: Math.round(r.top + e.y * sy), f: e.f || '' });
      }
      return text.length
        ? { rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, text }
        : null;
    } catch (e) { return null; }
  }

  // read 整页时并入画布文字：只读共享缓冲、不消费（不 flush/reset 钩子），下一张快照仍能取到画布文字。
  function canvasTextForRead() {
    if (!canvasTextBuffer.length) return '';
    const block = canvasBlockFrom(canvasTextBuffer);
    if (!block) return '';
    return block.text.map((it) => it.t).join('\n');
  }

  function buildSnapshot(canvasEntries, offset = 0) {
    // 翻页窗口：本轮收集绝对位置 offset+1..offset+MAX_ELEMENTS 的元素，收集完统一重排回 1..N
    const limit = offset + MAX_ELEMENTS;
    const map = refMap;
    map.clear(); // refMap 每次快照全量重建，避免旧页残留 ref 命中已不存在/已复用的元素（stale ref）
    const items = [];
    const seen = new Set();
    const seenKey = new Set(); // 重复链接（页脚/导航镜像）只收一次
    let ref = 0;

    // 浮层优先：弹层里的可交互元素先拿 ref（遮罩/面板经 elementsFromPoint 采样识别），
    // 避免正文元素先把名额占满、弹层按钮（关闭 × 等）永远进不了快照。
    const overlayPush = (el) => {
      if (ref >= limit) return false;
      if (seen.has(el) || !isVisible(el)) return true;
      if (el.tagName === 'A') {
        const k = dupKeyOf(el);
        if (k && seenKey.has(k)) return true; // 空 A（图标按钮）不去重，见 dupKeyOf
        if (k) seenKey.add(k);
      }
      seen.add(el);
      const item = describe(el, ++ref);
      item.overlay = true; // 标注：来自浮层，帮助大模型理解这是弹层控件
      map.set(ref, { el, inputEl: null, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
      items.push(item);
      return true;
    };
    for (const root of overlayRoots()) {
      if (ref >= limit) break;
      // ① 语义可点后代（button/a/[aria-label]…）
      for (const el of root.querySelectorAll(INTERACTIVE)) {
        if (!overlayPush(el)) break;
      }
      // ② 裸图标按钮（div/span/svg…，无 button 标签、无文字/aria，仅 React onClick / 手型）：
      //    弹层里的图标按钮通常是关闭 × 这类关键控件，不能因"没文字"就漏掉。
      let scanned = 0;
      const tw2 = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n2 = tw2.currentNode;
      while ((n2 = tw2.nextNode()) && ref < limit && scanned < 300) {
        scanned++;
        if (n2 === root || seen.has(n2) || n2.matches(INTERACTIVE)) continue;
        // 图标字形/图片不是独立按钮（cursor:pointer 常从父按钮继承来），跳过以免拿一堆 svg 当按钮填满 ref
        if (n2.tagName === 'SVG' || n2.tagName === 'USE' || n2.tagName === 'PATH' || n2.tagName === 'IMG') continue;
        // 父级已是可点控件（button/链接/图标按钮已收），内部 box/text 不再重复收
        let hasSeenP = false;
        for (let p2 = n2.parentElement; p2 && p2 !== root; p2 = p2.parentElement) {
          if (seen.has(p2)) { hasSeenP = true; break; }
        }
        if (hasSeenP) continue;
        const st = getComputedStyle(n2);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        if (!hasClickHandler(n2) && st.cursor !== 'pointer') continue;
        if (ref >= limit) break;
        seen.add(n2);
        const item = describe(n2, ++ref);
        item.overlay = true;
        if (!item.hint) {
          // 弹层惯例：顶部角落的小图标按钮多为关闭/收起（左上/右上都有）。有位置信号优先提示，
          // 没有就退化成"点了看效果"。
          const ir = n2.getBoundingClientRect();
          const rr = root.getBoundingClientRect();
          const topCorner = ir.top < rr.top + 80 && (ir.left < rr.left + 80 || ir.right > rr.right - 80);
          item.hint = topCorner ? '(浮层顶部角落图标按钮：通常是关闭/收起)' : '(浮层图标按钮：无文字说明，点击看效果)';
        }
        map.set(ref, { el: n2, inputEl: null, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
        items.push(item);
      }
      if (root.matches(INTERACTIVE)) overlayPush(root); // 遮罩本身可点（点空白处关闭）
    }

    const nodes = document.querySelectorAll(INTERACTIVE);
    for (const el of nodes) {
      if (seen.has(el)) continue;

      // 父级已被收录（嵌套可点元素，如 button 里的 a），跳过以去噪；
      // 但 contenteditable/textarea 是"可输入面"：宿主整块被收录为编辑器时，内部真正的输入框
      // 仍要放行（表格就地编辑框在整表编辑器内部），否则 Agent 会没有可打字的真实输入元素。
      let p = el.parentElement;
      let nested = false;
      while (p && p !== document.body) {
        if (seen.has(p)) { nested = true; break; }
        p = p.parentElement;
      }
      if (nested && el.tagName !== 'TEXTAREA' && !el.isContentEditable) continue;

      if (ref >= limit) break;

      // 隐藏输入捕获编辑器识别（腾讯文档等）：真实可编辑的是角落里又小又透明的 contenteditable
      // （实测 5×1 的 div#melo-hidden-editor[role=textbox]，且 opacity:0——正常可见性检查会把
      // 它整只挡掉）。输入进那个隐藏编辑器、由引擎重渲染到可见层。这里先于 isVisible 特判：
      // 命中就把"可见编辑框"宿主提升成 editor（文字=文档内容或占位文案），真实输入面 inputEl
      // 留给 type 动作路由（见下），避免大模型看到个莫名的空 textbox 认不出写作区。
      const r0 = el.getBoundingClientRect();
      let host = null;
      let inputEl = null;
      if (el.isContentEditable && (r0.width < 40 || r0.height < 40 || getComputedStyle(el).opacity === '0')) {
        // 画布渲染宿主优先：文档/表格的内容画在 canvas 上，宿主应从"内含尺寸≈自身的大画布"的祖先里
        // 找（findCanvasHost），比"找有文字的祖先"（findVisibleEditorHost）准——表格页按文字找会一路
        // 升到整页 workbench（标题栏/工具条文字），画布 1044×270 对不上它的尺寸，画布渲染识别不出、
        // 界面文案全当正文。非画布页面 findCanvasHost 返回 null，退回原逻辑。
        const canvasHost = findCanvasHost(el);
        host = canvasHost || findVisibleEditorHost(el);
        if (host && !seen.has(host) && !hasSeenAncestor(host, seen)) {
          inputEl = el;                        // 真实输入面：隐藏编辑器
          seen.add(el);
          seen.add(host);                      // 宿主已作为编辑器收录，动态扫描别再把它当可点元素重复收
          const item = describe(host, ++ref);  // 展示/操作对象换成可见宿主
          item.role = 'editor';                // 明确"文档正文编辑区"，让大模型认得出这是写作区
          if (canvasHost) {
            // 画布渲染的文档/表格页（如腾讯文档 melo-page-main-view / 网格 canvas）：内容真正画在
            // canvas 上，宿主的 DOM 文本只是界面提示（"AI帮我创建文档"/模板推荐），不是内容——不标出
            // 来的话大模型会把界面杂文案当成正文。
            // 通用读取通道：画布渲染的应用往往在 DOM 里保留一个文字镜像（即输入捕获用的隐藏编辑器 el
            // 本身，如表格公式栏 / 文档合成编辑器），当前焦点/选中区域的内容会回显进去。el 文字非空就
            // 并入 text，大模型就能读到"当前选中处"的实际内容——不依赖任何网站专属 id，凡是画布渲染 +
            // DOM 文字镜像的应用都适用；纯 canvas 无镜像的应用读不到（只能靠视觉/截图）。
            const mirrorText = (el.textContent || '').trim().slice(0, 120);
            if (mirrorText) {
              item.hint = '(画布渲染编辑区：内容画在 canvas 上 DOM 不可见；text 为当前焦点/选中处的文字镜像，即该处实际内容。要读其他区域，先点选目标位置再重新快照)';
              item.text = mirrorText;
            } else {
              item.hint = '(画布渲染编辑区：内容画在 canvas 上，DOM 不可见)';
              item.text = '';
            }
          } else {
            if (!item.text && !item.hint) item.hint = '(空编辑区)';
            // 兜底：非画布宿主也向上扫几层，别漏掉更高层画布（旧逻辑保留）
            try {
              const hr = host.getBoundingClientRect();
              const near = (a, b) => b > 0 && a > 100 && Math.abs(a - b) < b * 0.25;
              outer:
              for (let cur = host, i = 0; cur && i < 5; cur = cur.parentElement, i++) {
                for (const cv of cur.querySelectorAll('canvas')) {
                  const cr = cv.getBoundingClientRect();
                  if (near(cr.width, hr.width) && near(cr.height, hr.height)) {
                    item.hint = '(画布渲染编辑区：内容画在 canvas 上，DOM 不可见)';
                    item.text = '';
                    break outer;
                  }
                }
              }
            } catch (e) {}
          }
          map.set(ref, { el: host, inputEl, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
          items.push(item);
        } else if (host && (seen.has(host) || hasSeenAncestor(host, seen))) {
          // 宿主已被更早的编辑器收录（表格里公式栏先把整表提升成编辑器、就地编辑框随后到）：
          // 不重复提升宿主，把这个小编辑器本身暴露成可输入元素，给 Agent 一个能直接打字的编辑面。
          seen.add(el);
          const item = describe(el, ++ref);
          item.role = 'editor';
          item.hint = '(就地编辑框，可直接输入)';
          map.set(ref, { el, inputEl: el, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
          items.push(item);
        }
        continue; // 隐藏编辑器（无论有没有宿主）都走特判分支，不进普通可交互路径
      }

      if (!isVisible(el)) continue;
      if (el.tagName === 'A') {
        const k = dupKeyOf(el);
        if (k && seenKey.has(k)) continue; // 重复链接（页脚/导航镜像）只收第一处；空 A 不去重
        if (k) seenKey.add(k);
      }
      seen.add(el);
      const item = describe(el, ++ref);
      map.set(ref, { el, inputEl, selector: item.selector, desc: (item.text || item.hint || item.role || item.tag).slice(0, 30) });
      items.push(item);
    }

    // 动态构建的可点元素（无 role/onclick/tabindex 属性的 div/span 按钮等）：
    // 主列表没填满时补扫，让 agent 在纯 JS 动态 app（如腾讯文档）里也能看到并点击这类元素。
    // 判定"可点"看是否绑了点击处理器（见 hasClickHandler：内联 onclick / React props），
    // cursor:pointer 样式只作兜底候选（纯 addEventListener 的旧页面无法从外部探测处理器）。
    if (ref < limit) {
      let checked = 0;
      const maxCheck = 1500;
      // 收录判定：可见 + 自带文字/aria + 父级未收录（避免整块容器重复收进来）
      const tryAdd = (el) => {
        if (ref >= limit || checked >= maxCheck) return false;
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
      while ((n = tw.nextNode()) && ref < limit && checked < maxCheck && walked < maxCheck) {
        walked++;
        if (!hasClickHandler(n)) continue;
        if (!tryAdd(n)) break;
      }
      // 候选 2：样式表显式声明 cursor:pointer 的选择器命中 + 内联 cursor（兜底 addEventListener 老页面）。
      // 命中即说明作者标了手型，不再逐个校验 computed cursor（:hover 才出手型、被覆盖等情况都照收）。
      const dynSel = pointerSelectors().concat('[style*="cursor"]').join(',');
      if (dynSel) {
        for (const el of document.querySelectorAll(dynSel)) {
          if (ref >= limit || checked >= maxCheck) break;
          if (seen.has(el)) continue;
          if (!tryAdd(el)) break;
        }
      }
      // 候选 3：样式表跨域读不到（CDN 托管无 CORS）时的兜底——直接按运行时手型找，不依赖样式表。
      // 只收确凿的静止手型 pointer（不收 auto），避免重演 hover-only 才出手型的误判；有界扫描防止大页卡顿。
      // cursor 至此是最后一层信号：前有语义元素、真实处理器、样式表声明三层优先。
      if (ref < limit) {
        let c3 = 0;
        const tw3 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let n3 = tw3.currentNode;
        while ((n3 = tw3.nextNode()) && ref < limit && c3 < 800 && checked < maxCheck) {
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

    const bodyText = pageText(document.body, false) // 默认去页脚税（导航/页脚/法务备案不污染正文摘要）
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
    // 画布文字块：把钩子收到的条目换算成视口坐标，只保留"主画布范围内 + 可见画布画的"（见 canvasBlockFrom）。
    const canvasBlock = canvasBlockFrom(canvasEntries);
    // 翻页窗口重排：本轮编号是绝对位置 offset+1..offset+N，统一重排回 1..N 并重建 refMap，
    // 让 ref 永远指"本次快照窗口里的第几个"，与单窗口语义一致（子窗口合并、click 定位都不受影响）。
    if (offset > 0 && items.length) {
      const entries = items.map((it, i) => [i + 1, map.get(offset + i + 1)]);
      map.clear();
      for (const [k, v] of entries) {
        items[k - 1].ref = k;
        if (v) map.set(k, v);
      }
    }
    return {
      url: location.href,
      title: document.title,
      elements: items,
      excerpt: bodyText,
      iframes: iframeSrcs,
      canvas: canvasBlock || undefined,
      offset,            // 本次窗口起始偏移（0 = 第一批）
      more: ref >= limit // 收集被截断 = 页面还有元素没进本窗口，可 snapshot offset 翻下一批
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
      // 电子表格通用特征：value 是"格子号"格式（D2 / $A$1 / E5:G8）的输入框 → 单元格名称框
      // （Excel/Sheets/WPS/腾讯等表格的名称框都是这种值，按格式识别、不认站点）
      if (el.type === 'text' || el.type === '') {
        const v = String(el.value || '').trim().toUpperCase();
        if (/^[$]?[A-Z]{1,3}[$]?[0-9]{1,7}(:[$]?[A-Z]{1,3}[$]?[0-9]{1,7})?$/.test(v)) return '单元格名称框';
      }
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
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32,
      F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118,
      F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
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

  // 安全点击：.click() 只在 HTMLElement 上定义，SVG/MathML 等外来元素（快照会收录的裸图标）
  // 没有，直接调会抛 "el.click is not a function"。外来元素退化用 dispatchEvent 派发可冒泡的
  // click 事件，同样能触发元素自身及祖先上的点击处理（React/原生 onclick 都在冒泡路径上）。
  function fireClick(el) {
    if (!el) return;
    if (typeof el.click === 'function') { try { el.click(); return; } catch (e) {} }
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
  }
  // 安全聚焦：focus() 同样只在 HTMLElement 上可靠，外来元素拿不到就跳过（不抛错打断动作）。
  function focusEl(el) {
    if (!el) return;
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
  }

  // ---------------- show / hide：强制显示"悬浮/隐藏才出现"的元素 ----------------
  // 纯 CSS `:hover` 才显示的菜单（display:none → :hover 显示）合成事件触发不了，hover 动作对它无效；
  // show 用改 inline style 的方式把它焊成常驻可见（inline style 优先级最高，不会被 hover CSS 覆盖），
  // 操作完用 hide 精确还原。只改样式不执行代码、副作用最小；页面刷新后 inline style 自然失效自动复原。
  const shownEls = new Map(); // element -> 原始 style 属性（null=原本没有 inline style），hide 据此精确还原

  // display:none 强制改可见时的合理默认值：直接改 block 对表格元素是无效值会破坏布局，按标签给对应值
  const DISPLAY_DEFAULTS = { TR: 'table-row', TD: 'table-cell', TH: 'table-cell', LI: 'list-item' };

  // 强制显示单个元素：把"挡住显示"的三个属性改成可见值（display:none→对应默认 / visibility→visible / opacity:0→1）。
  // 首次动到的元素先记下原始 inline style，hide 时整体还原（含页面原有样式）。
  function forceShowElement(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (!shownEls.has(el)) shownEls.set(el, el.getAttribute('style'));
      let changed = false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') { el.style.display = DISPLAY_DEFAULTS[el.tagName] || 'block'; changed = true; }
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') { el.style.visibility = 'visible'; changed = true; }
      if (parseFloat(cs.opacity) === 0) { el.style.opacity = '1'; changed = true; }
      return changed;
    } catch (e) { return false; }
  }

  // 强制显示"元素自身 + 隐藏的祖先链"：菜单项常被 display:none 的父容器包着，只改自己仍看不见。
  // 从最外层往内改（外层不先可见，内层改了也没用）。返回实际动过的元素数（0=本来就是可见的）。
  function forceShowChain(el) {
    const chain = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      let hidden = false;
      try {
        const cs = getComputedStyle(cur);
        hidden = cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) === 0;
      } catch (e) { hidden = true; }
      if (hidden) chain.push(cur);
      if (cur === document.body) break;
      cur = cur.parentElement;
    }
    let changed = 0;
    for (const n of chain.reverse()) { if (forceShowElement(n)) changed++; }
    return changed;
  }

  function restoreElement(el) {
    const orig = shownEls.get(el);
    if (orig == null) el.removeAttribute('style');
    else el.setAttribute('style', orig);
    shownEls.delete(el);
  }

  // 还原单个元素及其被 show 强制显示的祖先链（show 带 target 对应的 hide）
  function restoreShownChain(el) {
    let n = 0;
    const els = [el];
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      els.push(cur);
      if (cur === document.body) break;
      cur = cur.parentElement;
    }
    for (const e of els) { if (shownEls.has(e)) { restoreElement(e); n++; } }
    return n;
  }

  // 还原本窗口全部被 show 过的元素（hide 不带 target；页面已移除的元素只清记录）
  function restoreAllShown() {
    let n = 0;
    for (const el of Array.from(shownEls.keys())) {
      if (document.contains(el)) { restoreElement(el); n++; }
      else shownEls.delete(el);
    }
    return n;
  }

  // 按文字找隐藏元素（show 用）：与 findElementByText 相反，不滤隐藏，专找"悬浮/隐藏才出现"的菜单项。
  // 纯 CSS :hover 显示的菜单在 DOM 里就是 display:none / visibility:hidden，文字照样能扫到。
  // 命中优先取"可点 + 当前不可见"者（最像"悬浮才显示"的菜单项），其次任意不可见命中，最后文本最短匹配兜底。
  function findHiddenElementByText(text) {
    const target = String(text || '').replace(/\s+/g, ' ').trim();
    if (!target || !document.body) return null;
    const cands = [];
    let checked = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode()) && checked++ < 4000) {
      const s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (s.indexOf(target) !== -1) {
        const p = n.parentElement;
        if (p) cands.push({ el: p, len: s.length });
      }
    }
    checked = 0;
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let m;
    while ((m = w2.nextNode()) && checked++ < 4000) {
      const s = String(m.textContent || '').replace(/\s+/g, ' ').trim();
      if (s.indexOf(target) !== -1) cands.push({ el: m, len: s.length });
    }
    cands.sort((x, y) => x.len - y.len);
    for (const c of cands) {
      if (c.len > Math.max(target.length * 4, 30)) break;
      if (isLikelyClickable(c.el) && !isVisible(c.el)) return c.el;
    }
    for (const c of cands) {
      if (c.len > Math.max(target.length * 3, 20)) break;
      if (!isVisible(c.el)) return c.el;
    }
    return cands.length ? cands[0].el : null; // 兜底：文本最短匹配（可见的也算，强制显示它本身或隐藏祖先）
  }

  // 动作后的页面稳定等待（事件驱动，非固定延时）：会触发跳转或重渲染的动作——Enter/Tab/Escape/空格这类"提交/
  // 关闭"键、scroll 滚动触发懒加载、click 触发的 SPA 状态切换——执行后，页面往往异步跳转或重渲染。若不等渲染完
  // 就返回，background 紧接着拍的快照会拍到动作前的旧页面，模型就基于旧页面乱点（如点击已失效的无名按钮）而失败。
  // 机制：MutationObserver 监听 DOM 变更，连续 SETTLE_QUIET_MS 无变更（渲染静止）即认为稳定；
  // URL 变化视为跳转进行中，重置静默计时再等渲染；整页导航（pagehide）立即放行，交给 background 的 awaitNav；
  // SETTLE_MAX_MS 仅为防挂死上限（页面持续动画/懒加载时兜底），正常路径远到不了它。
  const SETTLE_QUIET_MS = 300; // DOM 连续静默此毫秒数视为渲染稳定（事件驱动的静默窗口，非总等待时长）
  const SETTLE_MAX_MS = 2500;  // 兜底上限：防止页面永不静止（无限滚动/动画/懒加载）时本步挂死
  const KEYPRESS_NAV_KEYS = new Set(['Enter', 'Tab', 'Escape', ' ', 'Space']); // 可能触发跳转/重渲染的按键（仅 keypress 用）
  function settlePage() {
    return new Promise((resolve) => {
      let done = false;
      let last = Date.now();
      let lastUrl = location.href;
      const url0 = location.href; // 进入本动作时的 URL，用于判断本次动作是否触发了跳转
      let mutated = false;       // 静默窗口内 DOM 是否有过变更
      let timer = null;
      let maxTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(maxTimer);
        obs.disconnect();
        window.removeEventListener('pagehide', onPageHide);
        // changed=本次动作是否产生了可观察变化（URL 跳转或 DOM 重渲染）。click 用它告知模型
        // "这次点击到底有没有生效"：全 false 说明是死点（点了没反应），模型据此换招，别对死点反复试。
        resolve({ changed: mutated || location.href !== url0 });
      };
      const arm = () => { // DOM 有变更：记下变化、静默计时归零，重新数 QUIET_MS
        mutated = true;
        last = Date.now();
        clearTimeout(timer);
        timer = setTimeout(check, SETTLE_QUIET_MS);
      };
      const check = () => {
        const now = Date.now();
        if (location.href !== lastUrl) { // URL 已变 = 跳转进行中，重置计时等跳转后的渲染稳定
          lastUrl = location.href;
          last = now;
        }
        const remain = SETTLE_QUIET_MS - (now - last);
        if (remain <= 0) finish();
        else { clearTimeout(timer); timer = setTimeout(check, remain); }
      };
      const onPageHide = () => finish(); // 整页导航：本上下文即将销毁，放行由 background awaitNav 接管
      const obs = new MutationObserver(arm);
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      window.addEventListener('pagehide', onPageHide);
      timer = setTimeout(check, SETTLE_QUIET_MS);
      maxTimer = setTimeout(finish, SETTLE_MAX_MS);
    });
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
        fireClick(el);
        focusEl(el);
        // 点击常触发 SPA 跳转/弹层/状态切换，DOM 会异步重渲染：等页面稳定再返回，避免下个快照拍到点击前的旧页面。
        // settled.changed=false 说明点击没产生可观察变化（URL 没变、DOM 没动）= 死点，模型据此换招。
        const settled = await settlePage();
        return { ok: true, label: elementLabel(el), changed: !!settled.changed };
      }

      case 'clickAt': { // 按视口坐标点击：画布文字钩子给出坐标后，点画布上具体位置/单元格（内容不在 DOM，无法用 ref 定位）
        const x = Number(a.x), y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, message: 'clickAt 需要数字坐标 x,y（视口坐标）' };
        let target = null;
        try { target = document.elementFromPoint(x, y); } catch (e) {}
        if (!target || target === document.documentElement || target === document.body) {
          return { ok: false, message: '坐标 (' + Math.round(x) + ',' + Math.round(y) + ') 处没有元素' };
        }
        // 命中"会新开页面"的链接同 click 一样截获，交给 background 后台打开（不抢焦点）
        const anchor = target.closest ? target.closest('a') : null;
        if (anchor) {
          const tgt = String(anchor.target || anchor.getAttribute('target') || '').trim().toLowerCase();
          const href = anchor.getAttribute('href');
          if (tgt === '_blank' && href && /^(https?|file):/i.test(href)) {
            return { ok: true, openTab: new URL(href, location.href).href, label: elementLabel(target) };
          }
        }
        await humanClickGap(); // 拟人：随机 0.5s~2s
        // 画布应用（表格）用 mousedown/mouseup/click 做单元格命中；带 clientX/clientY 合成事件即可定位。
        const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, view: window, composed: true };
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        return { ok: true, label: elementLabel(target), at: [Math.round(x), Math.round(y)] };
      }

      case 'dblclickAt': { // 按视口坐标双击：画布表格/文档单元格要"双击进入就地编辑"才可输入（单击只是选中），双击后页面出现就地编辑框
        const x = Number(a.x), y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, message: 'dblclickAt 需要数字坐标 x,y（视口坐标）' };
        let target = null;
        try { target = document.elementFromPoint(x, y); } catch (e) {}
        if (!target || target === document.documentElement || target === document.body) {
          return { ok: false, message: '坐标 (' + Math.round(x) + ',' + Math.round(y) + ') 处没有元素' };
        }
        const anchor = target.closest ? target.closest('a') : null;
        if (anchor) {
          const tgt = String(anchor.target || anchor.getAttribute('target') || '').trim().toLowerCase();
          const href = anchor.getAttribute('href');
          if (tgt === '_blank' && href && /^(https?|file):/i.test(href)) {
            return { ok: true, openTab: new URL(href, location.href).href, label: elementLabel(target) };
          }
        }
        await humanClickGap();
        // 标准双击序列：两轮 down/up/click（第二次 detail=2）再补 dblclick，框架监听哪种都能命中
        const base = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, view: window, composed: true };
        const fire = (type, detail) => target.dispatchEvent(new MouseEvent(type, { ...base, detail }));
        fire('mousedown', 1); fire('mouseup', 1); fire('click', 1);
        await sleep(60); // 双击间隔（系统双击判定的时间窗口）
        fire('mousedown', 2); fire('mouseup', 2); fire('click', 2); fire('dblclick', 2);
        return { ok: true, label: elementLabel(target), at: [Math.round(x), Math.round(y)] };
      }

      case 'gotoCell': { // 电子表格通用能力：按格子引用跳格（D2 / $A$1 / E5:G8），不依赖像素坐标。
        // 识别"单元格名称框"（value 是格子号格式的输入框——表格通用特征）→ 输格号 + 回车 → 读回验证。
        const rawRef = String(a.ref || '').trim();
        const ref = rawRef.toUpperCase();
        if (!/^[$]?[A-Z]{1,3}[$]?[0-9]{1,7}(:[$]?[A-Z]{1,3}[$]?[0-9]{1,7})?$/.test(ref)) {
          return { ok: false, message: 'gotoCell 需要格子引用（如 D8、$A$1、E5:G8），收到: ' + (rawRef || '(空)') };
        }
        let nameBox = null;
        try {
          for (const el of document.querySelectorAll('input')) {
            const v = String(el.value || '').trim().toUpperCase();
            if (/^[$]?[A-Z]{1,3}[$]?[0-9]{1,7}(:[$]?[A-Z]{1,3}[$]?[0-9]{1,7})?$/.test(v)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { nameBox = el; break; } // 首个可见匹配即名称框（公式栏里排最前）
            }
          }
        } catch (e) {}
        if (!nameBox) return { ok: false, message: '没找到单元格名称框（页面没有 value 是格子号格式的输入框，无法跳格），可用 clickAt 坐标点选兜底' };
        try { nameBox.scrollIntoView({ block: 'center' }); } catch (e) {}
        nameBox.focus();
        nameBox.select();
        setNativeValue(nameBox, ref, false); // 覆盖原格号（走原生 setter + input 事件，受控组件也能收到）
        await humanClickGap(); // 拟人节奏
        const k = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, view: window };
        nameBox.dispatchEvent(new KeyboardEvent('keydown', k));
        nameBox.dispatchEvent(new KeyboardEvent('keypress', k));
        nameBox.dispatchEvent(new KeyboardEvent('keyup', k));
        await sleep(300); // 等跳转 + 表格重画
        const now = String(nameBox.value || '').trim().toUpperCase();
        const ok = now === ref;
        // ---- 跳格成功后把焦点交还给表格网格 ----
        // 名称框回车后焦点常留在输入框上，导致后续 F2/打字作用不到表格（F2 按在输入框上不进编辑）。
        // 表格的键盘处理器挂在"网格表面"容器上、键事件会冒泡，所以把焦点放到网格内部元素即可：
        // 先 blur 名称框（应用可能自己把焦点还回网格），焦点仍不在网格上时，再找大画布的可聚焦祖先/画布本身。
        if (ok) {
          try { nameBox.blur(); } catch (e) {}
          await sleep(60); // 给应用机会自行把焦点还回网格
          let g = document.activeElement;
          const gIsInput = g && (g.tagName === 'INPUT' || g.tagName === 'TEXTAREA' || g.isContentEditable);
          if (!g || g === document.body || g === document.documentElement || gIsInput) {
            g = null;
            try {
              for (const c of document.querySelectorAll('canvas')) {
                const r = c.getBoundingClientRect();
                if (r.width < 200 || r.height < 200) continue; // 小画布（图标/头像）跳过，只认大网格
                let cur = c;
                for (let i = 0; cur && cur !== document.body && i < 6; i++) {
                  const at = cur.getAttribute && cur.getAttribute('tabindex');
                  if (at != null && at !== '-1') { g = cur; break; } // 网格表面的可聚焦容器
                  cur = cur.parentElement;
                }
                g = g || (c.closest('[role="grid"],[role="application"],[role="table"],[role="treegrid"]') || c);
                break;
              }
              if (g) { g.focus(); await sleep(30); }
            } catch (e) {}
          }
        }
        // 诊断：跳格+焦点交还后，焦点落在哪个元素（日志里能直接看到，方便排查 F2 是否作用到表格）
        let foc = '';
        try {
          const f = document.activeElement;
          foc = f && f !== document.body && f !== document.documentElement ? (elementLabel(f) || f.tagName) : 'body';
        } catch (e) {}
        return { ok, message: ok ? '已跳到 ' + ref + '，焦点在「' + foc + '」' : '跳转未生效：名称框仍显示 ' + (now || '(空)') + '，可用 clickAt 坐标点选兜底', at: [ref, now] };
      }

      case 'clickText': { // 兜底：元素列表解决不了时，大模型对页面文字做语义判断、直接试点"可能可点"的文字
        const raw = String(a.text || '').trim();
        if (!raw) return { ok: false, message: 'clickText 缺少要点的文字 text' };
        const el = findElementByText(raw);
        if (!el) return { ok: false, quiet: true, message: '页面上没找到文字「' + raw.slice(0, 30) + '」——它可能已随列表滚动被回收（虚拟列表只保留视口附近的项），先 scroll 让列表项回到页面再重试 clickText' };
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
        fireClick(target);
        focusEl(target);
        return { ok: true, label: elementLabel(el), byText: true };
      }

      case 'hover': { // 悬浮在元素上（不点击），用于让"悬浮才出现"的元素显示出来；发完合成事件等渲染
        const el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };
        dispatchHover(el);
        await sleep(600); // 等悬浮展开的菜单/操作项渲染完，background 下一步快照才能看到
        return { ok: true, label: elementLabel(el), hovered: true };
      }

      case 'show': { // 强制显示"悬浮/隐藏才出现"的元素（hover 触发不了的纯 CSS :hover 菜单用这个兜底）
        // 定位三选一：text 按文字找（含隐藏元素，最常用）/ selector 用 CSS 选择器 / target 用快照 ref。
        // 元素隐藏时快照里没有它的 ref，所以按文字定位是主路：菜单项文字在 DOM 里，display:none 也扫得到。
        let el = null;
        if (a.target != null) {
          el = findTarget(a.target);
          if (!el) return { ok: false, message: notFoundMsg(a.target) };
        } else if (a.selector) {
          try { el = document.querySelector(String(a.selector)); } catch (e) { el = null; }
          if (!el) return { ok: false, message: '没找到选择器「' + a.selector + '」对应的元素（可能不在当前窗口）' };
        } else if (a.text) {
          el = findHiddenElementByText(String(a.text));
          if (!el) return { ok: false, message: '没找到含「' + a.text + '」的元素（隐藏的也没有）' };
        } else {
          return { ok: false, message: 'show 需要 target / selector / text 之一' };
        }
        const shown = forceShowChain(el);
        await sleep(200); // 等一瞬让强制显示后的重排/渲染落定，下个快照能拍到（纯 CSS 隐藏此时已可见）
        return { ok: true, label: elementLabel(el), shown }; // shown=实际动过的元素数，0 说明本来就可见（show 没揭示新东西）
      }

      case 'hide': { // 还原 show 强制显示的元素：带 target 只还原那个元素及其父容器，不带则还原本窗口全部
        if (a.target != null) {
          const el = findTarget(a.target);
          if (!el) return { ok: false, message: notFoundMsg(a.target) };
          const restored = restoreShownChain(el);
          return { ok: true, restored, label: elementLabel(el) };
        }
        const restored = restoreAllShown();
        return { ok: true, restored };
      }

      case 'type': {
        const t0 = performance.now(); // 记录开始时间，用于判定"输入卡住超过 10 秒"
        const el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };
        const text = String(a.text ?? '');
        // 隐藏输入捕获编辑器（如腾讯文档 melo-hidden-editor）：可见宿主是纯 div，真实输入面
        // 在 inputEl；宿主自身没标 editable 时也退回其内部可编辑子孙（textbox/textarea）兜底。
        const entry = refMap.get(a.target);
        const inputEl = entry && entry.inputEl && document.contains(entry.inputEl) ? entry.inputEl : null;
        let target = inputEl || el;
        if (!inputEl && !target.isContentEditable && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          const leaf = target.querySelector('textarea, [contenteditable], [role="textbox"]');
          if (leaf) target = leaf;
        }
        target.focus();
        if (target.isContentEditable) {
          // 富文本编辑器（ProseMirror/Slate/Quill/腾讯文档等）不走 textContent，
          // 直接赋 textContent 进不了它们的内部模型、内容不渲染，看起来就像"没开始写"。
          // 正路是走 document.execCommand('insertText')，它会进编辑器内部状态、触发它们自己的
          // 事件；全选（覆盖语义）后再逐字插入，模拟真人打字节奏。
          try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
          target.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(target);
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
            target.textContent = text;
            target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
          }
        } else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          setNativeValue(target, '', false); // 覆盖原内容
          for (const ch of text) {
            setNativeValue(target, target.value + ch, false);
            await humanTypeGap(); // 逐字输入
          }
          setNativeValue(target, target.value, true); // 收尾触发 change
        } else {
          return { ok: false, message: '目标不是可输入元素（' + el.tagName + '）' };
        }
        // 输入落地校验 + 超时判定：后台标签常被浏览器节流、或网站没接受合成输入（打进去又回退），
        // 此时 inputStuck=true 让后台非阻塞地提醒使用者介入（Agent 不等待、继续执行）。
        let inputStuck = false;
        if (text.trim() !== '') {
          await sleep(350); // 等一拍，让网站处理合成 input 事件 / 受控组件回写后再验
          if (inputEl) {
            // 隐藏编辑器自身常被引擎清空（内容渲染到可见层），照旧校验会误报"输入卡住"；
            // 改看可见宿主是否真的出现了输入内容。
            const hostText = (el.innerText || '').replace(/\s+/g, '');
            const probe = text.trim().replace(/\s+/g, '').slice(0, 30);
            inputStuck = hostText === '' || !hostText.includes(probe);
          } else {
            const got = target.isContentEditable ? (target.textContent || '') : (target.value || '');
            inputStuck = got.trim() === '';
          }
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
        let innerMoved = 0;
        if (moved === 0) {
          // window 没动 → 页面滚动容器是内层 div（overflow:auto），找主滚动容器兜底
          const el = findMainScrollable();
          if (el) {
            const eb = el.scrollTop;
            el.scrollBy({ top: delta, behavior: 'instant' });
            innerMoved = Math.abs(el.scrollTop - eb);
          }
        }
        // 滚动常触发懒加载/重排（无限流补内容），页面会异步加节点：等渲染稳定再返回，避免下个快照与滚动前无差异（白耗一轮往返）
        await settlePage();
        return { ok: true, moved: innerMoved || moved };
      }

      case 'read': {
        let el;
        if (a.target === 'page' || a.target == null) el = document.body;
        else el = findTarget(a.target);
        if (!el) return { ok: false, message: notFoundMsg(a.target) };
        const raw = a.raw === true;
        // 默认去页脚税；raw:true 只在核对页脚/备案等底部原文时用（会含页脚噪音）
        const text = pageText(el, raw)
          .replace(/\s+/g, ' ')
          .trim();
        // 整页读取并入画布文字：canvas 渲染的正文（表格/文档/小红书笔记等）DOM 里读不到、
        // 只有钩子捕获的画布文字有内容。只读缓冲不消费（不 flush/reset），下一张快照仍能取到。
        const canvasText = (!raw && el === document.body) ? canvasTextForRead() : '';
        const merged = canvasText ? (text ? text + '\n' : '') + canvasText : text;
        return {
          ok: true,
          text: merged.slice(0, READ_LIMIT),
          length: merged.length,
          truncated: merged.length > READ_LIMIT
        };
      }

      case 'keypress': {
        const el = document.activeElement || document.body;
        const keys = String(a.keys || '').split(',').map((s) => s.trim());
        for (const k of keys) {
          const code = keyCode(k);
          el.dispatchEvent(new KeyboardEvent('keydown', { key: k, keyCode: code, which: code, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: k, keyCode: code, which: code, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: k, keyCode: code, which: code, bubbles: true }));
        }
        // 只有真正聚焦了可交互元素时才报元素标签；聚焦 body 则留空，让面板显示按键本身
        const focused = document.activeElement;
        const hasTarget = focused && focused !== document.body && focused !== document.documentElement;
        // Enter/Tab/Escape/空格 可能触发 SPA 跳转或重渲染：等页面稳定再返回，避免下个快照拍到旧页面。
        // 纯编辑键（Backspace/方向键/字符）不等待，保持响应。
        if (keys.some((k) => KEYPRESS_NAV_KEYS.has(k))) {
          await settlePage();
        }
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


  // ---------------- 消息通信 ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'PING':
          return { pong: true };
        case 'GET_SNAPSHOT': {
          const canvasEntries = await collectCanvasText(); // 画布文字：收最新一批并重置钩子，供 buildSnapshot 带出
          return buildSnapshot(canvasEntries, Number(msg.offset) || 0); // offset：翻页窗口起始偏移
        }
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
