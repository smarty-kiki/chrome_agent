/**
 * background.js — PageAgent Service Worker
 *
 * 职责：
 *  1. 持有并持久化任务状态（chrome.storage.session，应对 MV3 worker 被回收）。
 *  2. 运行 Agent 循环：观察页面快照 -> LLM 决策 -> 执行动作 -> 再观察…。
 *  3. 调用 DeepSeek（OpenAI 兼容）接口，强制 JSON 输出并解析动作。
 *  4. 【持续对话模式】任务不因 finish/fail 结束，而是回到 idle 等待使用者
 *     下一条指令；对话记录与 Agent 自开标签跨轮保留，构成多轮对话。
 *  5. 多标签编排：
 *     - @MAIN  = 使用者交给 Agent 的标签页（不入分组）。
 *     - @T1/@T2 = Agent 用 tabs.create({active:false}) 自开的后台标签（不抢焦点），
 *       自动归入同一个 tab group 统一管理。
 *     - switch_tab 只切换 Agent 的关注焦点，不切换浏览器前台。
 *  6. 向侧边栏面板广播聊天消息 / 活动日志 / 状态。
 */
'use strict';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash'; // DeepSeek V4 Flash（deepseek-chat/reasoner 旧别名已退役）
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_STEPS = 25;
const NAV_TIMEOUT_MS = 120000;   // 页面加载/跳转等待上限
const MAX_AGENT_TABS = 8;        // Agent 自开标签上限，防止失控
const HEARTBEAT_ALARM = 'pageagent-heartbeat';
const MAX_STEP_LLM_RETRY = 4;    // 单步 LLM 输出解析失败的最大重试次数
const MAX_SESSIONS = 5;          // 最多并发会话数（顶部会话栏可新建/切换）
const MAX_CONVERSATION = 80;     // 对话记录最多保留条数
const MAX_HISTORY = 400;         // LLM 消息历史上限（超出后裁剪保留尾部）
const DEFAULT_CONTEXT_WINDOW = 1000000; // DeepSeek V4 上下文窗口（token），设置里可调
const OUTPUT_RESERVE = 8192;          // 每次调用给 LLM 输出预留的 token
const COMPRESS_THRESHOLD = 0.7;       // 上下文使用到 70% 触发历史压缩
const TAIL_KEEP_STEPS = 2;            // 压缩时保留最近几步原文（快照+动作+结果）
const SUMMARY_CHUNK_TOKENS = 150000;  // 摘要单次输入的 token 上限（超出分块链式合并）
const SUMMARY_MAX_CHARS = 1500;       // 压缩摘要长度上限（字符）

// ---------------- 会话状态模型（多会话并发） ----------------
// 会话对象 = 一个独立对话的全部状态（标签/分组/历史/回合）。tasks[sid] 为字典，
// 各会话的执行链互不干扰（并发安全的关键：执行链全程用参数传入的会话对象，不读全局）。
// activeId 是面板当前查看的会话；后台各会话可同时运行。
let tasks = {};      // sid -> 会话对象
let activeId = null; // 面板当前查看的会话 sid
let seq = 0;         // sid 生成用序号

function newSid() { return 's' + Date.now().toString(36) + (seq++); }
function getTask(sid) { return (sid != null && tasks[sid]) ? tasks[sid] : null; }
function activeTask() { return getTask(activeId); }
function setActive(sid) { activeId = (sid != null && tasks[sid]) ? sid : null; }

// 找出包含某 tabId 的会话（标签事件/教学事件按 tab 路由到所属会话）；找不到返回 null
function sessionOfTab(tabId) {
  for (const sid of Object.keys(tasks)) {
    if ((tasks[sid].tabs || []).some((e) => e.tabId === tabId)) return sid;
  }
  return null;
}

// 当前处于"教我演示"等待态的会话（演示是使用者独占行为，多个会话不会同时等教）
function findTeachSid() {
  let found = null;
  for (const sid of Object.keys(tasks)) {
    const s = tasks[sid];
    if (s && s.state === 'waiting_user' && s.askMode === 'teach') {
      if (sid === activeId) return sid;
      if (!found) found = sid;
    }
  }
  return found;
}

// 分配 1..MAX_SESSIONS 里最小空闲编号（删除会话后编号释放、可复用）
function nextNumber() {
  const used = new Set();
  for (const sid of Object.keys(tasks)) {
    const n = tasks[sid].n;
    if (n != null) used.add(n);
  }
  for (let n = 1; n <= MAX_SESSIONS; n++) if (!used.has(n)) return n;
  return null;
}

// ---------------- 会话持久化（storage key 'tasks'，兼容旧 'task' 单会话数据） ----------------
async function loadTasks() {
  if (Object.keys(tasks).length) return tasks;
  const { tasks: dict, task: old } = await chrome.storage.session.get(['tasks', 'task']);
  if (dict && Object.keys(dict).length) {
    tasks = dict;
  } else if (old) {
    const sid = newSid();
    old.sid = sid;
    old.n = 1;
    old.groupTitle = 'PageAgent 1';
    tasks = { [sid]: old };
    await chrome.storage.session.remove('task');
  }
  // 兜底：至少保留一个空会话（面板可直接发指令）
  if (!Object.keys(tasks).length) await createSession();
  if (!activeId || !tasks[activeId]) activeId = Object.keys(tasks)[0] || null;
  updateBadge();
  return tasks;
}

async function saveTasks() {
  // 长对话防膨胀：每会话保留 system + 最近 350 条
  for (const sid of Object.keys(tasks)) {
    const t = tasks[sid];
    if (t.history && t.history.length > MAX_HISTORY) {
      t.history = [t.history[0]].concat(t.history.slice(-(MAX_HISTORY - 50)));
      if (t.ctxBoundary != null) t.ctxBoundary = Math.min(t.ctxBoundary, t.history.length);
    }
  }
  await chrome.storage.session.set({ tasks });
  updateBadge(); // 所有状态变更都经 saveTasks，角标随之刷新
}

// 新建一个空会话（idle）。tabId 可选：给定时直接把 @MAIN 钉到该标签。返回会话对象；满 5 个返回 null
async function createSession(tabId) {
  const n = nextNumber();
  if (n == null) return null;
  const sid = newSid();
  const t = {
    id: 't' + Date.now().toString(36) + seq,
    sid,
    n,
    groupTitle: 'PageAgent ' + n,
    mainTabId: tabId != null ? tabId : null,
    tabSeq: 0,
    userTabSeq: 0,
    tabs: tabId != null ? [{ ref: 'MAIN', tabId, role: 'main', title: '', url: '' }] : [],
    currentRef: 'MAIN',
    groupId: null,
    waitTabId: null,
    goal: '',
    state: 'idle', // idle = 等待使用者第一条指令
    turnId: 0,     // 回合号，用于打断旧回合
    turnHistoryStart: 0, // 本回合在 history 里的起点（复盘时切出本轮访问过的站点）
    steps: 0,
    turnSteps: 0,  // 本轮步数（每轮重置，maxSteps 按轮生效）
    failStreak: 0, // 本轮连续失败次数（>=3 转人工）
    askText: null, // 等待使用者时的提示文案
    askMode: 'page', // page=需在页面上操作；reply=需在对话中回复；teach=教我模式（演示学习）
    waitingReply: false, // 是否正等待使用者在对话中回复
    teachTabId: null,    // 教我模式主教学标签（进入时当前操作标签）
    teachTabIds: [],     // 教我模式监听【任务下所有 tab】的录制挂载清单
    teachEvents: [],     // 教我模式录制缓冲（content 批量上报 TEACH_EVENT 累积）
    llmLogs: [],         // 大模型往返日志（面板"日志"视图）：每步决策 { t, req, res }
    history: [{ role: 'system', content: systemPrompt() }],
    ctxSummary: null,   // 历史压缩摘要（已完成进展 / 踩过的坑 / 用户注意点）
    ctxBoundary: 0,     // 历史下标：该下标之前的消息已并入 ctxSummary，之后逐条发送
    conversation: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    awaitingNavAt: 0,
    navWaitIdx: null, // "正在打开页面，等待就绪…"在 logs 里的索引，就绪后合并成一行
    lastActiveAt: Date.now(),
    consecWaits: 0,   // 连续 wait 次数（无真实动作插入时累计，防"假装人类"空转）
    lastActSig: '',   // 最近一次执行（成功或失败）的页面动作签名，识别"反复执行同一个动作"的无进展循环
    stuck: 0,         // 无进展计数：连续失败/重复同一动作/空等累计，换新动作清零，>=STUCK_TEACH_LIMIT 转教我
    lastTipsHost: ''  // 本会话已显示"加载 x 个相关技巧"的站点（同一站点只提示一次，避免刷屏）
  };
  tasks[sid] = t;
  await saveTasks();
  return t;
}

// 确保会话存在并把 @MAIN 钉到 tabId（首次发送/指令时）
async function ensureSession(sid, tabId) {
  await loadTasks();
  let t = getTask(sid) || (await createSession(tabId));
  if (t.mainTabId == null && tabId != null) {
    t.mainTabId = tabId;
    t.tabs.push({ ref: 'MAIN', tabId, role: 'main', title: '', url: '' });
    const mainTab = await getTab(tabId);
    if (mainTab) {
      t.tabs[0].title = mainTab.title || '';
      t.tabs[0].url = mainTab.url || '';
    }
    await saveTasks();
  }
  return t;
}

// ---------------- 配置 ----------------
async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return Object.assign(
    {
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      temperature: DEFAULT_TEMPERATURE,
      maxSteps: DEFAULT_MAX_STEPS,
      searchTemplate: 'https://www.bing.com/search?q=',
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      compressThreshold: Math.round(COMPRESS_THRESHOLD * 100),
      apiKey: ''
    },
    config || {}
  );
}
async function saveConfig(patch) {
  const cur = await getConfig();
  await chrome.storage.local.set({ config: Object.assign(cur, patch || {}) });
}

// ---------------- 工具 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getTab(id) {
  if (id == null) return null;
  try {
    return await chrome.tabs.get(id);
  } catch (e) {
    return null;
  }
}

// chrome://、about:、扩展管理页等受限地址：content script 无法注入，需跳过快照直接让 LLM 另开网页，避免反复失败空转
function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|chrome-search|edge|about|devtools|view-source|file):/i.test(String(url || ''));
}

function broadcast(msg, sid) {
  if (sid != null) msg.sid = sid;
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// addLog(sid, m, quiet)：向面板广播"友好动作轨迹"。quiet=true 时只进 SW console，不推送到面板
// （面板只显示给使用者看的动作痕迹，技术细节留在 Service Worker 控制台排查，不再持久化诊断日志）。
function addLog(sid, m, quiet) {
  console.log('[PageAgent]', m); // 始终进 SW console（chrome://extensions → Service Worker → DevTools Console）
  if (!quiet) broadcast({ type: 'AGENT_ACTIVITY', text: String(m) }, sid);
}

// 改写面板最后一行动作行（如把"正在打开页面，等待就绪…"补上就绪时间）
function updateLog(sid, idx, m) {
  broadcast({ type: 'AGENT_ACTIVITY_UPDATE', text: String(m) }, sid);
}

// ---------------- 大模型往返日志（面板"日志"视图用） ----------------
// 每步 LLM 决策记录一条：给大模型发了什么【从简】（消息条数 + 输入量 + 当前页面）、返回了什么【全量】。
// 存进 t.llmLogs（GET_STATE 带出，面板切走/重开仍在），同时广播 AGENT_LLM_LOG 实时推送。
const MAX_LLM_LOG = 150; // 每会话保留的大模型往返日志条数上限
const MAX_LLM_LOG_RES = 6000; // 单条日志里原始返回的最大字符数（防止长 finish 结果把面板撑爆）

// 发送内容的简况：消息条数 + 输入字符量 + 当前操作页面（取自 history 末条快照里的 URL）
function llmReqBrief(t, msgs) {
  let chars = 0;
  for (const m of msgs) chars += String(m.content || '').length;
  let page = '';
  const hist = (t && t.history) || [];
  const last = hist[hist.length - 1];
  if (last && last.content) {
    const m = String(last.content).match(/URL:\s*(\S+)/);
    if (m) page = shortUrl(m[1]);
  }
  const size = chars > 1000 ? (chars / 1000).toFixed(1) + 'k' : String(chars);
  return '发送 ' + msgs.length + ' 条 · 输入约 ' + size + ' 字符' + (page ? ' · ' + page : '');
}

function logLLMExchange(t, msgs, raw) {
  try {
    if (!t || !t.sid) return;
    if (!t.llmLogs) t.llmLogs = [];
    const entry = {
      t: Date.now(),
      req: llmReqBrief(t, msgs),
      res: String(raw || '').slice(0, MAX_LLM_LOG_RES)
    };
    t.llmLogs.push(entry);
    if (t.llmLogs.length > MAX_LLM_LOG) t.llmLogs.splice(0, t.llmLogs.length - MAX_LLM_LOG);
    console.log('[PageAgent] LLM 往返：' + entry.req);
    broadcast({ type: 'AGENT_LLM_LOG', req: entry.req, res: entry.res, t: entry.t }, t.sid);
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// 防"页面动作触发的 window.open 抢前台焦点"（target=_blank 链接已在 content.js 截获，这里是 JS 新开的兜底）：
// 页面动作执行窗口内新开的标签若抢到前台，立即把焦点还给动作前使用者的前台标签，
// 并把该新标签纳入 Agent 自开 @T（页面动作触发的，算 Agent 开的，不算使用者的）。
const focusGuard = { armed: false, until: 0, anchorTabId: null, created: new Set(), sid: null };

function armFocusGuard(t) {
  focusGuard.armed = true;
  focusGuard.until = Date.now() + 2500; // 覆盖动作执行 + 异步 window.open 的余量
  focusGuard.created.clear();
  focusGuard.sid = t ? t.sid : null;
  chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then((tabs) => { focusGuard.anchorTabId = (tabs && tabs[0]) ? tabs[0].id : null; })
    .catch(() => {});
}

chrome.tabs.onCreated.addListener((tab) => {
  if (focusGuard.armed && Date.now() <= focusGuard.until) focusGuard.created.add(tab.id);
});

chrome.tabs.onActivated.addListener(async (info) => {
  // 教我模式：使用者在演示中切到/新开另一个标签继续操作，也纳入该会话并挂上录制（学习者只演示不指挥，切到哪个就学哪个）
  const teachSid = findTeachSid();
  if (teachSid) {
    try {
      await adoptTeachTab(info.tabId, getTask(teachSid));
    } catch (e) {}
    return;
  }
  if (!focusGuard.armed || Date.now() > focusGuard.until) return;
  if (!focusGuard.created.has(info.tabId)) return; // 只处理动作期间新开的标签
  focusGuard.armed = false; // 只处理一次
  const anchor = focusGuard.anchorTabId;
  if (anchor != null && anchor !== info.tabId) {
    chrome.tabs.update(anchor, { active: true }).catch(() => {}); // 焦点还给使用者之前的标签
  }
  try {
    await adoptOpenedTab(info.tabId, getTask(focusGuard.sid) || activeTask());
  } catch (e) {}
});

// SW 全局异常兜底：任何未捕获的错误都会落到这里，便于定位"打开页面后就没反应"
self.addEventListener('error', (e) => {
  console.error('[PageAgent] SW 错误：', e.message, e.filename + ':' + e.lineno);
  try { addLog(null, '后台异常：' + e.message + ' @' + (e.filename || '') + ':' + e.lineno); } catch (_) {}
});
self.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const m = (r && r.message) || String(r);
  console.error('[PageAgent] SW 未处理拒绝：', r);
  try { addLog(null, '后台未处理异常：' + m); } catch (_) {}
});

function broadcastTabs(t) {
  broadcast({ type: 'AGENT_TABS', tabs: t ? (t.tabs || []).map((x) => ({ ref: x.ref, role: x.role, title: x.title, url: x.url })) : [] }, t ? t.sid : null);
}

// 工具栏图标右下角角标动效（badge 位于图标右下角）：
//   运行中/加载中 = 运行中的会话数 + 旋转动画（蓝）
//   等待手动操作 = 橙色 "!" 闪烁
//   空闲 = 清空
let badgeTimer = null;

function stopBadgeEffect() {
  if (badgeTimer) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }
}

