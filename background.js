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
 *     - @T1/@T2 = Agent 自开的标签（后台模式用 tabs.create({active:false}) 不抢焦点；
 *       前台模式切到浏览器前台），自动归入同一个 tab group 统一管理。
 *     - switch_tab 切换 Agent 的关注焦点；后台模式不切浏览器前台，前台模式把操作标签切到前台。
 *     - 执行模式由设置 config.backgroundExec 控制（false=前台执行默认，true=后台执行）。
 *  6. 向侧边栏面板广播聊天消息 / 活动日志 / 状态。
 */
'use strict';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash'; // DeepSeek V4 Flash（deepseek-chat/reasoner 旧别名已退役）
const DEFAULT_TEMPERATURE = 0.2;
const TEST_MODEL_TIMEOUT_MS = 10000; // 设置里拉取 /models 模型列表的超时：比正常 LLM 短，快速反馈
const DEFAULT_MAX_STEPS = 25;
const NAV_TIMEOUT_MS = 120000;   // 页面加载/跳转等待上限
const MAX_AGENT_TABS = 20;       // Agent 自开标签上限，防止失控
const HEARTBEAT_ALARM = 'pageagent-heartbeat';
const MAX_STEP_LLM_RETRY = 4;    // 单步 LLM 输出解析失败的最大重试次数
const MAX_SESSIONS = 5;          // 最多并发会话数（顶部会话栏可新建/切换）
const MAX_CONVERSATION = 200;    // 对话记录最多保留条数
const MAX_HISTORY = 800;         // LLM 消息历史上限（超出后裁剪保留尾部）
const DEFAULT_CONTEXT_WINDOW = 1000000; // DeepSeek V4 上下文窗口（token），设置里可调
const OUTPUT_RESERVE = 8192;          // 每次调用给 LLM 输出预留的 token
const COMPRESS_THRESHOLD = 0.7;       // 上下文使用到 70% 触发历史压缩
const TAIL_KEEP_STEPS = 2;            // 压缩时保留最近几步原文（快照+动作+结果）
const MAX_SNAPSHOT_KEEP = 3;          // 每次请求最多发给 LLM 的页面快照数（旧快照元素已过期，只留最近几次）
const MAX_BATCH = 100;                // 单批动作数硬上限（LLM 按动作颗粒度自行决定批量多少，最多此值）
const BATCH_FAMILIAR_THRESHOLD = 2;   // 同一页面成功快照 ≥ 此值 → 判定"熟悉"，允许批量输出
const BATCH_TERMINALS = new Set(['snapshot', 'finish', 'ask_user']); // 遇此类动作本批收尾（snapshot 会切换元素观察窗口，翻页后需重新观察；finish/ask_user 结束或转人工）。跨页/切页动作（open_tab/search/navigate/switch_tab/use_tab/close_tab）不再终止批：批内可连续跨页，页面就绪由 runActionBatch 在真正读/点的动作前自动保障。
const BATCH_NAV_READY_MS = 10000; // 批内跨页保障：真正读/点的动作前，等当前操作标签页面就绪的上限；超过按超时放行（动作失败走原有自愈）。单动作模式 NAV_TIMEOUT_MS=120s 不受影响
const LLM_TIMEOUT_MS = 240000; // LLM 单次请求超时：网络/服务端挂起时不再无限等（超时按解析失败重试），避免循环整体干等
const SUMMARY_CHUNK_TOKENS = 150000;  // 摘要单次输入的 token 上限（超出分块链式合并）
const SUMMARY_MAX_CHARS = 1500;       // 压缩摘要长度上限（字符）
const RESULT_KEEP_ROUNDS = 5;         // 工具结果全量保留的回合数（最近 N 个 model 回合 = 最近 N 条 assistant 决策及其结果）；更早的结果在发送时降级为短空壳，避免大结果长期占上下文
const RESULT_STUB_CHARS = 120;        // 旧回合工具结果空壳保留的开头字符数（足够让模型知道"这个动作返回过、ok/失败"，全量已省略）
const RESULT_MAX_STORE = 30000;       // 单条工具结果写历史的字符软上限：不再做"一律 3000"的硬截断（那会连最近结果都读不全），只防极端超大的结果把存储/序列化撑爆（覆盖 pageInfo html 20000 等源头上限 + 冗余）

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
  // 长对话防膨胀：每会话保留 system + 最近 750 条
  for (const sid of Object.keys(tasks)) {
    const t = tasks[sid];
    if (t.history && t.history.length > MAX_HISTORY) {
      t.history = [t.history[0]].concat(t.history.slice(-(MAX_HISTORY - 50)));
      if (t.ctxBoundary != null) t.ctxBoundary = Math.min(t.ctxBoundary, t.history.length);
    }
    if (t.llmLogs) delete t.llmLogs; // 迁移：日志已独立存 LLM_LOGS_KEY，旧会话对象里的残留字段不再写回 storage
  }
  await chrome.storage.session.set({ tasks });
  updateBadge(); // 所有状态变更都经 saveTasks，角标随之刷新
}

// 新建一个空会话（idle）。tabId 可选：给定时直接把 @MAIN 钉到该标签。返回会话对象；满 5 个返回 null
async function createSession(tabId) {
  const n = nextNumber();
  if (n == null) return null;
  const sysCfg = await getConfig(); // 系统提示词按当前执行模式（前台/后台）措辞
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
    // 大模型往返日志不在会话对象里：独立存 LLM_LOGS_KEY（见 logLLMExchange），避免每次 saveTasks 全量重写大日志
    history: [{ role: 'system', content: systemPrompt(sysCfg.backgroundExec) }],
    ctxSummary: null,   // 历史压缩摘要（已完成进展 / 踩过的坑 / 用户注意点）
    ctxBoundary: 0,     // 历史下标：该下标之前的消息已并入 ctxSummary，之后逐条发送
    conversation: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    awaitingNavAt: 0,
    navWaitIdx: null, // "打开页面"行已显示标记（navigate/awaitNav 置位），就绪后把用时合并进该行
    navWaitUrl: null, // navigate 的截断地址（awaitNav 为 null），合并时决定行文
    plan: [],         // 当前任务步骤计划（模型每轮输出的 steps 拆解 [{text,done}]），面板状态栏下方悬浮展示
    activities: [],   // 最近动作轨迹 [{text,inBatch,t}]（上限 ACTIVITY_PERSIST）：面板重载后恢复动作日志用，非实时展示载体；t 时间戳供面板与对话记录按时间交错恢复
    lastActiveAt: Date.now(),
    consecWaits: 0,   // 连续 wait 次数（无真实动作插入时累计，防"假装人类"空转）
    lastActSig: '',   // 最近一次执行（成功或失败）的页面动作签名，识别"反复执行同一个动作"的无进展循环
    stuck: 0,         // 无进展计数：连续失败/重复同一动作/空等累计，换新动作清零，>=STUCK_TEACH_LIMIT 转教我
    lastExpHost: '',  // 本会话已显示"加载该网站的经验 x 条"的站点（同一站点只提示一次，避免刷屏）
    pageSnapCounts: {}, // 页面熟悉度：pageKey(host+pathname) → 成功快照次数；动作失败会清零该页计数（恢复谨慎模式）
    snapOffset: 0,      // 元素窗口翻页偏移（每批 REF_WINDOW_SIZE 个）；snapshot 动作改写，URL 变化自动回第一批
    snapOffsetUrl: '',  // snapOffset 所属页面 URL：换页/导航/切标签后 offset 失效重置为 0
    readList: [],       // 已读清单："读 N 条"循环里实际点开读过的条目 {ref,title,pageKey,content}；快照标【已读】、重复点"已有正文记录"的同一条被拦截；正文随详情页快照采集（独立于历史，压缩后总结仍保真）。每回合重置，上限 300 条
    listTabsFresh: false, // use_tab 前置闸门：最近一次 list_tabs 之后标签集是否没变过（开/关/淘汰/纳入都会置 false）。use_tab 前必须先 list_tabs 拿最新 tabId，防模型用旧列表里的死 tabId 反复失败
    timer: null, // 任务计时器：{ running, startAt, acc }；从任务发出开始计时、等你操作时暂停、finish 答案落定时停止（复盘不算）
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
      batchEnabled: true, // 批量动作总开关：允许在熟悉页面一次执行多个动作（false=每步读页、一次一个动作，稳妥但慢）
      batchMark: false, // 调试：活动日志标出批量边界（"批 N 步"/批内每步"批1/4"前缀/批完·失败收尾），验证批量策略时打开，日常可关
      backgroundExec: false, // 执行模式：false=前台执行（默认，Agent 打开/切换操作标签时切到浏览器前台，实时可见）；true=后台执行（不切前台、不抢焦点，不打扰当前浏览）
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
function addLog(sid, m, quiet, forceInBatch) {
  console.log('[PageAgent]', m); // 始终进 SW console（chrome://extensions → Service Worker → DevTools Console）
  // forceInBatch 显式覆盖（如 askUser 的人工协助请求：虽在批内触发，但不是批内连续动作，不标批量灰底）
  const inBatch = forceInBatch !== undefined ? forceInBatch : !!getTask(sid)?._inBatch;
  if (!quiet) {
    broadcast({ type: 'AGENT_ACTIVITY', text: String(m), inBatch }, sid);
    // 面板重载后恢复最近动作轨迹：后台按任务挂环形缓冲（上限 ACTIVITY_PERSIST），随会话序列化下发
    const tk = getTask(sid);
    if (tk) {
      tk.activities = tk.activities || [];
      tk.activities.push({ text: String(m), inBatch, t: Date.now() });
      if (tk.activities.length > ACTIVITY_PERSIST) tk.activities.splice(0, tk.activities.length - ACTIVITY_PERSIST);
    }
  }
}

// 改写面板最后一行动作行（如把"打开页面…"补上就绪时间）；同步改写后台缓冲末条，重载后一致
function updateLog(sid, idx, m) {
  broadcast({ type: 'AGENT_ACTIVITY_UPDATE', text: String(m), inBatch: !!getTask(sid)?._inBatch }, sid);
  const tk = getTask(sid);
  if (tk && tk.activities && tk.activities.length) {
    tk.activities[tk.activities.length - 1].text = String(m);
    tk.activities[tk.activities.length - 1].inBatch = !!tk._inBatch;
  }
}

// ---------------- 大模型往返日志（面板「日志」按钮 → 导出全量文件用） ----------------
// 每步 LLM 决策记录一条：给大模型发了什么【从简】（消息条数 + 输入量 + 当前页面）、返回了什么【全量原文】。
// 日志为排查"任务为什么执行乱"设计，要全量——所以单独存 LLM_LOGS_KEY，不进 tasks 对象：
//  1) 不随每次 saveTasks 全量重写（tasks 对象里 history/快照本来就大，再加全量 res 会把每次存储写放大）；
//  2) 只留"字节预算"兜底防 storage.session 10MB 配额爆（tasks + 日志合计逼近才丢最早，正常会话几乎不触发）。
// EXPORT_LOG 导出时读取；不再实时广播，面板不做展示。
const LLM_LOGS_KEY = 'llmLogs';           // 独立存储 key
const LLM_LOG_MAX_PER_SESSION = 3000;     // 单会话日志条数兜底（正常会话远用不满；纯防御异常大响应无限膨胀）
const STORAGE_SAFE_TOTAL = 8.5 * 1024 * 1024; // 全存储（tasks 历史 + 日志）字节上限：10MB 配额留 1.5MB 余量，逼近才丢最早日志
const ACTIVITY_PERSIST = 60;              // 每任务保留最近动作轨迹条数（与面板活动行显示上限一致；面板重载后从后台恢复用）

let llmLogStore = null;      // sid -> [entry]
let llmLogStoreLoaded = null; // 惰性加载 promise（首次用到日志时从 storage.session 读一次）
let llmLogFlushTimer = null;

// 惰性加载日志库：worker 每次冷启动重新求值时首次用到前读一次即可，之后纯内存操作
async function ensureLlmLogs() {
  if (!llmLogStoreLoaded) {
    llmLogStoreLoaded = (async () => {
      const m = new Map();
      try {
        const { [LLM_LOGS_KEY]: saved } = await chrome.storage.session.get(LLM_LOGS_KEY);
        if (saved && typeof saved === 'object') {
          for (const [k, v] of Object.entries(saved)) if (Array.isArray(v)) m.set(k, v);
        }
      } catch (e) {}
      llmLogStore = m;
    })();
  }
  await llmLogStoreLoaded;
}

// 防抖落盘：日志只在写入后 ~400ms 合并写一次，不随每次 saveTasks 全量重写
function scheduleLlmLogFlush() {
  if (llmLogFlushTimer) return;
  llmLogFlushTimer = setTimeout(() => { llmLogFlushTimer = null; flushLlmLogs(); }, 400);
}

async function flushLlmLogs() {
  try {
    if (!llmLogStore || !llmLogStore.size) return;
    // 字节兜底：tasks（历史/对话）+ 日志 合计逼近 10MB 配额才丢最早的日志（按时间跨会话丢，保住最新）。
    // 正常会话远达不到，几乎不触发；触发时丢的是最老日志，排查"最新问题"不受影响。
    const logsBytes = JSON.stringify([...llmLogStore.values()]).length;
    let tasksBytes = 0;
    try { tasksBytes = JSON.stringify(tasks).length; } catch (e) {}
    if (logsBytes + tasksBytes > STORAGE_SAFE_TOTAL) {
      const over = logsBytes + tasksBytes - STORAGE_SAFE_TOTAL; // 需从日志里释放的字节
      const all = [];
      for (const [sid, arr] of llmLogStore) for (let i = 0; i < arr.length; i++) all.push({ sid, i, t: arr[i].t });
      all.sort((a, b) => a.t - b.t);
      const drop = Math.min(all.length - 10, Math.ceil(all.length * over / logsBytes));
      const dead = new Set();
      for (let i = 0; i < drop; i++) dead.add(all[i].sid + ':' + all[i].i);
      for (const [sid, arr] of llmLogStore) {
        const kept = arr.filter((_, i) => !dead.has(sid + ':' + i));
        if (kept.length) llmLogStore.set(sid, kept); else llmLogStore.delete(sid);
      }
    }
    await chrome.storage.session.set({ [LLM_LOGS_KEY]: Object.fromEntries(llmLogStore) });
  } catch (e) { /* 日志落盘失败不影响主流程 */ }
}

function removeLlmLogs(sid) {
  if (!llmLogStore) return;
  llmLogStore.delete(sid);
  flushLlmLogs();
}

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

async function logLLMExchange(t, msgs, raw, label) {
  try {
    if (!t || !t.sid) return;
    await ensureLlmLogs();
    const entry = {
      t: Date.now(),
      req: (label ? label + '｜' : '') + llmReqBrief(t, msgs),
      res: String(raw || '') // 完整原文，不截断（导出文件不受大小限制）
    };
    let arr = llmLogStore.get(t.sid);
    if (!arr) { arr = []; llmLogStore.set(t.sid, arr); }
    arr.push(entry);
    if (arr.length > LLM_LOG_MAX_PER_SESSION) arr.splice(0, arr.length - LLM_LOG_MAX_PER_SESSION);
    scheduleLlmLogFlush();
    console.log('[PageAgent] LLM 往返：' + entry.req);
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// 导出本会话全量日志（面板「日志」按钮 → 下载文件）：排查"任务为什么执行乱"用，内容完整、不截断。
// 五个部分对应：①发给大模型什么（系统提示 + 网站工具索引 + 压缩摘要 + 原始目标/最新指令 + 完整对话历史，
// 历史就是每步请求的消息本体）；②大模型返回什么（每步完整原始返回）；③插件在浏览器里操作了什么（动作序列）；
// ④拿到了什么（动作结果 / 失败原因，与③在操作序列里成对出现）；⑤面板活动轨迹（addLog 可见行：
// 含动作痕迹 + 复盘收藏/经验沉淀的过程与结果——复盘失败这类只闷在 SW console 的行，导出里也要看得见）。
async function exportSessionLog(t) {
  if (!t) return '';
  const L = [];
  const push = (s) => L.push(s);
  const ts = (x) => (x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '-');
  const hist = t.history || [];
  await ensureLlmLogs();
  const logs = (llmLogStore && llmLogStore.get(t.sid)) || [];
  const tabs = t.tabs || [];
  push('==================== PageAgent 会话全量日志 ====================');
  push('会话: ' + (t.n != null ? '会话 ' + t.n : t.sid) + ' · SID: ' + t.sid);
  push('标签组: ' + (t.groupTitle || '-') + (t.groupId ? '（groupId=' + t.groupId + '）' : ''));
  push('创建: ' + ts(t.startedAt) + ' · 状态: ' + t.state);
  push('步数: ' + t.steps + ' · 本回合步数: ' + t.turnSteps + ' · 连续失败: ' + t.failStreak + ' · 卡住计数: ' + (t.stuck || 0));
  push('Token: ' + (t.tokens || 0) + '（缓存命中 ' + (t.cacheHit || 0) + ' / 未命中 ' + (t.cacheMiss || 0) + '）');
  push('目标: ' + (t.goal || '-'));
  push('最新指令: ' + (t.lastInstruction || '-'));
  if (t.result) push('结果: ' + String(t.result));
  if (t.error) push('错误: ' + t.error);
  if (tabs.length) {
    push('标签:');
    for (const e of tabs) push('  @' + e.ref + ' [role=' + e.role + '] ' + (e.title || '') + ' ' + (e.url || ''));
  }
  push('');
  push('==================== ① 发给大模型什么 —— 系统提示 ====================');
  push((hist[0] && hist[0].content) || systemPrompt());
  push('');
  if (bookmarkIndexCache) {
    push('---------------------- 网站工具索引（当前书签） ----------------------');
    push(bookmarkIndexCache);
    push('');
  }
  if (t.ctxSummary) {
    push('---------------------- 已压缩的历史进展 ----------------------');
    push(t.ctxSummary);
    push('');
  }
  push('---------------------- 完整对话历史（共 ' + hist.length + ' 条：页面快照/动作/动作结果/失败原因，即请求消息本体） ----------------------');
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    push('[' + i + '] ' + m.role + (m.kind ? ' | kind=' + m.kind : ''));
    push(String(m.content || ''));
    push('');
  }
  push('==================== ③④ 插件在浏览器里操作了什么 / 拿到了什么 —— 操作序列（动作 → 结果/失败） ====================');
  const seq = [];
  for (const m of hist) {
    const c = String(m.content || '');
    if (m.role === 'assistant') {
      try {
        const a = JSON.parse(c);
        const acts = Array.isArray(a) ? a : [a];
        for (const x of acts) seq.push('动作: ' + JSON.stringify(x));
      } catch (e) { seq.push('动作(解析失败): ' + c.slice(0, 300)); }
    } else if (c.indexOf('动作结果：') === 0) {
      // 结果全量与历史一致（历史写完整结果，模型近 5 回合全量可见）；导出是排查用途，全量更好排查"为什么执行乱"
      seq.push('结果: ' + c);
    } else if (c.indexOf('动作执行失败：') === 0) {
      seq.push('失败: ' + c); // 失败消息进历史时本就不截断，导出保持一致
    }
  }
  push(seq.length ? seq.join('\n') : '（无动作记录）');
  push('');
  push('==================== ⑤ 面板活动轨迹（addLog 可见行：动作痕迹 + 复盘收藏/经验沉淀过程与结果） ====================');
  const acts = t.activities || [];
  if (acts.length) {
    for (const e of acts) push('  ' + ts(e.t) + '  ' + String(e.text || ''));
  } else {
    push('（无活动日志）');
  }
  push('');
  push('==================== ② 大模型返回了什么 —— 每步完整原始返回（共 ' + logs.length + ' 次） ====================');
  for (let i = 0; i < logs.length; i++) {
    const e = logs[i];
    push('----- 往返 #' + (i + 1) + ' · ' + ts(e.t) + ' · ' + (e.req || '') + ' -----');
    push('大模型返回：');
    push(String(e.res || '（空）'));
    push('');
  }
  return L.join('\n');
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
    if (!t) continue;
    // 复盘未完成标记（finish/停止后的后台复盘，MV3 worker 可能被回收打断）：
    // 按持久化标记补跑，避免"书签筛选跑完了、经验沉淀没来得及发请求"这类复盘无声丢失。
    // 标记回合号没变（没来新指令）才补跑；已来新指令则让位，旧标记由 reviewAfterTurnEnd 收尾时清掉。
    if (t._reviewPending) {
      // 复盘待办（无论正在跑还是待补跑）都算忙：alarm 保持心跳，不因 state=idle 被清
      anyBusy = true;
      if (!reviewRunning[sid]) {
        const p = t._reviewPending;
        reviewAfterTurnEnd(t, p.turnId, p.reviewSteps || 0).catch((e) => console.warn('[PageAgent] 复盘恢复失败 ' + sid + ' → ' + (e && e.message)));
      }
      continue;
    }
    if (t.state === 'idle' || t.state === 'done' || t.state === 'waiting_user') continue;
    anyBusy = true;
    if (t.state === 'awaiting_nav') {
      const waited = Date.now() - (t.awaitingNavAt || 0);
      if (waited > NAV_TIMEOUT_MS) {
        fail(t, '页面加载/跳转超时（' + Math.round(waited / 1000) + 's）');
      } else {
        tryResume(sid, t.waitTabId); // 尝试提前恢复，失败会再次进入 awaiting_nav
      }
    } else if (t.state === 'working') {
      // MV3 worker 可能被回收导致循环中断：检测到长期无进展则从持久化状态恢复。
      // 但若有 agentStep（含链式续步）正在跑——慢 LLM / 慢快照——绝不并发拉起新的，
      // 否则会跑出双份 LLM 请求、双份动作执行
      const stale = Date.now() - (t.lastActiveAt || 0) > 60000;
      if (stale && !agentStepDepth[sid]) {
        addLog(sid, '检测到任务停滞，尝试恢复…', true);
        agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
      }
    }
  }
  if (!anyBusy) clearAlarm();
});