function startBadgeEffect(kind, count) {
  stopBadgeEffect();
  if (kind === 'wait') {
    let show = true;
    badgeTimer = setInterval(() => {
      show = !show;
      try {
        chrome.action.setBadgeText({ text: show ? '!' : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#f5a623' });
      } catch (e) {}
    }, 600);
    return;
  }
  // working / awaiting_nav：旋转加载帧 + 运行中的会话数（如 2- 2\ 2| 2/）
  const frames = ['-', '\\', '|', '/'];
  let i = 0;
  badgeTimer = setInterval(() => {
    i = (i + 1) % frames.length;
    try {
      const num = Math.min(count || 0, 99);
      chrome.action.setBadgeText({ text: String(num) + frames[i] });
      chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' });
    } catch (e) {}
  }, 350);
}

// 统一由 saveTasks()/loadTasks() 触发：任何状态变更都会重新对齐角标动效。
// 多会话下聚合：任一等待手动操作 → 橙 !（优先生效，提醒使用者介入）；否则统计运行中的会话数，
// 蓝 spinner 显示该数量（N- N\ N| N/），不再显示单个会话的步数
function updateBadge() {
  try {
    let wait = false;
    let running = 0;
    for (const sid of Object.keys(tasks)) {
      const s = tasks[sid];
      if (!s) continue;
      const st = s.state || 'idle';
      if (st === 'waiting_user') wait = true;
      else if (st === 'working' || st === 'awaiting_nav') running++;
    }
    if (wait) { startBadgeEffect('wait'); return; }
    if (running > 0) { startBadgeEffect('working', running); return; }
    stopBadgeEffect();
    chrome.action.setBadgeText({ text: '' });
  } catch (e) {}
}

// 判断某个动作回合是否仍是当前回合（用于新指令打断旧回合时安全退出）
function stillCurrent(t, myTurn, force) {
  // force：复盘类后台任务用（如停止后复盘），只认回合号、不再要求 state===working
  return !!(t && t.turnId === myTurn && (force || t.state === 'working'));
}

// ---------------- 心跳（防休眠 + 跳转超时 + 停滞自愈） ----------------
function setupAlarm() {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
}
function clearAlarm() {
  chrome.alarms.clear(HEARTBEAT_ALARM);
}

chrome.alarms.onAlarm.addListener(async (al) => {
  if (al.name !== HEARTBEAT_ALARM) return;
  await loadTasks();
  let anyBusy = false;
  for (const sid of Object.keys(tasks)) {
    const t = tasks[sid];
    if (!t || t.state === 'idle' || t.state === 'done' || t.state === 'waiting_user') continue;
    anyBusy = true;
    if (t.state === 'awaiting_nav') {
      const waited = Date.now() - (t.awaitingNavAt || 0);
      if (waited > NAV_TIMEOUT_MS) {
        fail(t, '页面加载/跳转超时（' + Math.round(waited / 1000) + 's）');
      } else {
        tryResume(sid, t.waitTabId); // 尝试提前恢复，失败会再次进入 awaiting_nav
      }
    } else if (t.state === 'working') {
      // MV3 worker 可能被回收导致循环中断：检测到长期无进展则从持久化状态恢复
      const stale = Date.now() - (t.lastActiveAt || 0) > 60000;
      if (stale) {
        addLog(sid, '检测到任务停滞，尝试恢复…', true);
        agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
      }
    }
  }
  if (!anyBusy) clearAlarm();
});

// ---------------- 系统提示词（持续对话模式） ----------------
function systemPrompt() {
  return `你是 PageAgent，一个运行在用户浏览器里的智能助手，采用"持续对话"模式。

使用者会持续给你下达指令（操作类：登录、搜索、填表、抓取；总结类：提炼要点；查资料类：搜索/开网页；保存类：写成文件下载）。每收到一条新指令：
1. 先判题：判断 @MAIN 当前页面与这条指令是否相关。相关就在当前页操作；**不相关时不要在当前页瞎点**，直接用 search 搜索，或 open_tab 打开任务相关的网站/URL 来处理。
2. 逐步执行：观察 → 决策 → 执行 → 再观察，直到完成这条指令。
3. 用 finish 给出这条指令的回答，然后**等待使用者下一条指令**（不要结束对话，不要关闭标签）。

多轮对话中，请记住并复用此前完成的操作和得出的结论（对话记录跨轮保留）。例如使用者说"把刚才的总结存成文件"，你应能找到之前的总结内容并用 save_file 保存。注意：每轮完成时你自开的标签（@T 系）会被自动关闭，跨轮不再存在；要重新访问某页面时用 open_tab/search 重新打开，或用 use_tab 用使用者已打开的标签。

你拥有"任务标签页"：@MAIN 是使用者交给你的标签页（属于使用者，不要随便关）；@T1/@T2/... 是你自己新开的后台标签（已自动归入本会话的 PageAgent N 分组，不影响使用者浏览；点击"新开页面"的链接也会自动变成后台 @T 标签，不抢你正在看的焦点）；@U1/@U2/... 是你用 use_tab 纳入任务的使用者已有标签（同样属于使用者，不要随便关）。
你通过"页面快照"感知当前操作标签的网页：包括标签页列表、URL、标题、可交互元素列表（[ref] 类型 文本 值 选择器）和正文摘要。页面可能包含内嵌 iframe 子窗口（如某些网站的弹窗/新建流程），子窗口里的可交互元素也会并进快照、用【子窗口 N】分组标出，正文摘要里附有子窗口内容，你同样可以点击/读取它们。若快照提示有未读取成功的内嵌窗口（可能仍在加载），先 wait 等它加载完再重新观察，目标往往会出现，不要因为一时看不到就转去别处乱点。若你刚点击了一个按钮/链接，下一次快照里出现了新的【子窗口 N】分组或元素变多，说明弹窗/面板已经打开，接下来的目标应该在这个新窗口里找——**不要重复点击刚才那个按钮**（可能把弹窗又关掉），直接在弹窗里继续操作。
快照开头（元素列表之前）的【本站操作技巧】是该网站历史沉淀下来的操作经验（比如"搜索要直接点第一条结果""要先点开下拉再选择"）。它放在元素列表**之前**：**每次选元素、定动作前先对照它**，与技巧描述不符的做法多半在绕弯路，优先按技巧来。当反复失败、找不到元素、或准备执行的动作与技巧不一致时，先回头对照本站技巧调整，而不是硬试同一招；若某条技巧与当前页面明显冲突（页面已改版），说明它已过期，跳过它、以当前页面为准。

每收到一个快照，你必须输出唯一的 JSON 动作对象。可用动作：

0. 标签操作（ref 用 @MAIN / @T1 / @U1 ...；tabId 用 list_tabs 返回的编号）：
   {"action":"open_tab","url":"https://..."}   新开后台标签（不抢焦点、自动加入分组）
   {"action":"search","query":"关键词"}          用搜索引擎搜索（自动打开后台标签，不要手动拼 URL）
   {"action":"switch_tab","ref":"@T1"}          切换 Agent 关注的操作标签（不切换浏览器前台）
   {"action":"list_tabs"}                       列出浏览器【所有】标签（标题+网址+tabId，标记当前选中的、已在任务里的和无法操作的受限页）
   {"action":"use_tab","tabId":<list_tabs 给的 tabId>}   把浏览器里已打开的任意标签纳入任务并切换过去操作（不切浏览器前台；已在任务里的直接切过去）
   {"action":"close_tab","ref":"@T1"}           关闭自己开的标签（@MAIN/@U 等使用者的标签不可关闭）

1. 页面操作（target 用快照里的数字 ref，如 3；ref 是全局编号，若元素标在【子窗口 N】分组里，直接用它所在行的 ref 即可，系统会自动定位到那个 iframe）：
   {"action":"click","target":<ref>}                       点击元素
   {"action":"clickText","text":"页面上的文字","frame":<可选，子窗口号>}   兜底点击：元素列表里没有合适的可点元素时，直接点页面上看到的文字——按语义判断它可能可点（如"提交""确定""新建空白文档"这种按钮/卡片/链接样式的文字）。frame 填目标所在【子窗口 N】的 N（主窗口不填）。点文字也失败就不要再死磕，换 wait/hover/ask_user(teach) 推进
   {"action":"hover","target":<ref>}                       悬浮在元素上（不点击），让"悬浮才出现"的元素（如列表行悬浮才显示的编辑/删除按钮、下拉菜单）显示出来；悬浮后系统会重新截图，那些元素会出现在下一次快照里。适合：目标元素当前快照里没有、但你知道悬浮某个元素就会出现它的场景
   {"action":"type","target":<ref>,"text":"..."}           输入文本（覆盖原有内容）
   {"action":"select","target":<ref>,"value":"..."}        下拉框选择
   {"action":"scroll","direction":"down|up","amount":<像素,可选>}  滚动页面
   {"action":"read","target":<ref 或 "page">}              读取某元素或整页文本（用于总结）
   {"action":"wait","ms":<毫秒>}                           等待页面/动画/网络
   {"action":"keypress","keys":"Enter|Escape|Tab|Backspace|ArrowDown|..."}  向当前焦点发送按键
   {"action":"navigate","url":"https://..."}               在【当前操作标签】内跳转（沿用其会话/登录状态）

2. 结果保存：
   {"action":"save_file","filename":"总结.md","content":"文件内容"}  将结果保存为文件下载到本地（支持 md/txt/json/csv/html 等）

2.3 对话区消息（不打断流程）：
   {"action":"say","text":"..."}  在对话区给使用者说一句话（如复述你学到的操作步骤），说完继续执行，不等待使用者

2.4 书签操作（读写 Chrome 书签）：
   {"action":"bookmarks_read","folder":"可选，只读该文件夹（如 'AI工具'，支持 'AI工具/教程' 路径）"}  读取书签，返回书签列表（含所在文件夹路径）
   {"action":"bookmarks_write","title":"标题","url":"https://...","folder":"可选，目标文件夹（不存在会自动逐级创建），缺省放'其他书签'"}  把一条网址写入书签。title 描述【整个网站】的作用（"网站名 | 作用 | 使用技巧"三段式）；概括作用与技巧要按【你实际用到的功能】写，别照抄网站自己的广告语/营销文案（如"全球领先""一站式平台""引领未来"等自我宣传要过滤掉，只写它实际能干的事）；url 会自动规整为网站根 URL（协议+域名，去掉路径），不用特意填根地址。同一网站已收藏时自动把新技巧合并进既有标题并把 URL 规整为根，不会重复收藏
   {"action":"bookmark_find","keyword":"Claude"}  按关键词搜索书签（标题/网址），返回匹配项；网站工具索引里没找到时用它精确查找

2.5 请求使用者协助（卡住时用，分四种模式）：
   {"action":"ask_user","mode":"page","message":"需要你在页面上完成验证码/登录等，完成后我会继续"}  暂停并请使用者在【页面上】手动操作（验证码/登录/人机验证等）；使用者操作完点"继续"后自动继续
   {"action":"ask_user","mode":"reply","message":"请告诉我你的手机号，用于登录"}  暂停并请使用者在【对话中】直接回复信息（账号、个人信息、补充要求等）；使用者直接在下方的输入框回复即可
   {"action":"ask_user","mode":"teach","message":"我在这个页面上卡住了，请你手把手演示一遍正确操作，我会记录学习"}  遇到实在不知道怎么做的环节（尤其某网站特有的操作方式）时，暂停并请使用者在当前页面上手把手演示一遍；你会自动记录他的每一步操作来学习——录制覆盖【任务下所有标签页】（不只当前标签，使用者在演示中切到/新开的标签也会自动纳入并继续录制，跨页跨站演示不断），悬浮才出现的元素，悬浮这一步也会被记录成步骤，他操作完点"我操作完了"后你复述学到的步骤，经他确认后再按其演示继续
   {"action":"ask_user","mode":"confirm","message":"请确认我理解的步骤对不对"}  给使用者一个确认按钮（点「没问题」继续）；通常跟在 say 复述之后，使用者有出入会直接在对话里纠正

3. 结束本轮（不是结束对话）：
   {"action":"finish","result":"..."}   完成本条指令，result 是给使用者的答复；完成后你自开的标签（@T 系）会被自动关闭，使用者的标签（@MAIN/@U）保留，然后等待下一条指令

规则：
- 使用者在任务执行中发来的补充说明，务必重视并采纳：它可能是纠正你当前做法的指导（照它调整具体操作、继续推进原始目标），也可能就是明确改变目标的新指令（以它为准切换目标）。无论如何都不要无视它，也不要一收到就盲目放弃原始目标。
- 严格只输出一个 JSON 对象，不要输出解释、代码块或其它文字。
- 元素 ref 是数字；标签 ref 带 @ 前缀。绝不臆造，找不到就先 scroll/read/switch_tab 再观察。
- 想对列表/表格里的某一行执行操作（编辑 / 删除 / 更多菜单等）却找不到对应按钮时，别急着放弃——很多站点的行内操作按钮是**悬浮在那一行上才出现**的：用 hover 悬浮那一行（或其上的任意元素）让按钮显示出来，重截快照后就能看到并点击了。在页面上找不到下一步该点的按钮/入口时，同样先想想它是不是要 hover 某个列表项才会出现，用 hover 动作去试。
- 可交互元素列表解决不了问题时，可以用 clickText 兜底：有些按钮/卡片是纯 JS 动态渲染、提取不到列表里，但你仍能从正文和【子窗口 N】内容里看到它们的文字。对**明显可点**的文字（按钮/链接样式，或语境上显然是个入口，如"提交""创建""登录""新建空白文档"）用 clickText 按语义试点——点的是文字，不需要它出现在列表里。clickText 连续失败几次仍无进展就不要再赌，改用 wait 等弹层/内容加载、hover 让悬浮项出现、或 ask_user(teach) 请使用者演示。
- 任务没给具体网址、需要查资料/搜信息时，用 search 动作（后台自动开搜索页）；知道确切网址时用 open_tab。
- 当前页是受限页面（快照里会明确标注"受限页面"，如 chrome://、about:、扩展管理页、新标签页）时，绝对不要尝试操作它，直接用 open_tab 打开任务相关网址或 search 搜索。
- 需要访问新页面做独立工作时，优先 open_tab / search 新开后台标签，避免打扰使用者的浏览。
- 仅当要沿用当前标签的登录会话/上下文（如已登录站点）时才用 navigate。
- 教我模式：收到使用者演示的操作记录后，先用 say 动作向使用者复述你学到的操作步骤，再用 ask_user（mode=confirm）请他确认——他点「没问题」按钮或回复「没问题/确认」等确认后，就严格按演示步骤继续完成原始目标；页面状态与演示时不同（如已登录、元素变化）则灵活适配、按演示意图完成；有出入时按使用者的纠正调整。
- 教我模式的复述确认阶段是个**确认循环**：使用者在对话里回复纠正或问题（如"不对""少了一步""第三步不是这样"）时，你要重新理解他的纠正、修正你对步骤的理解，再用 say 复述修正后的步骤、用 ask_user（mode=confirm）再次请他确认——循环会一直持续，直到他明确说「没问题/确认」放行，或说「不教了/算了」「你先去做吧/你自己来」终止教学（终止后按你当前理解的自行继续完成原始目标），或说「重新演示」要求重开演示。不要未经再次确认就擅自继续执行，也不要自行猜测调整步骤。
- 教我模式记录到的输入值（账号、密码等）仅用于本轮复现使用者的演示，不要写入技巧库。
- 需要跨页面或并行处理时，开多个标签分别操作，需要哪个就 switch_tab 过去。
- 使用者问"我现在正在看哪个页面/我打开了哪些标签/在我已打开的某个标签里做 XX"时，先用 list_tabs 查看浏览器全部标签，再按需 use_tab 纳入并操作，不要新开标签重复打开使用者已有的页面。
- 某个标签不再需要时 close_tab 关掉它，保持整洁；不要关闭 @MAIN/@U 等使用者的标签。
- 目标是"总结/摘要"时：用 read 读取（可跨标签读取多个页面），然后 finish 输出简洁、结构化的中文总结。
- 目标要求"保存为文件/导出/下载"时：用 save_file 把总结或抓取结果写成文件（文件名带合适的扩展名），保存后再 finish 告知使用者文件路径。
- 任务涉及"我的书签/收藏"时：查询/盘点用 bookmarks_read（可指定 folder 只看某个文件夹）；要把某网址加入收藏用 bookmarks_write（folder 填目标文件夹名，不填就放"其他书签"）。
- 任务涉及某个已知网站/工具（如"打开我的网盘""在知乎搜 XX"），或指令要做的场景能在【网站工具索引】里匹配到能干这事的网站（如"压缩图片""查论文"）时：先查【网站工具索引】（书签，标题即用途），凭标题匹配网址直接用 open_tab 打开；索引里没找到就 bookmark_find 搜书签，再没有才用 search 网页搜索。
- 目标是"操作"时：逐步执行直到达成，最后 finish 输出操作结果。
- 遇到验证码、登录墙、人机验证弹窗，或某动作反复失败无法推进时，用 ask_user（mode=page）请使用者在【页面上】手动操作（把需要做什么写清楚）；需要使用者提供信息/补充说明时，用 ask_user（mode=reply）请使用者在【对话中】直接回复。某个动作反复尝试仍无进展（连续好几次同样的操作或失败）时，主动用 ask_user（mode=teach）请使用者在当前页面上手把手演示正确操作来学习——系统也会在你重复多次后自动弹出教学请求。**不要无限重试浪费时间**。
- type 会覆盖输入框原有内容；填表前先 click 聚焦。
- 全程用中文作答。`;
}

// ---------------- LLM 调用 ----------------
// 粗粒度 token 估算（判断上下文水位用）：中文 1 字≈1 token，英文/数字约 3.5 字符/token，每条消息另加 4
function estimateTokens(content) {
  const s = String(content || '');
  let cjk = 0, other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
        (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other++;
  }
  return 4 + Math.ceil(cjk + other / 3.5);
}
function messagesTokens(msgs) {
  return (msgs || []).reduce((n, m) => n + estimateTokens(m && m.content), 0);
}

// opts.json === false 时返回普通文本（用于历史压缩摘要）；默认仍是严格 JSON 动作
// t 可选：传会话对象时把本次响应的 total_tokens 累计进 t.tokens 并广播 AGENT_TOKENS（多会话 token 统计）
async function callLLM(messages, opts, t) {
  const cfg = await getConfig();
  if (!cfg.apiKey) throw new Error('未配置 API Key，请在设置中填写');
  const url = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + '/chat/completions';
  const totalChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  console.log('[PageAgent] LLM 请求（' + (opts && opts.json === false ? '摘要' : '动作') + '）：model=' + cfg.model + ' · 消息 ' + messages.length + ' 条 · 约 ' + totalChars + ' 字符');
  const body = {
    model: cfg.model || DEFAULT_MODEL,
    messages,
    temperature: cfg.temperature ?? DEFAULT_TEMPERATURE,
    stream: false
  };
  if (!opts || opts.json !== false) body.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) {}
    throw new Error('HTTP ' + res.status + ' ' + detail);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content || !String(content).trim()) {
    console.warn('[PageAgent] LLM 返回空白内容，完整响应：' + JSON.stringify(data).slice(0, 500));
    throw new Error('LLM 返回空白内容（可能是输入过长或服务端异常）');
  }
  // 累计本会话 token 用量并广播（供面板显示总消耗与各会话用量；无会话上下文时跳过）
  if (t && data.usage) {
    t.tokens = (t.tokens || 0) + (data.usage.total_tokens || 0);
    broadcast({ type: 'AGENT_TOKENS', tokens: t.tokens }, t.sid);
  }
  return content;
}

function parseAction(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const obj = JSON.parse(t);
  const ALLOWED = new Set(['open_tab', 'switch_tab', 'use_tab', 'list_tabs', 'close_tab', 'search', 'save_file', 'bookmarks_read', 'bookmarks_write', 'bookmark_find', 'ask_user', 'say', 'click', 'clickText', 'hover', 'type', 'select', 'scroll', 'read', 'wait', 'keypress', 'navigate', 'finish']);
  if (!obj || typeof obj !== 'object' || !ALLOWED.has(obj.action)) {
    throw new Error('非法动作：' + (obj && obj.action));
  }
  return obj;
}

// 组装发给 LLM 的消息：
//   system + 书签索引 + 压缩摘要（如果有） + 原始目标 + 尾部历史窗口
// 充分使用大上下文：尾部历史从最新往前一直装到放不下为止；历史过长时由 maybeCompress()
// 把中间部分压缩成摘要（保留原始目标 + 最近几步原文），释放上下文。
async function buildMessages(t) {
  const hist = (t && t.history) || [];
  const cfg = await getConfig();
  const ctxWin = cfg.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const msgs = [hist[0] || { role: 'system', content: '' }];
  // 把书签当作"网站工具索引"常驻上下文：收到任务时 Agent 凭标题匹配网址、直接用 open_tab 打开
  if (bookmarkIndexCache) {
    msgs.push({
      role: 'system',
      content: '【你的网站工具索引：来自浏览器书签，标题即用途】每条为"文件夹/标题 — 网址"，标题写明了网站能干什么。指令点名某网站/工具、或指令要做的场景能在标题的用途描述里匹配到对应网站（如"压缩图片""查论文"）时，直接 open_tab 打开该网址；索引匹配不到再用 bookmark_find 按关键词精确查找。\n' + bookmarkIndexCache
    });
  }
  // 压缩摘要：中间历史已被合并成"进展 + 踩过的坑 + 用户注意点"
  if (t.ctxSummary) {
    msgs.push({
      role: 'system',
      content: '【已压缩的历史进展】（此前的详细操作不再逐条列出，以下摘要涵盖已完成的事、踩过的坑与使用者补充的注意点，越靠后越新，继续执行时参考它）\n' + t.ctxSummary
    });
  }
  // 尾部历史窗口：从最新往前收集，直到放不下（充分用满上下文窗口；边界以下已由摘要覆盖）
  const B = Math.max(1, Math.min(t.ctxBoundary == null ? 0 : t.ctxBoundary, hist.length - 1));
  const body = [];
  let used = messagesTokens(msgs);
  const budget = ctxWin - OUTPUT_RESERVE;
  for (let i = hist.length - 1; i >= B; i--) {
    const cost = estimateTokens(hist[i].content);
    if (used + cost > budget) break;
    body.unshift(hist[i]);
    used += cost;
  }
  // 目标与最新指令分开注入（都独立保存、不会被裁剪）：
  //  - 原始目标（task.goal）：最初接到的指令，除非被最新指令明确否定，否则继续推进；
  //  - 最新指令/补充说明（task.lastInstruction）：使用者中途发来的，务必重视采纳——
  //    可能是纠正做法的指导（照它调整、继续推进原始目标），也可能就是明确改目标（以它为准）。
  // 两者即使已出现在历史尾部也重复注入作醒目强调，让"补充说明要被重视、但不必然放弃原目标"充分生效。
  const goalText = (t.goal && String(t.goal).trim()) || (() => {
    const gi = firstUserIdx(t);
    return gi > 0 ? String(hist[gi].content).slice(0, 600) : '';
  })();
  if (goalText) {
    msgs.push({
      role: 'user',
      content: '【原始目标（你最初接到的指令，请继续推进它；除非最新指令明确改变了它，否则不要放弃）】\n' + goalText.slice(0, 600)
    });
  }
  const lastInstr = (t.lastInstruction && String(t.lastInstruction).trim()) || '';
  if (lastInstr && lastInstr !== goalText) {
    msgs.push({
      role: 'user',
      content: '【最新指令/补充说明（使用者中途发来的，务必重视并采纳：若它只是纠正你的做法，就按它调整后继续推进原始目标；若它明确改变了目标，则以它为准切换目标）】\n' + lastInstr.slice(0, 600)
    });
  }
  msgs.push(...body);
  return msgs;
}

// 历史里第一条使用者消息的下标（即"原始目标"）
function firstUserIdx(t) {
  const hist = (t && t.history) || [];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].role === 'user') return i;
  }
  return -1;
}

// 判断历史里的 assistant 消息是否为 read 动作调用（压缩时用于成对删除 read 调用+结果）
function isReadAction(content) {
  try {
    const a = JSON.parse(String(content || ''));
    return !!(a && a.action === 'read');
  } catch (e) {
    return false;
  }
}

// 上下文水位检查：当前要发送的内容达到窗口 70% 时，触发历史压缩（合并中间、释放空间）
async function maybeCompress(t) {
  if (!t || (t.history || []).length < 12) return;
  const cfg = await getConfig();
  const ctxWin = cfg.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const thresholdPct = (cfg.compressThreshold == null ? COMPRESS_THRESHOLD * 100 : cfg.compressThreshold) / 100;
  const used = messagesTokens(await buildMessages(t));
  if (used < ctxWin * thresholdPct) return;
  addLog(t.sid, '上下文使用已达 ' + Math.round((used / ctxWin) * 100) + '%，自动压缩历史记录…');
  try {
    await compressContext(t);
    addLog(t.sid, '历史已压缩，上下文释放');
  } catch (e) {
    addLog(t.sid, '历史压缩失败：' + e.message, true);
  }
}

// 压缩：保留 原始目标 + 最近 TAIL_KEEP_STEPS 步原文，中间"read 调用+结果"成对删除，
// 其余交给 LLM 总结成"进展/坑/注意点"摘要，并把边界推进到压缩点
async function compressContext(t) {
  const hist = (t && t.history) || [];
  const B = hist.length - TAIL_KEEP_STEPS * 3; // 每步 = 快照 + 动作 + 结果 3 条
  if (B < 3) return; // 历史太短，无法压缩
  const prevBoundary = t.ctxBoundary == null ? 0 : t.ctxBoundary;
  const start = Math.max(2, Math.min(prevBoundary, B)); // 2 = 跳过 system 与原始目标
  const middle = [];
  for (let i = start; i < B; i++) {
    const m = hist[i];
    if (m.role === 'assistant' && isReadAction(m.content)) {
      // 成对删除：read 动作调用 + 紧邻的结果消息（最占上下文）
      if (i + 1 < B && hist[i + 1].role === 'user' && String(hist[i + 1].content).startsWith('动作结果')) {
        i++;
      }
      continue;
    }
    middle.push(m);
  }
  if (!middle.length) {
    t.ctxBoundary = B; // 无新增可总结，只推进边界
    await saveTasks();
    return;
  }
  const summary = await summarizeChunks(middle, t.ctxSummary || '', t);
  t.ctxSummary = summary;
  t.ctxBoundary = B;
  await saveTasks();
}

// 分块链式摘要：输入过多时切成小块，逐块合并进同一份摘要（避免单次输入超限）
async function summarizeChunks(middle, prevSummary, t) {
  let acc = prevSummary || '';
  let chunk = [];
  let cost = estimateTokens(acc);
  for (const m of middle) {
    const c = estimateTokens(m.content);
    if (chunk.length && cost + c > SUMMARY_CHUNK_TOKENS) {
      acc = await summarizeOnce(chunk, acc, t);
      chunk = [];
      cost = estimateTokens(acc);
    }
    chunk.push(m);
    cost += c;
  }
  if (chunk.length) acc = await summarizeOnce(chunk, acc, t);
  return acc;
}

async function summarizeOnce(middle, prevSummary, t) {
  const sys =
    '你是浏览器自动化助手。请把下面这段"已执行过的操作与对话记录"压缩成一份紧凑的中文【任务进展摘要】，供后续继续执行时参考。' +
    '必须保留三部分信息：\n' +
    '1.【已完成进展】做了什么、进行到哪一步、在哪个网站/页面。\n' +
    '2.【踩过的坑】遇到的失败、报错、需要绕开的点及已采用的解法（比如某按钮点了没反应、页面需要等加载、弹出了验证码等）。\n' +
    '3.【用户补充的注意点】使用者中途补充的要求、偏好、约束（比如"用中文回复""只查第一页""结果保存成 md 文件"等）。\n' +
    (prevSummary ? '若提供了"此前摘要"，请与之合并去重，不要丢失已有信息，也不要有重复段落。\n' : '') +
    '只输出这三部分，总长控制在 ' + SUMMARY_MAX_CHARS + ' 字以内。';
  const user =
    (prevSummary ? '【此前摘要】\n' + prevSummary + '\n\n' : '') +
    '【本次要合并的操作记录】\n' +
    middle.map((m) => (m.role === 'assistant' ? '助手决策：' : '观察/结果：') + String(m.content || '').slice(0, 1200)).join('\n');
  const raw = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: false }, t);
  return String(raw || '').trim().slice(0, SUMMARY_MAX_CHARS * 2);
}

// ---------------- 标签页管理 ----------------
function currentEntry(t) {
  return ((t && t.tabs) || []).find((e) => e.ref === t.currentRef) || null;
}

// 解析当前操作标签的 tabId；若其已关闭则回退到主标签/第一个存活标签，仍无则返回 null
async function resolveCurrentTabId(t) {
  let entry = currentEntry(t);
  if (entry) {
    const tab = await getTab(entry.tabId);
    if (tab) return entry.tabId;
    addLog(t.sid, '当前标签已关闭，自动切换…', true);
  }
  for (const e of t.tabs || []) {
    if (e.ref === t.currentRef) continue;
    const tab = await getTab(e.tabId);
    if (tab) {
      t.currentRef = e.ref;
      addLog(t.sid, '自动切换到其他标签', true);
      return e.tabId;
    }
  }
  return null;
}

function findTabEntry(ref, t) {
  return ((t && t.tabs) || []).find((e) => e.ref === ref) || null;
}

function tabLabel(entry) {
  return '@' + entry.ref + (entry.role === 'main' ? '(主)' : '');
}

// 把 URL 压缩成会话区精简显示：去掉 https:// 协议头，只保留"域名 + path 前 4 个字符"；没有 path 就只显示域名
function shortUrl(url) {
  let s = String(url || '').trim().replace(/^https?:\/\//i, '');
  const cut = s.search(/[/?#]/); // 第一个 path/查询串/锚点分隔符
  if (cut === -1) return s; // 没有 path/查询 → 只显示域名，如 www.xiaohongshu.com
  const host = s.slice(0, cut);
  let rest = s.slice(cut);
  if (rest[0] === '/') rest = rest.replace(/^\/+/, '');
  else rest = ''; // 只有 ?query / #frag 而没有 path → 按规则只显示域名
  if (!rest) return host;
  return host + '/' + rest.slice(0, 4) + (rest.length > 4 ? '…' : '');
}

// 中间省略截断：超长文字保留头尾，中间用 … 代替，用于"正在浏览 xxx"这类会话区的精简显示
function midTruncate(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const keep = Math.max(1, Math.floor((max - 1) / 2)); // 头尾各留一半（留 1 位给 …）
  return t.slice(0, keep) + '…' + t.slice(t.length - keep);
}

// 新开 Agent 后台标签（不抢焦点），并加入分组。display 为给使用者看的友好文案（search 用），缺省显示 url
async function openAgentTab(url, display, t) {
  const agentTabs = (t.tabs || []).filter((e) => e.role === 'agent');
  if (agentTabs.length >= MAX_AGENT_TABS) {
    throw new Error('Agent 自开标签已达上限（' + MAX_AGENT_TABS + '），请先 close_tab');
  }
  const t0 = performance.now();
  const tab = await chrome.tabs.create({ url, active: false });
  const ms = Math.round(performance.now() - t0);
  const ref = 'T' + ++t.tabSeq;
  const entry = { ref, tabId: tab.id, role: 'agent', title: tab.title || '', url: tab.url || url };
  t.tabs.push(entry);
  t.currentRef = ref;
  await addToGroup(tab.id, t);
  await saveTasks();
  addLog(t.sid, (display || '打开 ' + shortUrl(url)) + ' · ' + ms + 'ms');
  broadcastTabs(t);
  return entry;
}

async function addToGroup(tabId, t) {
  // 1) 本会话已记录分组且仍存活 → 直接加入（不重复建）
  if (t.groupId) {
    try {
      await chrome.tabGroups.get(t.groupId);
      await chrome.tabs.group({ tabIds: [tabId], groupId: t.groupId });
      return;
    } catch (e) {
      t.groupId = null; // 分组已销毁/不可用，走下方查找或重建
      await saveTasks();
    }
  }
  // 2) 优先复用本会话标题同名的分组（PageAgent N，跨会话不复用，各会话分组独立）
  let gid = null;
  try {
    const groups = await chrome.tabGroups.query({});
    const existing = (groups || []).find((g) => g.title === t.groupTitle);
    if (existing) gid = existing.id;
  } catch (e) {}
  if (gid != null) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: gid });
      t.groupId = gid;
      await saveTasks();
      return;
    } catch (e) {
      gid = null; // 加入失败（如跨窗口），回退为新建
    }
  }
  // 3) 确实没有才新建
  const newGid = await chrome.tabs.group({ tabIds: [tabId] });
  t.groupId = newGid;
  await saveTasks();
  chrome.tabGroups
    .update(newGid, { title: t.groupTitle, color: 'grey', collapsed: true })
    .catch(() => {});
}

// 页面动作触发的"新开标签"（window.open 等，content.js 截获不到的）纳入 Agent 自开 @T：
// 页面动作算 Agent 的行为，新开的页面也归 Agent（本轮结束随分组一起清理），不能算使用者的。
async function adoptOpenedTab(tabId, t) {
  if (!t || t.state !== 'working') return;
  if (findTabEntryByTabId(tabId, t)) return; // 已在任务里（如 openAgentTab 已注册）
  const tab = await getTab(tabId);
  if (!tab) return;
  if ((t.tabs || []).filter((e) => e.role === 'agent').length >= MAX_AGENT_TABS) return;
  const ref = 'T' + ++t.tabSeq;
  t.tabs.push({ ref, tabId, role: 'agent', title: tab.title || '', url: tab.url || '' });
  await addToGroup(tabId, t);
  await saveTasks();
  broadcastTabs(t);
  t.history.push({
    role: 'user',
    content: '页面动作新开的页面已在后台打开并纳入任务：@' + ref + '（' + (tab.title || shortUrl(tab.url || '')) + '），属 Agent 自开，本轮结束自动关闭'
  });
  addLog(t.sid, '页面新开 → 后台打开 ' + shortUrl(tab.url || '新页面'));
}

// 教我模式：使用者演示时切到/新开一个标签 → 纳入任务（@U 使用者标签）并挂上录制。
// 使用者只演示、不指挥，切到哪个标签就学哪个标签，录制不因跨标签而断。
async function adoptTeachTab(tabId, t) {
  if (!t) return;
  const ids = t.teachTabIds = t.teachTabIds || [];
  // 已挂录制的标签：只补任务登记，不重复 TEACH_START —— content 的 teachStart 对已录制状态会重置缓冲，
  // 反复切回会丢掉该标签最近未上报的几步；演示中导航重挂由 onUpdated / AGENT_READY 的 rearmTeachRecording 兜底
  if (ids.includes(tabId)) return;
  let entry = findTabEntryByTabId(tabId, t);
  if (!entry) {
    const tab = await getTab(tabId);
    if (!tab) return;
    if (!/^https?:/i.test(tab.url || '')) return; // 受限页/新标签页没法挂内容脚本
    const ref = 'U' + ++t.userTabSeq;
    entry = { ref, tabId, role: 'user', title: tab.title || '', url: tab.url || '' };
    t.tabs.push(entry);
    t.history.push({ role: 'user', content: '教我模式：把使用者切到的标签纳入任务 @' + ref + '（' + (tab.title || shortUrl(tab.url || '')) + '），一并录制其操作' });
    broadcastTabs(t);
  }
  ids.push(tabId);
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'TEACH_START' }).catch(() => {});
    console.log('[Teach] 教学切到/新开标签 → 挂载录制 tab=' + tabId);
  } catch (e) { console.log('[Teach] 教学挂载失败 tab=' + tabId + ' → ' + e.message); }
  await saveTasks();
}

// 列出浏览器所有标签（供 list_tabs 动作）：标题+网址+tabId，标记当前选中的、任务内的、受限无法操作的
async function listAllTabs(t) {
  const all = await chrome.tabs.query({});
  const taskIds = new Set((t.tabs || []).map((e) => e.tabId));
  const byRef = new Map((t.tabs || []).map((e) => [e.tabId, e.ref]));
  let active = null;
  try {
    const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    active = a ? a.id : null;
  } catch (e) {}
  const MAX_TABS_OUT = 30;
  const lines = [];
  for (const tab of all) {
    const marks = [];
    if (tab.id === active) marks.push('[当前选中]');
    if (taskIds.has(tab.id)) marks.push('[任务内@' + byRef.get(tab.id) + ']');
    if (isRestrictedUrl(tab.url)) marks.push('[受限，无法操作]');
    const title = (tab.title || '').trim().slice(0, 40);
    const urlTxt = isRestrictedUrl(tab.url) ? String(tab.url).slice(0, 60) : shortUrl(tab.url);
    lines.push((marks.length ? marks.join(' ') + ' ' : '') + 'tabId=' + tab.id + ' ' + title + (title && urlTxt ? ' ' : '') + urlTxt);
  }
  const head = '【浏览器所有标签】共 ' + all.length + ' 个（tabId 供 use_tab 使用）';
  if (lines.length > MAX_TABS_OUT) {
    lines.splice(MAX_TABS_OUT);
    lines.push('…还有 ' + (all.length - MAX_TABS_OUT) + ' 个标签未显示，共 ' + all.length + ' 个');
  }
  return head + '\n' + lines.join('\n');
}

// 删除本会话自开的 PageAgent N 标签分组（组内即 @T 标签，删组 = 一步清空该会话自开标签）。
// 只删本会话记录的分组 + 标题同名分组（跨会话不复用编号，删除不影响其他会话的分组）。
async function removeAgentGroup(t) {
  if (!t) return false;
  const ids = new Set();
  if (t.groupId) ids.add(t.groupId);
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups || []) if (g.title === t.groupTitle) ids.add(g.id);
  } catch (e) {}
  let ok = false;
  for (const id of ids) {
    try { await chrome.tabGroups.remove(id); ok = true; } catch (e) {}
  }
  t.groupId = null;
  return ok;
}

// 每轮结束（finish/失败）时清理 Agent 自开的标签：优先删除整个 PageAgent N 分组（一步到位），
// 不在分组内的 @T（如跨窗口另建过组/分组失败）逐个兜底关闭。
// 使用者的标签（@MAIN/@U）永不关闭。停止（STOP）不清理，保留待续。
async function closeAgentTabs(t) {
  if (!t) return;
  const agents = (t.tabs || []).filter((e) => e.role === 'agent');
  if (!agents.length) return;
  await removeAgentGroup(t);
  for (const e of agents) {
    const tab = await getTab(e.tabId); // 组删除可能已带走部分标签，剩余仍在的逐个关
    if (tab) chrome.tabs.remove(e.tabId).catch(() => {});
  }
  t.tabs = t.tabs.filter((e) => e.role !== 'agent');
  // 当前操作的若是自开标签，回退到使用者的标签（优先 @MAIN）
  if (t.currentRef && !(t.tabs.some((e) => e.ref === t.currentRef))) {
    const main = t.tabs.find((e) => e.role === 'main');
    t.currentRef = main ? main.ref : ((t.tabs[0] || {}).ref || null);
  }
  await saveTasks();
  broadcastTabs(t);
}

async function closeAgentTab(ref, t) {
  const entry = findTabEntry(ref, t);
  if (!entry) throw new Error('要关闭的标签不存在或已关闭：' + ref + '（先 list_tabs 确认再关）');
  if (entry.role === 'main' || entry.role === 'user') throw new Error('@' + entry.ref + ' 是使用者的标签，不可关闭');
  await chrome.tabs.remove(entry.tabId);
  t.tabs = t.tabs.filter((e) => e.ref !== ref);
  if (t.currentRef === ref) {
    // 回退到主标签
    const main = t.tabs.find((e) => e.role === 'main');
    t.currentRef = main ? main.ref : ((t.tabs[0] || {}).ref || null);
  }
  await saveTasks();
  addLog(t.sid, '已关闭标签');
  broadcastTabs(t);
}

function refreshTabEntry(tabId, info, t) {
  if (!t) return; // 无对话时（如日常浏览页面加载完成）也常触发，直接忽略
  const e = (t.tabs || []).find((x) => x.tabId === tabId);
  if (e) {
    if (info && info.title) e.title = info.title;
    if (info && info.url) e.url = info.url;
  }
}

// ---------------- 快照消息构建 ----------------
// tipsBlock（可选）：本站操作技巧块。放在 URL/标题与受限页提示之后、元素列表【之前】——
// LLM 要先读到历史经验再扫元素，避免技巧沉在快照末尾被 90 个元素淹没（否则"加载了但没怎么用"）。
function buildSnapshotMessage(snap, tipsBlock, t) {
  const lines = [];
  lines.push('【任务标签页】共 ' + t.tabs.length + ' 个');
  for (const e of t.tabs) {
    const cur = e.ref === t.currentRef ? ' [当前操作]' : '';
    const main = e.role === 'main' ? '使用者标签' : (e.role === 'user' ? '使用者已有标签' : 'Agent自开');
    lines.push(`[@${e.ref}] ${main} ${e.title || ''} ${e.url || ''}${cur}`);
  }
  lines.push('【当前页面】URL: ' + snap.url);
  lines.push('标题: ' + snap.title);
  if (snap.restricted) {
    lines.push('当前页是【受限页面】（chrome://、about:、扩展管理页、新标签页等），无法注入内容脚本，你无法在此页观察或操作。任务需要在网页上完成时，请直接用 open_tab 打开对应网址（如腾讯文档用 https://docs.qq.com），或用 search 搜索；不要在受限页上反复尝试，也不要用 navigate 跳到受限地址。');
  }
  if (tipsBlock) lines.push(tipsBlock);
  if (!snap.elements || snap.elements.length === 0) {
    lines.push('（未发现可见的可交互元素）');
  } else {
    const frames = snap.frames || [];
    if (frames.length > 1) {
      lines.push('（本页含 ' + frames.length + ' 个窗口：主窗口 + ' + (frames.length - 1) + ' 个内嵌子窗口；[ref] 是全局编号，子窗口元素已分组标注，可直接点按）');
    }
    let curF = 0;
    for (const el of snap.elements) {
      const fIdx = el.frameIndex || 0;
      if (fIdx !== curF) { // 换到另一个子窗口时打印分组头
        curF = fIdx;
        const meta = frames[fIdx];
        lines.push('【子窗口 ' + fIdx + '】' + (meta && meta.title ? ' ' + meta.title : '') + (meta && meta.url ? ' ' + shortUrl(meta.url) : ''));
      }
      const label = el.text || el.hint || el.tag;
      // 不把 CSS 选择器喂给 LLM：对决策是噪音且很占 token；ref 才是它用来定位动作的
      lines.push(
        `[${el.ref}] ${el.role} "${label}"` +
        (el.value ? ` 值=${el.value}` : '') +
        (el.disabled ? ' [disabled]' : '')
      );
    }
  }
  lines.push('【正文摘要】' + (snap.excerpt || ''));
  return lines.join('\n');
}

// ---------------- 分帧快照（iframe 感知） ----------------
// content.js 现在注入所有 frame（manifest all_frames）。快照要合并主窗口 + 各 iframe 子窗口的
// 可交互元素，动作才能定位到 iframe 里的东西（如腾讯文档新建弹窗就是跨域 iframe）。
// 子窗口元素的 ref 用「frameIndex*1000 + 局部 ref」偏移成全局唯一编号，动作路由时拆回。
const MAX_SNAP_FRAMES = 16;       // 快照合并的子窗口数量上限（含主窗口）。弹层/卡片常是动态后插的 iframe，上限太小会把它们整窗切掉
const MAX_MERGED_ELEMENTS = 90;   // 合并后元素总数上限，防刷爆上下文
const SUBFRAME_MIN = 6;           // 每个子窗口在合并快照里至少保留的元素数：保证 iframe 里的关键目标不被主窗口海量元素挤掉
const FRAME_REF_BASE = 1000;      // 子窗口元素 ref 偏移基数：全局 ref = frameIndex*FRAME_REF_BASE + 局部 ref

// 枚举 tab 的窗口（含 iframe）：返回 [{frameId, url, title}]，主窗口（frameId 0）排最前
async function frameList(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(frames) && frames.length) {
      const list = frames.slice();
      list.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0));
      return list.map((f) => ({ frameId: f.frameId, url: f.url || '', title: f.title || '' }));
    }
  } catch (e) {}
  return [{ frameId: 0, url: '', title: '' }];
}

// 读取合并快照：主窗口 + 各子窗口，ref 全局唯一偏移，元素带 frameId/frameIndex。
// 子窗口读取失败容忍（跨域受限 / 还在加载）；主窗口失败抛错，让上层按原逻辑重试。
async function readSnapshotWithFrames(tabId) {
  // 1) 先读主窗口——它 DOM 里的直接 iframe 清单是"弹层 iframe 确实存在"的硬证据，
  //    用来交叉校验 getAllFrames 枚举是否完整（弹层/卡片 iframe 常被读漏，导致"窗口数 1↔2 跳动"）。
  const mainSnap = await chrome.tabs.sendMessage(tabId, { type: 'GET_SNAPSHOT' }, { frameId: 0 });
  if (!mainSnap || !Array.isArray(mainSnap.elements)) throw new Error('主窗口快照为空');
  const domIframes = Array.isArray(mainSnap.iframes) ? mainSnap.iframes.length : 0; // 主窗口 DOM 里的直接 iframe 数

  // 2) 枚举窗口列表；若主窗口 DOM 里明明有 iframe、但枚举出的子窗口不够，说明枚举读漏了
  //    （导航刚注册 / getAllFrames 时序抖动，弹层 iframe 常"晚一步才被收录"），重试几次再合并。
  let allFrames = await frameList(tabId);
  if (domIframes > 0) {
    for (let i = 0; i < 3; i++) {
      const subFrames = allFrames.filter((f) => f.frameId !== 0);
      if (subFrames.length >= domIframes) break;
      await sleep(250);
      allFrames = await frameList(tabId);
    }
  }
  const frames = allFrames.slice(0, MAX_SNAP_FRAMES);
  const frameMeta = [];
  const frameElements = []; // 每个成功读取窗口的原始元素列表（截断前），供下面分帧保留
  let merged = { url: mainSnap.url, title: mainSnap.title, excerpt: mainSnap.excerpt, elements: [], frames: frameMeta };
  // 主窗口（frameId 0）固定是第 0 帧
  frameMeta.push({ frameId: 0, index: 0, url: mainSnap.url || '', title: mainSnap.title || '' });
  const mainList = [];
  for (const el of mainSnap.elements) {
    if (typeof el.ref !== 'number') continue;
    el.frameId = 0;
    el.frameIndex = 0;
    mainList.push(el);
  }
  frameElements.push(mainList);
  // 子窗口（iframe）：读取失败容忍跳过，ref 用「frameIndex*FRAME_REF_BASE + 局部 ref」偏移成全局唯一
  for (const f of frames) {
    if (f.frameId === 0) continue;
    let snap;
    try {
      snap = await chrome.tabs.sendMessage(tabId, { type: 'GET_SNAPSHOT' }, { frameId: f.frameId });
    } catch (e) {
      continue;
    }
    if (!snap || !Array.isArray(snap.elements)) {
      continue;
    }
    const idx = frameMeta.length;
    frameMeta.push({ frameId: f.frameId, index: idx, url: snap.url || f.url || '', title: snap.title || f.title || '' });
    if (snap.excerpt) {
      // 子窗口正文摘要也拼进来（截断），让 Agent 能读到 iframe 里的文字内容
      const ex = String(snap.excerpt).replace(/\s+/g, ' ').trim();
      if (ex) merged.excerpt = (merged.excerpt || '') + '\n【子窗口' + idx + ' 内容】' + ex.slice(0, 500);
    }
    const base = idx * FRAME_REF_BASE;
    const list = [];
    for (const el of snap.elements) {
      if (typeof el.ref !== 'number') continue;
      el.ref = base + el.ref;
      el.frameId = f.frameId;
      el.frameIndex = idx;
      list.push(el);
    }
    frameElements.push(list);
  }
  // 分帧截断（原来全局 slice 会让主窗口元素多时把 iframe 目标整体挤掉——"弹层打开后没有后续操作"的主因之一）。
  // 按帧分配预算：主窗口拿剩余槽位，每个子窗口保底 SUBFRAME_MIN、再把富余均分（余数给前面的窗口），
  // 子窗口没填满的额度顺延给后面的窗口。这样每个窗口都有连续分组、不会被前面的窗口饿死，ref 全局唯一不受影响。
  const budget = MAX_MERGED_ELEMENTS;
  const nSub = Math.max(0, frameElements.length - 1);
  const subFloor = nSub ? Math.min(SUBFRAME_MIN, Math.floor(budget / (nSub + 1))) : 0;
  const mainBudget = budget - subFloor * nSub;
  const mainTake = Math.min(frameElements[0] ? frameElements[0].length : 0, mainBudget);
  const leftForSubs = budget - mainTake; // 主窗口没用完的也留给子窗口
  const extraBase = nSub ? Math.floor((leftForSubs - subFloor * nSub) / nSub) : 0;
  const extraRem = nSub ? (leftForSubs - subFloor * nSub) % nSub : 0;
  const caps = [];
  for (let i = 0; i < nSub; i++) caps.push(subFloor + extraBase + (i < extraRem ? 1 : 0));
  const out = [];
  if (frameElements[0]) out.push(...frameElements[0].slice(0, mainTake));
  let slack = 0;
  for (let i = 0; i < nSub; i++) {
    const list = frameElements[1 + i];
    const cap = caps[i] + slack; // 前面窗口没用完的额度顺延
    const take = Math.min(list.length, cap);
    slack = cap - take;
    out.push(...list.slice(0, take));
  }
  merged.elements = out;
  merged.excerpt = String(merged.excerpt || '').slice(0, 3000); // 汇总摘要设上限，防 iframe 海量刷爆
  return merged;
}