// ---------------- 系统提示词（持续对话模式） ----------------
function systemPrompt(background) {
  // background=true → 后台执行（不切前台、不抢焦点）；false → 前台执行（操作标签切到浏览器前台）。缺省前台。
  const bg = !!background;
  return `你是 PageAgent，一个运行在用户浏览器里的智能助手，采用"持续对话"模式。

使用者会持续给你下达指令（操作类：登录、搜索、填表、抓取；总结类：提炼要点；查资料类：搜索/开网页；保存类：写成文件下载）。每收到一条新指令：
1. 先判题：判断 @MAIN 当前页面与这条指令是否相关。相关就在当前页操作；**不相关时不要在当前页瞎点**，直接用 search 搜索，或 open_tab 打开任务相关的网站/URL 来处理。**指令点名了某网站/工具（如"打开我的网盘""在 XX 站里找资料"）时，要开的网址从【网站工具索引】按标题匹配拿、原样使用，不要凭印象猜域名**；索引没有就 bookmark_find，再没有才 search。
2. 逐步执行：观察 → 决策 → 执行 → 再观察，直到完成这条指令。
3. 用 finish 给出这条指令的回答，然后**等待使用者下一条指令**（不要结束对话，不要关闭标签）。

多轮对话中，请记住并复用此前完成的操作和得出的结论（对话记录跨轮保留）。例如使用者说"把刚才的总结存成文件"，你应能找到之前的总结并用 save_file 保存。注意：每轮结束你自开的标签（@T 系）会被自动关闭、跨轮不再存在，需要重新访问时用 open_tab/search 重开，或 use_tab 用使用者已打开的标签。

你拥有"任务标签页"：@MAIN 是使用者交给你的标签（属于使用者，不要随便关）；@T1/@T2/... 是你自己新开的${bg ? '后台' : ''}标签（自动归入本会话 PageAgent N 分组${bg ? '、不抢焦点' : ''}；点"新开页面"链接也会自动变成${bg ? '后台 ' : ' '}@T）；@U1/@U2/... 是你用 use_tab 纳入的使用者已有标签（同样不要随便关）。${bg ? '' : '当前为前台执行模式：你切换/打开操作标签时，浏览器会把它切到前台展示，使用者能实时看到你的操作。'}
你通过"页面快照"感知当前操作标签的网页：包括标签页列表、URL、标题、可交互元素列表（[ref] 类型 文本 值 选择器）和正文摘要。正文摘要默认滤掉站点恒定导航/页脚/法务备案等噪音（页脚税）、并入画布渲染的正文，只留内容主体——读取正文、确认内容不必每次重复 read 整页（那是冗余往返）；但快照摘要/元素列表里**没出现**目标正文时（如正文还在加载、正文在图片上、只见推荐/相关列表），说明快照没抓到正文，必须 read 整页（target:"page"）去拿，**点开不等于读到**；read 用于读摘要没覆盖的局部（如某元素/弹窗内单独文字，target 填那个 ref）。read 整页的页脚税过滤与 raw 细节见动作说明。页面可能含内嵌 iframe 子窗口（弹窗/新建流程），其元素并进快照、用【子窗口 N】分组标出，正文摘要附其内容，可正常点击/读取。快照提示有未读取成功的内嵌窗口时，先 wait 等加载完再观察，别一时看不到就乱点。刚点击后快照出现新的【子窗口 N】分组或元素变多，说明弹窗已打开，目标在这个新窗口里找——**别重复点击刚才那个按钮**（可能把弹窗又关掉），直接在弹窗里继续操作。
快照开头的【本站操作经验】是该网站历史沉淀的操作经验（如"搜索要直接点第一条结果"）。**每次选元素、定动作前先对照它**——与经验不符的做法多半在绕弯路，优先按经验来；反复失败、找不到元素、或动作与经验不一致时先回头对照调整，别硬试同一招；某条经验与当前页面明显冲突（页面已改版）说明已过期，跳过它、以当前页为准。

每收到一个快照，你必须输出 JSON 动作。接到新指令的首轮先拆解：把达成这条指令要做的事分成 3~8 步（按大事件/阶段分，不是单个动作），随本轮 actions 一起输出 steps 字段 {"steps":[{"text":"...","done":false},...],"actions":[...]}；之后每轮随 actions 顺带输出更新后的 steps（已完成的 done 置 true），面板会实时划线展示进度，全部完成才 finish。**默认倾向批量输出**：把多个**连续、下一步不必看中间结果**的动作合在一起输出 {"actions":[{...},{...},...]}（最多 ${MAX_BATCH} 个），系统连续执行、大幅减少往返。逐条勾选、连续填表、列表内翻页、逐行操作这类重复循环，**务必合成一批，别单动作空转**；快照标【批量模式】（本页已熟悉）时更要尽量多合批，标【谨慎模式】（本页不熟悉/刚出错）时才退回一次一个动作。**多 tab 是默认工作方式**：任务需要（读多条详情、跨页对比、并行处理）时用 open_tab 开多个${bg ? '后台' : ''}标签放进同一批执行，而不是只盯一个 tab。**例外——输出单个动作**：必须看到本步结果才能决定下一步、拿不准、或要结束本轮（finish）。批量规则：
- **批内顺序依赖要弱**：某个动作执行后才出现的元素，后续动作**不能用它的 ref**（ref 来自旧快照，执行时会失效），要用 clickText 按文字 / clickAt·dblclickAt 按坐标 / gotoCell 按格号来定位；
- **批内可跨页**：open_tab / search / navigate / switch_tab / use_tab / close_tab 可在批内任意位置；连续跨页之间系统不等（多个新页并行加载），系统会在真正读/点的动作前自动等当前操作标签页面就绪——单页加载不打断整批。只有 snapshot / finish / ask_user 放批尾（执行到它们本批收尾），之后系统重新观察页面；
- 每批尽量以 read 或读回校验结尾，确认动作生效。
可用动作：

0. 标签操作（ref 用 @MAIN / @T1 / @U1 ...；tabId 用 list_tabs 返回的编号）：
   {"action":"open_tab","url":"https://..."}   新开${bg ? '后台标签（不抢焦点、自动加入分组）' : '标签并切到浏览器前台（自动加入分组）'}。链接元素快照里带 →地址，需要详情地址直接取来 open_tab（如读 N 条任务：用列表元素的 →地址 攒 URL 批量开页），不必先点开再找
   {"action":"search","query":"关键词"}          用搜索引擎搜索（自动打开${bg ? '后台' : '并切到前台'}标签，不要手动拼 URL）
   {"action":"switch_tab","ref":"@T1"}          切换 Agent 关注的操作标签（${bg ? '不切换浏览器前台' : '前台模式会切到浏览器前台'}）
   {"action":"list_tabs"}                       列出浏览器【所有】标签（标题+网址+tabId，标记当前选中的、已在任务里的和无法操作的受限页）
   {"action":"use_tab","tabId":<list_tabs 给的 tabId>}   把浏览器里已打开的任意标签纳入任务并切换过去操作（${bg ? '不切浏览器前台' : '前台模式会切到浏览器前台'}；已在任务里的直接切过去）。**必须先 list_tabs 拿最新 tabId**：系统强制——最近一次 list_tabs 之后标签集一变（新开/关闭/淘汰/纳入过标签），use_tab 就会被拒，需要重新 list_tabs 才能用
   {"action":"close_tab","ref":"@T1"}           关闭自己开的标签（@MAIN/@U 等使用者的标签不可关闭）

1. 页面操作（target 用快照里的数字 ref，如 3；ref 是全局编号，若元素标在【子窗口 N】分组里，直接用它所在行的 ref 即可，系统会自动定位到那个 iframe）：
   {"action":"click","target":<ref>}                       点击元素
   {"action":"clickAt","x":<视口坐标>,"y":<视口坐标>}       按视口坐标点击：点【画布文字】块里列出的坐标——画布渲染的表格/文档内容画在 canvas 上、不在 DOM 里，单元格无法用 ref 定位，用这个动作按坐标点选具体位置/单元格（x、y 直接填【画布文字】里括号内的数字）
   {"action":"dblclickAt","x":<视口坐标>,"y":<视口坐标>}     按视口坐标双击：画布表格/文档的单元格"单击只是选中、要编辑必须双击进入就地编辑"。双击后页面上会出现就地编辑框（快照里的"就地编辑框，可直接输入"元素），再 type 进那个编辑框、keypress Enter 提交
   {"action":"gotoCell","ref":"D8"}                          表格专用：按格子引用跳格（D8 / $A$1 / E5:G8）。在快照里找到"单元格名称框"（值形如 D2 的输入框）→ 输格号 → 回车 → 读回验证。编辑画布表格优先用它定位目标格，比坐标点选稳
   {"action":"clickText","text":"页面上的文字","frame":<可选，子窗口号>}   兜底点击：元素列表里没有合适的可点元素时，直接点页面上看到的文字——按语义判断它可能可点（如"提交""确定""新建空白文档"这种按钮/卡片/链接样式的文字）。frame 填目标所在【子窗口 N】的 N（主窗口不填）。点文字也失败就不要再死磕，换 wait/hover/ask_user(teach) 推进
   {"action":"hover","target":<ref>}                       悬浮在元素上（不点击），让"悬浮才出现"的元素（如列表行悬浮才显示的编辑/删除按钮、下拉菜单）显示出来；悬浮后系统会重新截图，那些元素会出现在下一次快照里。适合：目标元素当前快照里没有、但你知道悬浮某个元素就会出现它的场景
   {"action":"show","text":"删除"}                         强制显示"悬浮/隐藏才出现"的元素（hover 触发不了时的替代/兜底）：按文字找到含该文字的元素——即使它当前被 display:none / visibility:hidden 隐藏着——把元素本身和隐藏的父容器一起改成常驻可见（只改样式不执行代码）。定位三选一：text 按文字（含隐藏元素，最常用，如"删除""从图片库选择"）、selector 用 CSS 选择器、target 用快照 ref。改完系统会重截快照，目标会出现在下一次快照里，直接 click 即可。适用于：hover 出不了菜单项（菜单是纯 CSS :hover 才显示、合成事件触发不了）、或按钮被隐藏模板挡住
   {"action":"hide","target":<可选 ref>}                   还原 show 强制显示的元素：带 target 只还原那个元素及其父容器，不带则还原本窗口全部被 show 的元素。show 过的页面离开/刷新会自动复原，但同页继续操作时建议顺手 hide，避免菜单常驻影响后续点击
   {"action":"type","target":<ref>,"text":"..."}           输入文本（覆盖原有内容）
   {"action":"select","target":<ref>,"value":"..."}        下拉框选择
   {"action":"scroll","direction":"down|up","amount":<像素,可选>}  滚动页面（只在目标元素当前快照里没有、需要翻动/加载出新内容时用；目标已在元素列表/正文摘要里就不要再滚）
   {"action":"snapshot","offset":<100 的倍数>}             翻到下一批元素窗口：快照标注"还有下一批"且目标不在列表时用（offset 取快照提示里的值；回第一批用 0）
   {"action":"read","target":<ref 或 "page">,"selector":<可选，"css:#id 或 xpath:// 或 直接 CSS">,"limit":<可选字符数>,"raw":<可选 true>}  读取某元素/整页/指定选择器元素的文本（用于总结）。默认已滤掉页面恒定导航/页脚/法务备案等噪音（页脚税），且已并入画布渲染的正文——读内容/文档/表格直接 read 整页即可，**不要加 raw**；"raw":true 只在需要核对页脚/备案/许可这类底部原文时用（会带页脚噪音）；只想读页面某一块（如某篇文章/某个列表）时用 selector 直接指定该元素，不必先经快照拿 ref；只要开头一小段就够回答的问题加 "limit":<字符数> 按需取段
   {"action":"wait","ms":<毫秒>}                           等待页面/动画/网络
   {"action":"keypress","keys":"Enter|Escape|Tab|Backspace|ArrowDown|..."}  向当前焦点发送按键
   {"action":"navigate","url":"https://..."}               在【当前操作标签】内跳转（沿用其会话/登录状态）
   {"action":"clickSelector","selector":"css:#btn 或 xpath://div[text()='提交'] 或 直接 CSS","frame":<可选，子窗口号>}   按选择器点击：元素列表里 ref 不好定位/已失效时，用 CSS 或 XPath 精确指定要点的元素（frame 用法同 clickText）
   {"action":"readCss","target":<ref>,"selector":<可选>,"props":<可选数组>,"frame":<可选>}   读元素计算样式：省略 props 返回全量（显隐/定位/盒子/字体等，重要属性在前），只要看几个属性时用 "props":["display","visibility","opacity","position","z-index","pointer-events","overflow"] 按需取（省上下文）。元素看不见/位置异常时先 readCss 判断原因（display:none / opacity:0 / 被遮挡）
   {"action":"uploadFile","target":<ref>,"selector":<可选>,"content":<文本,可选>,"filename":"a.csv","mime":<可选>,"pick":<可选 true>}   文件上传：content 给文本自动编码注入（如 CSV 内容）；pick:true 会弹本地文件选择框等你选文件后注入（人工参与点，慎用）
   {"action":"pasteRich","target":<ref>,"selector":<可选>,"html":"<section>…</section>","frame":<可选>}   富文本粘贴：把带样式 HTML 粘进富文本编辑器（contenteditable，先清空再插入）
   {"action":"pageInfo","field":<可选数组，"url"/"title"/"iframes"/"html" 子集>,"html":<可选 true>}   读页面信息：url/标题/加载状态/iframe 清单；默认不含整页 HTML，需要整页 HTML 时才加 "html":true
   {"action":"getJsErrors","limit":<可选条数>}   读页面累计的 JS 错误（跨所有窗口聚合，错误标注来源窗口）；排查页面报错用，只要最近几条就够时加 "limit":<条数> 按需取
   {"action":"clearJsErrors"}   清空页面已采集的 JS 错误缓冲
   {"action":"exec_code","idx":<编号>,"args":{参数名:值}}   执行当前快照【本站操作经验】里编号 idx 那条经验写好的 JS：场景相符、且"这一步就该这么做"时用它一步完成（省得再一步步绕），args 按该经验的参数说明传（如 {"keyword":"AI 趋势"}；无参数可不带 args）。一次一条，idx 必须是快照里出现过的编号，代码只在当前页面执行

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
   {"action":"ask_user","mode":"teach","message":"我在这个页面上卡住了，想点击\"编辑\"按钮却找不到，请你手把手演示一遍正确做法，我会记录学习"}  遇到实在不知道怎么做的环节（尤其某网站特有的操作方式）时，暂停并请使用者在当前页面上手把手演示一遍；message 里必须写明你卡在的这一步想做什么（如"想点击'编辑'按钮却找不到""想给第2行删除"），让使用者一看就知道该演示什么操作；你会自动记录他的每一步操作来学习——录制覆盖【任务下所有标签页】（不只当前标签，使用者在演示中切到/新开的标签也会自动纳入并继续录制，跨页跨站演示不断），悬浮才出现的元素，悬浮这一步也会被记录成步骤，他操作完点"我操作完了"后你复述学到的步骤，经他确认后再按其演示继续
   {"action":"ask_user","mode":"confirm","message":"请确认我理解的步骤对不对"}  给使用者一个确认按钮（点「没问题」继续）；通常跟在 say 复述之后，使用者有出入会直接在对话里纠正

3. 结束本轮（不是结束对话）：
   {"action":"finish","result":"..."}   完成本条指令，result 是给使用者的答复；完成后你自开的标签（@T 系）会被自动关闭，使用者的标签（@MAIN/@U）保留，然后等待下一条指令

规则：
- 使用者在任务执行中发来的补充说明，务必重视并采纳：它可能是纠正你当前做法的指导（照它调整具体操作、继续推进原始目标），也可能就是明确改变目标的新指令（以它为准切换目标）。无论如何都不要无视它，也不要一收到就盲目放弃原始目标。
- 严格只输出一个 JSON 对象，不要输出解释、代码块或其它文字。
- 元素 ref 是数字；标签 ref 带 @ 前缀。绝不臆造，找不到就先 scroll/read/switch_tab 再观察。
- **先看快照再决定要不要滚**：快照元素列表里已出现的元素就是当前可见可操作的，目标文字已在元素列表或正文摘要里时直接点（click/clickText），**不要为了"确认可见"或"找位置"先 scroll**——滚一下要换一批元素、重等快照，目标没变时就是纯绕路；一次滚动后没翻出新目标，就回到滚动前的思路推进，别上下来回滚。
- 点击后看下一个快照：URL / 可交互元素 / 正文都没变化说明这次点击没生效——不要重复点同一元素，也不要对几乎相同的 URL 反复 navigate（同样多半不生效）；换一种做法推进（clickText 按文字点、hover 出悬浮项、read 读当前状态再判断）。
- 点击类动作的结果带 label（实际点到元素的描述）。当结果的 label 与你标注的意图 / 快照里该 ref 的描述对不上时（如你想点『全选』、结果 label 却是『邮箱』），说明 ref 已漂移（发动作时 DOM 变了，同编号元素已不是同一个）——**不要按旧 ref 继续点**，重新 snapshot 后用 clickText 按当前列表里实际出现的文字点。
- 目标是"读 N 条"（逐条读完列表/多篇内容再总结，如"读 20 条后分类总结"）时，**用批量跨页读法，不要逐条点开-返回**：列表快照里每个链接元素都带 →地址，那就是详情页地址。①攒出若干条【未读】条目的详情地址 → ②一批输出：open_tab 逐个新开详情页（可一次先开 10~15 个、让它们并行加载），再逐个 switch_tab 到某页 + read 读正文（系统会在 read 前自动等该页就绪，单页加载不打断整批）→ ③这一批读到的正文批末一次性全部返回给你，当场记下每条要点 → ④switch_tab 回列表看【已读】标记与【已读清单】，挑下一批【未读】继续，直到读够 N 条。判断"这条读过没"只看列表上的【已读】标记和【已读清单】，绝不重复读清单里已有的标题——列表里没读的条目多的是，别在一条上反复点。
- 同一列表点出来的子页面（同级的详情/条目页）结构基本一样——**先研究透一个子页要做的操作**（元素怎么定位、点什么、输什么、怎么提交），确认可行后，对剩下的同级子页**批量复用同一套做法**（open_tab 攒 URL 批量新开 → 逐个 switch_tab + 同样的动作序列，必要时再 read 校验），**不要每页从头摸索**；只有个别页面结构确实不同时才单独处理。
- **总结只许写你实际点开读过正文的条目**：只看到标题/摘要（没打开正文）的条目，最多只列它的标题（可加列表里就有的作者/时间），**绝不能编造正文内容或主观评价**。没读够目标条数就继续读、不要提前收尾；收尾时说明"实际点开读了 N 条 / 目标 M 条"。
- 任何详情正文出现在快照摘要或 read 结果里时，先把它并入当轮的结论再关闭/离开：要按 Escape 关掉详情前，确认它的内容已记入你的进度——看完就关等于没读，关了又忘、忘了又点回来，是纯空转。
- 点开条目后若正文没出现在快照摘要/元素列表（还在加载、在图片上、只见推荐列表），说明没拿到正文：**点了不等于读了**，别为"读"再点同一标题——read 都读不到就说明正文不在可读文本里；只要条目级信息就当场记下标题即可；点了却不打算读正文时，click 后的 wait 不必长等。
- 想操作列表/表格里某一行（编辑/删除/更多菜单）却找不到按钮时，别急着放弃——很多站点的行内按钮是**悬浮那一行才出现**的：先 hover 那一行（或其上任意元素）让按钮显示，重截快照后可点；在页面上找不到下一步该点的入口时，同样先想它是不是要 hover 某个列表项才出现。hover 后按钮仍不出现，多半是**纯 CSS :hover 才显示**的菜单（合成事件触发不了），改用 show 按文字强制显示（如 show {"text":"编辑"}）。
- 可交互列表里找不到的按钮/卡片，多半是纯 JS 动态渲染——从正文和【子窗口 N】内容里看到**明显可点**的文字（如"提交""创建""登录""新建空白文档"）时，用 clickText 按语义试点（点的是文字，不需它出现在列表里）；连续失败几次无进展就换 wait / hover / ask_user(teach)，不要一直赌。
- 画布表格/文档（快照里有【画布文字】块、内容画在 canvas 上）的操作：表格类页面一般都有**单元格名称框**（快照标注"单元格名称框"、值形如 D2——Excel/Sheets/WPS/腾讯等电子表格的通用特征），定位目标格**优先用 gotoCell**（如 gotoCell D8：名称框输格号+回车跳格），比坐标点选稳。编辑配方：gotoCell 跳目标格 → keypress F2 进就地编辑 → type 新值 → keypress Enter 提交 → 重新快照从【画布文字】确认已更新。F2 进不了编辑、或没有名称框时退回坐标方案：clickAt 单击选中 → dblclickAt 双击唤起编辑框 → type → Enter。
- 任务没给具体网址、需要查资料/搜信息时，用 search 动作（${bg ? '后台自动开搜索页' : '自动开搜索页并切到前台'}）；知道确切网址时用 open_tab。
- 当前页是受限页面（快照里会明确标注"受限页面"，如 chrome://、about:、扩展管理页、新标签页）时，绝对不要尝试操作它，直接用 open_tab 打开任务相关网址或 search 搜索。
- 需要访问新页面做独立工作时，用 open_tab / search 新开${bg ? '后台标签，避免打扰使用者的浏览' : '标签（前台模式会切到前台展示操作）'}。
- 仅当要沿用当前标签的登录会话/上下文（如已登录站点）时才用 navigate。
- 教我模式：收到使用者演示的操作记录后，先用 say 动作向使用者复述你学到的操作步骤，再用 ask_user（mode=confirm）请他确认——他点「没问题」按钮或回复「没问题/确认」等确认后，就严格按演示步骤继续完成原始目标；页面状态与演示时不同（如已登录、元素变化）则灵活适配、按演示意图完成；有出入时按使用者的纠正调整。
- 教我模式的复述确认阶段是个**确认循环**：使用者在对话里回复纠正或问题（如"不对""少了一步""第三步不是这样"）时，你要重新理解他的纠正、修正你对步骤的理解，再用 say 复述修正后的步骤、用 ask_user（mode=confirm）再次请他确认——循环会一直持续，直到他明确说「没问题/确认」放行，或说「不教了/算了」「你先去做吧/你自己来」终止教学（终止后按你当前理解的自行继续完成原始目标），或说「重新演示」要求重开演示。不要未经再次确认就擅自继续执行，也不要自行猜测调整步骤。
- 教我模式记录到的输入值（账号、密码等）仅用于本轮复现使用者的演示，不要写入经验库。
- 同一网址你已经在任务里打开过（list_tabs 里能看到）时，再次需要它直接 switch_tab 切过去复用，不要重复 open_tab 新开同一个页面——重复打开同一网址系统会直接切到已有标签。
- 使用者问"我现在正在看哪个页面/我打开了哪些标签/在我已打开的某个标签里做 XX"时，先用 list_tabs 查看浏览器全部标签，再按需 use_tab 纳入并操作，不要新开标签重复打开使用者已有的页面。
- 已用完、确认后续不会再用的标签 close_tab 关掉它，保持整洁（如一次性搜索结果页、只读一次的临时页）；拿不准还会不会用就先留着——同一网址再次需要时能直接切回已开标签，但关掉重开会丢失页面上的状态。不要关闭 @MAIN/@U 等使用者的标签。
- 目标是"总结/摘要"时：按上面"读 N 条"的批量跨页读法批量读取，然后 finish 输出简洁、结构化的中文总结。
- 目标要求"保存为文件/导出/下载"时：用 save_file 把总结或抓取结果写成文件（文件名带合适的扩展名），保存后再 finish 告知使用者文件路径。
- 任务涉及"我的书签/收藏"时：查询/盘点用 bookmarks_read（可指定 folder 只看某个文件夹）；要把某网址加入收藏用 bookmarks_write（folder 填目标文件夹名，不填就放"其他书签"）。
- 任务涉及某个已知网站/工具（如"打开我的网盘""在知乎搜 XX"），或指令要做的场景能在【网站工具索引】里匹配到能干这事的网站（如"压缩图片""查论文"）时：先查【网站工具索引】（书签，标题即用途），按标题匹配到条目后，**原样用该条目给出的网址** open_tab 打开——指令点名了哪个站，就取索引里标题指向那个站的那条网址，**不要凭印象猜域名、不要自己改拼索引里的网址**；索引里没找到就 bookmark_find 搜书签，再没有才用 search 网页搜索。
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
  if (t) t.lastActiveAt = Date.now(); // 长 LLM 调用期间保持"活跃"标记，防止心跳把慢请求误判成停滞并发起并发 agentStep
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  // 心跳看的是 t.lastActiveAt 是否超过 60s；LLM 请求可能远超过 60s，每 30s 刷新一次，
  // 这样整个请求期间"活跃"都不会过期，心跳不会重复发起并发 agentStep
  const keepAlive = t ? setInterval(() => { if (t) t.lastActiveAt = Date.now(); }, 30000) : null;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (keepAlive) clearInterval(keepAlive);
    if (e && e.name === 'AbortError') throw new Error('LLM 请求超时（' + (LLM_TIMEOUT_MS / 1000) + 's，输入过长或服务端繁忙）');
    throw e;
  }
  clearTimeout(timer);
  if (keepAlive) clearInterval(keepAlive);
  if (t) t.lastActiveAt = Date.now();
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
  // DeepSeek 自动上下文缓存在 usage 里带 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
  // 面板据此显示"缓存命中率"；第三方中转可能不透传，拿不到就当 0（命中率不显示，不影响其余）。
  if (t && data.usage) {
    t.tokens = (t.tokens || 0) + (data.usage.total_tokens || 0);
    t.cacheHit = (t.cacheHit || 0) + (data.usage.prompt_cache_hit_tokens || 0);
    t.cacheMiss = (t.cacheMiss || 0) + (data.usage.prompt_cache_miss_tokens || 0);
    broadcast({ type: 'AGENT_TOKENS', tokens: t.tokens, cacheHit: t.cacheHit, cacheMiss: t.cacheMiss }, t.sid);
  }
  return content;
}

// 设置里填了 API Key / Base URL（失焦）或进入配置时：GET /models 拉取服务端可用模型列表填充下拉，
// 顺带验证 API Key 与 Base URL（Key 错→401，URL 错→网络失败）。不走 callLLM（那是会话步骤，带 JSON
// 约束、token 统计与长超时）；官方 /models 每个模型只返回 id/object/owned_by，不含上下文窗口大小。
async function fetchModels(cfg) {
  const stored = await getConfig();
  const apiKey = cfg.apiKey || stored.apiKey;
  if (!apiKey) return { ok: false, error: '未配置 API Key，请在设置中填写' };
  const baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = baseUrl + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEST_MODEL_TIMEOUT_MS);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return { ok: false, error: '请求超时（' + (TEST_MODEL_TIMEOUT_MS / 1000) + 's）：Base URL 可能不可达或 DNS 解析失败' };
    return { ok: false, error: '网络错误：' + (e.message || e) + '（请检查 Base URL）' };
  }
  clearTimeout(timer);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) {}
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'HTTP ' + res.status + '：API Key 无效或未授权' };
    if (res.status === 404 || res.status === 405) return { ok: false, error: 'HTTP ' + res.status + '：Base URL 下没有 /models 接口（可能是只支持 /chat/completions 的中转）' };
    return { ok: false, error: 'HTTP ' + res.status + ' ' + detail };
  }
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: '返回不是合法 JSON，Base URL 可能不是 OpenAI 兼容接口' }; }
  const models = Array.isArray(data && data.data)
    ? data.data.map((m) => m && m.id).filter(Boolean)
    : [];
  return { ok: true, latencyMs: Date.now() - t0, models };
}

// 解析 LLM 输出为动作列表。兼容三种形态：
//   单个对象 {"action":"..."}                       → actions=[obj]
//   {"actions":[{...},{...}]}                       → actions=数组
//   顶层数组 [{...},{...}]                           → actions=数组
// 返回 { actions, steps }：actions 为动作数组，steps 为模型顺带输出的步骤计划（[{text,done}]，可 null）。
// 任一无合法 action 都抛错（整批重来）。批内动作会在 agentStep 里校验上限与终止规则。
function parseAction(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const obj = JSON.parse(t);
  const ALLOWED = new Set(['open_tab', 'switch_tab', 'use_tab', 'list_tabs', 'close_tab', 'search', 'save_file', 'bookmarks_read', 'bookmarks_write', 'bookmark_find', 'ask_user', 'say', 'click', 'clickAt', 'dblclickAt', 'gotoCell', 'clickText', 'clickSelector', 'hover', 'show', 'hide', 'type', 'select', 'scroll', 'read', 'readCss', 'wait', 'keypress', 'navigate', 'snapshot', 'pageInfo', 'getJsErrors', 'clearJsErrors', 'uploadFile', 'pasteRich', 'exec_code', 'finish']);
  let list = [];
  if (Array.isArray(obj)) {
    list = obj;
  } else if (obj && Array.isArray(obj.actions)) {
    list = obj.actions;
  } else {
    list = [obj];
  }
  if (!list.length) throw new Error('动作列表为空');
  for (const a of list) {
    if (!a || typeof a !== 'object' || !ALLOWED.has(a.action)) {
      throw new Error('非法动作：' + (a && a.action));
    }
  }
  // 步骤计划：模型每轮随 actions 顺带输出的拆解（[{text,done}]，可选；首轮拆解、后续轮更新 done）
  const steps = (obj && Array.isArray(obj.steps)) ? obj.steps : null;
  return { actions: list, steps };
}

// 步骤计划规范化：清掉畸形/空项，文本统一宽度截断（midTruncate 40），上限 12 步防跑飞
function normalizePlan(steps) {
  if (!Array.isArray(steps)) return null;
  const out = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const text = String(s.text || s.name || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text: midTruncate(text, 40), done: !!s.done });
    if (out.length >= 12) break;
  }
  return out.length ? out : null;
}

// 步骤计划合并（替代整表替换）：模型本轮重发的新计划与旧计划融合——
//   * 新计划与旧计划文本一致/相近的步骤：done 取"旧或新"（模型漏标 done、或只是措辞微调，都不会撤销已划线的步骤）；
//   * 旧计划独有步骤保留（含已划线的，模型按约定不删已定步骤）；新计划新增步骤追加到末尾；
//   * 步数上限 12，文本宽度截断 40。
// 注意：一旦某步被划线（模型置 done），后续模型重发只要该步文本还认得出来就不会被撤销；
// 模型若真想纠正（如误划线），需改该步骤的文字使其成为"新步骤"。
function mergePlan(oldPlan, newSteps) {
  if (!Array.isArray(newSteps) || !newSteps.length) return Array.isArray(oldPlan) && oldPlan.length ? oldPlan : null;
  const norm = (s) => String(s.text || s.name || '').replace(/\s+/g, ' ').trim();
  const newList = newSteps
    .map((s) => ({ text: midTruncate(norm(s), 40), done: !!s.done }))
    .filter((s) => s.text);
  const out = [];
  const usedNew = new Set();
  for (const old of Array.isArray(oldPlan) ? oldPlan : []) {
    const o = norm(old);
    if (!o) continue;
    const idx = newList.findIndex((n, i) => !usedNew.has(i) && planStepsSimilar(o, n.text));
    if (idx >= 0) {
      usedNew.add(idx);
      out.push({ text: newList[idx].text, done: !!(old.done || newList[idx].done) }); // 旧 done 或新 done：一旦划线不因模型漏标/漂移而撤销
    } else {
      out.push({ text: midTruncate(o, 40), done: !!old.done }); // 旧计划独有步骤保留（含已划线）
    }
  }
  for (let i = 0; i < newList.length; i++) if (!usedNew.has(i)) out.push(newList[i]); // 新计划新增步骤追尾
  return out.length ? out.slice(0, 12) : null;
}

// 两步文字是否"同一件事"：完全相等 / 互含（一方是另一方子串）/ 长公共子串 ≥4（措辞微调、换序都算同一步）。
// 上限：步骤文字 ≤40 字符，LCS 矩阵 ≤40×40，微不足道。
function planStepsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return Math.max(a.length, b.length) >= 4; // 互含且长者 ≥4 才算（防单字/短词误配）
  return lcsLen(a, b) >= 4;
}
function lcsLen(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = new Array(m + 1).fill(0).map(() => new Array(n + 1).fill(0));
  let best = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best) best = dp[i][j];
      } else {
        dp[i][j] = 0; // 连续公共子串（非子序列），防单字跨句拼凑出虚假公共段
      }
    }
  }
  return best;
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
      content: '【你的网站工具索引：来自浏览器书签，标题即用途】每条为"文件夹/标题 — 网址"，标题写明了网站能干什么。指令点名某网站/工具、或指令要做的场景能在标题的用途描述里匹配到对应网站（如"压缩图片""查论文"）时，直接 open_tab 打开该网址（**原样使用条目给出的网址，不要自己改拼、不要猜域名**）；索引匹配不到再用 bookmark_find 按关键词精确查找。\n' + bookmarkIndexCache
    });
  }
  // 当前任务步骤计划：每轮注入让模型看到进度并据实际执行更新 done（面板同源展示划线进度）
  if (t.plan && t.plan.length) {
    msgs.push({
      role: 'system',
      content: '【当前任务步骤计划】（这是你在面板展示的步骤清单，共 ' + t.plan.length + ' 步；每轮随 actions 用 steps 字段更新完成进度，完成的置 done:true，不要删除已定步骤、也不要改已完成步骤的文字；全部完成才 finish）\n' +
        t.plan.map((s, i) => (i + 1) + '. ' + (s.done ? '[已完成] ' : '[ ] ') + s.text).join('\n')
    });
  }
  // 压缩摘要：中间历史已被合并成"进展 + 踩过的坑 + 用户注意点"
  if (t.ctxSummary) {
    msgs.push({
      role: 'system',
      content: '【已压缩的历史进展】（此前的详细操作不再逐条列出，以下摘要涵盖已完成的事、踩过的坑与使用者补充的注意点，越靠后越新，继续执行时参考它）\n' + t.ctxSummary
    });
  }
  // 已读正文记录：上下文压缩后，历史里"实际读过的条目"的原文已并入(有损)摘要甚至删除，只剩这里保真。
  // readList 独立存于任务对象不受压缩影响，压缩一发生就注入，保证总结时有真材实料、不靠标题脑补。
  const readNotes = (t.readList || []).filter((x) => x.title);
  if (t.ctxSummary && readNotes.length) {
    const rl = ['【已读正文记录】（系统自动记录你已实际点开读过的条目，共 ' + readNotes.length + ' 条；上下文已压缩、历史里这些原文不再保留，总结以这里为准：有正文要点的直接用要点，**不要凭标题脑补**；标注"正文未采集到"的条目如确需详情，可重新打开它 read 补读——这类重复打开不会被拦截）'];
    for (const r of readNotes) {
      rl.push('· ' + r.title + (r.content ? '：' + midTruncate(r.content, 200) : '（正文未采集到）'));
    }
    msgs.push({ role: 'system', content: rl.join('\n') });
  }
  // 尾部历史窗口：从最新往前收集，直到放不下（充分用满上下文窗口；边界以下已由摘要覆盖）。
  // 页面快照只保留最近 MAX_SNAPSHOT_KEEP 次：旧快照里的元素 ref / 摘要早已过期（页面已重渲染），
  // 整页元素列表又是最占上下文的，全部重发纯属浪费——跳过更老的快照，其余消息（动作结果、失败提示等）仍按预算照常装。
  const B = Math.max(1, Math.min(t.ctxBoundary == null ? 0 : t.ctxBoundary, hist.length - 1));
  const body = [];
  let used = messagesTokens(msgs);
  const budget = ctxWin - OUTPUT_RESERVE;
  let snapKept = 0;
  let roundsSeen = 0; // 反向扫描中已越过的 assistant 决策条数 = "此条消息已有多新的回合"。工具结果超过 RESULT_KEEP_ROUNDS 回合 → 降级为空壳
  for (let i = hist.length - 1; i >= B; i--) {
    const m = hist[i];
    if (m.kind === 'snapshot') {
      if (snapKept >= MAX_SNAPSHOT_KEEP) continue; // 更老的快照不再发（最新快照永远在，循环从最新往前数）
      snapKept++;
    }
    let content = m.content;
    if (m.role === 'assistant') roundsSeen++; // 一个 model 决策 = 一回合（回合边界；一批多结果同属一回合）
    else if (m.role === 'user' && String(m.content || '').indexOf('动作结果：') === 0 && roundsSeen >= RESULT_KEEP_ROUNDS) {
      // 旧回合工具结果空壳化：保留开头短摘要（含 ok/失败与关键首字段），全量省略——让模型知道"这动作返回过"，
      // 但不占用大段上下文；细节已由更晚的快照/readList 承载，必要时可重读。空壳本身成本极小，不再拖垮预算。
      content = '动作结果（已过期，全量省略）：' + String(m.content).slice('动作结果：'.length, '动作结果：'.length + RESULT_STUB_CHARS);
    }
    const cost = estimateTokens(content);
    if (used + cost > budget) break;
    body.unshift({ ...m, content });
    used += cost;
  }
  // 目标与最新指令分开注入（都独立保存、不会被裁剪）：
  //  - 原始目标（task.goal）：最初接到的指令，除非被最新指令明确否定，否则继续推进；
  //  - 最新指令/补充说明（task.lastInstruction）：使用者中途发来的，务必重视采纳——
  //    可能是纠正做法的指导（照它调整、继续推进原始目标），也可能就是明确改目标（以它为准）。
  // 两者即使已出现在历史尾部也重复注入作醒目强调，让"补充说明要被重视、但不必然放弃原目标"充分生效。
  const goalText = (t.goal && String(t.goal).trim()) || (() => {
    const gi = firstUserIdx(t);
    return gi > 0 ? String(hist[gi].content) : '';
  })();
  if (goalText) {
    msgs.push({
      role: 'user',
      content: '【原始目标（你最初接到的指令，请继续推进它；除非最新指令明确改变了它，否则不要放弃）】\n' + goalText
    });
  }
  const lastInstr = (t.lastInstruction && String(t.lastInstruction).trim()) || '';
  if (lastInstr && lastInstr !== goalText) {
    msgs.push({
      role: 'user',
      content: '【最新指令/补充说明（使用者中途发来的，务必重视并采纳：若它只是纠正你的做法，就按它调整后继续推进原始目标；若它明确改变了目标，则以它为准切换目标）】\n' + lastInstr
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

// 判断历史里的 assistant 消息是否为 read 动作调用（压缩时用于成对删除 read 调用+结果）。
// 只认"单动作对象"：批量数组里的 read 不参与成对删除（数组与它的一串结果无法准确配对，宁可不删、留着天然被尾部窗口裁剪）。
function isReadAction(content) {
  try {
    const a = JSON.parse(String(content || ''));
    return !!(a && !Array.isArray(a) && a.action === 'read');
  } catch (e) {
    return false;
  }
}

// 把历史里的 assistant 动作消息展开成动作列表（兼容单对象与批量数组），供复盘统计遍历
function histActionList(content) {
  try {
    const a = JSON.parse(String(content || ''));
    return Array.isArray(a) ? a : [a];
  } catch (e) {
    return [];
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
  const c0 = performance.now();
  try {
    const folded = await compressContext(t);
    if (folded > 0) addLog(t.sid, '历史已压缩：' + folded + ' 条中间记录并入摘要，上下文释放 · ' + Math.round(performance.now() - c0) + 'ms');
  } catch (e) {
    console.log('[PageAgent]', '历史压缩失败：' + e.message); // 压缩是后台优化，失败不影响主流程，只留控制台可查
  }
}

// 压缩：保留 原始目标 + 最近 TAIL_KEEP_STEPS 步原文，中间"read 调用+结果"成对删除，
// 其余交给 LLM 总结成"进展/坑/注意点"摘要，并把边界推进到压缩点
async function compressContext(t) {
  const hist = (t && t.history) || [];
  const B = hist.length - TAIL_KEEP_STEPS * 3; // 每步 = 快照 + 动作 + 结果 3 条
  if (B < 3) return 0; // 历史太短，无法压缩
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
    return 0;
  }
  const summary = await summarizeChunks(middle, t.ctxSummary || '', t);
  t.ctxSummary = summary;
  t.ctxBoundary = B;
  await saveTasks();
  return middle.length; // 本次并入摘要的中间记录条数（供"历史已压缩"那行显示）
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

// 通过本会话的标签组查真实存活的 Agent 自开标签：组归属即会话归属，比 t.tabs 记录更全、
// 天然不会跨会话串（组按会话独立命名，查不到别的会话的组）。查不到组返回 []。
async function findSessionAgentTabs(t) {
  const gids = new Set();
  if (t.groupId != null) gids.add(t.groupId);
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups || []) if (g.title === t.groupTitle) gids.add(g.id);
  } catch (e) {}
  for (const gid of gids) {
    try {
      const tabs = await chrome.tabs.query({ groupId: gid });
      if (tabs && tabs.length) return tabs;
    } catch (e) {}
  }
  return [];
}

// 解析当前操作标签的 tabId。优先用当前任务标签；其次按本会话标签组查真实存活的 @T 自开标签
// （组内查比扫 t.tabs 记录更全、且天然不会串到别的会话），再补 t.tabs 里的 @MAIN/@U 使用者标签；
// 一个都不剩时自己开新标签接管——绝不报"任务标签页均已关闭"。
async function resolveCurrentTabId(t) {
  const entry = currentEntry(t);
  if (entry) {
    const tab = await getTab(entry.tabId);
    if (tab) return entry.tabId;
    addLog(t.sid, '当前标签已关闭，自动切换…', true);
  }
  // 1) 本会话标签组内的 Agent 自开标签（组归属即会话归属，天然不串；组内仍过一道归属校验作双保险）
  for (const tab of await findSessionAgentTabs(t)) {
    if (tab.id == null) continue;
    if (entry && entry.tabId === tab.id) continue;
    const owner = sessionOfTab(tab.id);
    if (owner && owner !== t.sid) continue;
    let rec = findTabEntryByTabId(tab.id, t);
    if (!rec) {
      rec = { ref: 'T' + ++t.tabSeq, tabId: tab.id, role: 'agent', title: tab.title || '', url: tab.url || '' };
      t.tabs.push(rec); // 记录缺的组内标签补登记（worker 休眠等丢记录时自愈）
      await saveTasks();
      broadcastTabs(t);
    }
    setCurrentRef(t, rec.ref);
    addLog(t.sid, '自动切换到其他标签', true);
    return tab.id;
  }
  // 2) t.tabs 里的 @MAIN/@U 使用者标签（使用者标签不分组，只能从记录里找）
  for (const e of t.tabs || []) {
    if (e.role === 'agent') continue; // 自开标签已由组查询覆盖
    if (e.ref === t.currentRef) continue;
    const tab = await getTab(e.tabId);
    if (!tab) continue;
    const owner = sessionOfTab(e.tabId);
    if (owner && owner !== t.sid) continue;
    setCurrentRef(t, e.ref);
    addLog(t.sid, '自动切换到其他标签', true);
    return e.tabId;
  }
  // 3) 一个都不剩 → 自己开新标签接管，让 LLM 在受限页上自行决定打开哪（open_tab/search）。
  //    先清掉已死的自开标签记录（避免撞 MAX_AGENT_TABS 上限），@MAIN/@U 的使用者记录保留不动。
  const staleAgents = (t.tabs || []).filter((e) => e.role === 'agent');
  if (staleAgents.length) {
    t.tabs = t.tabs.filter((e) => e.role !== 'agent');
  }
  try {
    const fresh = await openAgentTab('chrome://newtab/', '任务标签均已关闭，已自动开新标签', t);
    return fresh.entry.tabId;
  } catch (e) {
    addLog(t.sid, '自动开新标签失败：' + e.message, true);
  }
  return null;
}

function findTabEntry(ref, t) {
  // 快照/动作说明给模型看的是带 @ 的 ref（[@T2]、@MAIN），存储里不带（'T2'/'MAIN'/'U1'）。
  // 模型会把 @T2 原样发回 switch_tab/close_tab，这里剥掉开头单个 @ 再精确匹配，两种写法都认。
  const key = String(ref == null ? '' : ref).replace(/^@/, '');
  return ((t && t.tabs) || []).find((e) => e.ref === key) || null;
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

// 中间省略截断（按显示宽度）：中文/全角/emoji 记 2 个半角单位、ASCII/半角符号记 1，
// 用于"浏览页面 xxx"这类会话活动行的精简显示——max 传半角单位（如 26 ≈ 13 个汉字 / 26 个英文字母）。
// 按 grapheme 分段，避免 emoji 序列（😵‍💫）或代理对在截断处被切成半个。
function midTruncate(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const segs = splitGraphemes(t);
  let total = 0;
  for (const g of segs) total += charHalfWidth(g);
  if (total <= max) return t;
  const keep = Math.max(1, Math.floor((max - 1) / 2)); // … 占 1 单位，头尾各留一半
  let head = '', hw = 0;
  for (let i = 0; i < segs.length && hw < keep; i++) { head += segs[i]; hw += charHalfWidth(segs[i]); }
  let tail = '', tw = 0;
  for (let i = segs.length - 1; i >= 0 && tw < keep; i--) { tail = segs[i] + tail; tw += charHalfWidth(segs[i]); }
  return head + '…' + tail;
}

// 尾部省略截断（按显示宽度，同 midTruncate）：中文/全角/emoji 记 2 个半角单位、ASCII 记 1，
// 超长从末尾截掉补 …，保留开头整段（主机名/路径开头优先完整）；用于"打开页面 <地址>"这类行。
function tailTruncate(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const segs = splitGraphemes(t);
  let total = 0;
  for (const g of segs) total += charHalfWidth(g);
  if (total <= max) return t;
  let out = '', w = 0;
  for (const g of segs) {
    const gw = charHalfWidth(g);
    if (w + gw > max - 1) break; // 留 1 单位给末尾的 …
    out += g;
    w += gw;
  }
  return out + '…';
}

// 按可见字符（grapheme）分段；不支持 Segmenter 时退回按 code point 拆（至少不拆代理对）
function splitGraphemes(s) {
  if (Intl && Intl.Segmenter) {
    try { return Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(s), (x) => x.segment); }
    catch (e) {}
  }
  return Array.from(s);
}

// 单个可见字符的显示宽度（半角单位）：CJK/全角/emoji 为 2，ASCII/半角符号为 1
function charHalfWidth(g) {
  const cp = g.codePointAt(0);
  if (cp == null || isNaN(cp)) return 1;
  return isWideChar(cp) ? 2 : 1;
}

// 宽字符判定（East Asian Width Wide/Fullwidth + 主要 emoji 区段）
function isWideChar(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK 部首 ~ 日文标点
    (cp >= 0x3041 && cp <= 0x33ff) ||   // 平假名 ~ CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 统一汉字
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 兼容表意文字
    (cp >= 0xfe10 && cp <= 0xfe6f) ||   // 竖排形式 + CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) ||   // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // 全角符号
    (cp >= 0x1f300 && cp <= 0x1faff) ||  // emoji 主要区段（含 😵💫 等）
    (cp >= 0x20000 && cp <= 0x3fffd)     // CJK 扩展 B+（生僻字）
  );
}

// 记录"最近使用"：currentRef 每次切换到一个标签都刷新 lastUseSeq，供撞上限时按"最久未用"淘汰
// ---------------- 任务计时器 ----------------
// 语义：从任务发出的那一刻开始计时；中间卡在使用者操作（waiting_user，含教我演示等待）时暂停；
// 任务结束时停止（从发完完成/失败的文字那一刻冻结，之后跑复盘不算时间）。
// 结构 { running, startAt, acc }：acc 为已冻结的活跃毫秒，running 时面板按 startAt 实时补算当前值。
function timerElapsedMs(t) {
  const tm = t && t.timer;
  if (!tm) return null;
  return tm.acc + (tm.running ? Date.now() - (tm.startAt || Date.now()) : 0);
}
function timerBegin(t) { // 新任务：清零重计
  t.timer = { running: true, startAt: Date.now(), acc: 0 };
  broadcastTimer(t);
}
function timerPause(t) { // 暂停：冻结已计部分（等你操作 / 任务到此停止）
  const tm = t && t.timer;
  if (!tm || !tm.running) return;
  tm.acc = timerElapsedMs(t);
  tm.running = false;
  broadcastTimer(t);
}
function timerResume(t) { // 恢复计时（你操作完、Agent 继续跑）
  const tm = t && t.timer;
  if (!tm || tm.running) return;
  tm.running = true;
  tm.startAt = Date.now();
  broadcastTimer(t);
}
function timerClear(t) { // 清空会话：计时归零
  if (t) t.timer = null;
  broadcastTimer(t);
}
function broadcastTimer(t) {
  const tm = (t && t.timer) || null;
  broadcast({ type: 'TIMER', timer: tm ? { running: tm.running, startAt: tm.startAt, acc: tm.acc } : null }, t && t.sid);
}

function setCurrentRef(t, ref) {
  t.currentRef = ref;
  const entry = findTabEntry(ref, t);
  if (entry) {
    t.useSeq = (t.useSeq || 0) + 1;
    entry.lastUseSeq = t.useSeq;
  }
}

// 撞 MAX_AGENT_TABS 上限时，自动淘汰本会话"最久未用"的 @T 标签腾位置。
// 跳过当前正在操作的 currentRef 与正在等加载的 waitTabId；没有可淘汰的才抛错，交给模型自己 close_tab。
async function evictLruAgentTab(t) {
  const t0 = performance.now();
  const cur = currentEntry(t);
  const curId = cur ? cur.tabId : null;
  const waitingId = t.state === 'awaiting_nav' ? t.waitTabId : null;
  const candidates = (t.tabs || []).filter(
    (e) => e.role === 'agent' && e.tabId !== curId && e.tabId !== waitingId
  ).sort((a, b) => (a.lastUseSeq || 0) - (b.lastUseSeq || 0)); // 最久未用排最前
  const victim = candidates[0];
  if (!victim) {
    throw new Error('Agent 自开标签已达上限（' + MAX_AGENT_TABS + '），且没有可自动淘汰的（当前正在使用的除外），请先 close_tab');
  }
  const tab = await getTab(victim.tabId);
  if (tab) chrome.tabs.remove(victim.tabId).catch(() => {});
  t.tabs = t.tabs.filter((e) => e.ref !== victim.ref);
  t.listTabsFresh = false; // 关掉一个标签，use_tab 需重新 list_tabs
  await saveTasks();
  // 面板行与 close_tab 动作文案一致（已关闭标签 + 标题 + 行尾 · XXms 靠右对齐），并带上被淘汰的是哪个标签；不带 @/ref/括号
  addLog(t.sid, '已关闭标签 ' + (victim.title ? midTruncate(victim.title, 24) : shortUrl(victim.url || '')) + ' · ' + Math.round(performance.now() - t0) + 'ms');
  broadcastTabs(t);
  return victim;
}

// 同一 URL 已在本会话存活的 @T 标签里打开时返回该标签（否则 null）。只在"精确相同 URL"去重，
// 避免误并不同页面；Agent 真需要全新实例时可用 navigate（重载）或先 close_tab 再 open_tab。
async function findReusableAgentTab(url, t) {
  const want = String(url || '').split('#')[0].replace(/\/+$/, ''); // 去 hash 和结尾斜杠后比较
  for (const e of t.tabs || []) {
    if (e.role !== 'agent') continue;
    const tab = await getTab(e.tabId);
    if (!tab || !tab.url) continue;
    const owner = sessionOfTab(e.tabId); // 只在本会话内去重，不跨会话复用
    if (owner && owner !== t.sid) continue;
    if (String(tab.url).split('#')[0].replace(/\/+$/, '') === want) return e;
  }
  return null;
}

// 前台执行模式（config.backgroundExec=false）下，把 Agent 刚切换/打开的标签切到浏览器前台；后台模式不切。
async function bringTabToForeground(tabId) {
  try {
    const cfg = await getConfig();
    if (!cfg.backgroundExec && tabId != null) await chrome.tabs.update(tabId, { active: true });
  } catch (e) {}
}

// 新开 Agent 标签（前台模式切前台、后台模式不抢焦点），并加入分组。display 为给使用者看的友好文案（search 用），缺省显示 url。
// 返回 { entry, reused }：reused=true 表示本会话已有一个 tab 正停在这个 URL 上，直接切过去、没新开标签。
async function openAgentTab(url, display, t) {
  const t0 = performance.now();
  t.listTabsFresh = false; // 开新页（或复用切换）后标签集/当前操作变了，use_tab 需重新 list_tabs
  const reused = await findReusableAgentTab(url, t);
  if (reused) {
    setCurrentRef(t, reused.ref);
    await saveTasks();
    await bringTabToForeground(reused.tabId); // 前台模式：复用已有标签时也切到前台
    addLog(t.sid, '复用页面 ' + shortUrl(url) + ' · ' + Math.round(performance.now() - t0) + 'ms');
    broadcastTabs(t);
    return { entry: reused, reused: true };
  }
  const agentTabs = (t.tabs || []).filter((e) => e.role === 'agent');
  if (agentTabs.length >= MAX_AGENT_TABS) {
    await evictLruAgentTab(t); // 腾一个位置再开
  }
  const cfg = await getConfig();
  const tab = await chrome.tabs.create({ url, active: !cfg.backgroundExec }); // 前台模式：新标签直接切到浏览器前台
  const ms = Math.round(performance.now() - t0);
  const ref = 'T' + ++t.tabSeq;
  const entry = { ref, tabId: tab.id, role: 'agent', title: tab.title || '', url: tab.url || url };
  t.tabs.push(entry);
  setCurrentRef(t, ref);
  await addToGroup(tab.id, t);
  await saveTasks();
  addLog(t.sid, (display || '打开页面 ' + tailTruncate(url, 32)) + ' · ' + ms + 'ms'); // 地址按统一宽度计算的尾部省略（32 半角单位），保留主机名与路径开头
  broadcastTabs(t);
  return { entry, reused: false };
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
  t.listTabsFresh = false; // 页面动作新开了标签，use_tab 需重新 list_tabs
  await addToGroup(tabId, t);
  await saveTasks();
  broadcastTabs(t);
  const advCfg = await getConfig();
  t.history.push({
    role: 'user',
    content: '页面动作新开的页面已' + (advCfg.backgroundExec ? '在后台打开' : '打开') + '并纳入任务：@' + ref + '（' + (tab.title || shortUrl(tab.url || '')) + '），属 Agent 自开，本轮结束自动关闭'
  });
  addLog(t.sid, '页面新开 → ' + (advCfg.backgroundExec ? '后台打开 ' : '打开 ') + shortUrl(tab.url || '新页面'));
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
  const MAX_TABS_OUT = 50;
  const lines = [];
  for (const tab of all) {
    const marks = [];
    if (tab.id === active) marks.push('[当前选中]');
    if (taskIds.has(tab.id)) marks.push('[任务内@' + byRef.get(tab.id) + ']');
    else if (sessionOfTab(tab.id)) marks.push('[他会话]'); // 其他任务会话的标签：use_tab 会拒绝，标注让模型别去用
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
  t.listTabsFresh = false; // 清掉一批自开标签，use_tab 需重新 list_tabs
  // 当前操作的若是自开标签，回退到使用者的标签（优先 @MAIN）
  if (t.currentRef && !(t.tabs.some((e) => e.ref === t.currentRef))) {
    const main = t.tabs.find((e) => e.role === 'main');
    t.currentRef = main ? main.ref : ((t.tabs[0] || {}).ref || null);
  }
  await saveTasks();
  broadcastTabs(t);
}

async function closeAgentTab(ref, t) {
  const t0 = performance.now();
  const entry = findTabEntry(ref, t);
  if (!entry) throw new Error('要关闭的标签不存在或已关闭：' + ref + '（先 list_tabs 确认再关）');
  if (entry.role === 'main' || entry.role === 'user') throw new Error('@' + entry.ref + ' 是使用者的标签，不可关闭');
  await chrome.tabs.remove(entry.tabId);
  t.tabs = t.tabs.filter((e) => e.ref !== entry.ref); // 用规范 ref（不带 @）比对，输入可能是 @T2
  t.listTabsFresh = false; // 关掉一个标签，use_tab 需重新 list_tabs
  if (t.currentRef === entry.ref) {
    // 回退到主标签
    const main = t.tabs.find((e) => e.role === 'main');
    t.currentRef = main ? main.ref : ((t.tabs[0] || {}).ref || null);
  }
  await saveTasks();
  // 面板行带上关闭的是哪个标签（标题/地址）与耗时（行尾 · XXms 会靠右对齐，别放中间）；不带 @/ref/括号
  addLog(t.sid, '已关闭标签 ' + (entry.title ? midTruncate(entry.title, 24) : shortUrl(entry.url || '')) + ' · ' + Math.round(performance.now() - t0) + 'ms');
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

// ---------------- 已读清单（"读 N 条"循环） ----------------
// 系统自动记录"实际点开读过的条目"，解决模型在列表返回后忘掉读没读、重复点同一篇的问题。
// 条目标识：同一页里 ref 相同（click），或点文字时标题归一后相同（clickText）。ref 是全局编号（frameIndex*1000+局部 ref），与快照元素一致。
function normTxt(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
const READ_NAV_RE = /^(下一页|上一页|首页|末页|尾页|返回|后退|关闭|收起|展开|更多|加载更多|确定|确认|取消|提交|保存|搜索)$/; // 点这些导航文字"改变页面"不算"读了一条"，不记入已读清单
function normUrlForMatch(u) {
  let s = String(u || '');
  try { s = decodeURIComponent(s); } catch (e) {}
  try { s = new URL(s).origin + new URL(s).pathname + new URL(s).search; } catch (e) {}
  return s.replace(/\/+$/, '').toLowerCase();
}
function readListMatch(t, pageKey, ref, text, href) {
  const nt = text ? normTxt(text) : '';
  const nh = href ? normUrlForMatch(href) : '';
  for (const x of (t.readList || [])) {
    if (ref != null && x.ref === ref && x.pageKey === pageKey) return x; // 同页同 ref：click 记的，ref 漂移前的强匹配
    // URL 精确匹配：列表元素 href 与已读条目 url 相同即同一条（即使标题不同，如详情标题不含列表标题）
    if (nh && x.url && normUrlForMatch(x.url) === nh) return x;
    // 标题：相等或互相包含（与显示层 readMark 一致，列表短标题 ⇄ 详情"标题 - 站点"）。不再要求同 pageKey：
    // 批内 open_tab+read 读过的条目 pageKey 记在列表页，回列表能拦到；不同页同名是软提示（模型可 open_tab 绕过）。
    if (nt && x.title && (x.title === nt || x.title.includes(nt) || nt.includes(x.title))) return x;
  }
  return null;
}
function readListForPage(t, snap) {
  return (t.readList || []).filter((x) => x.pageKey === pageKeyOf(snap.url) && x.title);
}

// ---------------- 快照消息构建 ----------------
// expBlock（可选）：本站操作经验块。放在 URL/标题与受限页提示之后、元素列表【之前】——
// LLM 要先读到历史经验再扫元素，避免经验沉在快照末尾被 90 个元素淹没（否则"加载了但没怎么用"）。
function buildSnapshotMessage(snap, expBlock, t, batchHint) {
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
    lines.push('当前页是【受限页面】（chrome://、about:、扩展管理页、新标签页等），无法注入内容脚本，你无法在此页观察或操作。任务需要在网页上完成时，请直接用 open_tab 打开对应网址（任务点名的网站：从【网站工具索引】按标题匹配拿网址原样打开），或用 search 搜索；不要在受限页上反复尝试，也不要用 navigate 跳到受限地址。');
  }
  if (expBlock) lines.push(expBlock);
  if (batchHint) lines.push(batchHint);
  // 已读清单块：本页（通常是列表页）里已实际点开读过的条目，放在元素列表【之前】让 LLM 先看到"哪些已读、别重复点"
  const readList = readListForPage(t, snap);
  if (readList.length) {
    lines.push('【已读清单】（系统自动记录：本页你已点开读过 ' + readList.length + ' 条，对应列表元素已标【已读】。这些不要重复点，从列表中点【未读】的下一条标题继续读）');
    for (const x of readList) lines.push('· ' + x.title);
  }
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
      // 已读标记：ref 匹配优先（同一页同 ref）；点文字记入的（无 ref）按标题归一匹配，点文字常用短词（如「百果园真是疯了」点中「百果园真是疯了！！」），再兜底前缀互含。
      // 采到正文的标【已读】（重复点会被拦截）；没采到正文的标【已读·可重开】（正文丢了，允许重开补读）
      let readMark = '';
      for (const x of readList) {
        if (x.ref != null) {
          if (el.ref === x.ref) { readMark = x.content ? ' [已读]' : ' [已读·可重开]'; break; }
        } else if (x.title && el.text) {
          const a = normTxt(x.title), b = normTxt(el.text);
          if (a === b || a.startsWith(b) || b.startsWith(a)) { readMark = x.content ? ' [已读]' : ' [已读·可重开]'; break; }
        }
      }
      // 不把 CSS 选择器喂给 LLM：对决策是噪音且很占 token；ref 才是它用来定位动作的
      // 链接地址：只暴露真实 http(s) 地址，跳过 javascript:/mailto:/页内锚点/与当前页同址（页内跳转）。
      // 用途：模型从列表元素的 →地址 攒详情 URL，批量 open_tab + read，不必逐个点开。
      // 不给完整地址不行：open_tab 需要模型原样复制 →地址，任何截断（如 midTruncate 的 …）都会被模型
      // 原样当成 URL 发回来、浏览器把 … 编码成 %E2%80%A6 开出一个坏 tab。完整地址成本由元素窗口本身控制。
      let hrefTxt = '';
      if (el.href && /^https?:/i.test(el.href)) {
        try {
          const elU = new URL(el.href);
          const base = new URL(snap.url || '');
          if (!(elU.origin === base.origin && elU.pathname === base.pathname && elU.search === base.search)) {
            hrefTxt = ' →' + elU.href;
          }
        } catch (_) {}
      }
      lines.push(
        `[${el.ref}] ${el.role} "${label}"` +
        (el.value ? ` 值=${el.value}` : '') +
        hrefTxt +
        (el.disabled ? ' [disabled]' : '') +
        readMark
      );
    }
  }
  // 元素窗口翻页提示：每批 REF_WINDOW_SIZE 个 ref。more=true（本批收满、页面还有更多）时教模型翻下一页；
  // 已在后续批且是最后一页时提示可回第一批。普通页面（元素不满一批）不触发、零成本。
  const off = snap.offset || 0;
  if (snap.more) {
    lines.push('（元素窗口：第 ' + (Math.floor(off / REF_WINDOW_SIZE) + 1) + ' 批 · offset=' + off + '，每批最多 ' + REF_WINDOW_SIZE + ' 个。目标不在列表中时，用 {"action":"snapshot","offset":' + (off + REF_WINDOW_SIZE) + '} 翻下一批看更多元素）');
  } else if (off > 0) {
    lines.push('（元素窗口：第 ' + (Math.floor(off / REF_WINDOW_SIZE) + 1) + ' 批 · offset=' + off + '，已是最后一页；要找第一批的元素用 {"action":"snapshot","offset":0}）');
  }
  if (snap.canvas && Array.isArray(snap.canvas.text) && snap.canvas.text.length) {
    lines.push('【画布文字】（画布渲染的可见内容：正文画在 canvas 上、DOM 里读不到，坐标是视口坐标。表格类页面优先用 gotoCell 按格号定位（如 gotoCell D8）再 F2 编辑，比坐标稳；坐标也可直接 clickAt/dblclickAt 点选。操作后页面会重画，重新快照可读到新位置/新值）');
    for (const it of snap.canvas.text) {
      lines.push(`· "${it.t}" @(${it.x},${it.y})` + (it.f ? ' · ' + it.f : ''));
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
const MAX_MERGED_ELEMENTS = 120;  // 合并后元素总数上限，防刷爆上下文（≥ 主窗口 MAX_ELEMENTS，避免单帧页面被 90 截断）
const REF_WINDOW_SIZE = 100;      // 每批元素窗口大小（= content.js MAX_ELEMENTS）：翻页每批最多这么多 ref
const MAX_SNAPSHOT_OFFSET = 9900; // snapshot 翻页 offset 上限，防模型无限翻页死循环
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

// 任务收尾（完成/失败/清空/删会话）还原被 show 强制显示的元素：Agent 自开标签会被关闭无需处理，
// 使用者的标签（@MAIN/@U）页面上被 show 的菜单若不还原会常驻到刷新。遍历会话内使用者标签的所有窗口发 hide。
async function restoreShownOnSession(t) {
  const tabs = (t.tabs || []).filter((e) => e.tabId && (e.role === 'main' || e.role === 'user'));
  for (const e of tabs) {
    try {
      const frames = await frameList(e.tabId);
      for (const f of frames) {
        await chrome.tabs.sendMessage(e.tabId, { type: 'EXECUTE_ACTION', action: { action: 'hide' } }, { frameId: f.frameId }).catch(() => {});
      }
    } catch (err) {}
  }
}

// 读取合并快照：主窗口 + 各子窗口，ref 全局唯一偏移，元素带 frameId/frameIndex。
// offset：主窗口翻页窗口偏移（每批 REF_WINDOW_SIZE 个，见 content.js buildSnapshot）；子窗口始终从第一批读。
// 子窗口读取失败容忍（跨域受限 / 还在加载）；主窗口失败抛错，让上层按原逻辑重试。
async function readSnapshotWithFrames(tabId, offset = 0) {
  // 1) 先读主窗口——它 DOM 里的直接 iframe 清单是"弹层 iframe 确实存在"的硬证据，
  //    用来交叉校验 getAllFrames 枚举是否完整（弹层/卡片 iframe 常被读漏，导致"窗口数 1↔2 跳动"）。
  //    主窗口可能因页面主线程繁忙而迟迟不回（sendMessage 会一直 pending），带 8s 超时兜底，
  //    超时按失败走上层重试 → awaitNav → waitTabReady 轮询恢复，避免"整轮干等无超时"。
  const mainSnap = await sendTab(tabId, { type: 'GET_SNAPSHOT', offset }, 8000); // offset：翻页窗口起始
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
  merged.canvas = mainSnap.canvas; // 画布文字（画布渲染页面的可见内容）——只取主窗口的画布文字，子窗口的暂不合并
  merged.offset = offset;         // 翻页：本次窗口起始偏移（0 = 第一批），供快照提示用
  merged.more = !!mainSnap.more;  // 主窗口元素超过窗口上限 = 还有下一批可翻，供快照提示用
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
      snap = await sendTab(tabId, { type: 'GET_SNAPSHOT' }, 3000, { frameId: f.frameId }); // 3s 超时：子窗口繁忙跳过，不影响主窗口
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
  merged.excerpt = String(merged.excerpt || '').slice(0, 6000); // 汇总摘要设上限，防 iframe 海量刷爆
  return merged;
}

// ---------------- Agent 循环 ----------------
// 正在执行 agentStep（含批后/单动作后的链式续步）的会话深度计数。心跳的"停滞恢复"先看它：
// 只要还有 step 在跑（慢快照 / 慢 LLM / 批完再读页的续步），就绝不并发拉起新的 agentStep，
// 否则心跳会误判停滞、跑出双份 LLM 请求和双份动作执行。深度计数而非 bool：外层 agentStep
// 里会链式再调 agentStep（nextStepOrBatch 续步 / runActionBatch 批完重读页），两者是同一逻辑链。
const agentStepDepth = {}; // sid → 栈深度（外层 step + 链式续步）
const reviewRunning = {};  // sid → true（后台复盘进行中；内存态，SW 重启后自然清空，供 alarm 恢复路径防并发起跑）

async function agentStep(t) {
  if (!t || t.state !== 'working') return;
  const myTurn = t.turnId;
  if (!stillCurrent(t, myTurn)) return;
  const sid = t.sid;
  agentStepDepth[sid] = (agentStepDepth[sid] || 0) + 1;
  try {
    return await agentStepInner(t); // 异常原样上抛，沿用调用方各自的 .catch(fail) 处理
  } finally {
    agentStepDepth[sid]--;
    if (!agentStepDepth[sid]) delete agentStepDepth[sid];
  }
}

async function agentStepInner(t) {
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
  const t0 = performance.now(); // 计时：快照读取耗时，用于"浏览页面 xxx · Nms"
  let snap = null;
  let lastSnapErr = null;
  // 元素窗口翻页偏移：只对同一 URL 生效（换页/导航/切标签后 URL 变了，自动回第一批）。
  let wantOffset = 0;
  if (curTab && t.snapOffsetUrl === curTab.url) wantOffset = t.snapOffset || 0;
  else t.snapOffset = 0;
  if (curTab && isRestrictedUrl(curTab.url)) {
    addLog(t.sid, '受限页面，自动打开相关网页', true);
    snap = { url: curTab.url, title: curTab.title || '', elements: [], excerpt: '', restricted: true };
  } else {
    // 等-动：读快照前先确保当前操作标签就绪（替代 open_tab/navigate 操作后的 awaitNav——等待前移）
    await ensureCurrentOpReady(t, myTurn);
    for (let i = 0; i < 3 && !snap; i++) {
      try {
        await ensureContentScript(tabId);
        snap = await readSnapshotWithFrames(tabId, wantOffset); // 合并主窗口 + iframe 子窗口；wantOffset 翻页看下一批
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
      waitTabReady(t, tabId, myTurn); // 兜底：快照失败前 AGENT_READY/onUpdated 可能已广播被挡，轮询补上恢复信号
      return;
    }
  }
  if (!stillCurrent(t, myTurn)) return;

  t.snapOffset = wantOffset;           // 记住本次实际生效的窗口偏移
  t.snapOffsetUrl = snap.url || '';    // offset 所属页面 URL（以 content 读到的为准，可能比 chrome tab.url 新）
  t.snapFrames = (snap && Array.isArray(snap.frames)) ? snap.frames : []; // 供动作路由把全局 ref 拆回 (frameId, 局部 ref)
  t.curPageSig = pageSigOf(snap); // 记录当前页面状态指纹，供"无进展计数"判断重复动作时页面是否真的变了
  // 页面熟悉度：本次快照成功后计数 +1，达到阈值且未失败过 → 本步允许批量动作。
  // 失败（pushFailure 清零该页计数）后恢复谨慎模式：单动作 + 每步读页，连续成功几步再放开。
  const pageKey = pageKeyOf(snap.url);
  t.snapElements = Array.isArray(snap.elements) ? snap.elements : []; // 供已读清单记录解析点击目标文字（点击结果 label 是通用"标题"，ref 要回查快照元素取标题）
  t.snapUrl = snap.url || ''; // 已读清单的页面归属：动作发出时所在的页面
  t.snapTitle = snap.title || ''; // 供重复点击计数判断"页面是否真的跳走/推进"（url/标题一变即视为进展）

  // ---- 轮级"无进展"计数（改）：stuck 只抓连续两步完全相同、sigRepeat 只抓同一(动作,label)反复，都漏掉
  // "每轮换动作、动作全成功、但页面/计划纹丝不动"的静默空转。信号纯通用：上一轮页面指纹没变 + 无失败 → +1。
  // （"计划是否推进"的清零放在本轮收尾做——那里 merge 完才知道计划动没动；页面指纹也存好供下一轮比对。）
  const pageChangedRound = !!(t.curPageSig && t._prevRoundSig && t.curPageSig !== t._prevRoundSig);
  t._roundUnDoneStart = (t.plan || []).filter((s) => !s.done).length; // 本轮起始未完成步数（上轮最终计划），收尾对照判断"计划是否推进"
  // 只统计"上一轮试过改页面"的轮：纯读/滚/hover 是观察性轮，中性不计；动作轮页面/计划纹丝不动才累计。
  if (t._lastRoundMutated) {
    if (pageChangedRound || t.failStreak > 0) {
      t.unprodStreak = 0;
    } else {
      t.unprodStreak = (t.unprodStreak || 0) + 1;
      // 只在刚 +1 的这轮检查阈值（否则 streak 停在阈值时来一轮纯读轮会重复触发提醒）
      if (t.unprodStreak === UNPROD_REMIND_LIMIT) {
        t.history.push({ role: 'user', content: '注意：你已经连续 ' + t.unprodStreak + ' 轮在这个页面上操作，页面状态和步骤计划都没有任何推进（动作都成功执行了、结果却不变）。不要再重复相似操作。先 read 看当前页面实际状态、对照快照里的【本站操作经验】找正确做法、用 clickText 按列表里真正出现的文字点，或换一条完全不同的路径；实在不知道怎么继续，用 ask_user（mode=teach）请使用者手把手演示。' });
        addLog(t.sid, '无进展警示：连续 ' + t.unprodStreak + ' 轮页面与计划均无推进，提醒换招', true);
      } else if (t.unprodStreak >= UNPROD_TEACH_LIMIT) {
        await askUser(t, '我连续 ' + t.unprodStreak + ' 轮在这个页面上反复操作，页面状态和步骤计划都没有任何推进（动作都成功了但结果不变）。' + currentStepNote(t) + '请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
        return;
      }
    }
  }

  // ---- 已读正文采集：刚点开的详情页快照（页面 key 与点开前不同）→ 把正文摘要附到对应已读条目上。
  // 上下文压缩会把历史里这些正文并入(有损)摘要甚至删掉，而 readList 独立存于任务对象不受压缩影响——总结时靠这里保真。
  // 匹配：从最新往回找"还没采到正文、且不在点开前页面(列表页)"的条目，只认详情页标题含条目标题（或互为前缀）。
  // 不用正文摘要兜底：详情页的摘要常含"相关推荐/猜你喜欢"列表，会把别的条目标题匹配进来造成假采集（守卫误拦→死锁）。
  if (t.readList && t.readList.length) {
    const curKey = pageKeyOf(snap.url);
    const snappedTitle = normTxt(snap.title || '');
    if (snappedTitle) {
      for (let i = t.readList.length - 1; i >= 0; i--) {
        const r = t.readList[i];
        if (r.content || r.pageKey === curKey) continue; // 已采过，或还停在点开前的列表页（避免把列表摘要误当成详情）
        const t1 = normTxt(r.title || '');
        if (!t1 || t1.length < 2) continue;
        if (snappedTitle.includes(t1) || t1.includes(snappedTitle)) {
          r.content = String(snap.excerpt || '').trim().slice(0, 800); // 单条正文要点上限 800 字（压缩后总结仍可用的保真记录）
          break;
        }
      }
    }
  }
  t.pageSnapCounts = t.pageSnapCounts || {};
  t.pageSnapCounts[pageKey] = (t.pageSnapCounts[pageKey] || 0) + 1;
  const batchReady = cfg.batchEnabled !== false && t.pageSnapCounts[pageKey] >= BATCH_FAMILIAR_THRESHOLD;
  // 本站操作经验：每次操作某网站相关的动作前，先加载该网站沉淀过的经验。
  // 以 expBlock 传入 buildSnapshotMessage，插在元素列表【之前】，让 LLM 先读到历史经验再扫元素，
  // 避免经验沉在快照末尾被元素列表淹没（"加载了但没怎么用"的主因）。
  let expBlock = '';
  let expCount = 0;
  const snapHost = hostOf(snap.url);
  if (snapHost) {
    const tt0 = performance.now();
    const exps = await getSiteExperiences(snapHost);
    expCount = exps.length;
    // 记住本页加载的经验指纹：exec_code 新鲜度闸门靠它判断"快照里的经验编号"是否仍与当前库一致
    t._expRef = { host: snapHost, sig: expSig(exps) };
    if (expCount) {
      expBlock = '【本站操作经验】（该网站历史操作经验，持续有效：决策前先对照再选元素，避免绕弯路；若某条与当前页面明显冲突/已改版，说明已过期，跳过它、以当前页面为准；[经验N] 是该条在本次快照里的编号，可用动作 {"action":"exec_code","idx":N,"args":{参数名:值}} 直接执行它写好的代码一步完成）\n' + exps.map((x, i) => expSnapLine(i, x)).join('\n');
      if (snapHost !== t.lastExpHost) { // 同一站点每会话只在首次进入时显示一次加载提示
        t.lastExpHost = snapHost;
        addLog(t.sid, '加载该网站的经验 ' + expCount + ' 条 ' + Math.round(performance.now() - tt0) + 'ms');
      }
    }
  }
  // 浏览页面日志：优先页面标题（document.title，即快照时 LLM 看到的名字）；标题空（页面仍在加载/SPA 后置标题）时
  // 再取 Chrome 标签当前标题（快照读取这几百毫秒页面通常已加载完、标题已就位），最后才退回短 URL。
  const freshTab = await getTab(tabId);
  const viewTitle = snap.title || (freshTab && freshTab.title) || shortUrl(snap.url);
  addLog(t.sid, '浏览页面 ' + midTruncate(viewTitle, 32) + ' · ' + Math.round(performance.now() - t0) + 'ms');
  // 批量模式提示：熟悉页面明确告知 LLM 可一次输出多个动作（且给出批内定位约束），减少 LLM 往返
  const batchHint = batchReady
    ? '【批量模式】本页你已经熟悉（历史操作稳定成功），默认就该批量输出。请尽量**往大了合**：本步一次给出最多 ' + MAX_BATCH + ' 个连续动作（{"actions":[{...},{...},...]}）。重复性循环（逐条勾选、连续填表、列表内翻页、读多条详情、逐行操作这类同构步骤）务必合成一批，别再一步步单动作空转——**能确定的动作不要只合两三个就收手**。**读多条详情页**（读 N 条/读多页再总结）用批量跨页读法：从列表快照链接元素的 →地址 攒 URL，一批 open_tab 逐个新开详情页（可先一次开好几个、再逐个 switch_tab + read，让几个页面并行加载），系统会在真正 read 前自动等页面就绪、单页加载不打断整批，这一批读到的所有正文批末一次性返回给你——**别逐条点开-返回**。仅当下一步必须看到本步结果才能决定时才输出单个动作。批内约束：动作执行后才出现的元素不能用 ref 引用（ref 来自当前快照、执行时可能已失效），要用 clickText 按文字 / clickAt·dblclickAt 按坐标 / gotoCell 按格号定位；snapshot、finish、ask_user 放批尾（执行到它们本批收尾），open_tab/search/navigate/switch_tab/use_tab/close_tab 可在批内任意位置（系统会跨页自动等就绪）。确认生效用短读（read 的 target 指向批内动作涉及的具体元素）或依赖下一张快照回显；点开条目/翻页后，正文通常已由下一张快照的正文摘要提供（含画布文字），此时批内不必整页 read；但若正文摘要/元素列表里**没出现**目标正文（如正文仍在加载、正文在图片上、只见推荐/相关列表），说明快照没抓到正文，**就必须整页 read**（target:"page"）——点了不等于读了。'
    : '【谨慎模式】本页你还不熟悉（首次进入或刚出过错），一次只输出一个动作，系统会重新观察页面后再继续。';
  let snapMsg = buildSnapshotMessage(snap, expBlock, t, batchHint);
  t.history.push({ role: 'user', content: snapMsg, kind: 'snapshot' }); // kind 标记快照，buildMessages 只发最近 MAX_SNAPSHOT_KEEP 次
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;

  // 2) LLM 决策：先检查上下文水位，达到 70% 阈值时自动压缩历史释放空间
  await maybeCompress(t);
  if (!stillCurrent(t, myTurn)) return;

  // 2) LLM 决策（JSON 解析失败可重试）；单动作对象与批量 {actions:[...]} 都接受，解析结果一律为动作数组
  const thinkT0 = performance.now(); // 思考耗时起点：决策完成后给"思考下一步…"那行补 XXms
  addLog(t.sid, '思考下一步…'); // 可见进度：LLM 决策期间不再"无声"——看到这行后停顿说明在等 LLM（最多 LLM_TIMEOUT_MS 超时兜底）；这行都没出现说明卡在快照读取
  let actions = null;
  let stepsIn = null; // 模型每轮随 actions 顺带输出的步骤计划（[{text,done}]）
  let lastErr = null;
  for (let i = 0; i < MAX_STEP_LLM_RETRY && !actions; i++) {
    let raw = null;
    try {
      const msgs = await buildMessages(t);
      raw = await callLLM(msgs, undefined, t);
      logLLMExchange(t, msgs, raw); // 记录大模型往返（发送简况 + 原始返回），供面板"日志"视图排查
      console.log('[PageAgent] LLM 原始输出：' + String(raw).slice(0, 800));
      const parsed = parseAction(raw);
      actions = parsed.actions;
      stepsIn = parsed.steps;
      if (actions.length > MAX_BATCH) { // 超出上限的批直接作废重试，逼 LLM 收敛（批超长通常是复读/跑飞）
        throw new Error('批量动作超过上限 ' + MAX_BATCH + ' 个（' + actions.length + '）');
      }
    } catch (e) {
      lastErr = e;
      addLog(t.sid, 'LLM 输出解析失败（' + (i + 1) + '/' + MAX_STEP_LLM_RETRY + '）：' + e.message + (raw ? ' 原文=' + midTruncate(raw, 100) : ''), true); // 100：错误调试原文，预算放宽到约原 100 字符（半角单位），宽度感知
      console.warn('[PageAgent] LLM 调用/解析异常：' + e.message);
      await sleep(800 * (i + 1)); // 退避：0.8s / 1.6s / 2.4s / 3.2s，应对偶发空白/限流
    }
  }
  if (!actions || !actions.length) {
    fail(t, 'LLM 连续返回无效动作：' + (lastErr && lastErr.message));
    return;
  }
  if (!stillCurrent(t, myTurn)) return;

  // 步骤计划：模型每轮随 actions 顺带输出 steps（首轮拆解、后续轮更新 done），面板实时划线；无变化不重复广播。
  // 用 mergePlan 合并而非整表替换：模型重发时文本小漂移/漏标 done 不会撤销已划线的步骤。
  if (stepsIn) t._stepsOmitStreak = 0; // 模型带了 steps：连续省略计数清零
  const mergedPlan = mergePlan(t.plan, stepsIn);
  if (mergedPlan && JSON.stringify(mergedPlan) !== JSON.stringify(t.plan)) {
    t.plan = mergedPlan;
    broadcast({ type: 'AGENT_PLAN', steps: t.plan }, t.sid);
    await saveTasks();
  } else if (t.plan && t.plan.length && !stepsIn && t.plan.some((s) => !s.done)) {
    // 模型省略了 steps 更新（计划还远未完成）：轻提醒一次，别让它把步骤进度丢了——面板划线全靠它置 done。
    // 节流：首丢立即提醒、之后每 3 轮再提醒一次，避免每轮都打断。
    t._stepsOmitStreak = (t._stepsOmitStreak || 0) + 1;
    if (t._stepsOmitStreak === 1 || t._stepsOmitStreak % 3 === 0) {
      t.history.push({ role: 'user', content: '（提醒：你上一轮没有随动作输出 steps 更新步骤计划。若已完成某步，请在本轮 steps 里把对应项 done 置 true，面板才会划线；不要省略 steps。步骤文本保持本轮清单不变、只改 done 即可。）' });
      // 提醒行不在这里打：决策收尾的 updateLog 会改写"最后一条 activity 行"来给"思考下一步…"补耗时，
      // 若这行先插入，"思考下一步…"那行会被挤到倒数第二条、永远不带 ms，还多出一个被改写成"思考下一步… XXms"的重复行。
      t._stepsReminderLog = true;
    }
  }

  // 本轮收尾：记下页面指纹 + 未完成步数 + 是否试过改页面，供下一轮"有无进展"判定；计划比本轮开始更短 = 真推进，清零无进展计数。
  t._prevRoundSig = t.curPageSig;
  t._lastRoundMutated = actions.some((a) => MUTATE_ACTIONS.has(a.action));
  const unDoneNow = (t.plan || []).filter((s) => !s.done).length;
  if (unDoneNow < (t._roundUnDoneStart || 0)) t.unprodStreak = 0;

  // 决策完成：给"思考下一步…"那行补上耗时（面板改写最后一条 activity 行；决策期间无其他 activity 插入，安全）
  updateLog(t.sid, null, '思考下一步… ' + Math.round(performance.now() - thinkT0) + 'ms');
  // 步骤省略提醒行补打：必须在 updateLog 之后（见上面标记处说明），让"思考下一步…"那行稳定带耗时。
  // quiet：喂模型的提醒（history 里那行）才是真正起作用的，面板这行是内部过程噪音、用户不需要看
  if (t._stepsReminderLog) { t._stepsReminderLog = false; addLog(t.sid, '步骤计划提醒：模型本轮省略 steps，已提示补报完成进度', true); }

  // 单动作存对象（兼容 isReadAction 的历史配对压缩），批量存数组
  const stored = actions.length === 1 ? actions[0] : actions;
  t.history.push({ role: 'assistant', content: JSON.stringify(stored) });
  t.lastActiveAt = Date.now();
  addLog(t.sid, '决策：' + JSON.stringify(stored), true); // 原始动作保留在诊断日志，面板不显示
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;

  // 3) 执行动作（单动作走 runAction；多个走 runActionBatch 连续执行，批内失败即整体收尾重规划）
  await runActionBatch(t, actions);
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
  let total = 0;
  try {
    const tree = await chrome.bookmarks.getTree();
    const lines = [];
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
  return total; // 总条数（供调用方显示"加载书签索引 N 条"）
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

// 复盘入口：收集本轮访问过的站点 → LLM 筛选 → 写入书签（新网址收藏；已收藏的合并改进标题。尽力而为，失败不影响任务完成）
async function reviewAndBookmark(t, force, pinnedTurn, reviewSteps) {
  if (!t) return;
  // force：停止后复盘用（state 已回 idle，仍要跑复盘）；正常 finish 复盘时 force 为空，保持"仅 working 时复盘"
  if (!force && t.state !== 'working') return;
  const myTurn = (pinnedTurn != null) ? pinnedTurn : t.turnId; // 钉住停止那一刻的回合号，中途新指令会打断复盘
  const sites = collectVisitedSites(t);
  if (!sites.length) return;
  // 进度行：只是"正在复盘"的动作提示（非成果），用「本次…复盘中…」与结果行的「复盘网站：」前缀区分开
  addLog(t.sid, '本次访问过 ' + sites.length + ' 个网站，完成 ' + (reviewSteps || 0) + ' 步动作，复盘中…');
  const picks = await pickBookmarks(t, sites);
  if (!stillCurrent(t, myTurn, force)) return; // 筛选期间被新指令打断
  if (!picks.length) return;
  addLog(t.sid, '复盘网站：筛选出 ' + picks.length + ' 个有用站点'); // 成果：LLM 从访问过的网站里筛出值得收藏的
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
  if (added > 0) addLog(t.sid, '复盘：收藏了 ' + added + ' 个网站');
  if (updated > 0) addLog(t.sid, '复盘：改进了 ' + updated + ' 个书签的使用技巧');
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
      for (const a of histActionList(m.content)) { // 兼容单动作与批量数组
        if (a && typeof a === 'object' && a.url && (a.action === 'open_tab' || a.action === 'navigate' || a.action === 'search')) {
          add(String(a.url));
        }
      }
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
        '值得收藏的都挑出来，不限制条数；都不值得收藏就输出 {"bookmarks":[]}。'
    }
  ];
  try {
    const raw = await callLLM(msgs, undefined, t);
    await logLLMExchange(t, msgs, raw, '复盘·书签筛选'); // 复盘的过程也要进导出日志（② 大模型返回节），否则日志里看不出筛了哪些站、为何筛选
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
    addLog(t.sid, '复盘：收藏 ' + title, true); // 明细留 console，活动日志只报"收藏了 N 个网站"总数
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
  addLog(t.sid, '复盘：' + (update.title ? '改进既有书签的使用技巧：' + merged : '规整书签 URL 为根：' + url), true); // 明细留 console，活动日志只报"改进了 N 个"总数
  return 'updated';
}

// 键名 → 中文显示名（仅日志展示用；实际派发按键事件仍用浏览器键名 Enter/ArrowDown 等，见 content.js）
const KEY_CN = {
  Enter: '回车', Escape: 'Esc', Tab: 'Tab', Backspace: '退格',
  ArrowUp: '上方向键', ArrowDown: '下方向键', ArrowLeft: '左方向键', ArrowRight: '右方向键',
  ' ': '空格', Space: '空格', Delete: '删除', Insert: '插入', Home: '起始', End: '末尾',
  PageUp: '上翻页', PageDown: '下翻页', Shift: 'Shift', Control: 'Ctrl',
  Alt: 'Alt', Meta: 'Cmd', Command: 'Cmd', CapsLock: '大写锁定',
};
function cnKeys(s) {
  return String(s || '').split(',').map((k) => (k.trim() ? KEY_CN[k.trim()] || k.trim() : k)).join(',');
}

// 把动作转成给使用者看的极简文案：只报"做了什么 · Nms"，不带标签/输入值/按键等细节，保持列表清爽
function friendlyAction(a, res, ms) {
  const msTxt = ms != null ? ' · ' + ms + 'ms' : '';
  const label = (res && (res.label || res.targetLabel)) || '';
  const T = (s) => s + msTxt;
  const short = (s) => midTruncate(s, 32); // 宽度截断：16 个汉字 / 32 个英文符号
  // 目标是 iframe 子窗口元素时标注（子窗号·局部ref），方便核对 Agent 到底在不在点弹层里的目标
  const frameNote = (typeof a.target === 'number' && a.target >= FRAME_REF_BASE)
    ? '（子窗' + Math.floor(a.target / FRAME_REF_BASE) + '·ref' + (a.target % FRAME_REF_BASE) + '）'
    : '';
  switch (a.action) {
    case 'click': return T('点击' + (label ? '「' + short(label) + '」' : '') + frameNote);
    case 'clickAt': return T('点坐标(' + (Number.isFinite(Number(a.x)) ? Math.round(a.x) : '?') + ',' + (Number.isFinite(Number(a.y)) ? Math.round(a.y) : '?') + ')');
    case 'dblclickAt': return T('双击坐标(' + (Number.isFinite(Number(a.x)) ? Math.round(a.x) : '?') + ',' + (Number.isFinite(Number(a.y)) ? Math.round(a.y) : '?') + ')');
    case 'gotoCell': return T('跳格到 ' + String(a.ref || '?'));
    case 'clickText': return T('按文字点「' + midTruncate(a.text, 32) + '」' + (typeof a.frame === 'number' && a.frame > 0 ? '（子窗' + a.frame + '）' : ''));
    case 'clickSelector': return T('按选择器点「' + midTruncate(a.selector, 32) + '」' + (typeof a.frame === 'number' && a.frame > 0 ? '（子窗' + a.frame + '）' : ''));
    case 'uploadFile': return T('上传文件' + (a.filename ? '「' + short(a.filename) + '」' : ''));
    case 'pasteRich': return T('粘贴富文本' + (label ? '「' + short(label) + '」' : '') + frameNote);
    case 'readCss': return T('读计算样式' + (label ? '「' + short(label) + '」' : '') + frameNote);
    case 'pageInfo': return T('读页面信息');
    case 'getJsErrors': return T('读 JS 错误' + (res && res.ok && typeof res.count === 'number' ? '（' + res.count + ' 条）' : ''));
    case 'clearJsErrors': return T('清空 JS 错误' + (res && res.ok && typeof res.cleared === 'number' ? '（' + res.cleared + ' 条）' : ''));
    case 'hover': return T('悬浮' + (label ? '「' + short(label) + '」' : '') + frameNote);
    case 'show': return T('强制显示' + (a.text ? '「' + short(a.text) + '」' : (a.selector ? '「' + short(a.selector) + '」' : (label ? '「' + label + '」' : ''))) + frameNote);
    case 'hide': return T('还原显示' + (a.target != null ? frameNote : ''));
    case 'type': return T('输入' + (short(a.text) ? '「' + short(a.text) + '」' : (label ? '「' + label + '」' : '')) + frameNote);
    case 'select': return T('选择' + (short(a.value) ? '「' + short(a.value) + '」' : (label ? '「' + label + '」' : '')) + frameNote);
    case 'scroll': {
      // 页面未滚动（可能滚的是内层容器）不追加括号标注：行尾保持耗时，" · 366ms" 才能在面板拆出右对齐
      return T(a.direction === 'up' ? '向上滚动' : '向下滚动');
    }
    case 'read': return T('读取页面');
    case 'snapshot': return T('翻元素窗口到第 ' + (Math.floor((Number(a.offset) || 0) / REF_WINDOW_SIZE) + 1) + ' 批');
    case 'keypress': {
      const keys = String(a.keys || '').trim();
      return T('按键' + (keys ? ' ' + cnKeys(keys) : (label ? '「' + short(label) + '」' : '')));
    }
    case 'save_file': return T('保存文件');
    case 'bookmarks_write': return T('收藏书签');
    case 'bookmarks_read': return T('读取书签');
    case 'bookmark_find': return T('查找书签');
    case 'switch_tab': return T('切换标签');
    case 'list_tabs': return T('列出标签');
    case 'use_tab': return T('纳入标签');
    case 'close_tab': return T('关闭标签');
    case 'exec_code': return T('复用经验「' + short(a._scene || ('经验' + (a.idx != null ? a.idx : '?'))) + '」');
    case 'wait': return '假装人类发呆 ' + (a.ms || 0) + 'ms';
    default: return (a.action || '') + msTxt;
  }
}

// 无进展计数（t.stuck）阈值：连续失败 / 反复执行同一动作 / 空等累计到此值 → 主动请使用者手把手演示（ask_user mode=teach）
const STUCK_TEACH_LIMIT = 5;

// 同一目标重复点击检测（改4）的上限：与 stuck 互补——stuck 只抓"连续两步完全相同"，这里抓"跨多步反复点到同一个
// （动作+结果 label）且页面 url/标题没变"。达到 REPEAT_ACTION_LIMIT 次提醒换招；翻倍到 REPEAT_TEACH_LIMIT 次仍无变化
// 则主动请使用者手把手演示（不再无限重试，口径与 stuck 转教我一制）。
const REPEAT_ACTION_LIMIT = 3;   // 同一目标重复且结果 label 不变累计到此值 → 提醒换招（"强制换招"的提醒点）
const REPEAT_TEACH_LIMIT = 6;    // 同一目标重复到此时（结果仍无变化）→ 升级为请使用者手把手演示

// 轮级"无进展"计数（t.unprodStreak）：与 stuck / sigRepeat 互补——stuck 只抓"连续两步动作签名完全相同"、
// sigRepeat 只抓"同一（动作+结果label）反复出现"，两者都漏掉"每轮换动作、动作全部成功、但页面状态和步骤计划
// 纹丝不动"的静默空转（08-17 会话 63 轮里 30+ 轮在 全选→下载→本月→hover 之间轮转、一次进展都没有就属这种）。
// 这里按"轮"累计：上一轮页面指纹没变 + 无失败 → +1；页面变 / 计划推进 / 失败 / 请使用者 → 清零。
const UNPROD_REMIND_LIMIT = 3;   // 连续 N 轮"无可见进展" → 把提醒写进历史（本轮模型能看到），强制换招
const UNPROD_TEACH_LIMIT = 6;    // 翻倍仍无进展 → 升级为请使用者手把手演示（硬停，不再空转，口径与 stuck 转教我一制）

// "试过改变页面"的动作族：只有这类动作的轮才计入轮级无进展（静默空转的特征是"动了但没变化"）。
// 纯观察轮（read/scroll/pageInfo/hover/wait 等）不计数——长页阅读任务页面指纹同样不变，误计会把正常阅读当卡死。
const MUTATE_ACTIONS = new Set(['click', 'clickAt', 'dblclickAt', 'clickText', 'clickSelector', 'type', 'select', 'keypress', 'gotoCell', 'uploadFile', 'pasteRich', 'show', 'hide', 'exec_code']);

// 功能型通用 label（elementLabel 对无文字元素退回"按钮/链接/搜索框"这类功能名）：
// 它们不构成 ref 漂移证据，label 比对时排除，避免正常点击被误报。
const GENERIC_LABELS = new Set(['按钮', '链接', '搜索框', '输入框', '下拉框', '复选框', '单选框', '开关', '滑块', '标签页', '菜单项', '菜单', '选项', '单元格名称框', '上传', '日期', '时间', '数字输入框', '密码输入框', '邮箱输入框', '手机号输入框', '网址输入框', '文本框', '编辑区', '空编辑区']);

// 重复点击计数是否被"页面跳走了"打断：url/标题一变就是真的在推进（翻页/进详情），同一目标的计数作废重来。
function repeatPageMoved(t, prev) {
  return !prev || String(t.snapUrl || '') !== String(prev.url || '') || String(t.snapTitle || '') !== String(prev.title || '');
}

// 页面动作签名：用于识别"假装人类停顿后又重复执行同一个动作"的无进展循环（如连续两次 click 同一 ref）
function sigOf(a) {
  const p = a.ref || a.selector || a.target || a.url || a.key || a.text || a.offset || '';
  return a.action + ':' + String(p);
}
// a.offset 纳入签名：翻页每翻一页算新动作，不会被"反复执行同一动作"误判为无进展

// 页面状态指纹：判断"两次动作之间页面是否真的变了"（变了=有进展，没变=原地打转）。
// 用 url+标题+可交互元素数+正文长度做轻量指纹：翻页/加载出新内容时元素数与正文都会变；卡死循环则完全一致。
function pageSigOf(snap) {
  if (!snap) return '';
  const els = (snap.elements || []).length;
  // 帧 url 拼进指纹：动态新开的 iframe（如新建弹窗）即使顶层页面没变，也算页面状态变了
  const frameSig = (snap.frames || []).map((f) => f.url).join(',');
  return (snap.url || '') + '|' + (snap.title || '') + '|' + els + '|' + String(snap.excerpt || '').length + '|' + frameSig;
}

// 页面熟悉度键：host+pathname（不含 query/hash——筛选、翻页这类"同一页不同参数"算同一页，熟练度可延续）
function pageKeyOf(url) {
  try {
    const u = new URL(String(url || ''));
    return (u.hostname || '') + (u.pathname || '/');
  } catch (e) {
    return String(url || '');
  }
}

// 批内跨页保障。这两个函数配合 runActionBatch：批内跨页动作（open_tab/navigate/switch_tab/use_tab/close_tab）
// 不再打断整批——真正要读取/操作当前页面的动作（read/click 等）执行前，先等当前操作标签页面就绪。
// 连续跨页动作之间不等，让多个新页并行加载，直到要用它之前才等（高效利用加载时间）。
function actionNeedsLivePage(a) {
  if (!a || !a.action) return false;
  return ['read', 'click', 'clickAt', 'dblclickAt', 'gotoCell', 'clickText', 'clickSelector', 'uploadFile', 'pasteRich', 'readCss', 'pageInfo', 'getJsErrors', 'clearJsErrors', 'hover', 'show', 'hide', 'type', 'select', 'scroll', 'keypress', 'exec_code'].includes(a.action);
}

// 确保当前操作标签的页面就绪（内容脚本能响应 PING 且 tab status=complete）。
// 页面已就绪 → 一次 PING 零成本放行；未就绪（open_tab/navigate 新页、clickText 跳走后的新页）→ 轮询等待，
// 超过 BATCH_NAV_READY_MS 按超时放行（让动作失败走原有自愈）。轮询期间刷新 lastActiveAt，避免心跳误判卡住。
async function ensureCurrentOpReady(t, myTurn) {
  const cur = currentEntry(t);
  if (!cur || !cur.tabId) return;
  const tabId = cur.tabId;
  if (await sendTab(tabId, { type: 'PING' }, 1500)) return; // 已就绪
  let logged = false;
  const logWait = () => { if (!logged) { logged = true; addLog(t.sid, '等待页面就绪…'); } };
  const started = Date.now();
  for (;;) {
    if (!stillCurrent(t, myTurn)) return;
    t.lastActiveAt = Date.now();
    const tab = await getTab(tabId);
    if (!tab) return; // 标签没了（被关/崩溃），让动作失败走原有自愈
    const pong = await sendTab(tabId, { type: 'PING' }, 1500);
    if (pong && tab.status === 'complete') {
      if (logged) updateLog(t.sid, null, '页面已就绪 · ' + Math.round(Date.now() - started) + 'ms');
      return;
    }
    if (Date.now() - started > BATCH_NAV_READY_MS) {
      if (logged) updateLog(t.sid, null, '页面加载超时，继续尝试动作');
      return;
    }
    if (Date.now() - started > 1000) logWait(); // 超过 1s 才在面板记一行"等待页面就绪…"，就绪后合并
    await sleep(250);
  }
}

// 单步执行完后的下一步：批量模式（_inBatch）下由批循环继续执行本批剩余动作，不再重新读页；
// 非批量模式回到 agentStep 重读页面再决策。runAction 内部一律经它收尾，不再直接调 agentStep。
function nextStepOrBatch(t, myTurn) {
  if (!t || !stillCurrent(t, myTurn)) return;
  if (t._inBatch) return; // 批内：不打断，runActionBatch 的循环拿到控制权继续下一动作
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// 批量执行：一次 LLM 决策产出的多个动作连续执行，中间不重新读页（熟悉页面才允许进入）。
// 批内逐动作调 runAction，runAction 收尾的 nextStepOrBatch 因 _inBatch=true 直接返回，批循环据此接管。
// 批内失败（_batchFailed）/ 遇终止动作 / 会话状态改变 → 本批结束；整批成功 → 重读页再决策。
// 动作失败的兜底：ref 来自旧快照、批内执行时可能已失效，元素定位会失败——失败即收尾，由 pushFailure
// 把原因写回历史、清零本页熟悉度，下一次 agentStep 重快照后 LLM 用新 ref 重试，不会批内硬续。
async function runActionBatch(t, actions) {
  if (!t || t.state !== 'working') return;
  const myTurn = t.turnId;
  const rawList = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
  const list = rawList.slice(0, MAX_BATCH);
  // 单动作走原路径：不设 _inBatch，判重启发式 / 每步读页等单动作逻辑照常生效。
  // _inBatch 只在真正多动作批量时才开——否则单动作也会被当成"批内"而跳过重复识别（回归）。
  if (list.length === 1) {
    await runAction(t, list[0]);
    return;
  }
  const cfg = await getConfig();
  const mark = cfg.batchMark === true; // 调试开关：活动日志标出批量边界
  const truncated = rawList.length > MAX_BATCH;
  let lastSig = '';
  if (mark) addLog(t.sid, '【批 ' + list.length + ' 步】' + (truncated ? '（超过上限已截断）' : ''));
  for (let i = 0; i < list.length; i++) {
    if (!stillCurrent(t, myTurn)) return;
    const a = list[i];
    // 终止动作：切页 / 改会话状态 / 结束。批到此收尾，按单动作流程执行（runAction 自行处理 awaitNav / askUser / finish）
    if (BATCH_TERMINALS.has(a.action)) {
      if (mark) addLog(t.sid, '【批在 ' + a.action + ' 收尾】');
      if (i > 0) {
        t.history.push({ role: 'user', content: '（本批在动作 ' + a.action + ' 处收尾，其后 ' + (list.length - i - 1) + ' 个动作未执行，下一步会重新观察页面）' });
        await saveTasks();
      }
      t._inBatch = false;
      await runAction(t, a);
      return;
    }
    lastSig = sigOf(a);
    t._inBatch = true;
    t._batchFailed = false;
    if (mark) { t._batchPos = i + 1; t._batchLen = list.length; }
    // 批内跨页保障：动作要读取/操作当前页面时，先确保当前操作标签页面就绪。
    // open_tab/navigate 后的新页、clickText 跳走后的新页，都在真正读/点前自动等，单页加载不再打断整批；
    // 连续跨页动作之间不等，让多个新页并行加载，直到要用它之前才等（高效利用加载时间）。
    if (actionNeedsLivePage(a)) {
      await ensureCurrentOpReady(t, myTurn);
      if (!stillCurrent(t, myTurn)) return;
    }
    try {
      await runAction(t, a);
    } finally {
      t._inBatch = false;
      if (mark) { t._batchPos = null; t._batchLen = null; }
    }
    if (!stillCurrent(t, myTurn)) return;
    if (t._batchFailed) {
      if (mark) addLog(t.sid, '【批内动作失败，本批收尾、重读页重规划】');
      return; // 批内动作失败：pushFailure 已写回历史并触发重读页重规划，本批结束
    }
    if (t.state !== 'working') {
      if (mark) addLog(t.sid, '【批因会话状态变化收尾】');
      return; // 会话状态变了（如点击新开页 → awaitNav / 求助人工），批结束
    }
  }
  // 整批成功跑完：按"批"整体记录最近动作与页面状态，供下一批首个动作判重
  if (lastSig) t.lastActSig = lastSig;
  if (t.curPageSig) t.actionPageSig = t.curPageSig;
  if (truncated) {
    t.history.push({ role: 'user', content: '（本批动作数超过单批上限 ' + MAX_BATCH + '，已截断，剩余动作请在下一步继续）' });
    await saveTasks();
  }
  if (mark) addLog(t.sid, '【批完 ' + list.length + ' 步，重新读页再决策】');
  if (!stillCurrent(t, myTurn)) return;
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// ---- uploadFile 本地文件选择弹窗（pick:true）----
// 打开 picker.html 扩展页让使用者选本地文件，picker 读成 base64 后经 PICK_FILE_RESULT 消息回传。
// 消息 id 配对：并发/多次弹窗各自有独立 pickId，互不串扰；超时视为取消返回 null（走"弹窗被取消"失败）。
const PICK_WAIT_MS = 120000; // 选文件等待上限：使用者 2 分钟没选完视为取消
const pickWaiters = new Map(); // pickId -> resolve({base64, filename, mime, windowId})
async function pickLocalFile() {
  const pickId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pickWaiters.delete(pickId); resolve(null); }, PICK_WAIT_MS);
    pickWaiters.set(pickId, (msg) => { clearTimeout(timer); pickWaiters.delete(pickId); resolve(msg); });
    try {
      chrome.windows.create({
        url: chrome.runtime.getURL('picker.html') + '?pickId=' + pickId,
        type: 'popup',
        width: 420,
        height: 240,
        focused: true
      });
    } catch (e) {
      clearTimeout(timer);
      pickWaiters.delete(pickId);
      resolve(null);
    }
  });
}

async function runAction(t, a) {
  if (!t || t.state !== 'working') return;
  const myTurn = t.turnId;
  if (!stillCurrent(t, myTurn)) return;
  // 记录"这次在尝试什么动作"（使用者能看懂的话）：转人工求助时卡片据此告诉使用者卡在哪一步，
  // 不会只报站点、使用者不知道要帮什么（如"点击「收藏」"就一眼知道是点在收藏上失败）
  // 记录"这次真实动作之前攒了几次 wait"（供"等待后又重复同一个动作"识别），并清零连续等待计数
  const prevWaits = (a.action !== 'wait') ? (t.consecWaits || 0) : 0;
  if (a.action !== 'wait') t.consecWaits = 0;

  // ---- 元素窗口翻页（snapshot）----
  if (a.action === 'snapshot') {
    const t0 = performance.now();
    const off = Math.max(0, Math.min(Number(a.offset) || 0, MAX_SNAPSHOT_OFFSET));
    t.snapOffset = off; // 只改窗口偏移；下一步 agentStep 会按新 offset 重读快照（URL 变了自动回第一批）
    addLog(t.sid, '翻元素窗口到第 ' + (Math.floor(off / REF_WINDOW_SIZE) + 1) + ' 批 · ' + Math.round(performance.now() - t0) + 'ms');
    nextStepOrBatch(t, myTurn);
    return;
  }

  // ---- 标签操作 ----
  if (a.action === 'open_tab') {
    if (!a.url || !/^(https?|file):/i.test(a.url)) {
      await pushFailure(t, 'open_tab 地址无效：' + a.url);
      return;
    }
    // 兜底：地址含字面省略号 … 一定是被截断的地址（真实 URL 只会带 %E2%80%A6 编码、不会带 … 字符）。
    // 开这样的地址只会得到坏 tab，直接拦下纠错，让模型从快照 →地址 / list_tabs 取完整 URL 再开。
    if (String(a.url).includes('…')) {
      await pushFailure(t, 'open_tab 的地址是省略号截断的（含 "…" 字符），不是完整真实地址。从列表快照元素的 →地址 或 list_tabs 里取完整 URL 再 open_tab。', true); // 内部纠错，不刷用户面板
      return;
    }
    let res;
    try {
      res = await openAgentTab(a.url, null, t);
    } catch (e) {
      await pushFailure(t, e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    // 彻底统一：操作后不等待——新页就绪由下一步读/操作前 ensureCurrentOpReady 承担
    nextStepOrBatch(t, myTurn);
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
    let res;
    try {
      res = await openAgentTab(url, '搜索「' + midTruncate(query, 32) + '」', t);
    } catch (e) {
      await pushFailure(t, e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    // 彻底统一：操作后不等待——新页就绪由下一步读/操作前 ensureCurrentOpReady 承担
    nextStepOrBatch(t, myTurn);
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
    setCurrentRef(t, entry.ref);
    const ms = Math.round(performance.now() - t0);
    addLog(t.sid, '切换标签 · ' + ms + 'ms');
    await saveTasks();
    await bringTabToForeground(entry.tabId); // 前台模式：切到的标签切到浏览器前台；后台模式不切
    if (!stillCurrent(t, myTurn)) return;
    nextStepOrBatch(t, myTurn);
    return;
  }

  if (a.action === 'list_tabs') {
    try {
      const t0 = performance.now();
      const text = await listAllTabs(t);
      const ms = Math.round(performance.now() - t0);
      t.history.push({ role: 'user', content: text });
      t.listTabsFresh = true; // 刚列出过最新标签：use_tab 闸门放行
      addLog(t.sid, '列出标签 · ' + ms + 'ms', true); // quiet：完整标签清单已进 history 喂模型，不占面板消息列表
      await saveTasks();
    } catch (e) {
      await pushFailure(t, '列出标签失败：' + e.message);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    nextStepOrBatch(t, myTurn);
    return;
  }

  if (a.action === 'use_tab') {
    const t0 = performance.now();
    // 机械强制：use_tab 前必须先 list_tabs 拿最新 tabId。标签集一变（开/关/淘汰/纳入）旧列表就失效，
    // 直接用旧 tabId 只会得到"标签不存在或已关闭"的失败——闸门拦下并引导先 list_tabs。
    if (!t.listTabsFresh) {
      await pushFailure(t, 'use_tab 前必须先 list_tabs 获取最新 tabId（标签集可能已变化，旧列表里的 tabId 可能已失效）。先执行 list_tabs，再 use_tab。', true); // 内部纠错，不刷用户面板
      return;
    }
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
    const owner = sessionOfTab(tabId);
    if (owner && owner !== t.sid) {
      await pushFailure(t, 'use_tab 不能纳入其他会话的标签（避免两个 Agent 同时操作同一页面），请只选标记为「任务内@」的标签', true); // 内部纠错，不刷用户面板
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
    setCurrentRef(t, adoptedRef);
    const cfg = await getConfig();
    t.history.push({ role: 'user', content: '已把浏览器标签纳入任务：@' + adoptedRef + ' ' + (tab.title || shortUrl(tab.url)) + '（当前操作标签' + (cfg.backgroundExec ? '，未切浏览器前台' : '，前台模式已切到浏览器前台') + '）' });
    t.listTabsFresh = false; // 纳入后可用标签集已变，再 use_tab 需重新 list_tabs
    const ms = Math.round(performance.now() - t0);
    addLog(t.sid, '复用页面 ' + midTruncate(tab.title || shortUrl(tab.url), 32) + ' · ' + ms + 'ms');
    await saveTasks();
    broadcastTabs(t);
    await bringTabToForeground(tabId); // 前台模式：纳入的标签切到浏览器前台
    if (!stillCurrent(t, myTurn)) return;
    nextStepOrBatch(t, myTurn);
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
    nextStepOrBatch(t, myTurn);
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
    nextStepOrBatch(t, myTurn);
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
    nextStepOrBatch(t, myTurn);
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
    nextStepOrBatch(t, myTurn);
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
    nextStepOrBatch(t, myTurn);
    return;
  }

  // ---- 在对话区给使用者说一句话（不打断流程；如"复述"） ----
  if (a.action === 'say') {
    const text = String(a.text || '').trim().slice(0, 3000);
    if (text) {
      t.conversation.push({ role: 'agent', text, ok: true, t: Date.now() });
      if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
      broadcast({ type: 'AGENT_MESSAGE', text, ok: true }, t.sid);
    }
    t.turnSteps++;
    t.lastActiveAt = Date.now();
    await saveTasks();
    if (!stillCurrent(t, myTurn)) return;
    nextStepOrBatch(t, myTurn);
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
    const myTurn = t.turnId; // 钉住本回合号：先落答案、再后台复盘，期间新指令会打断复盘
    const reviewSteps = t.turnSteps; // 复盘进度行要报"本次完成 N 步动作"，complete 会清零 turnSteps，先留住
    if (!stillCurrent(t, myTurn)) return;
    await complete(t, result); // 先显示答案：立即广播给面板、状态回 idle，使用者不用等复盘跑完
    // 复盘挪到答案之后、以 force 模式照常执行（复用"停止后复盘"的机制）：complete 已把 state 置回 idle，
    // 不 force 的话两个复盘函数会因"非 working"静默跳过（答案一显示就以为任务完成、不复盘）。
    // 钉住回合号：新指令（turnId 变化）一到，复盘自动退出、不误动新回合。复盘失败不影响本轮完成。
    await reviewAfterTurnEnd(t, myTurn, reviewSteps);
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
    // 防重复跳：目标与当前标签已是同一页（仅编码/末尾斜杠差异视为同页；锚点 #hash 页内跳转不算，放行）
    // 时直接驳回，避免模型对几乎相同的 URL 反复 navigate（同样多半不生效）浪费往返——dead-click 规则是提示词层，这里是工具层兜底。
    try {
      const curTab = await getTab(tabId);
      const norm = (u) => {
        let s = '';
        try { s = decodeURIComponent(String(u || '')); } catch (e) { s = String(u || ''); }
        return s.replace(/\/+$/, '').toLowerCase();
      };
      if (curTab && curTab.url && norm(curTab.url) === norm(url)) {
        await pushFailure(t, 'navigate 目标 URL 与当前页面相同（' + url + '），重复跳转不会有新结果。若要刷新请先 wait 再重快照观察，或改用其他动作推进。', true); // quiet：只喂模型纠错、不进面板消息列表
        return;
      }
    } catch (e) {}
    // 打开页面：地址按统一宽度计算的尾部省略（tailTruncate 32，保留主机名与路径开头）；就绪用时由下一步 ensureCurrentOpReady 的"页面已就绪 · Nms"体现
    addLog(t.sid, '打开页面 ' + tailTruncate(url, 32));
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (e) {
      fail(t, '导航失败：' + e.message);
    }
    // 彻底统一：操作后不等待——新页就绪由下一步读/操作前 ensureCurrentOpReady 承担
    nextStepOrBatch(t, myTurn);
    return;
  }

  // ---- 等待 ----
  if (a.action === 'wait') {
    // 批量模式：wait 是 LLM 规划好批内的衔接步骤（如等动画/渲染），短停后继续批内下一动作即可，
    // 不做"连续空转"判断——那套是给"一步步决策"的单动作模式防发呆用的，批内会由整批成败来验证。
    if (t._inBatch) {
      const ms = Math.round(120 + Math.random() * 280);
      await sleep(ms);
      await saveTasks();
      if (!stillCurrent(t, myTurn)) return;
      nextStepOrBatch(t, myTurn);
      return;
    }
    // 拟人停顿：随机 0.2s~0.8s，模拟真人阅读/思考节奏，避免动作太快被风控判定为机器
    // 但连续 wait 而没有任何真实动作、页面也没变化，就是纯空转浪费时间——第二次起不再停顿，
    // 直接提醒 LLM 停止空等、去做实际动作或 finish。
    t.consecWaits = (t.consecWaits || 0) + 1;
    if (t.consecWaits >= 2) {
      // 空等也算"无进展"，累计到阈值主动请使用者演示（多数情况走下面的"禁止再 wait"就够了，这里兜底）
      t.stuck = (t.stuck || 0) + 1;
      if (t.stuck >= STUCK_TEACH_LIMIT) {
        await askUser(t, '我在等待页面变化上反复空转、一直没有进展。' + currentStepNote(t) + '请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
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
      nextStepOrBatch(t, myTurn);
      return;
    }
    const ms = Math.round(200 + Math.random() * 600);
    addLog(t.sid, '假装人类发呆 ' + ms + 'ms');
    await sleep(ms);
    if (!stillCurrent(t, myTurn)) return;
    nextStepOrBatch(t, myTurn);
    return;
  }

  // ---- 页面动作：发送到当前操作标签执行 ----
  let res = null;
  let err = null;
  // 无进展计数（t.stuck）：识别"一直在原地打转"——连续失败 / 反复执行同一个动作 / 空等。
  // 与 failStreak 不同：stuck 在【换新动作】时才清零，所以"同一个动作反复成功却毫无进展"的静默循环也会累计，
  // 累计到 STUCK_TEACH_LIMIT 就主动请使用者手把手演示（ask_user mode=teach），不再无限重试。
  const sig = sigOf(a);
  if (!t._inBatch) {
    // 批量模式不逐动作判重：批是 LLM 规划好的连续序列，批内动作本就连贯执行、不算"原地打转"，
    // 且 lastActSig 不更新，启发式会误判。判重/无进展计数由 runActionBatch 在整批结束后整体记录，下一批判重。
    const p = a.ref || a.selector || a.target || a.url || a.key || ''; // 动作的"目标身份"：scroll/read 等无具体目标的动作不算重复
    // 页面状态闸门：自上次动作以来页面真的变了（翻页/加载出新内容）→ 说明是有效进展，不算重复；页面纹丝不动才累计
    const pageChanged = !!(t.curPageSig && t.actionPageSig && t.curPageSig !== t.actionPageSig);
    const isRepeat = !!(p && t.lastActSig && sig && sig === t.lastActSig && !pageChanged);
    if (isRepeat) {
      if (prevWaits > 0) {
        // "等待后又重复同一个动作"：上个真实动作后只隔了 wait、页面没变化，现在又要执行一模一样的动作 → 提醒 LLM 换别的
        t.history.push({
          role: 'user',
          content: '注意：你要执行的动作和上一步刚做完的完全一样（' + sig + '），而中间只有 wait、页面没有变化，重复执行不会有新结果。请改做别的动作（先 read 看页面、scroll 看更多、点别的元素），或对照快照里的【本站操作经验】看看是否该按经验来，或 finish 结束本轮。'
        });
      } else if (t.stuck === 0) {
        // 第一次发现连续重复（中间没有 wait）：先轻提示一次让它自己换招；仍无进展会继续累计到阈值请使用者演示
        t.history.push({
          role: 'user',
          content: '注意：动作（' + sig + '）你刚刚已经执行过，如果它没能推进任务，重复执行不会有新结果。请先 read 看看当前页面状态，或对照快照里的【本站操作经验】调整做法，或换别的动作 / 滚动查看更多 / 点击别的元素；实在不知道怎么继续，可以用 ask_user（mode=teach）请使用者手把手演示。'
        });
      }
      t.stuck = (t.stuck || 0) + 1;
    } else {
      t.stuck = 0; // 换了个新动作 = 在尝试新路径，无进展计数清零
    }
    if (t.stuck >= STUCK_TEACH_LIMIT) {
      await askUser(t, '我反复尝试了 ' + t.stuck + ' 次同样的操作仍然没有进展，不知道怎么继续了。' + currentStepNote(t) + '请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
      return;
    }
  }
  // ---- 已读清单拦截（"读 N 条"循环）：要点的目标已在【已读】里（同一页同一 ref / 相同文字点过）→ 挡住并提示，避免重复读同一篇。
  // 与上面的 lastActSig 判重不同：它只抓"上一步刚做完、页面没变"的连续重复；这里是跨多步的"返回列表后重读已读过的条目"。
  if (!t._inBatch && (a.action === 'click' || a.action === 'clickText')) {
    const pkey = pageKeyOf(t.snapUrl || '');
    const ref = a.action === 'click' && typeof a.target === 'number' ? a.target : undefined;
    const el = ref != null ? (t.snapElements || []).find((e) => e.ref === ref) : undefined;
    const dup = readListMatch(t, pkey, ref, a.text || (el ? (el.text || el.hint) : ''), el ? el.href : '');
    // 只拦"已采到正文"的条目：正文已保真记录下来，重复点它没有新信息、纯空转。
    // 没采到正文的（content 为空，如详情标题对不上/正文加载失败）不拦——压缩后模型可能正需要重开补读，放行让它恢复。
    if (dup && dup.title && dup.content) {
      t.history.push({
        role: 'user',
        content: '注意：标题「' + dup.title + '」已经在你的【已读清单】里（你刚才点开读过它，快照里那一条元素标着【已读】）。不要重复点同一条——从列表里点一个【未读】的下一条标题继续读；如果确实要再看这一条，用 open_tab 直接打开它的详情地址，而不是在列表上反复点。'
      });
      addLog(t.sid, '已读拦截：' + midTruncate(dup.title, 32) + ' 已在已读清单，本次点击未执行', true);
      await saveTasks();
      if (!stillCurrent(t, myTurn)) return;
      nextStepOrBatch(t, myTurn);
      return;
    }
  }
  await saveTasks();
  if (!stillCurrent(t, myTurn)) return;
  const t0 = performance.now();
  armFocusGuard(t); // 记录动作前的前台标签；动作期间页面若 window.open 抢焦点，后台会把它收回

  // ---- uploadFile 本地文件弹窗编排：base64 / content 都没有且 pick:true → 弹扩展页选文件，等使用者选完补 base64 再走正常注入 ----
  // 批内遇到会等使用者选择（本质是人工交互点，类似 ask_user 模式，只是靠系统文件对话框完成）。
  if (a.action === 'uploadFile' && a.pick === true && !a.base64 && a.content == null) {
    const picked = await pickLocalFile();
    if (!stillCurrent(t, myTurn)) return;
    if (!picked) {
      res = { ok: false, message: '上传文件弹窗被取消或超时（' + Math.round(PICK_WAIT_MS / 1000) + ' 秒未选）' };
      await finishRunAction(t, a, res, Math.round(performance.now() - t0), sig, myTurn);
      return;
    }
    a = { ...a, base64: picked.base64, filename: picked.filename || a.filename, mime: picked.mime || a.mime, pick: false };
  }

  // ---- 广播动作（getJsErrors / clearJsErrors）：跨所有 frame 聚合/清空 JS 错误，不走单 frame 路由 ----
  // 顶层 content 无法访问跨域 iframe 的 DOM，错误是各 frame 独立采集的；这里用 getAllFrames 遍历广播、
  // 聚合时给非顶层错误标注来源窗口 url（对齐 chrome_do_action broadcastJsErrors）。
  if (a.action === 'getJsErrors' || a.action === 'clearJsErrors') {
    const frames = await frameList(tabId);
    const results = await Promise.all(frames.map((f) => sendTab(tabId, { type: 'EXECUTE_ACTION', action: a }, 2000, { frameId: f.frameId })));
    if (a.action === 'getJsErrors') {
      const all = [];
      for (let i = 0; i < frames.length; i++) {
        const r = results[i];
        if (r && r.ok && Array.isArray(r.errors)) {
          for (const e of r.errors) all.push(frames[i].frameId === 0 ? e : Object.assign({ frame: shortUrl(frames[i].url || '') }, e));
        }
      }
      res = { ok: true, count: all.length, errors: all };
    } else {
      let cleared = 0;
      for (let i = 0; i < frames.length; i++) {
        const r = results[i];
        if (r && r.ok && typeof r.cleared === 'number') cleared += r.cleared;
      }
      res = { ok: true, cleared };
    }
    await finishRunAction(t, a, res, Math.round(performance.now() - t0), sig, myTurn);
    return;
  }

  // ---- exec_code：执行快照里某条经验写好的 JS（Agent 只传编号+参数，不抄代码）。
  // 编号来自【本站操作经验】的 [经验N]，必须与当前快照那批一致（新鲜度闸门），经验列表在快照后变过就得重新 snapshot。
  if (a.action === 'exec_code') {
    const idx = a.idx;
    if (!Number.isInteger(idx) || idx < 0) {
      await pushFailure(t, 'exec_code 的 idx 必须是非负整数，你给的是：' + JSON.stringify(idx) + '。先重新 snapshot 看【本站操作经验】里的 [经验N] 编号再调。', true);
      return;
    }
    const argsRaw = (a.args == null) ? {} : a.args;
    if (typeof argsRaw !== 'object' || Array.isArray(argsRaw)) {
      await pushFailure(t, 'exec_code 的 args 必须是对象（参数名:值），你给的是：' + JSON.stringify(argsRaw), true);
      return;
    }
    // 新鲜度闸门（对齐 use_tab/list_tabs）：只认"当前快照那次加载的经验"。页面换过 / 库变过 → 编号已不可靠
    const ref = t._expRef || null;
    if (!ref || ref.host !== hostOf(t.snapUrl || '')) {
      await pushFailure(t, 'exec_code 需要当前快照里的经验编号，但当前页面没有可用的经验快照。请先重新 snapshot 拿到【本站操作经验】编号再调。', true);
      return;
    }
    const fresh = await getSiteExperiences(ref.host);
    if (expSig(fresh) !== ref.sig) {
      await pushFailure(t, '该网站的操作经验库在快照后发生了变化，编号可能已漂移。请先重新 snapshot 拿到最新【本站操作经验】编号再调 exec_code。', true);
      return;
    }
    const item = normExp(fresh[idx]);
    if (!item || !item.code) {
      await pushFailure(t, '经验 ' + idx + '（' + (item ? item.scene : '不存在') + '）没有可执行代码，无法 exec_code。请按场景描述手动操作。', true);
      return;
    }
    // 仅面板展示用（friendlyAction 的 exec_code 行显示场景名）；a 不会喂回模型 / 落历史，加下划线字段安全
    a._scene = item.scene;
    // 参数白名单：只透传该经验声明的参数名（防 Agent 传错键名把无关数据塞进代码）；未传的用 undefined，代码可自行判断
    const declared = new Set(item.params.map((p) => p.name));
    const args = {};
    for (const k of Object.keys(argsRaw)) if (declared.has(k)) args[k] = argsRaw[k];
    // 发到主窗口 / 指定子窗口执行，走统一收尾喂回模型（a.frame 用法同 clickText/readCss）
    let execFrame = { frameId: 0 };
    if (typeof a.frame === 'number' && a.frame > 0) {
      const frame = (t.snapFrames || [])[a.frame];
      if (frame && frame.frameId != null) execFrame = { frameId: frame.frameId };
    }
    let execRes = null;
    let execErr = null;
    try {
      execRes = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action: { action: 'exec_code', code: item.code, args } }, execFrame);
    } catch (e) {
      execErr = e;
    }
    const execMs = Math.round(performance.now() - t0);
    if (execErr) {
      // sendMessage 抛错 ≈ 页面正在加载/跳转、content 上下文失效
      const tab = await getTab(tabId);
      console.warn('[PageAgent] exec_code 连接失败 tab=' + tabId + ' ' + (tab ? tab.url : '(标签不存在)') + ' → ' + execErr.message);
      addLog(t.sid, '经验代码执行连接失败（可能页面正在跳转/未加载完成）', true);
      awaitNav(t, tabId);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    if (!execRes || execRes.ok === false) {
      const why = (execRes && (execRes.message || execRes.error)) || '经验代码执行失败';
      // 技术细节（语法/CSP/沙箱/超时等）只进控制台排查，不显示给用户（用户反馈"太复杂"）；
      // 删除 + 耗时合并成一行面板消息，报错原文与"经验不可用"都不再刷面板
      console.warn('[PageAgent] exec_code 执行失败 tab=' + tabId + ' → ' + why);
      // 基础设施类失败（userScripts 开关没开/API 不可用）要让人知道怎么修，不压成"经验不可用"，也不删经验
      if (execRes && execRes.infra) {
        await pushFailure(t, why, false, sig);
      } else {
        // 非基础设施失败 = 经验代码本身的问题（元素找不到/报错/超时/业务失败）：立即删掉这条经验，
        // 别让 Agent 在同站反复撞同一招；同时记下失败原因，本次复盘喂给 LLM 避免再生成同类代码。
        const fh = ref.host;
        const fscene = (item && item.scene) || ('经验' + idx);
        try {
          await saveSiteExperiences(fh, (fresh || []).filter((_, i) => i !== idx), t.sid);
          addLog(t.sid, '经验已删除：' + fscene + ' · ' + execMs + 'ms');
        } catch (e) {
          console.warn('[PageAgent] 删除失败经验出错 ' + fh + ' → ' + e.message);
        }
        if (!t._expFailures) t._expFailures = [];
        t._expFailures.push({ host: fh, scene: fscene, reason: why });
        t._expRef = null; // 库已变：旧快照的经验编号作废，下一次 snapshot 自然带出最新列表
        await pushFailure(t, '经验不可用，请按场景描述手动操作', true, sig); // quiet：只喂模型纠错，不刷面板
      }
      return;
    }
    await finishRunAction(t, a, execRes, execMs, sig, myTurn);
    return;
  }

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
  } else if (['clickText', 'clickSelector', 'uploadFile', 'pasteRich', 'readCss'].includes(a.action) && typeof a.frame === 'number' && a.frame > 0) {
    // 这组动作没有 target ref，用 frame 字段指定子窗口（与【子窗口 N】编号一致）；不填默认主窗口
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
    await pushFailure(t, why, !!(res && res.quiet), sig); // 失败也记入 lastActSig；content 标 quiet 的失败（如"没找到文字，重新快照"）只喂模型、不进面板，由后续动作体现修正
    return;
  }

  // pageInfo 跨域 iframe 补全：content 只能读到同源 iframe 的 url/title；跨域 iframe 只有 src 属性，
  // 用 getAllFrames 的 frame url 交叉匹配把 url/title 补上（src 是绝对地址的跨域窗基本能匹配上，匹配不上就保留 src 原样）
  if (res && res.ok && a.action === 'pageInfo' && res.info && Array.isArray(res.info.iframes)) {
    const frames = await frameList(tabId);
    for (const rec of res.info.iframes) {
      if (rec.sameOrigin || !rec.src) continue;
      const src = String(rec.src).slice(0, 120);
      const m = frames.find((f) => f.frameId !== 0 && f.url && f.url.indexOf(src) !== -1);
      if (m) { rec.url = m.url; rec.title = m.title || ''; }
    }
  }

  // 点击的链接是 target="_blank"（会新开页面）→ content 已截获，改为 Agent 标签打开并纳入 @T：
  // 前台模式切前台、后台模式不抢浏览器焦点，且算 Agent 自开标签（本轮结束随分组一起清理）。
  if (res.openTab) {
    const lnkCfg = await getConfig();
    let resTab;
    const label = (res.label || '').trim();
    const display = label
      ? ('点击「' + midTruncate(label, 32) + '」→ ' + (lnkCfg.backgroundExec ? '后台打开 ' : '打开 ') + shortUrl(res.openTab))
      : ('点击 → ' + (lnkCfg.backgroundExec ? '后台打开 ' : '打开 ') + shortUrl(res.openTab));
    try {
      resTab = await openAgentTab(res.openTab, display, t);
    } catch (e) {
      await pushFailure(t, e.message, false, sig);
      return;
    }
    if (!stillCurrent(t, myTurn)) return;
    t.failStreak = 0;
    const openedOrReused = resTab.reused
      ? '点击的链接目标已在 @' + resTab.entry.ref + ' 打开，直接切换过去（' + shortUrl(res.openTab) + '）'
      : '点击的链接会新开页面，已' + (lnkCfg.backgroundExec ? '在后台打开' : '打开') + '为 @' + resTab.entry.ref + '（' + shortUrl(res.openTab) + '），属 Agent 自开标签，本轮结束自动关闭';
    t.history.push({ role: 'user', content: openedOrReused });
    // 彻底统一：操作后不等待——新页就绪由下一步读/操作前 ensureCurrentOpReady 承担
    nextStepOrBatch(t, myTurn);
    return;
  }

  // ---- 已读清单记录：点击/点文字打开了 link 类内容 → 记入已读清单。
  // 判断标准：1) 动作成功返回（click 不再返回 changed——死点记录的空白条目由已读拦截的"无正文标【已读·可重开】放行补读"兜底，与 clickText 一致）；
  // 2) 目标是 link（列表项）或 clickText（按文字点的标题，不记"下一页/返回"这类导航文字）；3) 标题非空。
  // clickText 不要求页面真的变了：弹层式详情（URL/页面键不变，如站内弹层）是这类站点的主流读法，若也要求 changed，
  // 弹层打开的一条都记不进"已读"，模型看不到自己读过哪些，就会反复点同一批。已点开的重复点击由拦截兜底（有正文直接拦、没正文标【已读·可重开】放行补读）。
  if (res && (a.action === 'click' || a.action === 'clickText')) {
    const pkey = pageKeyOf(t.snapUrl || '');
    const ref = (a.action === 'click' && typeof a.target === 'number') ? a.target : undefined;
    const el = ref != null ? (t.snapElements || []).find((e) => e.ref === ref) : undefined;
    const title = a.action === 'clickText' ? String(a.text || '') : (el ? (el.text || el.hint || '') : '');
    const isLinkish = a.action === 'clickText' ? !READ_NAV_RE.test(normTxt(title)) : !!(el && el.role === 'link');
    if (isLinkish && normTxt(title) && pkey && !readListMatch(t, pkey, ref, title, el ? el.href : '')) {
      t.readList = t.readList || [];
      if (t.readList.length >= 300) {
        // 已读清单上限：超过后新条目不再跟踪（已记的照常拦截/采集），避免任务对象无限膨胀
        addLog(t.sid, '已读清单已满 ' + t.readList.length + ' 条，本轮不再记录新条目', true);
      } else {
        t.readList.push({ ref, title: normTxt(title), pageKey: pkey, content: '', url: el ? el.href : undefined });
      }
    }
  }
  // ---- read 整页也记已读清单：批量跨页读（open_tab + read）读详情页时，条目记在动作发出时所在页（列表页），
  // 回列表能标【已读】、避免重复读。title 取标签标题（详情"标题 - 站点"靠标题互含匹配列表元素），url 存标签地址供精确去重。
  // 同标题/同 URL 已存在则跳过（如 clickText 已记过，read 不重复记）。只记整页 read（target:"page"），局部元素短读不记。
  if (res && res.ok && a.action === 'read' && a.target === 'page') {
    const readTab = await getTab(tabId);
    const rtitle = normTxt((readTab && readTab.title) || '');
    const rurl = (readTab && readTab.url) || '';
    const rpkey = pageKeyOf(t.snapUrl || '');
    // 只记"读的页面和快照锚定页不同"的跨页读（批内 open_tab 读详情）：读当前页本身不记——
    // 否则在列表页 read 整页会把列表标题记进已读清单，之后点标题是列表标题子串的条目会被标题包含匹配误拦。
    if (rurl && pageKeyOf(rurl) === rpkey) return;
    if (rtitle.length >= 2 && rpkey && !readListMatch(t, rpkey, null, rtitle, rurl)) {
      t.readList = t.readList || [];
      if (t.readList.length >= 300) {
        addLog(t.sid, '已读清单已满 ' + t.readList.length + ' 条，本轮不再记录新条目', true);
      } else {
        t.readList.push({ ref: null, title: rtitle, pageKey: rpkey, url: rurl, content: String(res.text || '').trim().slice(0, 800) });
      }
    }
  }
  await finishRunAction(t, a, res, ms, sig, myTurn);
}

// runAction 收尾：动作结果写历史、面板日志、驱动下一步。广播动作（getJsErrors/clearJsErrors）与
// pick 编排（uploadFile 弹窗）在中途也走这里，避免复制收尾逻辑。
async function finishRunAction(t, a, res, ms, sig, myTurn) {
  // 结果全量写历史（不再一律 3000 硬截断——那会连当前回合的大结果如 pageInfo html / readCss 都读不全）。
  // 上下文控制改在发送侧 buildMessages：最近 RESULT_KEEP_ROUNDS 回合全量、更早的空壳化；压缩时 summarizeOnce 再按 1200/条摄入摘要。
  // RESULT_MAX_STORE 只是存储软上限，防止极端超大结果把 saveTasks 序列化/配额撑爆。
  t.history.push({ role: 'user', content: '动作结果：' + JSON.stringify(res).slice(0, RESULT_MAX_STORE) });
  // ---- ref 漂移警示：结果 label 与模型标注的意图 label 对不上 → DOM 在执行前变了，同编号元素已不是同一个。
  // 系统提示里已有"点击后看下一个快照"规则，但那是让模型自己对比两轮快照；这里把漂移直接点破，
  // 避免它继续按旧 ref 硬点（02:30 会话连点 19 次『邮箱』就是没人点破"你点错了"）。
  // 只在单步模式判断（批内动作是规划好的连续序列，ref 批内本就不该用，批头已约束用 clickText）。
  // 排除"按钮/链接/搜索框"这类功能型通用 label：它们不构成漂移证据（elementLabel 对无文字元素会退回功能名），
  // 避免正常点击被误报。只拿"意图与实点都是具体文字"的不符当漂移信号。
  if (!t._inBatch && (a.action === 'click' || a.action === 'hover' || a.action === 'show' || a.action === 'dblclickAt' || a.action === 'clickAt') && res && res.ok && res.label) {
    // 意图：优先用模型自标 a.label；模型没标（08-17 日志里 click 15 就只给 target 不给 label）就按 ref 回查快照
    // 元素文字当意图——这样"快照里是「全选」、实际却点到了「邮箱」"这类漂移也能被点破，不依赖模型自觉补 label。
    let intent = '';
    let intentTxt = ''; // 意图原始文字（日志展示用）
    let intentSrc = ''; // 意图来源的描述（警示文案用）
    if (a.label) {
      intent = normTxt(String(a.label));
      intentTxt = String(a.label);
      intentSrc = '你标注要点的目标「' + a.label + '」';
    } else if ((a.action === 'click' || a.action === 'hover') && (typeof a.target === 'number' || typeof a.target === 'string')) {
      const el = (t.snapElements || []).find((e) => String(e.ref) === String(a.target));
      if (el) {
        const elTxt = String(el.text || el.hint || el.value || '');
        intent = normTxt(elTxt);
        intentTxt = elTxt;
        intentSrc = '你点的 ref ' + a.target + ' 在快照里对应「' + midTruncate(elTxt, 12) + '」';
      }
    }
    const actual = normTxt(String(res.label)).toLowerCase().slice(0, 30);
    intent = intent.toLowerCase().slice(0, 30);
    if (intent && actual && !GENERIC_LABELS.has(intent) && !GENERIC_LABELS.has(actual) &&
        intent !== actual && !intent.includes(actual) && !actual.includes(intent)) {
      t.history.push({ role: 'user', content: '注意：' + intentSrc + '，动作结果 label 是「' + res.label + '」——两者对不上，说明发动作时 DOM 已经变了、ref 漂移（这个编号现在指向的是另一个元素）。**不要按这个 ref 继续点**。重新 snapshot 看当前列表实际状态，改用 clickText 按列表里真正出现的文字点击目标，或点别的元素。' });
      addLog(t.sid, 'ref 漂移警示：意图「' + midTruncate(intentTxt, 12) + '」≠ 实点「' + midTruncate(res.label, 12) + '」', true);
    }
  }
  // ---- 同一目标重复点击检测（加强）：与 lastActSig 的"连续两步完全相同"判重互补——
  // 这里是跨多步的"同一个（动作+结果 label）反复出现、且页面 url/标题没变"，中间夹 scroll/别的动作也照样累计。
  // 典型场景：ref 漂移后反复点到同一个错误元素（想点『全选』结果反复点到『邮箱』），每次结果都是 ok 且 label 相同，
  // 之前的判重因页面有滚动变化被绕过；这里按"结果 label 不变"直接抓，跨过阈值强制换招。
  if (!t._inBatch && (a.action === 'click' || a.action === 'clickText' || a.action === 'hover' || a.action === 'show' || a.action === 'clickAt' || a.action === 'dblclickAt')) {
    const rlabel = res && res.ok && typeof res.label === 'string' ? normTxt(res.label) : '';
    if (rlabel) {
      t.sigRepeat = t.sigRepeat || new Map();
      const key = a.action + ':' + rlabel;
      const prev = t.sigRepeat.get(key);
      if (prev && !repeatPageMoved(t, prev)) prev.n++;
      else t.sigRepeat.set(key, { n: 1, url: t.snapUrl || '', title: t.snapTitle || '' });
      const cur = t.sigRepeat.get(key);
      if (cur.n === REPEAT_ACTION_LIMIT) {
        t.history.push({ role: 'user', content: '注意：你已经在同一目标上执行 ' + a.action + ' ' + cur.n + ' 次，每次结果 label 都是「' + rlabel + '」，页面没有变化——这通常意味着 ref 已漂移（你反复点到的是同一个错误元素）、或这个元素点了不生效。**不要再按同一 ref/文字点它**。重新 snapshot 看当前列表实际状态，改用 clickText 按列表里真正出现的文字点击，或点别的元素 / 换一种做法。（如果是分步推进、每步页面确实在变，可忽略此条继续。）' });
        addLog(t.sid, '重复目标警示：' + a.action + ' ×' + cur.n + ' label「' + midTruncate(rlabel, 16) + '」未变，提醒换招', true);
      } else if (cur.n >= REPEAT_TEACH_LIMIT && cur.n % REPEAT_TEACH_LIMIT === 0) {
        // 翻倍仍无变化：升级为请使用者手把手演示，不再无限重试（口径与 stuck 转教我一制）。
        // 用 t._pendingTeach 记下"本条执行完请演示"，让公共收尾（面板日志等）照常走完，再转演示、不驱动下一步。
        t._pendingTeach = '我在同一目标上反复执行 ' + a.action + ' ' + cur.n + ' 次、结果 label 始终是「' + rlabel + '」，没有任何进展。' + currentStepNote(t) + '请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。';
      }
    }
  }
  t.failStreak = 0;
  // type 输入卡住提醒已随"操作后不等待"移除：type 不再返回 inputStuck，输入是否落地由下一个快照体现、模型据快照纠正
  if (!t._inBatch) {
    t.lastActSig = sig; // 记录本次动作，供"反复执行同一个动作"识别（批内不逐动作记录，批末由 runActionBatch 整体记录）
    t.actionPageSig = t.curPageSig; // 记录执行动作时的页面状态，供下次重复判断"页面是否真的变了"
  }
  addLog(t.sid, (t._batchPos != null ? '批' + t._batchPos + '/' + t._batchLen + ' ' : '') + friendlyAction(a, res, ms)); // 面板显示极简动作 + 耗时，如"点击 · 50ms"；批量标注开关打开时加"批N/M"前缀
  await saveTasks();
  if (t._pendingTeach) {
    const msg = t._pendingTeach;
    t._pendingTeach = null;
    await askUser(t, msg, 'teach');
    return;
  }
  if (stillCurrent(t, myTurn)) nextStepOrBatch(t, myTurn);
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
  if (ttl) return midTruncate(ttl, 32);
  return hostOf(url) || '当前页面';
}

// 把给 LLM 看的失败原因转成使用者能看懂的一句话：
// 去掉括号里的内部指引（如"先 list_tabs 确认再关"）和 @T3/ref 这类内部编号，保留实质原因
function humanizeWhy(why) {
  let s = String(why || '').trim();
  s = s.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
  // 去掉"先用 list_tabs 刷新后再选"这类给 Agent 看的内部指引句子（可能在括号里、逗号后或句号后；
  // 也兼容"先执行 list_tabs"这种带动作动词的写法，指引词后限 10 字符防误伤正常文案）
  s = s.replace(/[，,。]\s*(?:先|请|再|记得)?\s*[^，。]{0,10}?\s*(?:list_tabs|use_tab|switch_tab|open_tab|close_tab|navigate|search|snapshot)[^。]*。?/g, '');
  s = s.replace(/[:：]\s*@[A-Z]+\d*/g, '').replace(/@[A-Z]+\d*/g, '标签');
  s = s.replace(/ref=\s*[^\s,，;；]+/g, '');
  s = s.replace(/[，,]\s*$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 动作失败：把失败原因写回 history 并继续循环，让 LLM 修正；连续失败则转人工
async function pushFailure(t, why, quiet, sig) {
  if (!t || t.state !== 'working') return;
  if (t._inBatch) t._batchFailed = true; // 批量执行中失败：runActionBatch 据此结束本批，走重读页重规划，不在批内硬续
  t.failStreak = (t.failStreak || 0) + 1;
  t.stuck = (t.stuck || 0) + 1; // 失败也是"无进展"，计入 stuck（配合 runAction 的重复识别，累计到阈值转教我）
  t.unprodStreak = 0; // 失败由 failStreak/stuck 自带的转教我处理，不再计入"轮级无进展"（避免两套计数叠加双倍计）
  if (sig) t.lastActSig = sig; // 失败的动作也算"最近尝试"，这样反复重试同一个失败动作也会被识别为重复
  if (t.curPageSig) t.actionPageSig = t.curPageSig; // 失败也算一次"动作"，记录其时的页面状态
  // 失败清零"当前页"熟悉度：该页从批量模式退回谨慎模式（每步读页、一次一个动作），连续成功几步后再放开
  const cur = currentEntry(t);
  if (cur) {
    t.pageSnapCounts = t.pageSnapCounts || {};
    t.pageSnapCounts[pageKeyOf(cur.url)] = 0;
  }
  if (t.stuck >= STUCK_TEACH_LIMIT) {
    await askUser(t, '我反复尝试了 ' + t.stuck + ' 次仍然没有进展。' + currentStepNote(t) + '请你在当前页面上手把手演示一遍正确操作，我会记录学习后照着做。', 'teach');
    return;
  }
  if (t.failStreak >= 3) {
    const site = currentSiteLabel(t);
    // quiet 失败是"内部纠错、不刷用户面板"——文案写给模型看（如"先 list_tabs"），使用者无法代模型执行，
    // 拼进求助卡片只会让人困惑。升级转人工时这类失败不附原因。
    const plain = quiet ? '' : humanizeWhy(why);
    // 卡片要讲清"卡在哪一步 + 请使用者帮什么"，而不是只报站点：
    //  1) 当前步骤（t.plan 里第一个未完成的步骤，如"打开候选帖子详情页批量读取正文"）——使用者一眼知道该帮哪一步；
    //  2) 失败原因（非 quiet 才有，humanizeWhy 已转成使用者能懂的话）；
    //  3) 明确请使用者做什么（页面上操作完点继续 / 在对话里告诉 Agent 该怎么做）。
    // 刻意不附"刚在尝试的哪个动作"：底层动作（如切换标签）对使用者没有意义，反而干扰判断，当前步骤已足够说明问题。
    const stepNote = currentStepNote(t); // "当前步骤：xxx。"（优先具体步骤；步骤计划缺失才退大目标兜底）
    const askNote = '请帮我看一眼当前页面：如果是需要你手动操作（登录/验证码/特别步骤），直接在页面上帮我完成，完成后点「我已操作完成，继续」；如果是我理解错了，告诉我该怎么操作，我会照做。';
    await askUser(t, '在 ' + site + ' 上连续操作失败。' + stepNote + (plain ? '失败原因：' + plain + '。' : '') + askNote, undefined, '遇到了问题，需要你帮忙');
    return;
  }
  t.history.push({ role: 'user', content: '动作执行失败：' + why + '（先对照快照里的【本站操作经验】调整做法再重试，别硬试同一招）' });
  addLog(t.sid, why, quiet); // quiet=true 只进 SW console，不刷用户面板——内部纠错类失败（如切到不存在的标签 ref），使用者无需看原始 ref/tabId
  await saveTasks();
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// 求助卡里附一句"当前卡在哪一步"：从步骤计划（t.plan，[{text,done}]）取第一个未完成的步骤——
// 比整句大目标具体得多，使用者一看就知道该帮哪一步（"当前步骤：点击「收藏」按钮"好过"总结网友意见"）。
// 步骤计划缺失/没有未完成步骤时退回整句目标兜底；两者都无则空。
// 只用于 Agent 主动求助的卡；使用者主动说"我教你"时 goal 是占位文案，不进卡片。
function currentStepNote(t) {
  if (t && Array.isArray(t.plan)) {
    const cur = t.plan.find((s) => s && !s.done && s.text);
    if (cur) return '当前步骤：' + cur.text + '。';
  }
  return teachGoalNote(t);
}

// 整句目标兜底（步骤计划缺失时用）："当前目标：xxx。"
function teachGoalNote(t) {
  const g = String((t && t.goal) || '').trim();
  return g ? '当前目标：' + midTruncate(g, 44) + '。' : '';
}

// 请求使用者协助：暂停当前回合，等"继续"。
//   page  = 使用者在【页面上】手动操作（验证码/登录等），操作完点"继续"；
//   teach = 使用者在【页面上】手把手演示操作，Agent 记录学习（教我模式）；
//   reply = 使用者在【对话中】直接回复信息。
async function askUser(t, msg, mode, logMsg) {
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
  timerPause(t); // 等你操作（含教我演示等待）：计时暂停
  t.state = 'waiting_user';
  t.askText = String(msg);
  t.askMode = isTeach ? 'teach' : (isReply ? 'reply' : (isConfirm ? 'confirm' : 'page'));
  t.waitingReply = isReply; // confirm 不设 waitingReply：使用者直接在输入框打的字走 processUserMessage 的"确认循环"分流（确认/不教了/先去做/纠正）
  t.awaitingNavAt = 0;
  t.waitTabId = null;
  t.failStreak = 0;
  t.stuck = 0; // 任何一次请使用者协助都是一个检查点，无进展计数清零
  t.unprodStreak = 0; // 同上：请使用者协助后轮级无进展计数也清零
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
  // 卡片外的活动日志行可用 logMsg 精简（如"遇到了问题，需要你帮忙"）；卡片正文/LLM 上下文仍用完整 msg
  addLog(t.sid, label + (logMsg !== undefined ? logMsg : msg), false, false); // 请求人工协助：不是批内连续动作，不标批量灰底
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

// ---------------- 站点操作经验库（复盘沉淀，操作时加载） ----------------

const EXP_KEY = 'siteExperiences';   // storage.local 键：{ [host]: {scene, params, code}[] }（旧 string 数据在 getExpStore 一次性归一化）
const LEGACY_TIPS_KEY = 'siteTips';  // 旧版"技巧"键：改名"经验"后一次性迁移到 EXP_KEY
// 经验条数不设硬性上限：每次沉淀合并时都判断"重复/相近"并合并，数量会自然收敛，无需人为截断
const EXP_ACTION_THRESHOLD = 3;      // 单站点动作数 ≥ 此值 → 候选站点（动作多，通常有可复用的操作值得沉淀）
const EXP_FAIL_THRESHOLD = 2;        // 单站点失败数 ≥ 此值 → 候选站点（失败多，沉淀绕弯后的正确做法）
const EXP_MAX_NEW = 10;              // 每次复盘最多新增的经验条数
// 单条经验 = {scene, params, code}。以下上限随实现逐条列出（截断/停止/数量限制）：
const EXP_SCENE_MAX = 120;           // 场景简述最大字符数
const EXP_CODE_MAX = 10000;          // 单条经验代码最大字符数
const EXP_PARAMS_MAX = 8;            // 单条经验最多参数个数
const EXP_PARAM_NAME_MAX = 24;       // 参数名最大字符数
const EXP_PARAM_DESC_MAX = 100;      // 参数说明最大字符数

// 域名 = host（只记录域名，不带协议/路径/查询）；入参可能是完整 URL 也可能是裸域名，都能解析
function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : ('https://' + s));
    return u.hostname;
  } catch (e) { return ''; }
}

// 单条经验归一化：兼容旧 string（"技巧"时期/旧版）与新 {scene, params, code} 对象，幂等。
// scene 为空返回 null（丢弃）；code 去 CR 并截断；params 逐项归一化（name 空则丢该项，超出 EXP_PARAMS_MAX 只留前 N 条）。
function normExp(item) {
  if (typeof item === 'string') item = { scene: item };
  if (!item || typeof item !== 'object') return null;
  const scene = String(item.scene || '').replace(/\s+/g, ' ').trim().slice(0, EXP_SCENE_MAX);
  if (!scene) return null;
  const code = String(item.code || '').replace(/\r/g, '').trim().slice(0, EXP_CODE_MAX);
  const params = [];
  if (Array.isArray(item.params)) {
    for (const p of item.params) {
      if (!p || typeof p !== 'object') continue;
      const name = String(p.name || '').trim().slice(0, EXP_PARAM_NAME_MAX);
      if (!name) continue;
      const desc = String(p.desc || '').replace(/\s+/g, ' ').trim().slice(0, EXP_PARAM_DESC_MAX);
      params.push({ name, desc });
      if (params.length >= EXP_PARAMS_MAX) break;
    }
  }
  return { scene, params, code };
}

// 经验列表指纹：归一化后各条 scene/code/params 序列化的哈希。exec_code 的新鲜度闸门用它判断
// "快照时加载的经验编号"是否仍与当前库一致（经验在快照后增删/编辑过，编号就漂移了，得重新 snapshot）。
function expSig(list) {
  let s = '';
  for (const x of (list || [])) {
    const e = normExp(x);
    if (e) s += e.scene + '\n' + e.code + '\n' + e.params.map((p) => p.name + '=' + p.desc).join(',') + '\n';
  }
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

// 经验对象 → 展示用文本（喂 LLM 判断"已有哪些经验"时用；代码不展开、只标"有可执行代码"）
function expTextOf(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  let s = String(item.scene || '').trim();
  if (Array.isArray(item.params) && item.params.length) {
    s += '（参数 ' + item.params.map((p) => p.name + '=' + (p.desc || '')).join('；') + '）';
  }
  if (String(item.code || '').trim()) s += '（有可执行代码）';
  return s;
}

// 快照经验行：带编号；有可执行代码标「可执行」；有参数附传参说明（Agent 调 exec_code 时知道传什么）
function expSnapLine(idx, item) {
  const e = normExp(item);
  if (!e) return '';
  let s = '· [经验' + idx + ']' + (e.code ? '（可执行）' : '') + ' ' + e.scene;
  if (e.params.length) s += '（exec_code 时 args 传：' + e.params.map((p) => p.name + '=' + p.desc).join('；') + '）';
  return s;
}

// 经验对象 → 合并用完整文本（含完整代码，供 LLM 合并时对照去重/取舍）
function expFullText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const parts = ['场景：' + String(item.scene || '').trim()];
  if (Array.isArray(item.params) && item.params.length) {
    parts.push('参数：' + item.params.map((p) => p.name + '（' + (p.desc || '') + '）').join('；'));
  }
  const code = String(item.code || '').trim();
  if (code) parts.push('代码：\n' + code);
  return parts.join('\n');
}

async function getExpStore() {
  const obj = await chrome.storage.local.get([EXP_KEY, LEGACY_TIPS_KEY]);
  const store = (obj && obj[EXP_KEY]) || {};
  // 一次性迁移：旧键 siteTips（"技巧"时期）→ siteExperiences，迁移后删旧键
  if (obj && obj[LEGACY_TIPS_KEY] && !Object.keys(store).length) {
    const legacy = obj[LEGACY_TIPS_KEY];
    if (legacy && typeof legacy === 'object') {
      for (const h of Object.keys(legacy)) if (Array.isArray(legacy[h]) && legacy[h].length) store[h] = legacy[h];
    }
    await chrome.storage.local.set({ [EXP_KEY]: store });
    await chrome.storage.local.remove(LEGACY_TIPS_KEY);
  }
  // 归一化：旧 string / 缺字段对象 → {scene, params, code}，幂等；有变化才写回存储（只此一次，之后读走干净数据）
  let changed = false;
  for (const h of Object.keys(store)) {
    if (!Array.isArray(store[h])) { delete store[h]; changed = true; continue; }
    if (store[h].some((x) => typeof x === 'string' || !x || typeof x !== 'object' || !Array.isArray(x.params))) {
      store[h] = store[h].map(normExp).filter(Boolean);
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [EXP_KEY]: store });
  return store;
}

// 取某站点的操作经验（无则返回空数组）
async function getSiteExperiences(host) {
  if (!host) return [];
  const store = await getExpStore();
  return store[host] || [];
}

// 全站经验总条数（面板经验按钮的角标数字）
async function totalExpCount() {
  const store = await getExpStore();
  return Object.values(store).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
}

async function saveSiteExperiences(host, experiences, sid) {
  const store = await getExpStore();
  const cleaned = (experiences || []).map(normExp).filter(Boolean);
  // 删空连站点一起删：站点下没经验了就不留空数组占位（面板按键列出站点，空键只会制造"没经验却在列表里"的站点行）
  if (cleaned.length) store[host] = cleaned;
  else delete store[host];
  await chrome.storage.local.set({ [EXP_KEY]: store });
  // 复盘/教我沉淀了新经验后，广播新总数让面板经验按钮的数字跟着变（带来源会话 sid，面板按会话路由也能收到）
  if (sid != null) broadcast({ type: 'EXP_CHANGED', count: await totalExpCount() }, sid);
}

// 最终结果里自认未完成的强信号：明说要重做（重新下载/重新操作）、明确没做到/漏了/没拿到。
// 只匹配"自己承认没达成"的最强表述——避免把"已完成 + 顺带提一句可选的后续优化"（如"如需按月份分文件夹整理可告诉我"）
// 误判成失败。命中就整轮跳过经验沉淀，防止把错误操作的轨迹当成正确路径写进经验库。
function selfReportedFailure(result) {
  const s = String(result || '');
  return /未能|没能|没(?:有)?(?:完成|成功|做到|下载到|拿到|办到)|无法(?:完成|做到|下载)|漏了|遗漏|重新(?:下载|操作|做|来|点|筛选)/.test(s);
}

// 复盘入口（与书签复盘并列，都在 finish 时跑）：把本轮"做过可复用操作 / 反复失败 / 动作多"
// 的站点列为候选，把实际操作轨迹交给 LLM 判断哪些操作**未来值得复用**——不要求必须绕了弯路，
// 一路顺利但通用（下次还会再做）的操作同样沉淀为经验（只记域名），并带上该站既有经验做冲突去重合并，持续全量优化。
async function reviewAndLearnExperiences(t, force, pinnedTurn) {
  if (!t) return;
  // force：停止后复盘用（state 已回 idle，仍要跑复盘）；正常 finish 复盘时 force 为空，保持"仅 working 时复盘"
  if (!force && t.state !== 'working') return;
  const myTurn = (pinnedTurn != null) ? pinnedTurn : t.turnId; // 钉住停止那一刻的回合号，中途新指令会打断复盘
  // 任务结果自检：最终结果是否自认"没做到 / 需要重做"。
  // 失败轮次沉淀的经验会把错误操作（ref 漂移的无效点击、滚动来回找）当成"成功路径"照搬进经验库，
  // 跨会话传染同样的绕路（这就是"点全选前先滚动"这类坏经验）——这类轮次直接跳过沉淀，宁可少沉淀、不要沉淀错的。
  if (selfReportedFailure(t.result)) {
    addLog(t.sid, '复盘经验跳过：本轮最终结果自认未完成，错误操作不沉淀为经验'); // 面板可见 + 进导出日志⑤：跳沉淀也要让使用者看得见原因
    return;
  }
  const report = collectDifficultyReport(t);
  if (!report) { addLog(t.sid, '复盘经验：本轮无候选站点（无失败/无困难操作），不沉淀经验'); return; }
  const cfg = await getConfig();
  if (!cfg.apiKey) { addLog(t.sid, '复盘经验：未配置 API Key，跳过沉淀'); return; }
  if (!stillCurrent(t, myTurn, force)) { addLog(t.sid, '复盘经验：复盘期间来了新指令，本次沉淀跳过'); return; }
  const store = await getExpStore();
  const oldByHost = {};
  for (const h of report.domains) oldByHost[h] = (store[h] || []); // 对象数组：展示用 expTextOf，合并时整份交给 merge
  // 本轮 exec_code 失败并已删除的经验：把失败原因喂给 LLM，生成/合并同站经验时参考，避免再犯同类错误
  const expFailures = (t._expFailures || []).filter((f) => f && report.domains.includes(f.host));
  const expFailText = expFailures.length
    ? '\n\n本轮有几条【既有经验】的代码执行失败（已删除），失败原因如下——若本次为同站同类操作生成/合并经验，请对照这些原因检查新代码，避免再生成同样会失败的选择器或逻辑（例如选择器不匹配当前页真实元素、只匹配 input 却漏了 textarea、硬编码了本轮才有的路径/值等）：\n' +
      expFailures.map((f) => '- ' + f.host + '「' + f.scene + '」失败原因：' + (f.reason || '未说明')).join('\n')
    : '';
  const msgs = [
    {
      role: 'system',
      content: '你是 PageAgent 的"网站操作经验沉淀"助手。本次任务里 Agent 在某些网站做了操作，其中可能有绕弯路的部分（点错后纠正、操作失败后换招、重复点击同一处、滚动来回找、做了多余无效步骤才最终做对），也可能一路顺利。请逐个候选站点看它的实际操作轨迹，判断该站的哪些操作**未来在同类任务里值得复用**——**不要求这轮必须绕了弯路**：只要是在该站会重复遇到的通用操作（搜索、筛选、翻页、下载、提交表单、批量处理、跳转固定入口等），就算一路顺利也值得沉淀成经验。沉淀什么就写什么：要么是绕弯纠正后的正确做法，要么是顺利完成的通用操作；**没有复用价值的就不写**——纯阅读无交互、明显一次性/专属本轮、纯网络/服务端问题（页面打不开、超时、接口报错）、已有经验里讲过的（含已写过的代码）。每条经验的内容要写：**怎么做才是对且省事的**——即最正确、最省事的做法（比如"不用先滚动，直接点『全选』就行""搜索后要直接点下拉候选里的第一条，不能直接回车"），并把它**实现成一段可在该页面执行的 JS**。要求：① 只讲该网站的通用操作习惯，**禁止照搬本轮一次性内容**——不要出现具体搜索词、地点名、用户名、页面元素文本（如"点击『湖南郴州裕后街』"这种），要抽象成"输入框/下拉/按钮/列表"这类功能操作的规律。另外，报告里的"成功操作"只表示动作执行返回 ok，**不代表点对了**——ref 漂移时可能点到无关元素（如想点『全选』结果点成了『邮箱』）。哪些是正确做法，要以【最终结果】是否达成目标来定；拿不准的宁可不写，不要沉淀"按某编号元素点"这类依赖快照编号、换页即失效的做法。宁可少沉淀，不要沉淀明显一次性的。\n\n每条经验是对象 {scene, params, code}：**scene** 一句话描述适用场景（哪个页面/哪类操作，通用化，不含本轮一次性内容）；**code** 是把正确做法写成的、可在该页面 DOM 里执行的 JS——自包含、元素缺失要优雅返回 {ok:false,message}、末尾 return 结果对象；定位元素用通用稳定信号（按钮文字如『全选』『删除』、placeholder、name、data-testid、结构类名）；**禁止把本轮的搜索词/地点/用户名/页面文本硬编码进代码**——正确做法里依赖任务具体值的地方声明成参数：**params** 里给 name + desc（desc 说明传什么值并附示例，如"要搜索的关键词，如\\"AI 趋势\\""），code 里用 args.<参数名> 取（如输入搜索词就是 `input.value=args.keyword` 之类），这样 Agent 下次在同站传新值就能复用；没有可变值则 params 留空数组。禁止 fetch/XMLHttpRequest/WebSocket/本地存储/新开窗口/页面跳转/alert 弹窗/死循环；确实写不出通用代码时 code 留空字符串、只保留 scene 当提示。'
    },
    {
      role: 'user',
      content: '本轮操作报告：\n' + report.text +
        '\n\n本轮任务目标：' + String(t.goal || '（无）').slice(0, 200) + '\n最终结果：' + String(t.result || '（无）').slice(0, 300) +
        expFailText +
        '\n\n这些域名已有的操作经验（避免重复）：\n' + report.domains.map((h) => h + '：' + ((oldByHost[h] || []).map(expTextOf).join('\n') || '（无）')).join('\n') +
        '\n\n只输出 JSON：{"experiences":[{"domain":"域名","scene":"场景简述","params":[{"name":"参数名","desc":"传什么值/示例"}],"code":"JS 代码"}]}。每条 experience 的 domain 必须是上面报告里出现的域名；最多 ' + EXP_MAX_NEW + ' 条；某站点没有可复用操作就不写它，全都没有就输出 {"experiences":[]}。'
    }
  ];
  // 生成前先留一行"正在沉淀"标记：LLM 调用可能耗时较长（超时 240s），
  // 中途导出的日志也看得出复盘正在进行、而不是没跑（否则"复盘中…"之后一片空白，像功能挂了）。
  // 尽量与书签复盘那行"复盘网站：筛选出 N 个有用站点"合并成一行（用户反馈"筛选写了两行"太啰嗦）：
  // 书签复盘后没插别的行（末条即筛选行）就原地改写它、追加"总结网站用法…"；否则退回独立候选行。
  const actLast = (getTask(t.sid) || {}).activities || [];
  const lastText = actLast.length ? String(actLast[actLast.length - 1].text || '') : '';
  if (lastText.indexOf('复盘网站：筛选出') === 0) {
    updateLog(t.sid, null, lastText + '，总结网站用法…');
  } else {
    addLog(t.sid, '复盘网站：候选站点 ' + report.domains.length + ' 个（' + midTruncate(report.domains.join('、'), 40) + '），总结网站用法…');
  }
  let arr = [];
  let raw = ''; // 复盘返回原文：LLM 调用失败时为空，JSON 解析失败时保留原文供诊断
  try {
    raw = await callLLM(msgs, undefined, t);
    await logLLMExchange(t, msgs, raw, '复盘·经验沉淀'); // 复盘的过程也要进导出日志（② 大模型返回节）：沉淀了哪些站的哪些经验
    const obj = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
    arr = (obj && Array.isArray(obj.experiences)) ? obj.experiences : [];
  } catch (e) {
    // 失败原因不再闷在 SW console：面板可见 + 进导出日志⑤；解析失败时带原文片段，一眼看出是调用错还是返回格式错
    console.error('[PageAgent] 复盘经验生成失败：', e);
    addLog(t.sid, '复盘经验生成失败：' + e.message + (raw ? ' 原文=' + midTruncate(raw, 200) : ''));
    return;
  }
  if (!stillCurrent(t, myTurn, force)) return;
  // 按域名分组：只写报告里的域名，防 LLM 乱加别的站点；归一化成 {scene, params, code} 对象
  const byHost = new Map();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const h = hostOf(item.domain);
    if (!h || !report.domains.includes(h)) continue;
    const exp = normExp(item); // scene 空 / 归一化失败 → null 丢弃
    if (exp) { if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(exp); }
  }
  if (!byHost.size) {
    // 有候选站点但 LLM 判定无复用价值：不沉淀任何经验（宁缺毋滥）——结论要可见，别让"为什么没沉淀"靠猜
    addLog(t.sid, '复盘经验：本轮候选站点未发现可复用的经验');
    return;
  }
  for (const [h, newExp] of byHost) {
    if (!stillCurrent(t, myTurn, force)) break;
    try {
      const merged = await mergeSiteExperiences(h, newExp, oldByHost[h], t.sid);
      if (!merged || !merged.length) continue;
      await saveSiteExperiences(h, merged, t.sid);
      // 每个站一行即最终沉淀结果，不再另报"总结了 N 个"总数（用户反馈"沉淀写了两行"太啰嗦；各站新增条数已够）
      addLog(t.sid, '复盘：沉淀 ' + h + ' 的操作经验（新增 ' + newExp.length + ' 条）'); // 面板可见 + 进导出日志⑤
    } catch (e) {
      console.error('[PageAgent] 复盘经验保存失败：' + h, e);
      addLog(t.sid, '复盘经验保存失败：' + h + ' → ' + e.message);
    }
  }
}

// 合并某域名的既有经验与新经验：同站同操作的冲突经验合并处理、有价值的旧经验保留。返回最终对象列表。
// newExp / oldExp 都是 {scene, params, code} 对象数组（旧数据在 getExpStore 已归一化）。
async function mergeSiteExperiences(host, newExp, oldExp, sid) {
  const cfg = await getConfig();
  if (Array.isArray(oldExp) && oldExp.length && cfg.apiKey) {
    const msgs = [
      {
        role: 'system',
        content: '你是 PageAgent 的"网站操作经验合并"助手。给定一个网站的【旧经验】和【新经验】，合并成一份最终经验列表。每条经验是 {scene, params, code} 对象：scene 是"该怎么做"的一句话、params 是参数声明（name+desc，无则空数组）、code 是可执行 JS（自包含、用 args.<参数名> 取参数、无代码则 code 为空字符串）。规则：① 同一操作的不同/冲突经验要合并，新经验能覆盖旧经验的以新为准（新 code 比旧 code 正确时用新的）；② 仍有用的旧经验保留，不要丢失；③ scene 一句话、具体可执行；④ 重复或相近的经验必须合并成一条，宁精勿滥，不要让同一条经验以不同措辞堆叠多条；⑤ 只输出 JSON 数组，如 [{"scene":"经验一","params":[],"code":""},{"scene":"经验二","params":[{"name":"keyword","desc":"要搜索的关键词"}],"code":"..."}]。'
      },
      { role: 'user', content: '网站：' + host + '\n旧经验：\n' + (oldExp.map(expFullText).join('\n\n') || '（无）') + '\n\n新经验：\n' + newExp.map(expFullText).join('\n\n') }
    ];
    let raw = ''; // 合并返回原文：解析失败时保留原文供诊断
    try {
      const tsk = getTask(sid) || undefined;
      raw = await callLLM(msgs, { json: false }, tsk);
      await logLLMExchange(tsk, msgs, raw, '复盘·经验合并'); // 复盘的过程也要进导出日志（② 大模型返回节）：合并后最终留下哪些经验
      const arr = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
      if (Array.isArray(arr) && arr.length) {
        const clean = arr.map((x) => normExp(x)).filter(Boolean);
        if (clean.length) return clean;
      }
    } catch (e) {
      console.error('[PageAgent] 复盘经验合并失败：', e);
      addLog(sid, '复盘经验合并失败：' + e.message + (raw ? ' 原文=' + midTruncate(raw, 200) : '')); // 面板可见 + 进导出日志⑤
    }
  }
  // 兜底：旧 + 新 按 scene 去重（LLM 合并失败时不让旧经验丢失）
  const merged = [];
  const seen = new Set();
  for (const x of [...newExp, ...(Array.isArray(oldExp) ? oldExp : [])]) {
    const e = normExp(x);
    if (!e) continue;
    const key = String(e.scene).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  return merged;
}

// 统计本轮各站点的动作数/失败数/可交互操作数，返回"候选站点"的报告（供 LLM 判断哪些操作值得沉淀成经验）。
// 只统计实际操作过的站点：快照【当前页面】URL 之后、到下一个快照之前的动作归属该站点。
// 候选信号：失败 ≥ EXP_FAIL_THRESHOLD，或动作 ≥ EXP_ACTION_THRESHOLD，或做过可交互操作（clicks ≥ 1）——
// 不要求"绕了弯路"：只要做过点击/输入/选择这类可复用操作，就算一路顺利也列为候选，交 LLM 判断有无复用价值。
// 报告带实际操作轨迹（成功结果补元素 label，如 click(邮箱)→click(全选)），LLM 据此识别可沉淀的操作与绕弯。
function collectDifficultyReport(t) {
  const slice = (t.history || []).slice(t.turnHistoryStart || 0);
  const sites = new Map(); // host -> { actions, fails, clicks, actLines: Map<actionType,count>, actSeq: [], failMsgs: [], okSeq: [] }
  const ensure = (h) => {
    if (!h) return null;
    if (!sites.has(h)) sites.set(h, { actions: 0, fails: 0, clicks: 0, actLines: new Map(), actSeq: [], failMsgs: [], okSeq: [] });
    return sites.get(h);
  };
  let cur = null; // 当前操作站点
  let lastActType = null; // 最近一个"可点类"动作类型，供配对成功的"动作结果"label（尽力配对，label 本身才是关键）
  let lastActIdx = -1;   // 最近一个"可点类"动作在轨迹里的位置，成功结果返回时给轨迹补 label
  const CLICKLIKE = new Set(['click', 'clickAt', 'dblclickAt', 'gotoCell', 'clickText', 'hover', 'show', 'type', 'select', 'keypress']);
  for (const m of slice) {
    if (m.role === 'assistant' && typeof m.content === 'string') {
      for (const a of histActionList(m.content)) { // 兼容单动作与批量数组
        if (!a || typeof a !== 'object' || !a.action) continue;
        if (CLICKLIKE.has(a.action)) lastActType = a.action; // 成功结果带元素 label，供复盘提炼"走通的操作"
        if (a.action === 'open_tab' || a.action === 'navigate' || a.action === 'search') {
          cur = ensure(hostOf(a.url));
          if (cur) { cur.actions++; bumpAct(cur, a.action); }
        } else if (CLICKLIKE.has(a.action) || a.action === 'scroll') {
          if (cur) {
            cur.actions++;
            bumpAct(cur, a.action);
            if (CLICKLIKE.has(a.action)) { cur.clicks++; lastActIdx = cur.actSeq.length - 1; } // 记住该动作在轨迹里的位置，供结果 label 回填
          }
        }
      }
    } else if (m.role === 'user' && typeof m.content === 'string') {
      const pm = m.content.match(/【当前页面】URL:\s*(\S+)/);
      if (pm) cur = ensure(hostOf(pm[1]));
      if (m.content.indexOf('动作执行失败') !== -1 && cur) {
        cur.fails++;
        cur.failMsgs.push(m.content.replace(/^动作执行失败：/, '').slice(0, 500));
      }
      // 成功的动作结果带元素 label（"动作结果：{"ok":true,"label":"发布",...}"）：把"最终走通的操作"记进报告，
      // 复盘沉淀经验时 LLM 能据此提炼"该怎么操作才顺"；同时给轨迹补上 label（click → click(邮箱)），
      // 让 LLM 看到真实点击轨迹、判断"点错再点对"这类绕弯，而不是只看到失败。
      const rm = m.content.match(/^动作结果：(.*)/);
      if (rm && cur && lastActType) {
        try {
          const r = JSON.parse(rm[1]);
          if (r && r.ok && r.label) {
            const lbl = String(r.label).replace(/\s+/g, ' ').trim().slice(0, 16);
            if (lbl) {
              cur.okSeq.push(lastActType + '(' + lbl + ')');
              if (lastActIdx >= 0 && cur.actSeq[lastActIdx] === lastActType) cur.actSeq[lastActIdx] = lastActType + '(' + lbl + ')';
            }
          }
        } catch (e) { /* 结果非 JSON（如链接后台打开的消息），跳过 */ }
      }
    }
  }
  const bad = [...sites.values()].filter((s) => s.fails >= EXP_FAIL_THRESHOLD || s.actions >= EXP_ACTION_THRESHOLD || s.clicks > 0);
  // exec_code 失败并删除了经验：该站即使动作/失败数不够候选门槛也强制进候选，让本次复盘读到失败原因、避免再生成同类代码
  for (const f of (t._expFailures || [])) {
    if (!f || !f.host) continue;
    const s = ensure(f.host);
    if (s && !bad.includes(s)) bad.push(s);
  }
  if (!bad.length) return null;
  const hostOfSite = (s) => { for (const [h, v] of sites) if (v === s) return h; return ''; };
  const lines = [];
  for (const s of bad) {
    const h = hostOfSite(s);
    const acts = [...s.actLines.entries()].map(([k, n]) => k + '×' + n).join(' ');
    lines.push('【' + h + '】动作 ' + s.actions + ' 次' + (s.fails ? '，失败 ' + s.fails + ' 次' : '') + (acts ? '；动作分布：' + acts : '') + (s.okSeq.length ? '；成功操作：' + s.okSeq.join('→') : '') + (s.actSeq.length ? '；动作轨迹：' + s.actSeq.join('→') : ''));
    for (const f of s.failMsgs) lines.push('  - 失败：' + f);
  }
  return { domains: bad.map(hostOfSite), text: lines.join('\n') };
}

function bumpAct(site, action) {
  site.actLines.set(action, (site.actLines.get(action) || 0) + 1);
  site.actSeq.push(action);
}

// ---------------- 跨页面/跨标签恢复 ----------------
function findTabEntryByTabId(tabId, t) {
  return (t.tabs || []).find((e) => e.tabId === tabId) || null;
}

function awaitNav(t, tabId) {
  if (!t) return;
  if (t._inBatch) return; // 批内跨页：不动 state（仍 working），页面就绪由 runActionBatch 在下一页面动作前自动保障；单页加载不再打断整批
  t.state = 'awaiting_nav';
  t.awaitingNavAt = Date.now();
  t.waitTabId = tabId;
  t.lastActSig = ''; // 换了操作页面上下文，上一页的动作签名作废
  if (t.sigRepeat) t.sigRepeat.clear(); // 换页后 ref 重排、编号语义全变，同一目标重复计数作废
  const entry = findTabEntryByTabId(tabId, t);
  t.navWaitIdx = true; // 标记"打开页面"行已显示，就绪后合并成一行
  t.navWaitUrl = null; // awaitNav 无具体地址（点击/切页后等就绪），合并时按无地址行文
  addLog(t.sid, '打开页面…');
  saveTasks();
}

// 带超时的 sendMessage：接收端存在但主线程繁忙时 sendMessage 可能一直 pending，必须超时兜底（超时返回 null）。
// opts 透传给 chrome.tabs.sendMessage（如 { frameId }），与不带超时的裸调用行为一致。
function sendTab(tabId, msg, timeoutMs, opts) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 1500);
    chrome.tabs.sendMessage(tabId, msg, opts).then(
      (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

// 快照失败进入等待后，AGENT_READY / onUpdated 可能在 state 置位前就已广播（被 tryResume 的
// state==='awaiting_nav' 门槛挡掉），造成恢复信号丢失、只能干等心跳最多 1 分钟。waitTabReady
// 在等待期间轮询该标签：页面就绪（PING 有响应且 tab 状态 complete）就立刻 tryResume，几秒内补上漏掉的恢复。
async function waitTabReady(t, tabId, myTurn) {
  const sid = t && t.sid;
  if (!sid) return;
  for (let i = 0; i < 12; i++) { // 最多 ~10s（每次 PING 1.5s 超时兜底），超时交给心跳 / AGENT_READY / onUpdated 接管
    const cur = getTask(sid);
    if (!cur || cur.turnId !== myTurn) return;                       // 会话已被打断 / 切换
    if (cur.state !== 'awaiting_nav' || cur.waitTabId !== tabId) return; // 已恢复或换了等待目标
    if (Date.now() - (cur.awaitingNavAt || 0) > NAV_TIMEOUT_MS) return;  // 交给心跳报加载超时
    const pong = await sendTab(tabId, { type: 'PING' }, 1500);
    if (!pong) { await sleep(250); continue; }                       // 还没就绪，继续等
    const tab = await getTab(tabId);
    if (tab && tab.status === 'complete') {
      tryResume(sid, tabId);
      return;
    }
    await sleep(250);
  }
}

function tryResume(sid, tabId) {
  const t = getTask(sid);
  if (!t || t.state !== 'awaiting_nav') return;
  if (t.waitTabId && t.waitTabId !== tabId) return; // 等的不是这个标签
  if (Date.now() - (t.awaitingNavAt || 0) > NAV_TIMEOUT_MS) {
    fail(t, '页面加载/跳转超时');
    return;
  }
  const waitMs = Math.round(Date.now() - (t.awaitingNavAt || 0));
  t.state = 'working'; // 同步置位，避免 AGENT_READY 与 onUpdated 双触发
  if (t.navWaitIdx) {
    // navigate 路径：把就绪用时合并进"打开页面 <地址>"本行 → "打开页面 <地址> · XXms"；awaitNav 路径（无地址）保持"打开页面… 页面已就绪 · XXms"
    updateLog(t.sid, t.navWaitIdx, t.navWaitUrl ? '打开页面 ' + t.navWaitUrl + ' · ' + waitMs + 'ms' : '打开页面… 页面已就绪 · ' + waitMs + 'ms');
    t.navWaitIdx = null;
    t.navWaitUrl = null;
  } else {
    addLog(t.sid, '页面已就绪 · ' + waitMs + 'ms');
  }
  saveTasks();
  agentStep(t).catch((e) => fail(t, '运行异常：' + e.message));
}

// ---------------- 完成 / 失败（回到 idle，等待下一条指令） ----------------
async function complete(t, result) {
  if (!t) return;
  if (t.state === 'idle') return; // 已被新指令打断/停止
  timerPause(t); // 完成文字落定的这一刻停止计时；之后跑复盘不再计入
  t.state = 'idle';
  await closeAgentTabs(t).catch(() => {}); // 每轮完成自动关闭 Agent 自开标签（使用者的标签永不关闭）
  await restoreShownOnSession(t).catch(() => {}); // 还原本会话在"使用者标签"上 show 强制显示的元素，避免菜单常驻
  t.turnSteps = 0;
  t.result = String(result);
  // 步骤计划：全部划线（面板保留展示直到下一条新指令）
  if (t.plan && t.plan.length) {
    t.plan = t.plan.map((s) => ({ text: s.text, done: true }));
    broadcast({ type: 'AGENT_PLAN', steps: t.plan }, t.sid);
  }
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
  timerPause(t); // 失败文字落定的这一刻停止计时
  t.state = 'idle';
  await closeAgentTabs(t).catch(() => {}); // 每轮失败也清理 Agent 自开标签（使用者的标签永不关闭）
  await restoreShownOnSession(t).catch(() => {}); // 还原本会话在"使用者标签"上 show 强制显示的元素，避免菜单常驻
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
  if (!midTask) timerBegin(t); // 空闲发起的教我 = 新任务，开始计时（随后 askUser 等待演示时会暂停）
  t.turnId++;
  t.state = 'working'; // 临时置 working（覆盖 idle/done/waiting_user），让 askUser 的校验通过
  t.turnSteps = 0;
  t.waitTabId = null;
  t.askText = null;
  t.failStreak = 0;
  t.stuck = 0;
  t.unprodStreak = 0;
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
  await askUser(t, '请把你想让我学会的操作演示给我看，完成后点「我操作完了」', 'teach');
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
      addLog(t.sid, '使用者终止教学：' + midTruncate(content, 32));
      t.askMode = null;
      t.askText = null;
      t.waitTabId = null;
      t.teachEvents = []; // 未确认的教学步骤不沉淀
      timerResume(t); // 终止教学、继续原任务：计时恢复
      t.state = 'working';
      t.turnSteps = 0;
      t.failStreak = 0;
      t.stuck = 0;
      t.unprodStreak = 0;
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
      addLog(t.sid, '使用者在对话里确认复述无误：' + midTruncate(content, 32));
      await resumeAfterUser(t.sid, content); // 把使用者的话带进去，避免重复占位
      return;
    }
    // 纠正：保留原始目标/goal，进入"再理解-再确认"循环
    addLog(t.sid, '使用者对复述提出纠正，进入再理解-再确认循环：' + midTruncate(content, 32));
    t.askMode = null;
    t.askText = null;
    t.waitTabId = null;
    timerResume(t); // 纠正循环重开：计时恢复
    t.state = 'working';
    t.turnSteps = 0;
    t.failStreak = 0;
    t.stuck = 0;
    t.unprodStreak = 0;
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
    timerResume(t); // 你回复完、Agent 继续：计时恢复
    t.state = 'working';
    t.waitingReply = false;
    t.askMode = null;
    t.askText = null;
    t.turnSteps = 0;
    t.failStreak = 0;
    t.stuck = 0;
    t.unprodStreak = 0;
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
  // 任务计时：闲置时收到指令 = 新任务（清零重计）；执行中/等待中的补充指令 = 同一任务续跑（恢复计时）
  // 步骤计划重置与计时同一边界：只有"新任务"（闲置时收到指令）才清掉旧计划让模型重新拆解；
  // 执行中/等待中的补充指令（纠正做法、回答求助）保留已有计划，面板不退回"正在拆解"占位。
  const freshTask = t.state === 'idle';
  if (t.state === 'idle') timerBegin(t); else timerResume(t);
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
  t.sigRepeat = new Map(); // 新回合重置"同一目标重复点击"计数（改4）
  t._pendingTeach = null;  // 新回合清除遗留的"本条执行完转演示"标记（正常应在同轮耗尽）
  t._stepsOmitStreak = 0;  // 新回合重置"连续省略 steps"计数（步骤计划提醒节流用）
  t.unprodStreak = 0;   // 新回合重置"轮级无进展"计数
  t._prevRoundSig = ''; // 新回合重置"上一轮页面指纹"（轮级无进展判定用）
  t._roundUnDoneStart = 0; // 新回合重置"本轮起始未完成步数"（轮级无进展判定用）
  t._lastRoundMutated = false; // 新回合重置"上一轮是否试过改页面"（轮级无进展判定用）
  t.readList = [];     // 新回合重置"已读清单"：上一轮读过的条目不再拦截，新任务从零记录
  t.lastActiveAt = Date.now();
  t.lastExpHost = ''; // 新回合重置"经验加载提示"去重

  t.conversation.push({ role: 'user', text: content, t: Date.now() });
  if (t.conversation.length > MAX_CONVERSATION) t.conversation = t.conversation.slice(-MAX_CONVERSATION);
  t.turnHistoryStart = t.history.length; // 本回合历史起点（复盘用）
  if (!t.goal) t.goal = content; // 记下最初的原始目标，压缩/裁剪后仍能保留（中途补充说明不覆盖它）
  t.lastInstruction = content; // 最新一条指令/补充说明：注入上下文醒目强调、务必采纳（可能是改目标，也可能只是纠正做法的指导）
  t.history.push({ role: 'user', content });
  if (freshTask) {
    t.plan = []; // 新任务才重置步骤计划：模型本轮重新拆解；补充指令保留旧计划（面板照常显示，模型随 actions 顺带更新覆盖）
    broadcast({ type: 'AGENT_PLAN', steps: [] }, t.sid); // 面板收起旧计划（后续 AGENT_STATUS working 会显示"拆解中"占位）
  }

  const bt0 = performance.now();
  const bookmarkCount = await refreshBookmarkIndex(); // 新指令重新载入书签索引（书签可能已变）
  if (bookmarkCount > 0) addLog(t.sid, '加载书签索引 ' + bookmarkCount + ' 条 · ' + Math.round(performance.now() - bt0) + 'ms');
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
    const reviewSteps = t.turnSteps; // 复盘进度行要报"本次完成 N 步动作"，下面会清零 turnSteps，先留住
    await stopTeachRecording(t); // 教我模式停止时一并停止录制
    timerPause(t); // 主动停止：计时冻结在当前值（复盘不追加）
    t.state = 'idle';
    t.waitTabId = null;
    t.askText = null;
    t.turnSteps = 0;
    await saveTasks();
    addLog(t.sid, '已停止当前操作，可继续对话');
    broadcast({ type: 'AGENT_STATUS', status: 'idle' }, t.sid);
    // 停止后仍做复盘：本轮实际访问过的网站 / 走过的弯路，照常沉淀成书签与操作经验。
    // 后台执行不阻塞停止按钮的响应；期间若来了新指令（turnId 变化）复盘自动退出。
    reviewAfterTurnEnd(t, myTurn, reviewSteps);
  }
}

// 回合收尾后的复盘（停止 / finish 完成都走这里）：任务已回 idle，用 force 让复盘在后台照常执行
// （LLM 判断本轮访问的网站是否有用、操作是否有困难）。钉住回合号：新指令（turnId 变化）自动退出。
// 复盘是 fire-and-forget 且 complete()/停止路径都清了心跳 alarm：MV3 worker 随时可能被回收，一回收
// 复盘链就断了且毫无痕迹（会话1 实测：书签筛选 #7 跑完、经验沉淀 #8 还没发请求 worker 就被回收，
// 导出日志⑤停在 complete() 存档时刻、② 缺经验沉淀那轮）。因此：起跑前把"复盘未完成"标记落盘并重挂
// alarm —— 落盘保证 worker 重启后能按标记补跑；alarm 保证有唤醒源触发补跑（心跳期间 anyBusy 不会清）。
async function reviewAfterTurnEnd(t, myTurn, reviewSteps) {
  if (!t) return;
  if (reviewRunning[t.sid]) {
    // 上回合复盘还没跑完就来了新指令（本回合复盘想起跑被挡）：不并发起跑，
    // 把待办标记更新为当前回合——正在跑的旧复盘会在仍 current 检查时退出，其收尾不清新标记，
    // 之后由 alarm 心跳路径按新标记补跑本回合复盘。
    t._reviewPending = { turnId: myTurn, reviewSteps: reviewSteps || 0 };
    return;
  }
  reviewRunning[t.sid] = true;
  t._reviewPending = { turnId: myTurn, reviewSteps: reviewSteps || 0 };
  try {
    await saveTasks(); // 先把"复盘未完成"标记落盘
    setupAlarm(); // 复盘窗口保持心跳（complete()/停止已把 alarm 清了），worker 不被空闲回收
    try { await reviewAndBookmark(t, true, myTurn, reviewSteps); } catch (e) { /* 复盘失败不影响收尾 */ }
    try { await reviewAndLearnExperiences(t, true, myTurn); } catch (e) { /* 经验沉淀失败不影响收尾 */ }
  } finally {
    reviewRunning[t.sid] = false;
    // 本次复盘完成：清掉自己的标记。期间来了新回合的（_reviewPending 已被新回合更新）不在此清，
    // 留给 alarm 心跳路径补跑新回合复盘。alarm 不在此清，交给 alarm 处理器"无任务忙 + 无复盘待办"时统一收。
    if (t._reviewPending && t._reviewPending.turnId === myTurn) t._reviewPending = null;
    await saveTasks(); // 清标记（或保留新回合标记）都落盘：worker 随时可能回收
  }
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

// 使用者手动操作完成，继续当前回合（page / teach 两种模式）。
// confirmedText：confirm 模式下使用者在对话里输入确认的话（有则带进上下文，避免与按钮占位重复）
async function resumeAfterUser(sid, confirmedText) {
  const t = getTask(sid);
  if (!t || t.state !== 'waiting_user') return;
  if (t.waitingReply) return; // 对话回复模式没有"继续"按钮，回复直接走 processUserMessage

  // ---- 教我模式：使用者演示完成 → 停止录制、沉淀经验、把步骤注入上下文让 Agent 学习 ----
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
            // 尾部缓冲事件没走 TEACH_EVENT 上报，补来源 host（收尾按网站分组沉淀经验）
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
    // 步骤留在 teachEvents 上只供 Agent 复述学习（不再落库：经验统一由 finish 复盘沉淀，
    // 教过的正确做法会以动作形式出现在本轮轨迹里，复盘自然看得到）；确认循环结束会清掉。
    t.teachEvents = events;
    t.askMode = null;
    t.askText = null;
    timerResume(t); // 演示录完、Agent 接手复述：计时恢复
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

  // 教我模式确认后不再沉淀经验：统一由 finish 复盘综合审查任务执行来沉淀（教过的正确做法会以动作形式出现在本轮轨迹里）。
  // 这里只清掉教学步骤，避免残留占用内存、也不误复用上一轮的演示。
  if (isConfirm) t.teachEvents = [];

  t.askMode = null;
  timerResume(t); // 你操作完/确认完，Agent 继续：计时恢复
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
  await restoreShownOnSession(t).catch(() => {}); // 清空会话也还原本会话在"使用者标签"上 show 的元素
  t.turnId++; // 使旧回合的任何在途异步链自行退出
  timerClear(t); // 清空会话：计时归零
  t.state = 'idle';
  t.waitTabId = null;
  t.goal = '';
  t.lastInstruction = '';
  t.steps = 0;
  t.turnSteps = 0;
  t.failStreak = 0;
  t.stuck = 0;
  t.unprodStreak = 0;
  t.consecWaits = 0;
  t.lastActSig = '';
  t.askText = null;
  t.askMode = 'page';
  t.waitingReply = false;
  t.teachTabId = null;
  t.teachTabIds = [];
  t.teachEvents = [];
  removeLlmLogs(t.sid); // 清空本会话：大模型往返日志一并清零（独立存储）
  const sysCfg = await getConfig(); // 重置提示词时按当前执行模式措辞
  t.history = [{ role: 'system', content: systemPrompt(sysCfg.backgroundExec) }];
  t.ctxSummary = null;
  t.ctxBoundary = 0;
  t.tokens = 0; // 清空本会话 = 重新开始，token 用量一并清零
  t.cacheHit = 0; t.cacheMiss = 0; // 缓存命中统计一并清零
  t.turnHistoryStart = 0;
  t.conversation = [];
  t.plan = [];          // 清空会话：步骤计划一并清掉（面板收起划线，重载不恢复旧计划）
  t.activities = [];    // 清空会话：动作轨迹一并清掉（重载不恢复旧动作日志）
  t.result = null;
  t.error = null;
  t.navWaitIdx = null;
  t.navWaitUrl = null;
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
    plan: t.plan || [],
    activities: (t.activities || []).slice(-ACTIVITY_PERSIST), // 最近动作轨迹（面板重载后重建活动日志用）；条目带 t，面板据此与 conversation 按时间交错恢复
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
    navWaitIdx: t.navWaitIdx || null,
    navWaitUrl: t.navWaitUrl || null,
    result: t.result,
    error: t.error,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    tokens: t.tokens || 0,
    cacheHit: t.cacheHit || 0,
    cacheMiss: t.cacheMiss || 0,
    timer: t.timer || null
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 异步响应
});

async function handleMessage(msg, sender) {
  // 冷启动兜底：MV3 服务 worker 空闲被回收后重新唤醒时，内存 tasks 是空的。凡涉及会话的消息
  // （EXPORT_LOG / CREATE_SESSION / DELETE_SESSION / VIEW_TAB …）都必须先灌会话再处理，否则会误报
  // "会话不存在或已被删除"（实际只是还没 load 进内存），更严重的是 CREATE_SESSION 在空 tasks 上 saveTasks
  // 会把 storage 里已有会话整组覆盖丢数据。loadTasks 在已加载时立即返回（不碰存储），正常路径零开销。
  await loadTasks();
  switch (msg.type) {
    case 'PING':
      return { pong: true };
    case 'RUN_EXP_USERSCRIPT': { // 经验代码改走 userScripts 主世界注入（MV3 内容脚本 CSP 禁 unsafe-eval，无法 new AsyncFunction/eval）
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId == null) return { ok: false, infra: true, message: '缺少标签页上下文，无法注入经验脚本' };
      if (!chrome.userScripts || typeof chrome.userScripts.execute !== 'function') {
        return { ok: false, infra: true, message: '经验脚本执行需要「允许用户脚本」开关：请到 chrome://extensions 的 PageAgent 详情页，打开「开发者模式」下的「允许用户脚本」（Chrome 138+；更早版本需全局开启开发者模式）后重试。' };
      }
      const frameId = (sender && sender.frameId != null) ? sender.frameId : 0;
      try {
        await chrome.userScripts.execute({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          js: [{ code: msg.script }],
          injectImmediately: true
        });
        return { ok: true };
      } catch (e) {
        console.warn('[PageAgent] userScripts 注入失败 tab=' + tabId + ' frame=' + frameId + ' → ' + e.message);
        return { ok: false, infra: true, message: '经验脚本注入失败：' + e.message };
      }
    }
    case 'PICK_FILE_RESULT': { // 本地文件弹窗回传：选中文件 base64 与元信息（uploadFile pick:true 编排用）
      const w = pickWaiters.get(msg.pickId);
      if (w) {
        if (msg.cancelled) w(null); // 使用者在弹窗里取消 → 走"弹窗被取消/超时"失败
        else w({ base64: msg.base64, filename: msg.filename, mime: msg.mime, windowId: msg.windowId });
        if (msg.windowId != null) { try { chrome.windows.remove(msg.windowId); } catch (e) {} }
      }
      return { ok: true };
    }
    case 'GET_CONFIG':
      return { config: await getConfig() };
    case 'SAVE_CONFIG':
      await saveConfig(msg.config || {});
      return { ok: true };
    case 'FETCH_MODELS': { // 设置里填 Key / Base URL（失焦）时：GET /models 拉服务端模型列表填充下拉，顺带验证连接
      return await fetchModels(msg.config || {});
    }
    case 'GET_STATE':
      await loadTasks();
      const sessions = Object.keys(tasks)
        .map((sid) => serializeSession(tasks[sid]))
        .sort((a, b) => a.n - b.n);
      return { activeId, sessions, config: await getConfig() };
    case 'EXPORT_LOG': { // 面板「日志」按钮：导出本会话全量日志（完整消息 + 原始返回 + 动作/结果），下载为文件
      const t = getTask(msg.sid);
      if (!t) return { ok: false, error: '会话不存在或已被删除' };
      return { ok: true, text: await exportSessionLog(t) };
    }
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
      await restoreShownOnSession(t).catch(() => {}); // 删会话也还原本会话在"使用者标签"上 show 的元素
      removeLlmLogs(sid); // 删除会话：大模型往返日志一并清除（独立存储）
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
    case 'STOP':
      await stopCurrent(msg.sid);
      return { ok: true };
    case 'RESUME': // 使用者手动操作完成，继续当前回合
      await resumeAfterUser(msg.sid);
      return { ok: true };
    case 'CLEAR':
      await clearConversation(msg.sid);
      return { ok: true };
    case 'GET_EXP': // 面板经验管理：读取全部站点操作经验 { [host]: Item[] }（Item = {scene, params, code}）
      return { exps: await getExpStore() };
    case 'SAVE_EXP': { // 面板经验管理：保存某站点整份经验（空数组=删除该站点）
      const h = hostOf(msg.domain);
      if (!h) throw new Error('无效域名');
      const store = await getExpStore();
      if (Array.isArray(msg.exps) && msg.exps.length) {
        store[h] = msg.exps.map((x) => normExp(x)).filter(Boolean); // normExp 兼容旧 string 与新对象，去重按 scene 兜底在面板删除/编辑路径不适用（面板按 index 操作，无需去重）
      } else {
        delete store[h];
      }
      await chrome.storage.local.set({ [EXP_KEY]: store });
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
        // 给每条事件补上来源 tab / host / frame（收尾按网站分组沉淀经验用；frameId 标记 iframe 内步骤，复现时按窗口定位）
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

// 浏览器启动清理：把上次浏览器会话残留的一次性状态全部清掉。
// ① storage.session 本就随 Chrome 退出自动清空，这里再显式清一次 tasks/llmLogs 双保险；
// ② 关键是清掉崩溃/异常退出后残留的孤儿 PageAgent N 标签分组（会话状态已空，无法走正常删除路径）。
// 持久层（config、EXP_KEY）跨重启保留，不动。
chrome.runtime.onStartup.addListener(() => {
  cleanupStartup().catch(() => {});
});

async function cleanupStartup() {
  push('启动清理：清空会话存储（tasks/llmLogs）并清理孤儿 PageAgent 分组');
  // 1) 会话级存储显式清空（tasks / llmLogs；config、EXP_KEY 等持久层保留）
  try {
    await chrome.storage.session.remove(['tasks', LLM_LOGS_KEY]);
  } catch (e) {}
  tasks = {};
  llmLogStore = null;
  llmLogStoreLoaded = null;
  activeId = null;
  // 2) 孤儿 PageAgent N 分组：启动时会话状态必为空，标题符合的分组只可能是上次残留。
  //    只解组不关标签 —— 重启后无法区分组内标签归属（组内可能有使用者自己拖进来的标签，
  //    记忆：永不关用户标签），解组保住所有标签，仅去掉残留分组结构。
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups || []) {
      if (/^PageAgent \d+$/.test(g.title || '')) {
        try { await chrome.tabGroups.ungroup(g.id); } catch (e) {}
      }
    }
  } catch (e) {}
}