// ---------------- Agent 循环 ----------------
async function agentStep(t) {
  if (!t || t.state !== 'working') return;
  const myTurn = t.turnId;
  if (!stillCurrent(t, myTurn)) return;

  const cfg = await getConfig();
  if (t.turnSteps >= cfg.maxSteps) {
    fail(t, '本轮超过最大步数上限（' + cfg.maxSteps + '）');
    return;
  }
  t.steps++;
  t.turnSteps++;
  t.lastActiveAt = Date.now();
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;

  const tabId = await resolveCurrentTabId(t);
  if (!tabId) {
    fail(t, '任务标签页均已关闭');
    return;
  }
  if (!stillCurrent(t, myTurn)) return;

  // 1) 读取当前操作标签的页面快照
  //    受限页面（chrome://、about:、扩展管理页等）无法注入内容脚本，直接构造"受限快照"让 LLM 判题另开网页，避免反复失败空转
  const curTab = await getTab(tabId);
  const t0 = performance.now(); // 计时：快照读取耗时，用于"正在浏览 xxx · Nms"
  let snap = null;
  let lastSnapErr = null;
  if (curTab && isRestrictedUrl(curTab.url)) {
    addLog(t.sid, '受限页面，自动打开相关网页', true);
    snap = { url: curTab.url, title: curTab.title || '', elements: [], excerpt: '', restricted: true };
  } else {
    for (let i = 0; i < 3 && !snap; i++) {
      try {
        await ensureContentScript(tabId);
        snap = await readSnapshotWithFrames(tabId); // 合并主窗口 + iframe 子窗口
      } catch (e) {
        lastSnapErr = e;
        const tab = await getTab(tabId);
        console.warn('[PageAgent] 快照失败（第 ' + (i + 1) + ' 次）tab=' + tabId + ' ' + (tab ? tab.url : '标签已不存在') + ' → ' + e.message);
        await sleep(500);
      }
    }
    if (!snap) {
      const tab = await getTab(tabId);
      addLog(t.sid, '快照失败（3 次）：' + (lastSnapErr ? lastSnapErr.message : '未知原因') + (tab ? ' · ' + tab.url : ' · 标签已不存在'), true);
      awaitNav(t, tabId);
      return;
    }
  }
  if (!stillCurrent(t, myTurn)) return;

  t.snapFrames = (snap && Array.isArray(snap.frames)) ? snap.frames : []; // 供动作路由把全局 ref 拆回 (frameId, 局部 ref)
  t.curPageSig = pageSigOf(snap); // 记录当前页面状态指纹，供"无进展计数"判断重复动作时页面是否真的变了
  // 本站操作技巧：每次操作某网站相关的动作前，先加载该网站沉淀过的技巧。
  // 以 tipsBlock 传入 buildSnapshotMessage，插在元素列表【之前】，让 LLM 先读到历史经验再扫元素，
  // 避免技巧沉在快照末尾被元素列表淹没（"加载了但没怎么用"的主因）。
  let tipsBlock = '';
  let tipsCount = 0;
  const snapHost = hostOf(snap.url);
  if (snapHost) {
    const tt0 = performance.now();
    const tips = await getSiteTips(snapHost);
    tipsCount = tips.length;
    if (tipsCount) {
      tipsBlock = '【本站操作技巧】（该网站历史操作经验，持续有效：决策前先对照再选元素，避免绕弯路；若某条与当前页面明显冲突/已改版，说明已过期，跳过它、以当前页面为准）\n' + tips.map((x) => '· ' + x).join('\n');
      if (snapHost !== t.lastTipsHost) { // 同一站点每会话只在首次进入时显示一次加载提示
        t.lastTipsHost = snapHost;
        addLog(t.sid, '加载 ' + tipsCount + ' 个相关技巧 ' + Math.round(performance.now() - tt0) + 'ms');
      }
    }
  }
  addLog(t.sid, '正在浏览 ' + midTruncate(snap.title || shortUrl(snap.url), 16) + ' · ' + Math.round(performance.now() - t0) + 'ms');
  let snapMsg = buildSnapshotMessage(snap, tipsBlock, t);
  t.history.push({ role: 'user', content: snapMsg });
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;

  // 2) LLM 决策：先检查上下文水位，达到 70% 阈值时自动压缩历史释放空间
  await maybeCompress(t);
  if (!stillCurrent(t, myTurn)) return;

  // 2) LLM 决策（JSON 解析失败可重试）
  let action = null;
  let lastErr = null;
  for (let i = 0; i < MAX_STEP_LLM_RETRY && !action; i++) {
    let raw = null;
    try {
      const msgs = await buildMessages(t);
      raw = await callLLM(msgs, undefined, t);
      logLLMExchange(t, msgs, raw); // 记录大模型往返（发送简况 + 原始返回），供面板"日志"视图排查
      console.log('[PageAgent] LLM 原始输出：' + String(raw).slice(0, 800));
      action = parseAction(raw);
    } catch (e) {
      lastErr = e;
      addLog(t.sid, 'LLM 输出解析失败（' + (i + 1) + '/' + MAX_STEP_LLM_RETRY + '）：' + e.message + (raw ? ' 原文=' + String(raw).slice(0, 100) : ''), true);
      console.warn('[PageAgent] LLM 调用/解析异常：' + e.message);
      await sleep(800 * (i + 1)); // 退避：0.8s / 1.6s / 2.4s / 3.2s，应对偶发空白/限流
    }
  }
  if (!action) {
    fail(t, 'LLM 连续返回无效动作：' + (lastErr && lastErr.message));
    return;
  }
  if (!stillCurrent(t, myTurn)) return;

  t.history.push({ role: 'assistant', content: JSON.stringify(action) });
  t.lastActiveAt = Date.now();
  addLog(t.sid, '决策：' + JSON.stringify(action), true); // 原始动作保留在诊断日志，面板不显示
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;

  // 3) 执行动作
  await runAction(t, action);
}

// ---------------- 文件下载 ----------------
const MIME_BY_EXT = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
  '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xml': 'application/xml',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.log': 'text/plain'
};
const MAX_FILE_CHARS = 500000;

function sanitizeFilename(name) {
  let n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  n = n.replace(/^\.+/, '');
  if (!n) n = 'pageagent_result.txt';
  return n;
}

function mimeFor(filename) {
  const ext = '.' + (filename.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'text/plain';
}

async function saveFile(a) {
  const filename = sanitizeFilename(a.filename);
  const content = String(a.content ?? a.text ?? '');
  if (!content) throw new Error('文件内容为空');
  if (content.length > MAX_FILE_CHARS) {
    throw new Error('内容过长（' + content.length + ' 字符），超过保存上限 ' + MAX_FILE_CHARS);
  }
  const mime = a.mime || mimeFor(filename);
  const dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return { ok: true, downloadId, filename };
}

// ---------------- 书签操作 ----------------

const MAX_BOOKMARKS_OUT = 300; // bookmarks_read 单次返回给 LLM 的条数上限

// 读取书签：拍平成 [路径] 标题 + url 的文本列表；folder 可选过滤某个文件夹
async function readBookmarks(folderPath) {
  const tree = await chrome.bookmarks.getTree();
  const items = [];
  const walk = (nodes, path) => {
    for (const n of nodes || []) {
      const thisPath = path ? path + '/' + n.title : n.title;
      if (n.url) {
        items.push({ path: path || '', title: n.title, url: n.url });
      }
      if (n.children) walk(n.children, thisPath);
    }
  };
  walk(tree, '');

  let list = items;
  const f = String(folderPath || '').trim().replace(/^\/+|\/+$/g, '');
  if (f) {
    const prefix = f + '/';
    list = items.filter((it) => it.path === f || it.path.startsWith(prefix));
    if (!list.length) throw new Error('未找到文件夹：' + f + '（可用 bookmarks_read 不带 folder 查看全部）');
  }

  const lines = list.map((it) => (it.path ? it.path + '/' : '') + it.title + ' — ' + it.url);
  if (lines.length > MAX_BOOKMARKS_OUT) {
    lines.length = MAX_BOOKMARKS_OUT;
    lines.push('…共 ' + list.length + ' 条，仅显示前 ' + MAX_BOOKMARKS_OUT + ' 条');
  }
  return lines.join('\n');
}

// 规范化成网站"根 URL"（协议+域名+端口+/）——书签只收藏网站整体（如 https://www.example.com/），
// 不收藏带路径的局部页面（如 .../docs/guide、.../search?q=xxx）。非 http(s) 原样返回。
function rootUrl(url) {
  const clean = String(url || '').trim();
  try {
    const u = new URL(clean);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin + '/';
    return clean;
  } catch (e) {
    return clean.replace(/\/+$/, '');
  }
}

// 写入一条书签；folder 不存在时逐级自动创建。url 一律规整为网站根 URL。
async function writeBookmark(a, t) {
  const title = String(a.title || '').trim().replace(/\s+/g, ' ').slice(0, 200) || '未命名';
  const url = rootUrl(String(a.url || '').trim());
  if (!url) throw new Error('缺少 url');
  if (!/^(https?|file):/i.test(url)) throw new Error('url 无效：' + url);
  const folder = String(a.folder || '').trim().replace(/^\/+|\/+$/g, '');
  const parentId = folder ? await ensureBookmarkFolder(folder) : undefined;
  // 已收藏过同一网站（按根 URL 匹配）→ 合并改进标题（保持原位置），避免重复收藏、越攒越乱；
  // 若既有书签存的还是带路径的 URL，顺带规整为根 URL。
  const existing = await findBookmarkByUrl(url);
  if (existing) {
    const oldTitle = String(existing.title || '').replace(/\s+/g, ' ').trim();
    const merged = await mergeBookmarkTitle(t, existing.title, title, url);
    const update = {}; // 可能同时改进标题 + 规整 URL
    if (merged && merged !== oldTitle) update.title = merged;
    if (existing.url !== url) update.url = url;
    if (Object.keys(update).length) {
      await chrome.bookmarks.update(existing.id, update);
      await refreshBookmarkIndex();
      const note = update.title ? '更新书签（改进使用技巧）：' + update.title : '该网址已收藏，标题无变化';
      return { created: false, msg: note + ' → ' + url };
    }
    return { created: false, msg: '该网址已收藏，标题无变化：' + oldTitle + ' → ' + url };
  }
  await chrome.bookmarks.create({ parentId, title, url });
  await refreshBookmarkIndex();
  return { created: true, msg: (folder ? folder + '/' : '') + title + ' → ' + url };
}

// 定位或创建书签文件夹（按路径逐级，返回最后一级的 id）
async function ensureBookmarkFolder(path) {
  const parts = path.split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const tree = await chrome.bookmarks.getTree();
  const byPath = new Map(); // 完整路径 -> folder id
  const walk = (nodes, parentPath) => {
    for (const n of nodes || []) {
      if (!n.url) { // 只收文件夹
        const full = parentPath ? parentPath + '/' + n.title : n.title;
        byPath.set(full, n.id);
        if (n.children) walk(n.children, full);
      }
    }
  };
  walk(tree, '');
  let parentId = undefined;
  let cur = '';
  for (const part of parts) {
    cur = cur ? cur + '/' + part : part;
    if (byPath.has(cur)) {
      parentId = byPath.get(cur);
    } else {
      parentId = (await chrome.bookmarks.create({ parentId, title: part })).id;
      byPath.set(cur, parentId);
    }
  }
  return parentId;
}

// ---- 书签当作"网站工具索引"常驻上下文 ----

let bookmarkIndexCache = ''; // 当前回合的书签索引文本（新指令时刷新）

const BOOKMARK_INDEX_MAX = 200; // 注入上下文的索引条数上限，超出的让 Agent 用 bookmark_find 找

// 拍平书签树，生成 "文件夹/标题 — url" 的紧凑索引；读不到（无权限等）则清空，静默降级
async function refreshBookmarkIndex() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const lines = [];
    let total = 0;
    const walk = (nodes, path) => {
      for (const n of nodes || []) {
        const thisPath = path ? path + '/' + n.title : n.title;
        if (n.url) {
          total++;
          if (lines.length < BOOKMARK_INDEX_MAX) {
            lines.push((path ? path + '/' : '') + n.title + ' — ' + n.url);
          }
        }
        if (n.children) walk(n.children, thisPath);
      }
    };
    walk(tree, '');
    if (total > BOOKMARK_INDEX_MAX) {
      lines.push('…共 ' + total + ' 条书签，仅列前 ' + BOOKMARK_INDEX_MAX + ' 条，可用 bookmark_find 按关键词精确查找');
    }
    bookmarkIndexCache = lines.join('\n');
  } catch (e) {
    bookmarkIndexCache = '';
  }
}

// 按关键词搜索书签（标题/网址），返回匹配项；供 bookmark_find 动作调用
async function findBookmarks(keyword) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) throw new Error('bookmark_find 缺少关键词');
  const tree = await chrome.bookmarks.getTree();
  const hits = [];
  const walk = (nodes, path) => {
    for (const n of nodes || []) {
      const thisPath = path ? path + '/' + n.title : n.title;
      if (n.url && (n.title.toLowerCase().includes(k) || n.url.toLowerCase().includes(k))) {
        hits.push({ path, title: n.title, url: n.url });
      }
      if (n.children) walk(n.children, thisPath);
    }
  };
  walk(tree, '');
  if (!hits.length) return '未找到与 "' + keyword + '" 相关的书签（可改用 search 搜索网页）';
  const lines = hits.slice(0, 20).map((it) => (it.path ? it.path + '/' : '') + it.title + ' — ' + it.url);
  if (hits.length > 20) lines.push('…共 ' + hits.length + ' 条，仅显示前 20 条');
  return lines.join('\n');
}

// ---- 复盘：任务完成后，把新发现的有用网站记入书签 ----

const MAX_REVIEW_PICKS = 5; // 单次复盘最多收藏条数

// 复盘入口：收集本轮访问过的站点 → LLM 筛选 → 写入书签（新网址收藏；已收藏的合并改进标题。尽力而为，失败不影响任务完成）
async function reviewAndBookmark(t, force, pinnedTurn) {
  if (!t) return;
  // force：停止后复盘用（state 已回 idle，仍要跑复盘）；正常 finish 复盘时 force 为空，保持"仅 working 时复盘"
  if (!force && t.state !== 'working') return;
  const myTurn = (pinnedTurn != null) ? pinnedTurn : t.turnId; // 钉住停止那一刻的回合号，中途新指令会打断复盘
  const sites = collectVisitedSites(t);
  if (!sites.length) return;
  addLog(t.sid, '复盘：梳理本次任务访问过的 ' + sites.length + ' 个网站，筛选有用站点…');
  const picks = await pickBookmarks(t, sites);
  if (!picks.length) return;
  let added = 0, updated = 0;
  for (const p of picks) {
    if (!stillCurrent(t, myTurn, force)) break; // 复盘期间被新指令打断
    try {
      const r = await reviewCollectBookmark(t, p);
      if (r === 'added') added++;
      else if (r === 'updated') updated++;
    } catch (e) {
      addLog(t.sid, '复盘收藏失败：' + ((p && p.title) || '') + ' → ' + (e.message || e), true);
    }
  }
  if (added > 0 || updated > 0) {
    const parts = [];
    if (added > 0) parts.push('新增 ' + added + ' 个');
    if (updated > 0) parts.push('改进 ' + updated + ' 个既有书签的使用技巧');
    addLog(t.sid, '复盘完成：' + parts.join('、'));
  }
}

// 收集本轮任务中实际访问过的站点（按域名归并）：
// 只看"本轮"history——① 动作里的 open_tab/navigate/search 网址；② 每步快照的【当前页面】URL（含标题）。
// 不扫【任务标签页】列表（含跨轮保留的旧标签）也不扫【正文摘要】（含页面内容里的杂散链接），
// 避免把没真正打开过的网站算进来（比如"只开了小红书却报打开 13 个网站"）。
// 网站按【域名】统计：同一网站的不同页面 URL 合并成一条（一页结果、一页笔记 = 小红书 1 个网站），
// 保留该域名下第一次访问到的 URL（含路径，保住"这是搜索结果页/单次页"的信号供 LLM 判断取舍）。
// 注意：不忽略 www 等二级域名前缀——有的公司一个二级域名就是一个独立项目，www.xx.com 与 xx.com 按不同网站算。
function collectVisitedSites(t) {
  const seen = new Map(); // 域名 -> { url, title, host }
  const add = (url, title) => {
    if (!url) return;
    const clean = String(url).replace(/[.,;，。、\]\s]+$/, '');
    if (!/^https?:/i.test(clean)) return;
    const key = hostOf(clean); // 按域名归并（完整 host，含二级域名前缀）
    if (!key) return;
    if (!seen.has(key)) {
      seen.set(key, { url: clean.replace(/\/+$/, ''), title: (title || '').trim(), host: key });
    }
  };
  const slice = (t.history || []).slice(t.turnHistoryStart || 0);
  for (const m of slice) {
    if (m.role === 'assistant' && typeof m.content === 'string') {
      try {
        const a = JSON.parse(m.content);
        if (a && typeof a === 'object' && a.url && (a.action === 'open_tab' || a.action === 'navigate' || a.action === 'search')) {
          add(String(a.url));
        }
      } catch (e) {}
    } else if (m.role === 'user' && typeof m.content === 'string') {
      // 只取快照的【当前页面】URL（+标题）：这才是 Agent 实际查看/操作过的页面
      const pm = m.content.match(/【当前页面】URL:\s*(\S+)(?:\s*\n标题:\s*([^\n]*))?/);
      if (pm) add(pm[1], pm[2]);
    }
  }
  return [...seen.values()];
}

// 调 LLM 复盘：从访问过的站点里挑出值得收藏的，返回 [{title,url,reason}]
async function pickBookmarks(t, sites) {
  const cfg = await getConfig();
  if (!cfg.apiKey) return [];
  // 已按域名归并：同站多页只列一条（url 为该站本轮访问的其中一页，用于判断网站类型；域名是判断对象）
  const list = sites.map((s) => (s.title ? s.title + ' — ' : '') + '(' + s.host + ') ' + s.url).join('\n');
  const msgs = [
    {
      role: 'system',
      content: '你是 PageAgent 的"书签复盘"助手。使用者刚完成一次浏览器任务，下面列出了本次任务访问过的网站（已按域名归并，同一网站访问多页只算一条，域名是判断对象）。请挑出其中【对以后可能有用的网站/工具/平台/资料站】（如在线工具、文档库、服务平台、效率网站等）；忽略：搜索引擎结果页、单次查询页、登录页、一次性文章详情页、与本任务无关的中间页。为每个选中的网站生成一条收藏记录。'
    },
    {
      role: 'user',
      content: '本次访问过的网站（每条 = 一个网站/域名，url 是其代表页）：\n' + list + '\n\n只输出 JSON，格式：{"bookmarks":[{"title":"网站名 | 作用 | 使用技巧","url":"https://...","reason":"为什么以后有用（一句话）"}]}。\n' +
        'title 用竖线 | 分成三段：①网站名（如 小红书、Bing 搜索）；②作用类别（两三个词概括【整个网站】实际是干嘛的，如 新闻查询、文档工具、用户内容查询、设计素材、代码参考——以使用者在任务里真正用到的功能为准，别只针对访问到的那个局部页面，也【别照抄网站自己的广告语/营销文案】，像"全球领先""一站式智能平台""引领未来""更好的生活方式"这类自我宣传要过滤掉，概括出它实际能干的事）；③本次总结到的使用技巧（一句话，以使用者实际操作为准，如"直接点击第一条结果打开、别点推荐流更准""需先登录，进创作中心才能看数据"）。\n' +
        'url 填该网站的【根 URL】（协议+域名，如 https://www.example.com/），不要带路径、查询或锚点。\n' +
        '最多 ' + MAX_REVIEW_PICKS + ' 个；都不值得收藏就输出 {"bookmarks":[]}。'
    }
  ];
  try {
    const raw = await callLLM(msgs, undefined, t);
    const obj = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
    const arr = (obj && Array.isArray(obj.bookmarks)) ? obj.bookmarks : [];
    return arr.filter((b) => b && typeof b === 'object' && b.url && /^https?:/i.test(String(b.url)));
  } catch (e) {
    addLog(t.sid, '复盘筛选失败：' + e.message, true);
    return [];
  }
}

// 按"根 URL"匹配已收藏的书签（任意层级），返回 { id, title, url } 或 null。
// 只要是同一网站的根 URL 就算命中——既有带路径的书签也能被找到、合并标题时顺便规整成根。
async function findBookmarkByUrl(url) {
  const want = rootUrl(url).replace(/\/+$/, '').toLowerCase();
  if (!/^https?:/i.test(want)) return null;
  const tree = await chrome.bookmarks.getTree();
  let found = null;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (found) return;
      if (n.url) {
        const bUrl = rootUrl(n.url).replace(/\/+$/, '').toLowerCase();
        if (bUrl === want) { found = { id: n.id, title: n.title || '', url: n.url }; return; }
      }
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return found;
}

// 用 LLM 把旧标题与新总结合并成更好的标题（"网站名 | 作用 | 使用技巧"三段式、技巧合并去重）；
// 失败/无新信息时原样返回旧标题，绝不破坏既有书签
async function mergeBookmarkTitle(t, oldTitle, newTitle, url) {
  const o = String(oldTitle || '').replace(/\s+/g, ' ').trim();
  const n = String(newTitle || '').replace(/\s+/g, ' ').trim();
  if (!n || o === n) return o;
  const cfg = await getConfig();
  if (!cfg.apiKey) return o;
  const msgs = [
    { role: 'system', content: '你是 PageAgent 的"书签标题维护"助手。浏览器书签标题格式固定为三段："网站名 | 作用类别 | 使用技巧"。使用者刚在任务里再次访问了一个已收藏的网站，可能总结出了新的使用技巧。请把"旧标题"和"新总结标题"合并成一条更好的标题。要求：①保留网站名与作用类别（以旧标题为准，新标题更准确时微调；概括作用要按使用者实际用到的功能，过滤掉网站自己的广告语/营销文案这类自我宣传）；②使用技巧部分合并去重、用分号连接，只留最有价值的信息；③仍保持三段式；④总长不超过 200 字；⑤若新标题没带来任何新信息，原样输出旧标题。只输出合并后的标题本身，不要引号、不要解释、不要代码块。' },
    { role: 'user', content: '网址：' + url + '\n旧标题：' + o + '\n新总结标题：' + n }
  ];
  try {
    const raw = await callLLM(msgs, { json: false }, t);
    const merged = String(raw).replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return merged || o;
  } catch (e) {
    addLog(t.sid, '书签标题合并失败：' + e.message, true);
    return o;
  }
}

// 复盘收藏：新网址直接写入书签根目录（不建文件夹，避免每次复盘都多一个文件夹很乱）；
// 已收藏过则把本次新总结的使用技巧合并进既有标题（保持原位置，持续改进）。
// 返回 'added'（新收藏）/ 'updated'（改进既有书签）/ 'skipped'（无变化）
async function reviewCollectBookmark(t, p) {
  const url = rootUrl(String(p.url || '').trim()); // 复盘只收藏网站根 URL，不收藏带路径的局部页面
  if (!/^https?:/i.test(url)) return 'skipped';
  const title = String(p.title || '').trim().replace(/\s+/g, ' ').slice(0, 200) || url;
  const existing = await findBookmarkByUrl(url);
  if (!existing) {
    // 不传 parentId → Chrome 默认放到书签根（其他书签），标题按"网站名 | 作用 | 使用技巧"三段式
    await chrome.bookmarks.create({ title, url });
    await refreshBookmarkIndex();
    addLog(t.sid, '复盘：收藏 ' + title);
    return 'added';
  }
  const oldTitle = String(existing.title || '').replace(/\s+/g, ' ').trim();
  const merged = await mergeBookmarkTitle(t, existing.title, title, url);
  const update = {}; // 可能同时改进标题 + 把既有带路径的 URL 规整为根 URL
  if (merged !== oldTitle) update.title = merged;
  if (existing.url !== url) update.url = url;
  if (!Object.keys(update).length) { addLog(t.sid, '复盘：已收藏过且无新技巧，跳过 ' + url, true); return 'skipped'; }
  await chrome.bookmarks.update(existing.id, update);
  await refreshBookmarkIndex();
  addLog(t.sid, '复盘：' + (update.title ? '改进既有书签的使用技巧：' + merged : '规整书签 URL 为根：' + url));
  return 'updated';
}

// 把动作转成给使用者看的极简文案：只报"做了什么 · Nms"，不带标签/输入值/按键等细节，保持列表清爽
function friendlyAction(a, res, ms) {
  const msTxt = ms != null ? ' · ' + ms + 'ms' : '';
  const label = (res && (res.label || res.targetLabel)) || '';
  const T = (s) => s + msTxt;
  const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  // 目标是 iframe 子窗口元素时标注（子窗号·局部ref），方便核对 Agent 到底在不在点弹层里的目标
  const frameNote = (typeof a.target === 'number' && a.target >= FRAME_REF_BASE)
    ? '（子窗' + Math.floor(a.target / FRAME_REF_BASE) + '·ref' + (a.target % FRAME_REF_BASE) + '）'
    : '';
  switch (a.action) {
    case 'click': return T('点击' + (label ? '「' + label + '」' : '') + frameNote);
    case 'clickText': return T('按文字点「' + short(a.text) + '」' + (typeof a.frame === 'number' && a.frame > 0 ? '（子窗' + a.frame + '）' : ''));
    case 'hover': return T('悬浮' + (label ? '「' + label + '」' : '') + frameNote);
    case 'type': return T('输入' + (short(a.text) ? '「' + short(a.text) + '」' : (label ? '「' + label + '」' : '')) + frameNote);
    case 'select': return T('选择' + (short(a.value) ? '「' + short(a.value) + '」' : (label ? '「' + label + '」' : '')) + frameNote);
    case 'scroll': {
      const base = T(a.direction === 'up' ? '向上滚动' : '向下滚动');
      if (res && res.moved === 0) return base + '（页面未滚动，疑似内层容器）';
      return base;
    }
    case 'read': return T('读取页面');
    case 'keypress': {
      const keys = String(a.keys || '').trim();
      return T('按键' + (keys ? ' ' + keys : (label ? '「' + label + '」' : '')));
    }
    case 'save_file': return T('保存文件');
    case 'bookmarks_write': return T('收藏书签');
    case 'bookmarks_read': return T('读取书签');
    case 'bookmark_find': return T('查找书签');
    case 'switch_tab': return T('切换标签');
    case 'list_tabs': return T('列出标签');
    case 'use_tab': return T('纳入标签');
    case 'close_tab': return T('关闭标签');
    case 'wait': return '假装人类 ' + (a.ms || 0) + 'ms';
    default: return (a.action || '') + msTxt;
  }
}

// 无进展计数（t.stuck）阈值：连续失败 / 反复执行同一动作 / 空等累计到此值 → 主动请使用者手把手演示（ask_user mode=teach）
const STUCK_TEACH_LIMIT = 5;

// 页面动作签名：用于识别"假装人类停顿后又重复执行同一个动作"的无进展循环（如连续两次 click 同一 ref）
function sigOf(a) {
  const p = a.ref || a.selector || a.target || a.url || a.key || a.text || '';
  return a.action + ':' + String(p);
}

// 页面状态指纹：判断"两次动作之间页面是否真的变了"（变了=有进展，没变=原地打转）。
// 用 url+标题+可交互元素数+正文长度做轻量指纹：翻页/加载出新内容时元素数与正文都会变；卡死循环则完全一致。
function pageSigOf(snap) {
  if (!snap) return '';
  const els = (snap.elements || []).length;
  // 帧 url 拼进指纹：动态新开的 iframe（如新建弹窗）即使顶层页面没变，也算页面状态变了
  const frameSig = (snap.frames || []).map((f) => f.url).join(',');
  return (snap.url || '') + '|' + (snap.title || '') + '|' + els + '|' + String(snap.excerpt || '').length + '|' + frameSig;
}

async function runAction(t, a) {
  if (!t || t.state !== 'working') return;
  const myTurn = t.turnId;
  if (!stillCurrent(t, myTurn)) return;
  // 记录"这次真实动作之前攒了几次 wait"（供"等待后又重复同一个动作"识别），并清零连续等待计数
  const prevWaits = (a.action !== 'wait') ? (t.consecWaits || 0) : 0;
  if (a.action !== 'wait') t.consecWaits = 0;

  // ---- 标签操作 ----
  if (a.action === 'open_tab') {
    if (!a.url || !/^(https?|file):/i.test(a.url)) {
      await pushFailure(t, 'open_tab 地址无效：' + a.url);
      return;
    }
    let entry;
    try {
      entry = await openAgentTab(a.url, null, t);
    } catch (e) {
      await pushFailure(t, e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    awaitNav(t, entry.tabId);
    return;
  }

  if (a.action === 'search') {
    const query = String(a.query || '').trim();
    if (!query) {
      await pushFailure(t, 'search 缺少关键词');
      return;
    }
    const cfg = await getConfig();
    const template = cfg.searchTemplate || 'https://www.bing.com/search?q=';
    const url = template.includes('{q}')
      ? template.replace(/\{q\}/g, encodeURIComponent(query))
      : template + encodeURIComponent(query);
    let entry;
    try {
      entry = await openAgentTab(url, '搜索「' + query + '」', t);
    } catch (e) {
      await pushFailure(t, e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    awaitNav(t, entry.tabId);
    return;
  }

  if (a.action === 'switch_tab') {
    const t0 = performance.now();
    const entry = findTabEntry(a.ref, t);
    if (!entry) {
      // 内部纠错：Agent 切到了不存在的 ref（可能臆造了 @@T6，或标签已被清理）。反馈给模型重新确认，不把原始 ref 噪音刷给用户
      await pushFailure(t, '要切换的标签不存在或已关闭（ref=' + a.ref + '），先用 list_tabs 查看当前可用标签再切换（@MAIN 一直可用）', true);
      return;
    }
    t.currentRef = entry.ref;
    const ms = Math.round(performance.now() - t0);
    addLog(t.sid, '切换标签 · ' + ms + 'ms');
    await saveTasks();
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  if (a.action === 'list_tabs') {
    try {
      const t0 = performance.now();
      const text = await listAllTabs(t);
      const ms = Math.round(performance.now() - t0);
      t.history.push({ role: 'user', content: text });
      addLog(t.sid, '列出标签 · ' + ms + 'ms');
      await saveTasks();
    } catch (e) {
      await pushFailure(t, '列出标签失败：' + e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  if (a.action === 'use_tab') {
    const t0 = performance.now();
    const tabId = Number(a.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      await pushFailure(t, 'use_tab 需要 list_tabs 返回的 tabId', true); // 内部纠错，不刷用户面板
      return;
    }
    const tab = await getTab(tabId);
    if (!tab) {
      await pushFailure(t, '要纳入的标签不存在或已关闭（tabId=' + tabId + '），先 list_tabs 刷新后再选', true); // 内部纠错，不刷用户面板
      return;
    }
    let adoptedRef;
    const existing = findTabEntryByTabId(tabId, t);
    if (existing) {
      adoptedRef = existing.ref; // 已在任务里，直接切过去
    } else {
      adoptedRef = 'U' + (++t.userTabSeq);
      t.tabs.push({ ref: adoptedRef, tabId, role: 'user', title: tab.title || '', url: tab.url || '' });
    }
    t.currentRef = adoptedRef;
    t.history.push({ role: 'user', content: '已把浏览器标签纳入任务：@' + adoptedRef + ' ' + (tab.title || shortUrl(tab.url)) + '（当前操作标签，未切浏览器前台）' });
    const ms = Math.round(performance.now() - t0);
    addLog(t.sid, '纳入标签（' + (tab.title || shortUrl(tab.url)).slice(0, 30) + '） · ' + ms + 'ms');
    await saveTasks();
    broadcastTabs(t);
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  if (a.action === 'close_tab') {
    try {
      await closeAgentTab(a.ref, t);
    } catch (e) {
      await pushFailure(t, e.message, true); // 关不存在的标签/关使用者标签 = 内部纠错，不刷用户面板
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // ---- 保存文件 ----
  if (a.action === 'save_file') {
    try {
      const res = await saveFile(a);
      t.history.push({ role: 'user', content: '文件已保存：' + res.filename });
      addLog(t.sid, '保存文件：' + res.filename);
      await saveTasks();
    } catch (e) {
      await pushFailure(t, '保存文件失败：' + e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // ---- 书签操作 ----
  if (a.action === 'bookmarks_read') {
    try {
      const text = await readBookmarks(a.folder);
      t.history.push({ role: 'user', content: '书签读取结果：\n' + text });
      addLog(t.sid, '读取书签');
      await saveTasks();
    } catch (e) {
      await pushFailure(t, '读取书签失败：' + e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  if (a.action === 'bookmarks_write') {
    try {
      const done = await writeBookmark(a, t);
      t.history.push({ role: 'user', content: '书签写入结果：' + done.msg });
      addLog(t.sid, done.created ? '收藏书签' : '更新书签');
      await saveTasks();
    } catch (e) {
      await pushFailure(t, '写入书签失败：' + e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  if (a.action === 'bookmark_find') {
    try {
      const text = await findBookmarks(a.keyword);
      t.history.push({ role: 'user', content: '书签查找结果：\n' + text });
      addLog(t.sid, '查找书签');
      await saveTasks();
    } catch (e) {
      await pushFailure(t, '查找书签失败：' + e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // ---- 在对话区给使用者说一句话（不打断流程；如"复述"） ----
  if (a.action === 'say') {
    const text = String(a.text || '').trim().slice(0, 800);
    if (text) {
      t.conversation.push({ role: 'agent', text, ok: true, t: Date.now() });
      if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
      broadcast({ type: 'AGENT_MESSAGE', text, ok: true }, t.sid);
    }
    t.turnSteps++;
    t.lastActiveAt = Date.now();
    await saveTasks();
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // ---- 请求使用者协助（验证码/登录等卡点 / 教我演示 / 复述确认） ----
  if (a.action === 'ask_user') {
    const mode = (a.mode === 'reply' || a.mode === 'teach' || a.mode === 'confirm') ? a.mode : 'page';
    const fallback = mode === 'reply'
      ? '请直接在下方的对话输入框回复我'
      : (mode === 'teach'
        ? '我在这个页面上卡住了，请你手把手演示一遍正确操作，我会记录学习'
        : (mode === 'confirm'
          ? '请确认我理解的步骤对不对：没问题点下方按钮，有出入直接在对话里纠正，我会理解后再来确认'
          : '需要你手动在页面上操作（如验证码、登录等），完成后点击"继续"'));
    await askUser(t, String(a.message || fallback), mode);
    return;
  }

  // ---- 结束本轮 ----
  if (a.action === 'finish') {
    const result = typeof a.result === 'string' ? a.result : JSON.stringify(a.result || '');
    try { await reviewAndBookmark(t); } catch (e) { /* 复盘失败不影响任务完成 */ }
    try { await reviewAndLearnTips(t); } catch (e) { /* 技巧沉淀失败不影响任务完成 */ }
    if (!stillCurrent(t, myTurn)) return;
    complete(t, result);
    return;
  }

  const tabId = await resolveCurrentTabId(t);
  if (!tabId) {
    fail(t, '任务标签页均已关闭');
    return;
  }
  if (!stillCurrent(t, myTurn)) return;

  // ---- 导航 ----
  if (a.action === 'navigate') {
    const url = a.url;
    if (!url || !/^(https?|file):/i.test(url)) {
      await pushFailure(t, 'navigate 地址无效：' + url);
      return;
    }
    addLog(t.sid, '打开 ' + shortUrl(url));
    t.state = 'awaiting_nav';
    t.awaitingNavAt = Date.now();
    t.waitTabId = tabId;
    await saveTasks();
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (e) {
      fail(t, '导航失败：' + e.message);
    }
    return; // 等 AGENT_READY / onUpdated 恢复
  }

  // ---- 等待 ----
  if (a.action === 'wait') {
    // 拟人停顿：随机 0.2s~0.8s，模拟真人阅读/思考节奏，避免动作太快被风控判定为机器
    // 但连续 wait 而没有任何真实动作、页面也没变化，就是纯空转浪费时间——第二次起不再停顿，
    // 直接提醒 LLM 停止空等、去做实际动作或 finish。
    t.consecWaits = (t.consecWaits || 0) + 1;
    if (t.consecWaits >= 2) {
      // 空等也算"无进展"，累计到阈值主动请使用者演示（多数情况走下面的"禁止再 wait"就够了，这里兜底）
      t.stuck = (t.stuck || 0) + 1;
      if (t.stuck >= STUCK_TEACH_LIMIT) {
        await askUser(t, '我在等待页面变化上反复空转、一直没有进展。请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
        return;
      }
      if (t.consecWaits === 2) {
        addLog(t.sid, '连续等待没有新进展，推动继续…', true);
        t.history.push({
          role: 'user',
          content: '你已经连续 wait（假装人类停顿）两次，而中间没有执行任何动作、页面也没有变化。之后禁止再 wait，请直接执行一个实际动作（点击 / 悬浮 / 输入 / 选择 / 滚动 / read）或 finish 结束本轮，不要空等。'
        });
      } else {
        addLog(t.sid, '仍在连续等待，跳过停顿直接继续', true);
      }
      await saveTasks();
      if (!stillCurrent(t, myTurn)) return;
      agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
      return;
    }
    const ms = Math.round(200 + Math.random() * 600);
    addLog(t.sid, '假装人类 ' + ms + 'ms');
    await sleep(ms);
    if (!stillCurrent(t, myTurn)) return;
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // ---- 页面动作：发送到当前操作标签执行 ----
  let res = null;
  let err = null;
  // 无进展计数（t.stuck）：识别"一直在原地打转"——连续失败 / 反复执行同一个动作 / 空等。
  // 与 failStreak 不同：stuck 在【换新动作】时才清零，所以"同一个动作反复成功却毫无进展"的静默循环也会累计，
  // 累计到 STUCK_TEACH_LIMIT 就主动请使用者手把手演示（ask_user mode=teach），不再无限重试。
  const sig = sigOf(a);
  const p = a.ref || a.selector || a.target || a.url || a.key || ''; // 动作的"目标身份"：scroll/read 等无具体目标的动作不算重复
  // 页面状态闸门：自上次动作以来页面真的变了（翻页/加载出新内容）→ 说明是有效进展，不算重复；页面纹丝不动才累计
  const pageChanged = !!(t.curPageSig && t.actionPageSig && t.curPageSig !== t.actionPageSig);
  const isRepeat = !!(p && t.lastActSig && sig && sig === t.lastActSig && !pageChanged);
  if (isRepeat) {
    if (prevWaits > 0) {
      // "等待后又重复同一个动作"：上个真实动作后只隔了 wait、页面没变化，现在又要执行一模一样的动作 → 提醒 LLM 换别的
      t.history.push({
        role: 'user',
        content: '注意：你要执行的动作和上一步刚做完的完全一样（' + sig + '），而中间只有 wait、页面没有变化，重复执行不会有新结果。请改做别的动作（先 read 看页面、scroll 看更多、点别的元素），或对照快照里的【本站操作技巧】看看是否该按技巧来，或 finish 结束本轮。'
      });
    } else if (t.stuck === 0) {
      // 第一次发现连续重复（中间没有 wait）：先轻提示一次让它自己换招；仍无进展会继续累计到阈值请使用者演示
      t.history.push({
        role: 'user',
        content: '注意：动作（' + sig + '）你刚刚已经执行过，如果它没能推进任务，重复执行不会有新结果。请先 read 看看当前页面状态，或对照快照里的【本站操作技巧】调整做法，或换别的动作 / 滚动查看更多 / 点击别的元素；实在不知道怎么继续，可以用 ask_user（mode=teach）请使用者手把手演示。'
      });
    }
    t.stuck = (t.stuck || 0) + 1;
  } else {
    t.stuck = 0; // 换了个新动作 = 在尝试新路径，无进展计数清零
  }
  if (t.stuck >= STUCK_TEACH_LIMIT) {
    await askUser(t, '我反复尝试了 ' + t.stuck + ' 次同样的操作仍然没有进展，不知道怎么继续了。请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
    return;
  }
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;
  const t0 = performance.now();
  armFocusGuard(t); // 记录动作前的前台标签；动作期间页面若 window.open 抢焦点，后台会把它收回
  // 目标窗口路由：合并快照里 iframe 元素的 ref 是全局编号（frameIndex*1000+局部 ref），
  // 先拆回 (frameId, 局部 ref) 再只发给那个窗口执行，避免全 frame 都收到、返回数组乱掉。
  // 非数字目标（read 页面/scroll/keypress 等）一律落在主窗口（frameId 0）。
  let sendFrame = { frameId: 0 };
  let actionForFrame = a;
  if (typeof a.target === 'number' && a.target >= FRAME_REF_BASE) {
    const frameIdx = Math.floor(a.target / FRAME_REF_BASE);
    const frame = (t.snapFrames || [])[frameIdx];
    if (frame && frame.frameId != null) {
      sendFrame = { frameId: frame.frameId };
      actionForFrame = { ...a, target: a.target % FRAME_REF_BASE };
    }
  } else if (a.action === 'clickText' && typeof a.frame === 'number' && a.frame > 0) {
    // clickText 没有 target ref，用 frame 字段指定子窗口（与【子窗口 N】编号一致）；不填默认主窗口
    const frame = (t.snapFrames || [])[a.frame];
    if (frame && frame.frameId != null) sendFrame = { frameId: frame.frameId };
  }
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action: actionForFrame }, sendFrame);
  } catch (e) {
    err = e;
  }
  const ms = Math.round(performance.now() - t0);
  if (err) {
    // sendMessage 抛错 ≈ 页面正在加载/跳转、content 上下文失效
    const tab = await getTab(tabId);
    console.warn('[PageAgent] EXECUTE_ACTION 连接失败 tab=' + tabId + ' ' + (tab ? tab.url : '(标签不存在)') + ' → ' + err.message);
    addLog(t.sid, '页面动作连接失败（可能页面正在跳转/未加载完成）' + (tab ? '' : '，标签已不存在'), true);
    awaitNav(t, tabId);
    return;
  }
  if (!stillCurrent(t, myTurn)) return;
  if (!res || res.ok === false) {
    const why = (res && (res.message || res.error)) || '动作执行失败';
    console.warn('[PageAgent] 动作执行失败 tab=' + tabId + ' → ' + why);
    await pushFailure(t, why, false, sig); // 失败也记入 lastActSig，反复重试同一失败动作会被识别为重复
    return;
  }

  // 点击的链接是 target="_blank"（会新开页面）→ content 已截获，改为后台打开并纳入 @T：
  // 不抢浏览器焦点，且算 Agent 自开标签（本轮结束随分组一起清理）。
  if (res.openTab) {
    let entry;
    const label = (res.label || '').trim();
    const display = label
      ? ('点击「' + label + '」→ 后台打开 ' + shortUrl(res.openTab))
      : ('点击 → 后台打开 ' + shortUrl(res.openTab));
    try {
      entry = await openAgentTab(res.openTab, display, t);
    } catch (e) {
      await pushFailure(t, e.message, false, sig);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    t.failStreak = 0;
    t.history.push({
      role: 'user',
      content: '点击的链接会新开页面，已在后台打开为 @' + entry.ref + '（' + shortUrl(res.openTab) + '），属 Agent 自开标签，本轮结束自动关闭'
    });
    awaitNav(t, entry.tabId);
    return;
  }

  t.history.push({
    role: 'user',
    content: '动作结果：' + JSON.stringify(res).slice(0, 800)
  });
  t.failStreak = 0;
  // 输入动作卡住（耗时 >10s 或内容没落地）→ 非阻塞提醒使用者介入；Agent 不等待、继续执行。
  // 同一"卡住阶段"只提醒一次，输入恢复顺畅后解除标记，下次再卡会再提醒。
  if (a.action === 'type' && res.inputStuck) {
    if (!t.inputNudged) {
      t.inputNudged = true;
      nudgeUser(t, '在 ' + currentSiteLabel(t) + ' 上的输入动作超过 10 秒还没生效（后台标签可能被浏览器节流，或网站没接受输入）。你可以把该标签切到前台手动输入，Agent 会继续执行，不用等你。');
    }
  } else if (a.action === 'type') {
    t.inputNudged = false;
  }
  t.lastActSig = sig; // 记录本次动作，供"反复执行同一个动作"识别
  t.actionPageSig = t.curPageSig; // 记录执行动作时的页面状态，供下次重复判断"页面是否真的变了"
  addLog(t.sid, friendlyAction(a, res, ms)); // 面板显示极简动作 + 耗时，如"点击 · 50ms"
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// 当前操作页面的标识（转人工/提醒时告诉使用者"哪个页面"）：
// 优先用标签标题（一眼认出是哪个页面），标题为空或太短再用域名，仍无则"当前页面"
function currentSiteLabel(t) {
  let title = '', url = '';
  const cur = currentEntry(t);
  if (cur) { title = cur.title || ''; url = cur.url || ''; }
  if (!title) {
    const main = (t.tabs || []).find((e) => e.role === 'main');
    if (main) { title = main.title || ''; url = main.url || ''; }
  }
  const ttl = String(title).replace(/\s+/g, ' ').trim();
  if (ttl) return ttl.length > 30 ? ttl.slice(0, 30) + '…' : ttl;
  return hostOf(url) || '当前页面';
}

// 把给 LLM 看的失败原因转成使用者能看懂的一句话：
// 去掉括号里的内部指引（如"先 list_tabs 确认再关"）和 @T3/ref 这类内部编号，保留实质原因
function humanizeWhy(why) {
  let s = String(why || '').trim();
  s = s.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
  // 去掉"先用 list_tabs 刷新后再选"这类给 Agent 看的内部指引句子（有时不在括号里）
  s = s.replace(/[，,]\s*(?:先|请|再)?\s*用?\s*(?:list_tabs|use_tab|switch_tab|open_tab|close_tab|navigate|search|snapshot)[^。]*/g, '');
  s = s.replace(/[:：]\s*@[A-Z]+\d*/g, '').replace(/@[A-Z]+\d*/g, '标签');
  s = s.replace(/ref=\s*[^\s,，;；]+/g, '');
  s = s.replace(/[，,]\s*$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 动作失败：把失败原因写回 history 并继续循环，让 LLM 修正；连续失败则转人工
async function pushFailure(t, why, quiet, sig) {
  if (!t || t.state !== 'working') return;
  t.failStreak = (t.failStreak || 0) + 1;
  t.stuck = (t.stuck || 0) + 1; // 失败也是"无进展"，计入 stuck（配合 runAction 的重复识别，累计到阈值转教我）
  if (sig) t.lastActSig = sig; // 失败的动作也算"最近尝试"，这样反复重试同一个失败动作也会被识别为重复
  if (t.curPageSig) t.actionPageSig = t.curPageSig; // 失败也算一次"动作"，记录其时的页面状态
  if (t.stuck >= STUCK_TEACH_LIMIT) {
    await askUser(t, '我反复尝试了 ' + t.stuck + ' 次仍然没有进展。请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
    return;
  }
  if (t.failStreak >= 3) {
    const site = currentSiteLabel(t);
    const plain = humanizeWhy(why);
    await askUser(t, '在 ' + site + ' 上连续操作失败' + (plain ? '：' + plain : '') + '。请检查这个页面：如出现验证码、登录框或弹窗请先手动处理，其他情况也可在页面上自行调整；处理完点击「继续」。');
    return;
  }
  t.history.push({ role: 'user', content: '动作执行失败：' + why + '（先对照快照里的【本站操作技巧】调整做法再重试，别硬试同一招）' });
  addLog(t.sid, why, quiet); // quiet=true 只进 SW console，不刷用户面板——内部纠错类失败（如切到不存在的标签 ref），使用者无需看原始 ref/tabId
  await saveTasks();
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// 请求使用者协助：暂停当前回合，等"继续"。
//   page  = 使用者在【页面上】手动操作（验证码/登录等），操作完点"继续"；
//   teach = 使用者在【页面上】手把手演示操作，Agent 记录学习（教我模式）；
//   reply = 使用者在【对话中】直接回复信息。
async function askUser(t, msg, mode) {
  if (!t) return;
  const myTurn = t.turnId;
  const isReply = mode === 'reply';
  const isTeach = mode === 'teach';
  const isConfirm = mode === 'confirm';
  // 页面操作/教我模式需要把操作标签切到前台；对话回复/确认模式不抢焦点
  const needForeground = !isReply && !isConfirm;
  let tabId = null;
  if (needForeground) tabId = await resolveCurrentTabId(t);
  if (!t || t.turnId !== myTurn || t.state !== 'working') return; // 已被新指令打断
  t.state = 'waiting_user';
  t.askText = String(msg);
  t.askMode = isTeach ? 'teach' : (isReply ? 'reply' : (isConfirm ? 'confirm' : 'page'));
  t.waitingReply = isReply; // confirm 不设 waitingReply：使用者直接在输入框打的字走 processUserMessage 的"确认循环"分流（确认/不教了/先去做/纠正）
  t.awaitingNavAt = 0;
  t.waitTabId = null;
  t.failStreak = 0;
  t.stuck = 0; // 任何一次请使用者协助都是一个检查点，无进展计数清零
  if (isTeach) {
    t.teachTabId = tabId;
    t.teachTabIds = []; // 教我模式监听【任务下所有 tab】（不只当前标签），逐个挂上录制
    t.teachEvents = []; // 教你模式的录制缓冲，由 content 上报 TEACH_EVENT 累积
  }
  await saveTasks();
  // 页面操作/教我模式：把当前操作标签切到前台供使用者操作，并（教我时）启动事件录制
  if (tabId && needForeground) chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (isTeach) {
    // 把录制挂到任务下所有 tab（使用者标签 @U/@MAIN、Agent 自开 @T），使用者可能在多页/多站之间切换演示
    const targets = new Set([tabId, ...(t.tabs || []).map((e) => e.tabId).filter(Boolean)]);
    for (const id of targets) {
      if (id == null) continue;
      try {
        await ensureContentScript(id);
        await chrome.tabs.sendMessage(id, { type: 'TEACH_START' }).catch(() => {});
        t.teachTabIds.push(id);
        console.log('[Teach] 教学挂载 tab=' + id);
      } catch (e) { console.log('[Teach] 教学挂载失败 tab=' + id + ' → ' + e.message); }
    }
    await saveTasks();
  }
  clearAlarm();
  const label = isReply ? '请使用者在对话中回复：' : (isTeach ? '请求使用者手把手演示（教我模式）：' : (isConfirm ? '请使用者确认复述：' : '请求使用者手动操作：'));
  addLog(t.sid, label + msg);
  const tail = isReply ? '（使用者会直接在对话中输入回复）' : (isTeach ? '（Agent 会记录使用者的操作并学习，完成后点"我操作完了"）' : (isConfirm ? '（使用者点"没问题"按钮确认，或直接在对话里纠正）' : '（等使用者完成后点击"继续"）'));
  const head = isReply ? '需要使用者在对话中回复：' : (isTeach ? '需要使用者手把手演示操作：' : (isConfirm ? '需要使用者确认复述：' : '需要使用者手动操作：'));
  t.history.push({ role: 'user', content: head + msg + tail });
  t.conversation.push({ role: 'agent', text: String(msg), ok: false, ask: true, mode: isTeach ? 'teach' : (isReply ? 'reply' : (isConfirm ? 'confirm' : 'page')), t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  await saveTasks();
  broadcast({ type: 'AGENT_ASK', text: String(msg), mode: isTeach ? 'teach' : (isReply ? 'reply' : (isConfirm ? 'confirm' : 'page')) }, t.sid);
  broadcast({ type: 'AGENT_STATUS', status: 'waiting_user', askMode: isTeach ? 'teach' : (isReply ? 'reply' : (isConfirm ? 'confirm' : 'page')) }, t.sid);
  broadcastTabs(t);
}

// 非阻塞提醒：写一条提示给使用者看，但不改变会话状态、不等待他介入（Agent 继续执行）。
// 与 askUser 的区别：askUser 转 waiting_user 必须等"继续"，这里只是提醒。
function nudgeUser(t, text) {
  if (!t) return;
  t.conversation.push({ role: 'agent', text: String(text), kind: 'nudge', t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  broadcast({ type: 'AGENT_NUDGE', text: String(text) }, t.sid);
  addLog(t.sid, '提示：' + text);
}

// ---------------- 站点操作技巧库（复盘沉淀，操作时加载） ----------------

const TIPS_KEY = 'siteTips';         // storage.local 键：{ [host]: string[] }
// 技巧条数不设硬性上限：每次沉淀合并时都判断"重复/相近"并合并，数量会自然收敛，无需人为截断
const TIPS_ACTION_THRESHOLD = 4;     // 单站点动作数 ≥ 此值视为"绕了弯路/多点了很多次"
const TIPS_FAIL_THRESHOLD = 2;       // 单站点失败数 ≥ 此值视为"反复失败"
const TIPS_MAX_NEW = 3;              // 每次复盘最多新增的技巧条数

// 域名 = host（只记录域名，不带协议/路径/查询）；入参可能是完整 URL 也可能是裸域名，都能解析
function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : ('https://' + s));
    return u.hostname;
  } catch (e) { return ''; }
}

async function getTipStore() {
  const obj = await chrome.storage.local.get(TIPS_KEY);
  return (obj && obj[TIPS_KEY]) || {};
}

// 取某站点的操作技巧（无则返回空数组）
async function getSiteTips(host) {
  if (!host) return [];
  const store = await getTipStore();
  return store[host] || [];
}

async function saveSiteTips(host, tips) {
  const store = await getTipStore();
  store[host] = (tips || [])
    .map((s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean);
  await chrome.storage.local.set({ [TIPS_KEY]: store });
}

// 复盘入口（与书签复盘并列，都在 finish 时跑）：把本轮"反复失败 / 绕了弯路多点了很多次"
// 的操作沉淀成"该网站的操作技巧"（只记域名），并带上该站既有技巧做冲突去重合并，持续全量优化。
async function reviewAndLearnTips(t, force, pinnedTurn) {
  if (!t) return;
  // force：停止后复盘用（state 已回 idle，仍要跑复盘）；正常 finish 复盘时 force 为空，保持"仅 working 时复盘"
  if (!force && t.state !== 'working') return;
  const myTurn = (pinnedTurn != null) ? pinnedTurn : t.turnId; // 钉住停止那一刻的回合号，中途新指令会打断复盘
  const report = collectDifficultyReport(t);
  if (!report) return;
  const cfg = await getConfig();
  if (!cfg.apiKey) return;
  if (!stillCurrent(t, myTurn, force)) return;
  addLog(t.sid, '复盘：' + report.domains.length + ' 个站点操作有困难，沉淀操作技巧…');
  const store = await getTipStore();
  const oldByHost = {};
  for (const h of report.domains) oldByHost[h] = (store[h] || []).join('\n');
  const msgs = [
    {
      role: 'system',
      content: '你是 PageAgent 的"网站操作技巧沉淀"助手。使用者一次任务里在某些网站反复失败、或绕了弯路多点了很多次。请为这些网站总结出【下次该怎么操作才更顺】的简短技巧。技巧要提炼成该网站**可复用的操作/交互规律**（比如：搜索框输入关键词后必须从下拉候选里点选、不能直接回车；这个页面要先点开下拉框再选择；登录入口在页面右下角）。要求：① 一句话一条、具体可执行；② 只讲该网站的通用操作习惯，**禁止照搬本轮一次性内容**——不要出现具体搜索词、地点名、用户名、页面元素文本（如"点击『湖南郴州裕后街』"这种），要抽象成"输入框/下拉/按钮/列表"这类功能操作的规律；③ 忽略纯网络/服务端问题（页面打不开、超时、接口报错）；④ 已有技巧里讲过的别重复。'
    },
    {
      role: 'user',
      content: '本轮操作困难报告：\n' + report.text +
        '\n\n这些域名已有的操作技巧（避免重复）：\n' + report.domains.map((h) => h + '：' + (oldByHost[h] || '（无）')).join('\n') +
        '\n\n只输出 JSON：{"tips":[{"domain":"域名","tip":"一句话技巧"}]}。每条 tip 的 domain 必须是上面报告里出现的域名；最多 ' + TIPS_MAX_NEW + ' 条；某网站不需要新增技巧就输出 {"tips":[]}。'
    }
  ];
  let arr = [];
  try {
    const raw = await callLLM(msgs, undefined, t);
    const obj = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
    arr = (obj && Array.isArray(obj.tips)) ? obj.tips : [];
  } catch (e) {
    addLog(t.sid, '复盘技巧生成失败：' + e.message, true);
    return;
  }
  if (!stillCurrent(t, myTurn, force)) return;
  // 按域名分组：只写报告里的域名，防 LLM 乱加别的站点
  const byHost = new Map();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const h = hostOf(item.domain);
    if (!h || !report.domains.includes(h)) continue;
    const tip = String(item.tip || '').replace(/\s+/g, ' ').trim();
    if (tip) { if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(tip); }
  }
  if (!byHost.size) return;
  for (const [h, newTips] of byHost) {
    if (!stillCurrent(t, myTurn, force)) break;
    try {
      const merged = await mergeSiteTips(h, newTips, oldByHost[h], t.sid);
      if (!merged || !merged.length) continue;
      await saveSiteTips(h, merged);
      addLog(t.sid, '复盘：沉淀 ' + h + ' 的操作技巧（共 ' + merged.length + ' 条）');
    } catch (e) {
      addLog(t.sid, '复盘技巧保存失败：' + h + ' → ' + e.message, true);
    }
  }
}

// 合并某域名的既有技巧与新技巧：同站同操作的冲突技巧合并处理、有价值的旧技巧保留、限制条数。返回最终列表。
async function mergeSiteTips(host, newTips, oldTipsText, sid) {
  const cfg = await getConfig();
  if (oldTipsText && cfg.apiKey) {
    const msgs = [
      {
        role: 'system',
        content: '你是 PageAgent 的"网站操作技巧合并"助手。给定一个网站的【旧技巧】和【新技巧】，合并成一份最终技巧列表。规则：① 同一操作的不同/冲突技巧要合并处理，新技巧能覆盖旧技巧的以新为准（新技巧说明旧做法是错的时，删除旧做法）；② 仍有用的旧技巧保留，不要丢失；③ 每条一句话、具体可执行；④ 重复或相近的技巧必须合并成一条，宁精勿滥，不要让同一条经验以不同措辞堆叠多条；⑤ 只输出 JSON 数组，如 ["技巧一","技巧二"]。'
      },
      { role: 'user', content: '网站：' + host + '\n旧技巧：\n' + (oldTipsText || '（无）') + '\n新技巧：\n' + newTips.join('\n') }
    ];
    try {
      const raw = await callLLM(msgs, { json: false }, getTask(sid) || undefined);
      const arr = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
      if (Array.isArray(arr) && arr.length) {
        const clean = arr.map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (clean.length) return clean;
      }
    } catch (e) {
      addLog(sid, '复盘技巧合并失败：' + e.message, true);
    }
  }
  // 兜底：旧 + 新 简单去重（LLM 合并失败时不让旧技巧丢失）
  const merged = [...newTips];
  const seen = new Set(merged);
  for (const o of String(oldTipsText || '').split('\n')) {
    const s = o.replace(/\s+/g, ' ').trim();
    if (s && !seen.has(s)) { merged.push(s); seen.add(s); }
  }
  return merged;
}

// 统计本轮各站点的动作数/失败数，返回有"困难信号"站点的报告（供 LLM 沉淀技巧）。
// 只统计实际操作过的站点：快照【当前页面】URL 之后、到下一个快照之前的动作归属该站点。
// 困难信号：失败 ≥ TIPS_FAIL_THRESHOLD，或动作 ≥ TIPS_ACTION_THRESHOLD（绕弯路/多点了很多次）。
function collectDifficultyReport(t) {
  const slice = (t.history || []).slice(t.turnHistoryStart || 0);
  const sites = new Map(); // host -> { actions, fails, actLines: Map<actionType,count>, actSeq: [], failMsgs: [] }
  const ensure = (h) => {
    if (!h) return null;
    if (!sites.has(h)) sites.set(h, { actions: 0, fails: 0, actLines: new Map(), actSeq: [], failMsgs: [] });
    return sites.get(h);
  };
  let cur = null; // 当前操作站点
  for (const m of slice) {
    if (m.role === 'assistant' && typeof m.content === 'string') {
      try {
        const a = JSON.parse(m.content);
        if (!a || typeof a !== 'object' || !a.action) continue;
        if (a.action === 'open_tab' || a.action === 'navigate' || a.action === 'search') {
          cur = ensure(hostOf(a.url));
          if (cur) { cur.actions++; bumpAct(cur, a.action); }
        } else if (a.action === 'click' || a.action === 'clickText' || a.action === 'hover' || a.action === 'type' || a.action === 'select' || a.action === 'scroll' || a.action === 'keypress') {
          if (cur) { cur.actions++; bumpAct(cur, a.action); }
        }
      } catch (e) {}
    } else if (m.role === 'user' && typeof m.content === 'string') {
      const pm = m.content.match(/【当前页面】URL:\s*(\S+)/);
      if (pm) cur = ensure(hostOf(pm[1]));
      if (m.content.indexOf('动作执行失败') !== -1 && cur) {
        cur.fails++;
        cur.failMsgs.push(m.content.replace(/^动作执行失败：/, '').slice(0, 100));
      }
    }
  }
  const bad = [...sites.values()].filter((s) => s.fails >= TIPS_FAIL_THRESHOLD || s.actions >= TIPS_ACTION_THRESHOLD);
  if (!bad.length) return null;
  const hostOfSite = (s) => { for (const [h, v] of sites) if (v === s) return h; return ''; };
  const lines = [];
  for (const s of bad) {
    const h = hostOfSite(s);
    const acts = [...s.actLines.entries()].map(([k, n]) => k + '×' + n).join(' ');
    lines.push('【' + h + '】动作 ' + s.actions + ' 次' + (s.fails ? '，失败 ' + s.fails + ' 次' : '') + (acts ? '；动作分布：' + acts : '') + (s.actSeq.length ? '；动作轨迹：' + s.actSeq.join('→') : ''));
    for (const f of s.failMsgs.slice(0, 3)) lines.push('  - 失败：' + f);
  }
  return { domains: bad.map(hostOfSite), text: lines.join('\n') };
}

function bumpAct(site, action) {
  site.actLines.set(action, (site.actLines.get(action) || 0) + 1);
  site.actSeq.push(action);
  if (site.actSeq.length > 14) site.actSeq.splice(0, site.actSeq.length - 14); // 保留最近 14 步，供复盘提炼操作规律
}

// ---------------- 跨页面/跨标签恢复 ----------------
function findTabEntryByTabId(tabId, t) {
  return (t.tabs || []).find((e) => e.tabId === tabId) || null;
}

function awaitNav(t, tabId) {
  if (!t) return;
  t.state = 'awaiting_nav';
  t.awaitingNavAt = Date.now();
  t.waitTabId = tabId;
  t.lastActSig = ''; // 换了操作页面上下文，上一页的动作签名作废
  const entry = findTabEntryByTabId(tabId, t);
  t.navWaitIdx = true; // 标记"正在打开页面"行已显示，就绪后合并成一行
  addLog(t.sid, '正在打开页面，等待就绪…');
  saveTasks();
}

function tryResume(sid, tabId) {
  const t = getTask(sid);
  if (!t || t.state !== 'awaiting_nav') return;
  if (t.waitTabId && t.waitTabId !== tabId) return; // 等的不是这个标签
  if (Date.now() - (t.awaitingNavAt || 0) > NAV_TIMEOUT_MS) {
    fail(t, '页面加载/跳转超时');
    return;
  }
  const readyTxt = '页面已就绪 · ' + Math.round(Date.now() - (t.awaitingNavAt || 0)) + 'ms';
  t.state = 'working'; // 同步置位，避免 AGENT_READY 与 onUpdated 双触发
  if (t.navWaitIdx) {
    updateLog(t.sid, t.navWaitIdx, '正在打开页面，等待就绪… ' + readyTxt); // 合并到"等待就绪"那一行
    t.navWaitIdx = null;
  } else {
    addLog(t.sid, readyTxt);
  }
  saveTasks();
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// ---------------- 完成 / 失败（回到 idle，等待下一条指令） ----------------
async function complete(t, result) {
  if (!t) return;
  if (t.state === 'idle') return; // 已被新指令打断/停止
  t.state = 'idle';
  await closeAgentTabs(t).catch(() => {}); // 每轮完成自动关闭 Agent 自开标签（使用者的标签永不关闭）
  t.turnSteps = 0;
  t.result = String(result);
  t.finishedAt = Date.now();
  t.conversation.push({ role: 'agent', text: String(result), ok: true, t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  t.history.push({ role: 'assistant', content: '本轮回答：' + String(result) });
  await saveTasks();
  addLog(t.sid, '本轮完成（第 ' + t.steps + ' 步），等待下一条指令');
  broadcast({ type: 'AGENT_MESSAGE', text: String(result), ok: true }, t.sid);
  broadcast({ type: 'AGENT_STATUS', status: 'idle' }, t.sid);
  broadcastTabs(t);
  clearAlarm();
}

async function fail(t, msg) {
  if (!t) return;
  if (t.state === 'idle') return; // 已被新指令打断/停止
  t.state = 'idle';
  await closeAgentTabs(t).catch(() => {}); // 每轮失败也清理 Agent 自开标签（使用者的标签永不关闭）
  t.turnSteps = 0;
  t.error = String(msg);
  t.finishedAt = Date.now();
  t.conversation.push({ role: 'agent', text: '未完成：' + msg, ok: false, t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  t.history.push({ role: 'assistant', content: '本轮未能完成：' + msg });
  await saveTasks();
  addLog(t.sid, '本轮失败：' + msg + '（可继续下一条指令）');
  broadcast({ type: 'AGENT_MESSAGE', text: String(msg), ok: false }, t.sid);
  broadcast({ type: 'AGENT_STATUS', status: 'idle' }, t.sid);
  broadcastTabs(t);
  clearAlarm();
}

// ---------------- 对话控制 ----------------

// 教我模式：使用者在对话里说这类话时，暂停并记录其页面操作来学习
const TEACH_INTENT = /我教你|教你操作|我演示|演示给你|你看我怎么|看好了|你来操作|我来操作|手把手教|跟我学|我做一遍|示范/;

// 教我重录：使用者在"演示录制中（teach）"回复说演示有问题/少步骤等时，放弃当前录制、重开一个新的演示。
// 复述确认阶段（confirm）的"有问题/不对/少了一步"等纠正不再走这里，而是进入确认循环（见 processUserMessage）。
const RETEACH_INTENT = /重新演示|重新教|再演示|再来一遍|重新来|重录|有问题|有出入|不对|错了|少了一步|漏了一步|缺了一步|不是这样|搞错了|重新操作|再教一遍/;

// 复述确认循环的三类回复判定：
//   · TEACH_QUIT_INTENT    —— 使用者终止教学："不教了/算了/你先去做吧"等 → 结束循环，让 Agent 按当前理解自行继续完成目标
//   · TEACH_REDEMO_INTENT  —— 使用者要求重开演示 → 放弃当前教学，重新演示（确认阶段也保留这个出口）
//   · TEACH_CONFIRM_INTENT —— 使用者确认复述无误 → 放行，按演示继续
// 以上都没命中（比如回复了纠正/问题/疑问）→ 视为"纠正"，让 Agent 重新理解后再复述、再确认，形成循环。
const TEACH_QUIT_INTENT = /不教了|不学了|算了|别教了|不用教了|不用你教|放弃教|放弃吧|你先去做吧|你先做|你自己来|你自己做|你看着办|你自己处理|你来吧|你来做|你直接做|你直接来|不用(再|你)确认/;
const TEACH_REDEMO_INTENT = /重新演示|重新教|再演示一遍|再演示|再来一遍|重新来|重录|再教一遍|重新演示一遍/;
const TEACH_CONFIRM_INTENT = /没问题|确认|没错|无误|正确|赞同|就这样|可以|好的|嗯嗯|嗯的|是的|对的|按你教的|按你说的|^对[啊呀]?[！!。.\s]*$|^行[啊呀]?[！!。.\s]*$|^好[啊呀]?[！!。.\s]*$|^OK$|^ok$/;

// 进入教我模式：暂停当前回合，把教学标签切到前台并启动事件录制，等使用者操作完点"我操作完了"
async function enterTeachMode(t, content, tabId) {
  const midTask = !!(t && (t.state === 'working' || t.state === 'awaiting_nav'));
  let teachTabId = null;
  if (!midTask) {
    // 空闲/无任务：教学目标是当前前台标签（无任务则以它建对话）
    if (tabId) teachTabId = tabId;
    else {
      try { const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); teachTabId = a ? a.id : null; } catch (e) {}
    }
    if (!teachTabId) { addLog(t.sid, '教你模式：未找到可操作的标签页', true); return; }
    const entry = findTabEntryByTabId(teachTabId, t);
    if (entry) {
      t.currentRef = entry.ref;
    } else {
      const tb = await getTab(teachTabId);
      if (!tb) { addLog(t.sid, '教你模式：目标标签已关闭', true); return; }
      const ref = 'U' + ++t.userTabSeq;
      t.tabs.push({ ref, tabId: teachTabId, role: 'user', title: tb.title || '', url: tb.url || '' });
      t.currentRef = ref;
      addLog(t.sid, '教你模式：把当前前台标签纳入任务（@' + ref + '）');
    }
  }
  t.turnId++;
  t.state = 'working'; // 临时置 working（覆盖 idle/done/waiting_user），让 askUser 的校验通过
  t.turnSteps = 0;
  t.waitTabId = null;
  t.askText = null;
  t.failStreak = 0;
  t.stuck = 0;
  t.lastActiveAt = Date.now();
  t.conversation.push({ role: 'user', text: content, t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  t.turnHistoryStart = t.history.length;
  if (!t.goal) {
    let host = '';
    try { const tb = await getTab(teachTabId || t.mainTabId); host = hostOf((tb && tb.url) || ''); } catch (e) {}
    t.goal = '学习使用者在 ' + (host || '该网站') + ' 的演示操作';
  }
  t.lastInstruction = content;
  t.history.push({ role: 'user', content });
  await saveTasks();
  await askUser(t, '请你在这个页面上操作，我会记录你的每一步操作来学习；完成后点「我操作完了」', 'teach');
}

// 处理使用者新指令：无对话则新建；有则打断当前回合并开始新回合
async function processUserMessage(sid, text, tabId) {
  const content = String(text || '').trim();
  if (!content) return;

  await ensureSession(sid, tabId);
  const t = getTask(sid);
  if (!t) return;

  // 教我模式：使用者说"我教你/我演示"等话时，暂停并记录其页面操作来学习（优先于回复/普通指令判断）
  if (TEACH_INTENT.test(content)) {
    await enterTeachMode(t, content, tabId);
    return;
  }

  // 复述确认循环：Agent 正等使用者确认复述的步骤（mode=confirm）时，按回复内容分流——
  //   · 明确"没问题/确认" → 放行，按演示继续（走 resumeAfterUser 的 confirm 分支）
  //   · 明确"不教了/算了/你先去做吧" → 终止教学，让 Agent 按当前理解自行继续完成目标
  //   · 明确"重新演示" → 放弃当前教学、重开一个新的演示
  //   · 其它回复（纠正/问题/疑问）→ 进入确认循环：让 Agent 重新理解、修正后再复述、再 ask_user(confirm) 确认，
  //     循环一直持续到使用者确认 / 说不教了 / 说先去做为止，不再"一有出入就重开演示"。
  if (t.askMode === 'confirm') {
    if (TEACH_QUIT_INTENT.test(content)) {
      addLog(t.sid, '使用者终止教学：' + content.slice(0, 40));
      t.askMode = null;
      t.askText = null;
      t.waitTabId = null;
      t.teachEvents = []; // 未确认的教学步骤不沉淀
      t.state = 'working';
      t.turnSteps = 0;
      t.failStreak = 0;
      t.stuck = 0;
      t.lastActiveAt = Date.now();
      t.conversation.push({ role: 'user', text: content, t: Date.now() });
      if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
      t.history.push({
        role: 'user',
        content: '使用者决定不再让你按演示教学，回复了：「' + content + '」。请放弃教学演示（已学到的思路可以保留），按你目前的理解自行继续完成原始目标；完成不了的部分可再用 ask_user（mode:page/reply）向使用者求助。'
      });
      await saveTasks();
      broadcast({ type: 'AGENT_STATUS', status: 'working' }, t.sid);
      setupAlarm();
      agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
      return;
    }
    if (TEACH_REDEMO_INTENT.test(content)) {
      addLog(t.sid, '使用者要求重新演示，放弃当前教学、重开新的演示');
      t.askMode = null;
      await saveTasks();
      await enterTeachMode(t, content, tabId);
      return;
    }
    if (TEACH_CONFIRM_INTENT.test(content)) {
      addLog(t.sid, '使用者在对话里确认复述无误：' + content.slice(0, 40));
      await resumeAfterUser(t.sid, content); // 把使用者的话带进去，避免重复占位
      return;
    }
    // 纠正：保留原始目标/goal，进入"再理解-再确认"循环
    addLog(t.sid, '使用者对复述提出纠正，进入再理解-再确认循环：' + content.slice(0, 60));
    t.askMode = null;
    t.askText = null;
    t.waitTabId = null;
    t.state = 'working';
    t.turnSteps = 0;
    t.failStreak = 0;
    t.stuck = 0;
    t.lastActiveAt = Date.now();
    t.conversation.push({ role: 'user', text: content, t: Date.now() });
    if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
    t.history.push({
      role: 'user',
      content: '使用者在确认阶段对你的理解提出了纠正：「' + content + '」。请重新理解他的纠正，对照演示步骤与你刚复述的内容修正你的理解（必要时先看当前页面快照核对），然后用 say 复述修正后的步骤，再用 ask_user（mode=confirm）再次请使用者确认。确认循环会一直持续，直到使用者明确说「没问题/确认」放行，或说「不教了/算了」「你先去做吧/你自己来」终止教学——不要未经再次确认就擅自继续执行，也不要自行猜测调整步骤。'
    });
    await saveTasks();
    broadcast({ type: 'AGENT_STATUS', status: 'working' }, t.sid);
    setupAlarm();
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // 教我重录：仍在"演示录制中"（teach），回复说演示有问题/少步骤等 → 放弃当前录制，直接重开一个新的演示
  if (t.askMode === 'teach' && RETEACH_INTENT.test(content)) {
    addLog(t.sid, '使用者反馈教学有误，放弃当前录制、重开新的演示');
    await enterTeachMode(t, content, tabId);
    return;
  }

  // 对话回复模式：Agent 正等使用者在对话里回复信息，此消息当作回复继续当前回合（不是新指令）
  if (t.state === 'waiting_user' && t.waitingReply) {
    t.state = 'working';
    t.waitingReply = false;
    t.askMode = null;
    t.askText = null;
    t.turnSteps = 0;
    t.failStreak = 0;
    t.stuck = 0;
    t.lastActiveAt = Date.now();
    t.history.push({ role: 'user', content: '使用者回复：' + content });
    t.conversation.push({ role: 'user', text: content, t: Date.now() });
    if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
    await saveTasks();
    broadcast({ type: 'AGENT_STATUS', status: 'working' }, t.sid);
    setupAlarm();
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // 打断：正在执行/等待使用者的上一条指令先作废（turnId 增一，旧回合的后续 await 会自行退出）
  if (t.state === 'working' || t.state === 'awaiting_nav' || t.state === 'waiting_user') {
    addLog(t.sid, '收到新指令，打断当前操作…');
  }
  t.turnId++;
  t.state = 'working';
  t.turnSteps = 0;
  t.waitTabId = null;
  t.askText = null;
  await stopTeachRecording(t); // 打断时若正处于教我录制，先停掉录制（sendMessage 守卫读的是 askMode，故需在置空前调用）
  t.askMode = null;
  t.failStreak = 0;
  t.consecWaits = 0;   // 新回合重置"连续 wait 空转"计数
  t.lastActSig = '';   // 新回合重置"重复动作"识别
  t.stuck = 0;         // 新回合重置"无进展计数"
  t.lastActiveAt = Date.now();
  t.lastTipsHost = ''; // 新回合重置"技巧加载提示"去重

  t.conversation.push({ role: 'user', text: content, t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  t.turnHistoryStart = t.history.length; // 本回合历史起点（复盘用）
  if (!t.goal) t.goal = content; // 记下最初的原始目标，压缩/裁剪后仍能保留（中途补充说明不覆盖它）
  t.lastInstruction = content; // 最新一条指令/补充说明：注入上下文醒目强调、务必采纳（可能是改目标，也可能只是纠正做法的指导）
  t.history.push({ role: 'user', content });

  await refreshBookmarkIndex(); // 新指令重新载入书签索引（书签可能已变）
  await saveTasks();
  broadcast({ type: 'AGENT_STATUS', status: 'working' }, t.sid);
  setupAlarm();
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// 停止教我模式的录制并清理 teach 态（停止/新对话/中断时用）
async function stopTeachRecording(t) {
  if (!t) return;
  const ids = t.teachTabId ? [t.teachTabId, ...(t.teachTabIds || [])] : (t.teachTabIds || []);
  if (t.askMode === 'teach') {
    // 对【所有】已挂录制的教学 tab 逐个发 TEACH_STOP 停录
    for (const id of new Set(ids)) {
      if (id == null) continue;
      try { await chrome.tabs.sendMessage(id, { type: 'TEACH_STOP' }).catch(() => {}); } catch (e) {}
    }
  }
  t.teachTabId = null;
  t.teachTabIds = [];
  t.teachEvents = [];
}

// 停止当前回合（不结束对话，可继续下一条指令）
async function stopCurrent(sid) {
  const t = getTask(sid);
  if (!t) return;
  clearAlarm();
  if (t.state === 'working' || t.state === 'awaiting_nav' || t.state === 'waiting_user') {
    const myTurn = t.turnId; // 钉住被停止回合的号，供停止后复盘判定是否被打断
    await stopTeachRecording(t); // 教我模式停止时一并停止录制
    t.state = 'idle';
    t.waitTabId = null;
    t.askText = null;
    t.turnSteps = 0;
    await saveTasks();
    addLog(t.sid, '已停止当前操作，可继续对话');
    broadcast({ type: 'AGENT_STATUS', status: 'idle' }, t.sid);
    // 停止后仍做复盘：本轮实际访问过的网站 / 走过的弯路，照常沉淀成书签与操作技巧。
    // 后台执行不阻塞停止按钮的响应；期间若来了新指令（turnId 变化）复盘自动退出。
    reviewAfterStop(t, myTurn);
  }
}

// 停止后的复盘：任务已回 idle，用 force 让复盘在后台照常执行（LLM 判断本轮访问的网站是否有用、操作是否有困难）。
async function reviewAfterStop(t, myTurn) {
  try { await reviewAndBookmark(t, true, myTurn); } catch (e) { /* 复盘失败不影响停止 */ }
  try { await reviewAndLearnTips(t, true, myTurn); } catch (e) { /* 技巧沉淀失败不影响停止 */ }
}

// 事件是否录自 iframe 子窗口（frameId 非 0 或缺失时视为主窗口）
const inIframe = (e) => !!(e && e.frameId != null && e.frameId !== 0);

// 把录制的教学事件拼成给 LLM 看的步骤列表（含输入值，供本轮复现操作）
function formatTeachSteps(events) {
  if (!events || !events.length) return '（未记录到任何操作）';
  const lines = events.map((e, i) => {
    const no = (i + 1) + '. ';
    const frameNote = inIframe(e) ? '（该步骤在页面内嵌子窗口 iframe 里，复现时点击快照里对应子窗口的元素）' : '';
    switch (e.t) {
      case 'click': return no + '点击「' + (e.label || '元素') + '」' + frameNote + (e.href ? '（链接：' + e.href + '）' : '');
      case 'hover': return no + '悬浮「' + (e.label || '元素') + '」以显示操作项' + frameNote;
      case 'type': return no + '在「' + (e.label || '输入框') + '」输入：' + (e.value != null && e.value !== '' ? e.value : '（留空）') + frameNote;
      case 'select': return no + '选择「' + (e.label || '下拉框') + '」为：' + (e.text || e.value || '（留空）') + frameNote;
      case 'submit': return no + '在「' + (e.label || '输入框') + '」按回车提交' + frameNote;
      default: return no + '执行 ' + e.t + '「' + (e.label || '') + '」';
    }
  });
  return lines.join('\n');
}

// 脱敏配方：教学步骤去掉输入的具体值（不把密码/账号存进技巧库），只保留动作+控件名，供同站未来复用
function buildTeachRecipe(events) {
  if (!events || !events.length) return '';
  const nums = '①②③④⑤⑥⑦⑧⑨⑩';
  const lines = events.map((e, i) => {
    const no = nums.charAt(i) || (i + 1);
    const frameNote = inIframe(e) ? '（子窗口内）' : '';
    switch (e.t) {
      case 'click': return no + '点击『' + (e.label || '按钮/链接') + '』' + frameNote;
      case 'hover': return no + '悬浮『' + (e.label || '元素') + '』' + frameNote;
      case 'type': return no + '在『' + (e.label || '输入框') + '』输入' + frameNote;
      case 'select': return no + '在『' + (e.label || '下拉框') + '』选择' + frameNote;
      case 'submit': return no + '按回车提交' + frameNote;
      default: return no + '执行' + (e.label || '');
    }
  });
  return '该站操作流程：' + lines.join('；');
}

// 使用者手动操作完成，继续当前回合（page / teach 两种模式）。
// confirmedText：confirm 模式下使用者在对话里输入确认的话（有则带进上下文，避免与按钮占位重复）
async function resumeAfterUser(sid, confirmedText) {
  const t = getTask(sid);
  if (!t || t.state !== 'waiting_user') return;
  if (t.waitingReply) return; // 对话回复模式没有"继续"按钮，回复直接走 processUserMessage

  // ---- 教我模式：使用者演示完成 → 停止录制、沉淀技巧、把步骤注入上下文让 Agent 学习 ----
  if (t.askMode === 'teach') {
    const teachTabId = t.teachTabId;
    const teachTabIds = (t.teachTabIds || []).slice(); // 快照，下面会清
    let events = (t.teachEvents || []).slice();
    console.log('[Teach] resumeAfterUser：TEACH_STOP 前已累积 events=' + events.length + ' 条，监听 tab=[' + teachTabIds.join(',') + ']');
    // 对【所有】教学 tab 的【所有窗口】（主窗口 + iframe 子窗口）逐个发 TEACH_STOP，
    // 各自带回缓冲里的最后几步（800ms 定时器没到期的），合并避免丢步——iframe 内录制的步骤也一并收回
    for (const id of teachTabIds) {
      const frames = await frameList(id);
      for (const f of frames) {
        try {
          const resp = await chrome.tabs.sendMessage(id, { type: 'TEACH_STOP' }, { frameId: f.frameId }).catch(() => ({}));
          const extra = resp && Array.isArray(resp.events) ? resp.events : [];
          console.log('[Teach] TEACH_STOP tab=' + id + ' frame=' + f.frameId + ' 响应带回 extra=' + extra.length + ' 条 [' + extra.map((e) => e.t).join(',') + ']');
          if (extra.length) {
            // 尾部缓冲事件没走 TEACH_EVENT 上报，补来源 host（收尾按网站分组沉淀技巧）
            const tb = await getTab(id);
            const h = hostOf((tb && tb.url) || '');
            for (const e of extra) { e.tab = id; e.host = e.host || h; e.frameId = e.frameId || f.frameId; }
            events = events.concat(extra);
          }
        } catch (e) { console.log('[Teach] TEACH_STOP 发送失败 tab=' + id + ' frame=' + f.frameId + ' → ' + e.message); }
      }
    }
    console.log('[Teach] 合并后本轮教学步骤共 ' + events.length + ' 条：' + events.map((e) => e.t + (e.label ? '(' + e.label + ')' : '')).join(' → '));
    t.teachTabId = null;
    t.teachTabIds = [];
    // 步骤先留在 teachEvents 上，等使用者确认 Agent 的复述后再沉淀成技巧（见 resumeAfterUser 的 confirm 分支）；
    // 确认循环中途若被打断/放弃，会在对应分支清掉，避免存了未经确认、可能理解错误的流程。
    t.teachEvents = events;
    t.askMode = null;
    t.askText = null;
    t.state = 'working';
    t.turnSteps = 0;
    t.failStreak = 0;
    t.waitTabId = null;
    t.lastActiveAt = Date.now();

    // 注入演示步骤：先 say 复述 → 再 ask_user 等使用者确认 → 确认后按演示继续
    let url = '';
    try { const tb = await getTab(teachTabId); url = tb ? (tb.url || '') : ''; } catch (e) {}
    const stepText = formatTeachSteps(events);
    const msg = '使用者手把手演示了以下操作（页面：' + shortUrl(url) + '）：\n' + stepText +
      '\n\n请先用 say 动作向使用者复述一遍你学到的操作步骤（讲清楚你理解了什么），再用 ask_user（mode=confirm）请使用者确认，他会直接点「没问题」按钮确认。' +
      '如果他在对话里回复了纠正或问题，你要重新理解他的纠正、修正你对步骤的理解，再用 say 复述修正后的步骤、用 ask_user（mode=confirm）再次请他确认——确认循环会一直持续，直到他明确说「没问题/确认」放行，或说「不教了/算了」「你先去做吧/你自己来」终止教学（终止后按你当前理解的自行继续完成原始目标）。不要未经再次确认就擅自继续执行。' +
      '确认后严格按照这些步骤继续完成原始目标；若当前页面状态与演示时不同（如已登录、元素变化），请灵活适配、按演示的意图完成，必要时先观察快照确认元素再操作。' +
      '若使用者只确认步骤、没有给新指令，就按演示把该操作流程实际走完并 finish 汇报。';
    t.history.push({ role: 'user', content: msg });
    t.conversation.push({ role: 'user', text: '（我已演示完，请按我教的继续）', t: Date.now() });
    if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
    await saveTasks();
    addLog(t.sid, '教我模式：已记录 ' + events.length + ' 步操作，交给 Agent 学习');
    broadcast({ type: 'AGENT_STATUS', status: 'working' }, t.sid);
    setupAlarm();
    agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
    return;
  }

  // ---- 普通页面操作模式 / 复述确认（confirm） ----
  const isConfirm = t.askMode === 'confirm';

  // 复述确认通过后才沉淀技巧：教的动作流程经使用者确认无误，才写入该站操作技巧库。
  // （不再"录完就存"——未确认/可能理解错误的流程不该落库）
  if (isConfirm && t.teachEvents && t.teachEvents.length) {
    try {
      const byHost = {};
      for (const e of t.teachEvents) {
        const h = e.host || '';
        if (h) (byHost[h] = byHost[h] || []).push(e);
      }
      for (const host of Object.keys(byHost)) {
        const recipe = buildTeachRecipe(byHost[host]);
        if (!recipe) continue;
        const store = await getTipStore();
        const old = (store[host] || []).join('\n');
        const merged = await mergeSiteTips(host, [recipe], old, t.sid);
        if (merged && merged.length) {
          await saveSiteTips(host, merged);
          addLog(t.sid, '教我模式：使用者确认后，已把该站操作流程沉淀为技巧（' + host + '）');
        }
      }
    } catch (e) { addLog(t.sid, '教我模式：技巧沉淀失败 → ' + e.message, true); }
    t.teachEvents = [];
  }

  t.askMode = null;
  t.state = 'working';
  t.turnSteps = 0;
  t.failStreak = 0;
  t.askText = null;
  t.waitTabId = null;
  t.lastActiveAt = Date.now();
  t.history.push({ role: 'user', content: isConfirm ? (confirmedText ? '使用者确认了复述的步骤无误（他说：' + confirmedText + '），请按演示继续完成原始目标' : '使用者确认了复述的步骤无误，请按演示继续完成原始目标') : '使用者已完成手动操作，请继续' });
  t.conversation.push({ role: 'user', text: isConfirm ? (confirmedText || '（没问题，按我教的继续）') : '（已完成手动操作，请继续）', t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  await saveTasks();
  addLog(t.sid, isConfirm ? '使用者确认复述无误，继续执行' : '使用者确认完成手动操作，继续执行');
  broadcast({ type: 'AGENT_STATUS', status: 'working' }, t.sid);
  setupAlarm();
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// 清空本会话：关闭该会话自开的 Agent 标签并清空对话记录（会话保留；新建走顶部会话栏 ＋）
async function clearConversation(sid) {
  const t = getTask(sid);
  if (!t) return;
  clearAlarm();
  await stopTeachRecording(t); // 清空时停止教我模式的录制
  await closeAgentTabs(t).catch(() => {}); // 关 Agent 自开 @T 标签并删分组（使用者的 @MAIN/@U 永不关闭）
  t.turnId++; // 使旧回合的任何在途异步链自行退出
  t.state = 'idle';
  t.waitTabId = null;
  t.goal = '';
  t.lastInstruction = '';
  t.steps = 0;
  t.turnSteps = 0;
  t.failStreak = 0;
  t.stuck = 0;
  t.consecWaits = 0;
  t.lastActSig = '';
  t.askText = null;
  t.askMode = 'page';
  t.waitingReply = false;
  t.teachTabId = null;
  t.teachTabIds = [];
  t.teachEvents = [];
  t.llmLogs = []; // 清空本会话：大模型往返日志一并清零
  t.history = [{ role: 'system', content: systemPrompt() }];
  t.ctxSummary = null;
  t.ctxBoundary = 0;
  t.tokens = 0; // 清空本会话 = 重新开始，token 用量一并清零
  t.turnHistoryStart = 0;
  t.conversation = [];
  t.result = null;
  t.error = null;
  t.navWaitIdx = null;
  t.lastActiveAt = Date.now();
  await saveTasks();
  updateBadge(); // 角标随之刷新
  broadcast({ type: 'AGENT_CLEARED' }, t.sid);
  broadcastTabs(t);
}

// ---------------- 注入与消息 ----------------
// 教我模式中，教学标签在演示时导航到新页 / worker 恢复后：重发 TEACH_START 重挂事件录制。
// 监听对象是【任务下所有 tab】：任何任务标签导航/恢复时都重挂，并把新挂载的 tab 补进 teachTabIds
async function rearmTeachRecording(tabId, frameId) {
  const sid = sessionOfTab(tabId); // 按标签路由到所属会话
  if (!sid) return;
  const t = getTask(sid);
  if (!(t && t.state === 'waiting_user' && t.askMode === 'teach')) return;
  const isTaskTab = !!(t.tabs || []).some((e) => e.tabId === tabId);
  const isTeachTab = (t.teachTabIds || []).includes(tabId) || t.teachTabId === tabId;
  if (!isTaskTab && !isTeachTab) {
    // 教学期间使用者演示中【新开/导航到】一个此前未知的标签（如点了"新建"打开的新页面）：
    // 使用者只演示不指挥，把新页纳入任务（@U）并挂上录制，跨页演示的后续操作才不漏。
    // 受限页（chrome:// 等）由 adoptTeachTab 自行忽略；已挂录制的标签重复触发会走上面的重挂分支。
    console.log('[Teach] 教学演示新开标签 → 纳入任务并挂录制 tab=' + tabId);
    await adoptTeachTab(tabId, t);
    return;
  }
  // frameId 指定（子窗口就绪，可能是 JS 动态新开的 iframe）：只给该窗口挂录制，
  // 避免全 tab 重发 TEACH_START 重置其它窗口的录制缓冲（teachStart 对已开录的会清缓冲）。
  if (frameId) {
    console.log('[Teach] 子窗口就绪 → 单独挂录制 tab=' + tabId + ' frame=' + frameId);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TEACH_START' }, { frameId }).catch(() => {});
    } catch (e) { console.log('[Teach] 子窗口挂录制失败 frame=' + frameId + ' → ' + e.message); }
    return;
  }
  console.log('[Teach] 导航/恢复 → 重挂 TEACH_START tab=' + tabId);
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'TEACH_START' }).catch(() => {});
    if (!(t.teachTabIds || []).includes(tabId)) {
      (t.teachTabIds = t.teachTabIds || []).push(tabId);
      await saveTasks();
    }
  } catch (e) { console.log('[Teach] 重挂失败 → ' + e.message); }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  }
}

function serializeSession(t) {
  if (!t) return null;
  return {
    id: t.id,
    sid: t.sid,
    n: t.n,
    groupTitle: t.groupTitle,
    tabId: t.mainTabId,
    goal: t.goal,
    lastInstruction: t.lastInstruction || null,
    state: t.state,
    steps: t.steps,
    turnId: t.turnId,
    turnSteps: t.turnSteps,
    failStreak: t.failStreak,
    stuck: t.stuck || 0,
    currentRef: t.currentRef,
    groupId: t.groupId,
    tabs: (t.tabs || []).map((e) => ({ ref: e.ref, role: e.role, title: e.title, url: e.url })),
    conversation: t.conversation,
    ctxSummary: t.ctxSummary || null,
    ctxBoundary: t.ctxBoundary || 0,
    askText: t.askText,
    askMode: t.askMode || 'page',
    waitingReply: !!t.waitingReply,
    teachTabId: t.teachTabId || null,
    teachTabIds: t.teachTabIds || [],
    teachEvents: t.teachEvents || [],
    llmLogs: t.llmLogs || [], // 大模型往返日志（面板"日志"视图，切走/重开面板不丢）
    navWaitIdx: t.navWaitIdx || null,
    result: t.result,
    error: t.error,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    tokens: t.tokens || 0
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 异步响应
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'PING':
      return { pong: true };
    case 'GET_CONFIG':
      return { config: await getConfig() };
    case 'SAVE_CONFIG':
      await saveConfig(msg.config || {});
      return { ok: true };
    case 'GET_STATE':
      await loadTasks();
      const sessions = Object.keys(tasks)
        .map((sid) => serializeSession(tasks[sid]))
        .sort((a, b) => a.n - b.n);
      return { activeId, sessions, config: await getConfig() };
    case 'CREATE_SESSION': { // 顶部会话栏 ＋：新建一个空闲会话
      const t = await createSession();
      if (!t) return { ok: false, error: '最多 ' + MAX_SESSIONS + ' 个会话' };
      return { ok: true, sid: t.sid, n: t.n };
    }
    case 'DELETE_SESSION': { // 会话栏 ×：删会话（面板已确认），关其 @T 并释放编号
      const sid = msg.sid;
      const t = getTask(sid);
      if (!t) return { ok: true, activeId };
      if (t.state === 'working' || t.state === 'awaiting_nav' || t.state === 'waiting_user') {
        await stopCurrent(sid); // 非空闲会话先停掉当前回合
      }
      await stopTeachRecording(t);
      await closeAgentTabs(t).catch(() => {}); // 关 Agent 自开标签并删分组（使用者的标签永不关闭）
      delete tasks[sid];
      if (activeId === sid) {
        const rest = Object.keys(tasks).map((k) => tasks[k]).sort((a, b) => b.n - a.n); // 切到剩余编号最大的
        activeId = rest.length ? rest[0].sid : null;
      }
      await saveTasks();
      clearAlarm();
      return { ok: true, activeId };
    }
    case 'SET_ACTIVE':
      setActive(msg.sid);
      return { ok: true };
    case 'VIEW_TAB': { // 求助卡「查看」：把浏览器聚焦到该会话当前操作页面的标签上
      const t = getTask(msg.sid);
      if (!t) return { ok: false };
      const tabId = await resolveCurrentTabId(t);
      if (!tabId) return { ok: false, error: '当前没有可查看的标签' };
      const tab = await getTab(tabId);
      if (!tab) return { ok: false };
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { ok: true };
    }
    case 'SEND':
      // 新指令：首条会创建会话并把 @MAIN 钉到当前标签，后续延续同一会话
      await processUserMessage(msg.sid, msg.text, msg.tabId);
      return { ok: true };
    case 'START': // 兼容：等同 SEND
      if (!msg.tabId) throw new Error('缺少标签页');
      await processUserMessage(msg.sid, msg.goal || msg.text, msg.tabId);
      return { ok: true };
    case 'STOP':
      await stopCurrent(msg.sid);
      return { ok: true };
    case 'RESUME': // 使用者手动操作完成，继续当前回合
      await resumeAfterUser(msg.sid);
      return { ok: true };
    case 'CLEAR':
      await clearConversation(msg.sid);
      return { ok: true };
    case 'GET_TIPS': // 面板技巧管理：读取全部站点操作技巧 { [host]: string[] }
      return { tips: await getTipStore() };
    case 'SAVE_TIPS': { // 面板技巧管理：保存某站点整份技巧（空数组=删除该站点）
      const h = hostOf(msg.domain);
      if (!h) throw new Error('无效域名');
      const store = await getTipStore();
      if (Array.isArray(msg.tips) && msg.tips.length) {
        store[h] = msg.tips.map((s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean);
      } else {
        delete store[h];
      }
      await chrome.storage.local.set({ [TIPS_KEY]: store });
      return { ok: true };
    }
    case 'DIAG_SNAPSHOT': { // 面板诊断：提取当前标签页合并快照（agent 同款 readSnapshotWithFrames 管线），面板复制到剪贴板
      let tabId = msg.tabId;
      if (tabId == null) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tab && tab.id;
      }
      if (tabId == null) throw new Error('未找到当前标签页');
      const tab = await getTab(tabId);
      if (tab && isRestrictedUrl(tab.url)) {
        return { ok: true, snapshot: { url: tab.url, title: tab.title || '', elements: [], excerpt: '', frames: [{ frameId: 0, index: 0, url: tab.url, title: tab.title || '' }], restricted: true } };
      }
      await ensureContentScript(tabId);
      const snapshot = await readSnapshotWithFrames(tabId);
      return { ok: true, snapshot };
    }
    case 'TEACH_EVENT': { // 教我模式：content 批量上报录制的用户操作
      const src = sender && sender.tab ? sender.tab.id : null;
      const evts = Array.isArray(msg.events) ? msg.events : [];
      // 按上报标签定位会话：正常应落在教学会话；兜底退回唯一教学会话
      const tt = getTask(sessionOfTab(src)) || getTask(findTeachSid());
      if (!tt) return { ok: true };
      const teachIds = (tt.teachTabIds) || [];
      const matched = !!(tt.askMode === 'teach' && (src != null && (teachIds.includes(src) || tt.teachTabId === src)));
      console.log('[Teach] 收到 TEACH_EVENT tab=' + src + ' 条数=' + evts.length + ' 匹配教学会话=' + matched + ' 类型=[' + evts.map((e) => e.t).join(',') + ']');
      if (matched && evts.length) {
        tt.teachEvents = tt.teachEvents || [];
        // 给每条事件补上来源 tab / host / frame（收尾按网站分组沉淀技巧用；frameId 标记 iframe 内步骤，复现时按窗口定位）
        const srcHost = hostOf(sender && sender.tab ? (sender.tab.url || '') : '');
        const srcFrame = (sender && sender.frameId) || 0;
        for (const e of evts) { e.tab = src; e.host = srcHost || e.host || ''; e.frameId = e.frameId || srcFrame; }
        tt.teachEvents.push(...evts);
        console.log('[Teach] 累计 teachEvents=' + tt.teachEvents.length);
        await saveTasks();
        broadcast({ type: 'AGENT_TEACH_STEPS', count: tt.teachEvents.length }, tt.sid); // 面板实时步数
      }
      return { ok: true };
    }
    case 'AGENT_DEBUG': { // content script 回报的调试日志
      const tt = getTask(sessionOfTab(sender && sender.tab ? sender.tab.id : null)) || activeTask();
      if (tt) addLog(tt.sid, '[页面] ' + String(msg.text || ''), true);
      return { ok: true };
    }
    case 'AGENT_READY': // 顶层 frame content script 注入完成（可能是 navigate 后的新页面或新开的后台标签）
      if (sender && sender.tab) {
        console.log('[PageAgent] AGENT_READY tab=' + sender.tab.id + ' ' + (sender.tab.url || ''));
        const tt = getTask(sessionOfTab(sender.tab.id));
        if (tt) {
          refreshTabEntry(sender.tab.id, sender.tab, tt);
          tryResume(tt.sid, sender.tab.id);
        }
        rearmTeachRecording(sender.tab.id); // 教我模式中用户演示时导航到新页：重挂录制
      }
      return { ok: true };
    case 'FRAME_READY': // 子窗口就绪（可能是 JS 动态新开的 iframe）：教学录制中则单独给该窗口挂上录制
      if (sender && sender.tab) {
        console.log('[PageAgent] FRAME_READY tab=' + sender.tab.id + ' frame=' + (sender.frameId || 0) + ' ' + (sender.tab.url || ''));
        rearmTeachRecording(sender.tab.id, sender.frameId || 0);
      }
      return { ok: true };
    default:
      return { ok: false, error: '未知消息类型 ' + msg.type };
  }
}

// 页面加载完成事件（AGENT_READY 消息的兜底）；只影响所属会话，其他会话不受影响
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    const sid = sessionOfTab(tabId);
    const tt = getTask(sid);
    const isWait = !!(tt && tt.state === 'awaiting_nav' && tt.waitTabId === tabId);
    if (isWait) console.log('[PageAgent] onUpdated complete tab=' + tabId + '（正是等待中的标签，触发恢复）');
    if (tt) refreshTabEntry(tabId, null, tt);
    if (sid) tryResume(sid, tabId);
    rearmTeachRecording(tabId); // 教我模式中演示导航到新页：重挂录制
  }
});

// 标签被使用者或系统关闭时，只移除所属会话的记录（"开页面关页面互不影响"）
chrome.tabs.onRemoved.addListener((tabId) => {
  const sid = sessionOfTab(tabId);
  if (!sid) return;
  const t = getTask(sid);
  const e = (t.tabs || []).find((x) => x.tabId === tabId);
  if (!e) return;
  t.tabs = t.tabs.filter((x) => x.tabId !== tabId);
  if (t.currentRef === e.ref) {
    const main = t.tabs.find((x) => x.role === 'main');
    t.currentRef = main ? main.ref : ((t.tabs[0] || {}).ref || null);
  }
  // 若正等待该标签加载，则立即恢复循环，避免干等到超时
  if (t.state === 'awaiting_nav' && t.waitTabId === tabId) {
    t.state = 'working';
    t.waitTabId = null;
    saveTasks().then(() => pushFailure(t, '等待中的标签已被关闭：' + e.ref));
  } else {
    saveTasks();
  }
});

// 安装时：点击工具栏图标直接打开侧边栏
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {}
});
