/**
 * panel.js — 侧边栏面板逻辑（多会话持续对话模式）
 *
 * 职责：设置（API Key / Base URL / 模型 / 温度 / 最大步数 / 搜索模板）、
 * 顶部会话栏（chips 切换/新建/删除，最多 MAX_SESSIONS 个会话）、
 * 每会话独立的消息缓存与渲染、发送/停止/清空本会话、
 * 渲染 background 广播的聊天消息与活动日志（按 sid 路由到所属会话）。
 */
'use strict';

const $ = (s) => document.querySelector(s);
const MAX_SESSIONS = 5;

let currentTabId = null;
let activeSid = null; // 当前查看的会话
let teachStepEl = null; // 教我模式卡里实时步数元素（AGENT_TEACH_STEPS 更新）

// 每会话缓存：sid -> { sid, n, msgs: [], tabs: [], status, statusLabel, statusClass, askMode, teachSteps }
const sessionCache = {};

function ensureCache(sid, n) {
  if (!sessionCache[sid]) {
    let maxN = 0;
    for (const k of Object.keys(sessionCache)) maxN = Math.max(maxN, sessionCache[k].n || 0);
    sessionCache[sid] = {
      sid,
      n: n != null ? n : maxN + 1,
      msgs: [],
      tabs: [],
      status: 'idle',
      statusLabel: '等待指令',
      statusClass: '',
      askMode: 'page',
      teachSteps: 0,
      tokens: 0,
      cacheHit: 0,
      cacheMiss: 0,
      plan: [] // 当前任务步骤计划 [{text,done}]：状态栏下方悬浮展示，done 行划线
    };
  }
  return sessionCache[sid];
}
function activeCache() { return activeSid ? ensureCache(activeSid) : null; }

// ---------------- 设置 ----------------
// 模型下拉由服务端 /models 实时拉取（见 fetchModels）：填了 API Key 或 Base URL（失焦）即重新拉取重建下拉。
// preferredModel 记录"当前该选的模型"（存量配置或用户刚选的），拉取后优先保留它，不在列表则落第一个。
let preferredModel = '';

async function loadConfig() {
  const { config } = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  $('#apiKey').value = config.apiKey || '';
  $('#baseUrl').value = config.baseUrl || 'https://api.deepseek.com/v1';
  preferredModel = config.model || '';
  $('#temperature').value = config.temperature ?? 0.2;
  $('#maxSteps').value = config.maxSteps || 25;
  $('#searchTemplate').value = config.searchTemplate || 'https://www.bing.com/search?q=';
  $('#contextWindow').value = config.contextWindow || 1000000;
  $('#compressThreshold').value = config.compressThreshold ?? 70;
  $('#batchEnabled').checked = config.batchEnabled !== false;
  $('#batchMark').checked = config.batchMark === true;
  // 已有 Key 进配置就拉一次模型列表；没有则留占位提示（填了 Key/URL 失焦会自动再拉）
  if (config.apiKey) fetchModels();
  else populateModelSelect([]);
}

// 把模型下拉重建为服务端返回的模型列表；preferred 在列表则选中它，否则落第一个；空列表放占位提示
function populateModelSelect(models, preferred, placeholder) {
  const sel = $('#model');
  sel.innerHTML = '';
  const list = (models || []).filter(Boolean);
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder || '请先填写 API Key 与 Base URL';
    opt.disabled = true;
    sel.appendChild(opt);
    sel.value = '';
    return;
  }
  const pick = preferred && list.indexOf(preferred) !== -1 ? preferred : list[0];
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  sel.value = pick;
}

// 用当前表单里的 API Key / Base URL 拉模型列表：成功→重建下拉并保存自动选中的模型；失败→清空下拉并显示原因
async function fetchModels() {
  const res = $('#modelTestResult');
  res.hidden = false;
  res.textContent = '测试中…';
  res.className = 'hint';
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'FETCH_MODELS',
      config: {
        apiKey: $('#apiKey').value.trim(),
        baseUrl: $('#baseUrl').value.trim()
      }
    });
    if (r && r.ok) {
      populateModelSelect(r.models, preferredModel);
      res.textContent = '连接正常（' + r.latencyMs + 'ms）';
      res.className = 'hint ok';
      if ($('#model').value) saveConfig(); // 自动选中/保留的模型写进配置，跑任务时直接用
    } else {
      populateModelSelect([], '', '（无可用模型）');
      res.textContent = '连接失败：' + ((r && r.error) || '未知错误');
      res.className = 'hint err';
    }
  } catch (e) {
    populateModelSelect([], '', '（无可用模型）');
    res.textContent = '拉取模型列表失败：' + (e.message || e);
    res.className = 'hint err';
  }
}

function saveConfig() {
  chrome.runtime.sendMessage({
    type: 'SAVE_CONFIG',
    config: {
      apiKey: $('#apiKey').value.trim(),
      baseUrl: $('#baseUrl').value.trim(),
      model: $('#model').value,
      temperature: parseFloat($('#temperature').value),
      maxSteps: parseInt($('#maxSteps').value, 10) || 25,
      searchTemplate: $('#searchTemplate').value.trim(),
      contextWindow: parseInt($('#contextWindow').value, 10) || 1000000,
      compressThreshold: parseInt($('#compressThreshold').value, 10) || 70,
      batchEnabled: $('#batchEnabled').checked,
      batchMark: $('#batchMark').checked
    }
  });
}

function wireSettings() {
  ['temperature', 'maxSteps', 'searchTemplate', 'contextWindow', 'compressThreshold', 'batchEnabled', 'batchMark'].forEach((id) => {
    $('#' + id).addEventListener('change', saveConfig);
  });
  // API Key / Base URL：失焦保存，并重新拉一次模型列表（填对才填充下拉）
  $('#apiKey').addEventListener('change', () => { saveConfig(); fetchModels(); });
  $('#baseUrl').addEventListener('change', () => { saveConfig(); fetchModels(); });
  // 模型：切换即保存（列表来自服务端，无需再测）
  $('#model').addEventListener('change', () => {
    preferredModel = $('#model').value;
    saveConfig();
  });
  $('#toggleSettings').addEventListener('click', () => {
    $('#settings').hidden = !$('#settings').hidden;
  });
}

// ---------------- 当前标签 ----------------
async function refreshTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    currentTabId = tab ? tab.id : null;
    $('#tabTitle').textContent = tab ? (tab.title || tab.url || '(新标签页)') : '-';
  } catch (e) {
    currentTabId = null;
    $('#tabTitle').textContent = '-';
  }
}

// ---------------- 状态 / 消息渲染 ----------------
function setStatus(text, cls) {
  const bar = $('#statusBar');
  $('#statusText').textContent = text;
  bar.className = cls || '';
}

// token 用量格式化：1234 → "1.2k"，>=10 万取整 "100k"；<1000 原样
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1000) {
    const v = n / 1000;
    return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  return String(n);
}

// 任务计时当前值（ms）：后台只存 { running, startAt, acc }，这里按墙钟实时补算；无计时器返回 null
function cacheTimerMs(cache) {
  const tm = cache.timer;
  if (!tm) return null;
  return (tm.acc || 0) + (tm.running ? Date.now() - (tm.startAt || Date.now()) : 0);
}

// 计时显示：mm:ss，超过一小时 h:mm:ss（纯文字，不用 emoji）
function fmtTimer(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  return m + ':' + String(s % 60).padStart(2, '0');
}

// 会话状态栏文案：状态标签 + token 用量（有消耗时）+ 任务用时（计时器存在时，如 "运行中… · 12.3k · 用时 03:45"）
function statusText(cache, label) {
  const l = label != null ? label : cache.statusLabel;
  const parts = [];
  const toks = cache.tokens || 0;
  if (toks > 0) parts.push(fmtTokens(toks));
  // 缓存命中率：本会话累计 prompt 缓存命中 / (命中+未命中)。DeepSeek 透传 cache 字段才有，
  // 第三方中转拿不到时 hit+miss=0，不显示。
  const hit = cache.cacheHit || 0;
  const miss = cache.cacheMiss || 0;
  if (hit + miss > 0) parts.push('缓存命中 ' + Math.round((hit / (hit + miss)) * 100) + '%');
  const tms = cacheTimerMs(cache);
  if (tms != null) parts.push('用时 ' + fmtTimer(tms));
  return parts.length ? l + ' · ' + parts.join(' · ') : l;
}

// 统一在显示某会话状态时调用（状态栏 + 会话栏），确保 token 用量随状态一并刷新
function setSessionStatus(cache, label, cls) {
  setStatus(statusText(cache, label), cls);
}

// 任务步骤浮层渲染：有计划显示清单（done 划线）；计划空但正在运行显示"拆解中"占位；否则隐藏
function renderStepPlan(sid) {
  const el = $('#stepPlan');
  const cache = sessionCache[sid];
  if (sid !== activeSid || !cache) { el.hidden = true; return; }
  const plan = cache.plan || [];
  if (plan.length) {
    el.innerHTML = '';
    const head = document.createElement('div'); head.className = 'step-head';
    head.textContent = '任务步骤 · ' + plan.length + ' 步';
    const list = document.createElement('div'); list.className = 'step-list';
    plan.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'step-row' + (s.done ? ' done' : '');
      row.textContent = (i + 1) + '. ' + s.text;
      list.appendChild(row);
    });
    el.appendChild(head); el.appendChild(list);
    el.hidden = false;
  } else if (cache.status === 'working') {
    el.innerHTML = '';
    const head = document.createElement('div'); head.className = 'step-head'; head.textContent = '任务步骤';
    const row = document.createElement('div'); row.className = 'step-row placeholder'; row.textContent = '正在拆解任务步骤…';
    el.appendChild(head); el.appendChild(row);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// 顶部标题旁的"总 token 消耗"：各会话用量求和
function renderHeaderTokens() {
  const el = $('#tokenTotal');
  let total = 0;
  for (const k of Object.keys(sessionCache)) total += sessionCache[k].tokens || 0;
  el.textContent = 'Token ' + fmtTokens(total);
  el.title = '全部会话累计消耗 ' + total + ' tokens';
}

// 等待使用者协助的状态栏文案/样式（page=手动操作、reply=对话回复、teach=教我演示、confirm=复述确认）
function askStatusLabel(mode) {
  return mode === 'reply' ? '等待你在对话中回复…' : mode === 'teach' ? '等待你演示操作…' : mode === 'confirm' ? '等待你确认…' : '需要你手动操作…';
}
function askStatusClass(mode) {
  return mode === 'reply' ? 'askreply' : mode === 'teach' ? 'teach' : 'wait'; // confirm 用绿色 wait
}

// ---------------- Markdown 渲染（紧凑排版） ----------------
// Agent 返回内容可能带 Markdown（**加粗**、`行内代码`、列表、标题、链接、```围栏代码``` 等），
// 这里把它渲染成 HTML 气泡。安全：整段先做 HTML 转义（块级转义保留 > 以识别引用行），
// 只产出我们自己拼的白名单标签，链接仅允许 http/https 并强制新标签打开，杜绝注入。
// 排版刻意紧凑：段落/列表/代码块间距压到 0.35em、标题不大幅放大，避免行距过大浪费阅读空间。
// 块级源码转义：&、<、" 都转，唯独不转 >——这样 "> " 开头的引用行在块解析时仍可识别；
// 不转 > 也安全：浏览器把 &lt; 当作字符引用解析成纯文本，无法构成标签，杜绝注入。
function escBlock(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// 行内语法：行内代码（先占位，避免被后面的加粗/链接误处理）→ 链接 → 加粗 → 斜体 → 删除线 → 段内软换行转 <br>
function renderInline(esc) {
  let s = esc;
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + renderInline(t) + '</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

// 块级语法：围栏代码 / 标题 / 分隔线 / 引用 / 无序有序列表 / 段落（段内连续行 → <br>）
function renderMarkdown(text) {
  const src = escBlock(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  let curList = [];
  const flushList = () => {
    if (!curList.length) return;
    const tag = curList[0].ordered ? 'ol' : 'ul';
    out.push('<' + tag + '>' + curList.map((it) => '<li>' + renderInline(it.text) + '</li>').join('') + '</' + tag + '>');
    curList = [];
  };
  const flushPara = () => {
    if (para.length) { out.push('<p>' + renderInline(para.join('\n')) + '</p>'); para = []; }
  };
  const closeText = () => { flushPara(); flushList(); };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flushPara(); flushList(); i++; continue; } // 空行 = 段落/列表分隔

    const fm = t.match(/^(`{3,}|~{3,})\s*(\S*)\s*$/); // 代码围栏
    if (fm) {
      closeText();
      const ch = fm[1][0];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp('^\\' + ch + '{3,}\\s*$').test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳过闭合围栏（缺失则忽略）
      out.push('<pre><code>' + code.join('\n') + '</code></pre>');
      continue;
    }

    const hm = t.match(/^(#{1,6})\s+(.*)$/); // 标题
    if (hm) {
      closeText();
      out.push('<h' + hm[1].length + '>' + renderInline(hm[2]) + '</h' + hm[1].length + '>');
      i++;
      continue;
    }

    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_{3,})$/.test(t)) { closeText(); out.push('<hr>'); i++; continue; } // 分隔线

    if (t[0] === '>') { // 引用
      flushPara(); flushList();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + quote.map((l) => renderInline(l)).join('<br>') + '</blockquote>');
      continue;
    }

    const um = t.match(/^[-*+]\s+(.*)$/); // 无序列表
    const om = t.match(/^\d+[.)]\s+(.*)$/); // 有序列表
    if (um || om) {
      flushPara();
      const ordered = !!om;
      const itemText = om ? om[1] : um[1];
      if (curList.length && curList[0].ordered !== ordered) flushList();
      curList.push({ ordered, text: itemText });
      i++;
      continue;
    }

    flushList(); // 普通段落行：累计成段，段内换行由 renderInline 转 <br>
    para.push(line);
    i++;
  }
  closeText();
  return out.join('');
}

// 消息元素构造器（纯 DOM，供 pushMsg 与 renderSessionMsgs 共用）
function userEl(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  return el;
}
function agentEl(text, ok) {
  const el = document.createElement('div');
  el.className = 'msg agent' + (ok === false ? ' err' : '') + ' md';
  // Agent 回复可能带 Markdown：转义后按渲染结果注入（只生成自名单标签，链接仅 http/https 新窗口打开）
  el.innerHTML = renderMarkdown(text);
  return el;
}
// 活动行内容：主体靠左，行尾耗时（"· 838ms" / " 4191ms"）拆出靠右对齐；无耗时则整行当主体
function fillActivity(el, text) {
  const mm = /^(.*?)\s*·?\s*(\d+ms)$/.exec(text);
  el.innerHTML = '';
  const body = document.createElement('span');
  body.className = 'act-body';
  body.textContent = mm ? mm[1] : text;
  el.appendChild(body);
  if (mm) {
    const ms = document.createElement('span');
    ms.className = 'act-ms';
    ms.textContent = mm[2];
    el.appendChild(ms);
  }
}
function activityEl(text, inBatch) {
  const el = document.createElement('div');
  el.className = 'msg activity' + (inBatch ? ' batch' : '');
  fillActivity(el, text);
  return el;
}
// 非阻塞提示行（输入卡住等）：比活动行醒目一点（accent 色），但同样不需要使用者操作
function nudgeEl(text) {
  const el = document.createElement('div');
  el.className = 'msg nudge';
  el.textContent = text;
  return el;
}
function hintEl() {
  const el = document.createElement('div');
  el.className = 'chat-hint';
  el.textContent = '持续对话模式：下达指令，完成后可继续追问。';
  return el;
}

// 求助气泡，分四种模式（同原逻辑）：
//   page    = 需要使用者在【页面上】操作（验证码/登录等）→ 绿色"我已操作完成，继续"按钮
//   reply   = 需要使用者在【对话中】回复信息 → 不显示按钮，提示直接在输入框回复
//   teach   = 教我模式：使用者手把手演示操作，Agent 记录学习 → 琥珀色教卡 + 实时步数 + "我操作完了"按钮
//   confirm = 复述确认：点「没问题」按钮继续（有出入可直接在输入框纠正）→ 绿色确认按钮 + 纠正提示
function askEl(cache, desc) {
  disablePendingAsks('已取消（新的确认已接手）'); // 新确认进来，旧确认卡片按钮作废
  const mode = desc.mode || 'page';
  const isReply = mode === 'reply';
  const isTeach = mode === 'teach';
  const isConfirm = mode === 'confirm';
  const wrap = document.createElement('div');
  wrap.className = 'msg agent ask' + (isReply ? ' reply' : isTeach ? ' teach' : isConfirm ? ' confirm' : '');
  const p = document.createElement('div');
  p.textContent = (isReply ? '请回复我：' : isTeach ? '请你演示操作：' : isConfirm ? '请确认：' : '需要你手动操作：') + desc.text;
  wrap.appendChild(p);
  if (isTeach) {
    const hint = document.createElement('div');
    hint.className = 'reply-hint';
    hint.textContent = '我会记录你在页面上的每一步操作来学习；操作完点下面按钮';
    wrap.appendChild(hint);
    const stepEl = document.createElement('div');
    stepEl.className = 'teach-steps';
    stepEl.textContent = '已记录 ' + (cache.teachSteps || 0) + ' 步';
    teachStepEl = stepEl;
    wrap.appendChild(stepEl);
    const actions = document.createElement('div');
    actions.className = 'ask-actions';
    actions.appendChild(makeResumeBtn(cache, '我操作完了，按我教的继续', '已确认，正在整理你教的步骤…', '（我操作完了，请按我教的继续）'));
    actions.appendChild(makeViewBtn(cache));
    wrap.appendChild(actions);
  } else if (isReply) {
    const hint = document.createElement('div');
    hint.className = 'reply-hint';
    hint.textContent = '直接在下方输入框回复即可';
    wrap.appendChild(hint);
  } else {
    const hint = document.createElement('div');
    hint.className = 'reply-hint';
    hint.textContent = isConfirm ? '没问题就点下面按钮；有出入可直接在输入框纠正，Agent 理解后会再来确认' : '在页面上操作完，点下面按钮继续';
    wrap.appendChild(hint);
    const actions = document.createElement('div');
    actions.className = 'ask-actions';
    actions.appendChild(makeResumeBtn(cache, isConfirm ? '没问题，按我教的继续' : '我已操作完成，继续', '已确认，继续执行…', isConfirm ? '（没问题，请继续）' : '（已完成手动操作，请继续）'));
    if (!isConfirm) actions.appendChild(makeViewBtn(cache)); // 复述确认只需点按钮，无需去页面
    wrap.appendChild(actions);
  }
  if (isReply) $('#input').focus(); // 对话回复模式：聚焦输入框，提示用户直接打字
  if (!isTeach) teachStepEl = null; // 非教卡渲染时清掉实时步数引用
  return wrap;
}

// 求助卡「查看页面」按钮：让浏览器聚焦到该会话当前操作的页面上（去页面上处理完再回来点继续）
function makeViewBtn(cache) {
  const btn = document.createElement('button');
  btn.className = 'view';
  btn.textContent = '查看页面';
  btn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'VIEW_TAB', sid: cache.sid });
    } catch (e) { /* 后台可能已卸载，忽略 */ }
  });
  return btn;
}

// 求助卡"继续"按钮：点击后置灰、写入确认占位消息、通知后台继续该会话
function makeResumeBtn(cache, label, busyText, confirmText) {
  const btn = document.createElement('button');
  btn.className = 'resume';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = busyText;
    pushMsg(cache.sid, { kind: 'user', text: confirmText });
    cache.status = 'working';
    cache.statusLabel = '运行中…';
    cache.statusClass = 'running';
    renderSessionBar();
    if (cache.sid === activeSid) setSessionStatus(cache, '运行中…', 'running');
    try {
      await chrome.runtime.sendMessage({ type: 'RESUME', sid: cache.sid });
    } catch (e) {
      if (cache.sid === activeSid) setStatus('发送失败', 'fail');
    }
  });
  return btn;
}

// 把一条消息写入会话缓存；若该会话正是当前查看的，同步渲染到 DOM
function pushMsg(sid, desc, silent) {
  const cache = ensureCache(sid);
  cache.msgs.push(desc);
  // 活动行缓存也只保留最近 60 条，避免切回时刷屏
  if (desc.kind === 'activity') {
    let acts = 0;
    for (let i = cache.msgs.length - 1; i >= 0; i--) {
      if (cache.msgs[i].kind === 'activity') { acts++; if (acts > 60) cache.msgs.splice(i, 1); }
    }
  }
  if (sid === activeSid) {
    const box = $('#messages');
    let el;
    if (desc.kind === 'user') el = userEl(desc.text);
    else if (desc.kind === 'agent') el = agentEl(desc.text, desc.ok);
    else if (desc.kind === 'activity') {
      el = activityEl(desc.text, desc.inBatch);
      const acts = document.querySelectorAll('.msg.activity');
      if (acts.length > 60) acts[0].remove();
    } else if (desc.kind === 'nudge') el = nudgeEl(desc.text);
    else if (desc.kind === 'ask') el = askEl(cache, desc);
    box.appendChild(el);
    if (!silent) box.scrollTop = box.scrollHeight;
  }
}

// 按会话缓存整份重绘消息区（切换会话 / 恢复时用）
function renderSessionMsgs(sid) {
  const cache = ensureCache(sid);
  const box = $('#messages');
  box.innerHTML = '';
  teachStepEl = null;
  box.appendChild(hintEl());
  for (const m of cache.msgs) {
    if (m.kind === 'user') box.appendChild(userEl(m.text));
    else if (m.kind === 'agent') box.appendChild(agentEl(m.text, m.ok));
    else if (m.kind === 'activity') box.appendChild(activityEl(m.text, m.inBatch));
    else if (m.kind === 'nudge') box.appendChild(nudgeEl(m.text));
    else if (m.kind === 'ask') box.appendChild(askEl(cache, m));
  }
  // 恢复/切回时只有"确实在等用户"的那张确认卡按钮有效（askEl 已把更早的卡禁用）；
  // 若该会话并不在等用户（已继续/已停止/已空闲），历史确认卡的按钮一律作废，避免误点。
  if (cache.status !== 'waiting_user') disablePendingAsks('已取消');
  box.scrollTop = box.scrollHeight;
}

function renderTabs(tabs) {
  const el = $('#agentTabs');
  const agents = (tabs || []).filter((t) => t.role === 'agent');
  const users = (tabs || []).filter((t) => t.role === 'user');
  const parts = [];
  if (agents.length) parts.push('Agent 自开 ' + agents.length + ' 个标签（后台运行）');
  if (users.length) parts.push('已纳入 ' + users.length + ' 个你的标签');
  el.textContent = parts.join(' · ');
  el.hidden = parts.length === 0;
}

// 取消未处理的确认卡片按钮：用户不一定是点卡片上的按钮——可能另发了消息、点了停止、或新的确认已接手。
// 旧卡片的按钮还亮着会误导误点，把它禁用并标明已取消（保留卡片本身作对话上下文）。
function disablePendingAsks(label) {
  for (const btn of document.querySelectorAll('.msg.ask .resume')) {
    if (btn.disabled) continue;
    btn.disabled = true;
    btn.textContent = label || '已取消';
  }
}

// ---------------- 顶部会话栏 ----------------
function dotClass(c) {
  if (c.status === 'working') return 'working';
  if (c.status === 'waiting_user') {
    if (c.askMode === 'teach') return 'teach';
    if (c.askMode === 'confirm') return 'ok';
    return 'warn';
  }
  return 'idle';
}

function renderSessionBar() {
  const bar = $('#sessionBar');
  bar.innerHTML = '';
  const sids = Object.keys(sessionCache).sort((a, b) => (sessionCache[a].n || 0) - (sessionCache[b].n || 0));
  for (const sid of sids) {
    const c = sessionCache[sid];
    const chip = document.createElement('div');
    chip.className = 'chip' + (sid === activeSid ? ' active' : '');
    chip.title = '会话' + c.n;
    const dot = document.createElement('span');
    dot.className = 'dot ' + dotClass(c);
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = '会话' + c.n;
    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '×';
    del.title = '删除会话' + c.n + '（关闭其 Agent 标签，你的标签保留）';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteSession(sid); });
    chip.appendChild(dot);
    chip.appendChild(label);
    chip.appendChild(del);
    chip.addEventListener('click', () => switchSession(sid));
    bar.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'chip-add';
  add.textContent = '＋ 新建';
  add.disabled = sids.length >= MAX_SESSIONS;
  add.title = '新建会话（最多 ' + MAX_SESSIONS + ' 个）';
  add.addEventListener('click', onCreateSession);
  bar.appendChild(add);
}

// 切换当前查看的会话：本地置 active → 重绘会话栏与消息区 → 后台 SET_ACTIVE
function switchSession(sid) {
  if (!sessionCache[sid]) return;
  activeSid = sid;
  renderSessionBar();
  const cache = ensureCache(sid);
  renderSessionMsgs(sid);
  renderTabs(cache.tabs);
  setSessionStatus(cache);
  renderStepPlan(sid); // 切换会话同步浮层（各会话计划独立缓存）
  chrome.runtime.sendMessage({ type: 'SET_ACTIVE', sid }).catch(() => {});
}

async function onCreateSession() {
  const { ok, sid, n, error } = await chrome.runtime.sendMessage({ type: 'CREATE_SESSION' });
  if (!ok) { setStatus(error || '创建会话失败', 'fail'); return; }
  ensureCache(sid, n);
  switchSession(sid);
  $('#input').focus();
}

async function onDeleteSession(sid) {
  const c = sessionCache[sid];
  if (!c) return;
  // × 关闭会话时再确认一次：会关闭该会话标签组下的全部 Agent 自开标签（你的 @MAIN/@U 标签永不关闭）
  const agentCount = (c.tabs || []).filter((x) => x.role === 'agent').length;
  const note = agentCount ? '将关闭其标签组下 ' + agentCount + ' 个 Agent 标签（你的标签保留）。' : '';
  const busy = c.status === 'working' || c.status === 'waiting_user';
  let q;
  if (busy) q = '会话' + c.n + ' 正在运行，删除会停止它。' + note + '确定吗？';
  else if (c.msgs.length) q = '删除会话' + c.n + '？其聊天记录将丢失。' + note + '确定吗？';
  else q = '删除空会话' + c.n + '？' + note + '确定吗？';
  if (!confirm(q)) return;
  const { activeId: newActive } = await chrome.runtime.sendMessage({ type: 'DELETE_SESSION', sid });
  delete sessionCache[sid];
  if (activeSid === sid) activeSid = newActive;
  renderSessionBar();
  renderHeaderTokens();
  if (!activeSid || !sessionCache[activeSid]) await onCreateSession(); // 全删光 → 建一个空会话兜底
  else switchSession(activeSid);
}

// 清空单个会话的本地缓存与 DOM（后台 CLEAR 广播 AGENT_CLEARED 后也会调用）
function resetSessionUI(sid) {
  const c = ensureCache(sid);
  c.msgs = [];
  c.tabs = [];
  c.status = 'idle';
  c.statusLabel = '等待指令';
  c.statusClass = '';
  c.askMode = 'page';
  c.teachSteps = 0;
  c.tokens = 0; // 清空本会话：token 用量一并清零
  c.cacheHit = 0; c.cacheMiss = 0; // 缓存命中统计一并清零
  c.timer = null; // 任务计时一并清空
  c.plan = []; // 步骤计划一并清空
  renderSessionBar();
  renderHeaderTokens();
  if (sid === activeSid) {
    renderSessionMsgs(sid);
    renderTabs([]);
    setSessionStatus(c, '就绪', '');
    renderStepPlan(sid); // 清空后隐藏浮层
  }
}

// ---------------- 发送 / 停止 / 清空本会话 ----------------
async function onSend() {
  const text = $('#input').value.trim();
  if (!text) return;
  const sid = activeSid;
  const cache = activeCache();
  if (!sid || !cache) return;
  $('#input').value = '';
  pushMsg(sid, { kind: 'user', text });
  disablePendingAsks('已取消（已另发消息）'); // 用户没点卡片按钮而是另发了指令，卡片按钮作废
  if (!currentTabId) {
    await refreshTab();
    if (!currentTabId) {
      pushMsg(sid, { kind: 'agent', text: '未获取到当前标签页，请切换到正常网页后再试', ok: false });
      return;
    }
  }
  cache.status = 'working';
  cache.statusLabel = '运行中…';
  cache.statusClass = 'running';
  renderSessionBar();
  setSessionStatus(cache, '运行中…', 'running');
  try {
    await chrome.runtime.sendMessage({ type: 'SEND', sid, tabId: currentTabId, text });
  } catch (e) {
    pushMsg(sid, { kind: 'agent', text: '发送失败：' + (e.message || e), ok: false });
    setStatus('失败', 'fail');
  }
}

async function onStop() {
  const sid = activeSid;
  const cache = activeCache();
  if (!sid || !cache) return;
  disablePendingAsks('已取消（已停止）'); // 停止后待确认卡片按钮不再有意义
  try {
    await chrome.runtime.sendMessage({ type: 'STOP', sid });
  } catch (e) {}
  // 后台 stopCurrent 会广播 AGENT_STATUS: idle，这里同步置位避免闪烁
  cache.status = 'idle';
  cache.statusLabel = '等待指令';
  cache.statusClass = '';
  renderSessionBar();
  setSessionStatus(cache, '已停止，可继续对话', '');
}

async function onClear() {
  const sid = activeSid;
  if (!sid) return;
  if (!confirm('清空本会话会关闭 Agent 自开的标签并清空聊天记录（会话保留；新建会话请用上方 ＋），确定吗？')) return;
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR', sid });
  } catch (e) {}
  resetSessionUI(sid);
  $('#input').focus();
}

// ---------------- 诊断工具 ----------------
// 点「诊断」把当前标签页的合并快照（Agent 浏览侧看到的：可交互元素 + 正文摘要 + 子窗口）提取为
// JSON 复制到剪贴板，方便排查浏览侧识别问题（元素有没有被看到、role/text 对不对、iframe 有没有合并）。
async function onDiag() {
  if (!currentTabId) await refreshTab();
  if (!currentTabId) { setStatus('未获取到当前标签页，请切换到网页后再试', 'fail'); return; }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DIAG_SNAPSHOT', tabId: currentTabId });
    if (!res || !res.ok) throw new Error((res && res.error) || '读取快照失败');
    const snap = res.snapshot || {};
    const nEls = Array.isArray(snap.elements) ? snap.elements.length : 0;
    await copyText(JSON.stringify(snap, null, 2));
    setStatus('快照已复制到剪贴板（' + (snap.title || '当前页') + ' · ' + nEls + ' 个元素）', 'ok');
  } catch (e) {
    setStatus('诊断失败：' + (e.message || e), 'fail');
  }
}

// 剪贴板写入：navigator.clipboard 不可用（面板未获焦点等）时退回隐藏 textarea + execCommand('copy')
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
}

// ---------------- 全量日志导出 ----------------
// 状态栏「日志」按钮：把本会话的全量信息下载成文件（发给大模型的完整消息、大模型完整原始返回、
// 浏览器动作与结果、会话状态等），供人工排查"任务为什么执行乱"。内容由后台 EXPORT_LOG 组装、不截断。
async function onLogExport() {
  const sid = activeSid;
  if (!sid) return;
  const c = sessionCache[sid];
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EXPORT_LOG', sid });
    if (!res || !res.ok) throw new Error((res && res.error) || '导出失败');
    const text = res.text || '';
    if (!text) throw new Error('该会话没有可导出的日志');
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
    const filename = 'PageAgent-会话' + (c && c.n != null ? c.n : sid) + '-' + stamp + '.txt';
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    setStatus('已下载会话' + (c && c.n != null ? c.n : '') + ' 全量日志（' + (text.length / 1024).toFixed(0) + 'KB）', 'ok');
  } catch (e) {
    setStatus('导出日志失败：' + (e.message || e), 'fail');
  }
}

// ---------------- 网站操作技巧管理 ----------------
// 技巧按钮角标数字：全站技巧总条数（init / 后台广播 TIPS_CHANGED 时刷新）
async function updateTipsBtn() {
  try {
    const { tips } = await chrome.runtime.sendMessage({ type: 'GET_TIPS' });
    setTipsBtnCount(tips || {});
  } catch (e) { /* 后台未就绪时保持原样 */ }
}
function setTipsBtnCount(store) {
  const n = Object.values(store || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
  $('#tipsBtn').textContent = '技巧 ' + n;
}

// 打开技巧面板：读取全部站点技巧并渲染（查看 / 编辑 / 删除）
async function openTipsPanel() {
  try {
    const { tips } = await chrome.runtime.sendMessage({ type: 'GET_TIPS' });
    renderTips(tips || {});
    $('#tipsPanel').hidden = false;
  } catch (e) {
    setStatus('读取技巧失败：' + (e.message || e), 'fail');
  }
}

function renderTips(store) {
  const list = $('#tipsList');
  list.innerHTML = '';
  const domains = Object.keys(store).sort();
  const countEl = $('#tipsCount');
  const total = domains.reduce((n, d) => n + (store[d] || []).length, 0);
  countEl.textContent = domains.length ? total + ' 条 · ' + domains.length + ' 个站点' : '（暂无技巧）';
  setTipsBtnCount(store); // 手动编辑/删除后技巧按钮的数字同步
  for (const d of domains) {
    const tips = store[d] || [];
    const box = document.createElement('div');
    box.className = 'tip-domain';

    const head = document.createElement('div');
    head.className = 'tip-domain-head';
    const name = document.createElement('span');
    name.className = 'tip-domain-name';
    name.textContent = d;
    const delDomain = document.createElement('button');
    delDomain.className = 'ghost tip-del-domain';
    delDomain.textContent = '删除站点';
    delDomain.title = '删除该站点的全部技巧';
    delDomain.addEventListener('click', async () => {
      if (!confirm('删除站点 ' + d + ' 的全部技巧？')) return;
      await chrome.runtime.sendMessage({ type: 'SAVE_TIPS', domain: d, tips: [] });
      openTipsPanel(); // 重渲染即反馈（站点从列表消失），不再顶掉会话顶部状态栏
    });
    head.appendChild(name);
    head.appendChild(delDomain);
    box.appendChild(head);

    const items = document.createElement('div');
    items.className = 'tip-items';
    tips.forEach((tip, i) => items.appendChild(buildTipItem(d, i, tip)));
    box.appendChild(items);

    list.appendChild(box);
  }
}

// 单条技巧：默认一行紧凑展示（文本 + 编辑/删除），点"编辑"才展开 textarea 修改。
// 不提供"添加技巧"入口——技巧只由复盘自动沉淀，避免人工乱加。
function buildTipItem(domain, index, text) {
  const item = document.createElement('div');
  item.className = 'tip-item';

  // 显示行：一行文本 + 操作按钮
  const row = document.createElement('div');
  row.className = 'tip-row';
  const txt = document.createElement('span');
  txt.className = 'tip-row-text';
  txt.textContent = text;
  const acts = document.createElement('span');
  acts.className = 'tip-item-actions';
  const editBtn = document.createElement('button');
  editBtn.className = 'ghost';
  editBtn.textContent = '编辑';
  const delBtn = document.createElement('button');
  delBtn.className = 'ghost';
  delBtn.textContent = '删除';
  acts.appendChild(editBtn);
  acts.appendChild(delBtn);
  row.appendChild(txt);
  row.appendChild(acts);
  item.appendChild(row);

  // 编辑模式（默认隐藏）：textarea + 保存/取消
  const editor = document.createElement('div');
  editor.className = 'tip-editor';
  editor.hidden = true;
  const ta = document.createElement('textarea');
  ta.className = 'tip-text';
  ta.rows = 2;
  ta.placeholder = '一句话技巧：具体、可执行…';
  ta.value = text;
  const edAct = document.createElement('div');
  edAct.className = 'tip-item-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'ghost tip-save';
  saveBtn.textContent = '保存';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = '取消';
  edAct.appendChild(saveBtn);
  edAct.appendChild(cancelBtn);
  editor.appendChild(ta);
  editor.appendChild(edAct);
  item.appendChild(editor);

  editBtn.addEventListener('click', () => { editor.hidden = false; ta.focus(); });
  cancelBtn.addEventListener('click', () => { editor.hidden = true; });
  saveBtn.addEventListener('click', async () => {
    const v = ta.value.trim();
    if (!v) { setStatus('技巧内容为空', 'fail'); return; }
    const { tips } = await chrome.runtime.sendMessage({ type: 'GET_TIPS' });
    const list = (tips && tips[domain]) ? tips[domain].slice() : [];
    if (index != null && index < list.length) list[index] = v;
    await chrome.runtime.sendMessage({ type: 'SAVE_TIPS', domain, tips: list });
    openTipsPanel(); // 重渲染即反馈（保存后的文本展示在列表里），不顶掉会话顶部状态栏
  });
  delBtn.addEventListener('click', async () => {
    if (!confirm('删除这条技巧？')) return;
    const { tips } = await chrome.runtime.sendMessage({ type: 'GET_TIPS' });
    const list = (tips && tips[domain]) ? tips[domain].slice() : [];
    if (index != null && index < list.length) list.splice(index, 1);
    await chrome.runtime.sendMessage({ type: 'SAVE_TIPS', domain, tips: list });
    openTipsPanel(); // 重渲染即反馈（该条从列表消失），不再顶掉会话顶部状态栏
  });
  return item;
}

// ---------------- 初始化 ----------------
// 把后台返回的某会话状态灌进本地缓存（GET_STATE 恢复 / 会话新建时用）
function hydrateCache(s) {
  const cache = ensureCache(s.sid, s.n);
  cache.sid = s.sid;
  cache.n = s.n;
  cache.msgs = [];
  cache.tabs = s.tabs || [];
  cache.askMode = s.askMode || 'page';
  cache.teachSteps = (s.teachEvents || []).length;
  cache.tokens = s.tokens || 0;
  cache.cacheHit = s.cacheHit || 0;
  cache.cacheMiss = s.cacheMiss || 0;
  cache.timer = s.timer || null; // 任务计时器（面板本地按秒刷新显示）
  cache.plan = Array.isArray(s.plan) ? s.plan : []; // 步骤计划：从后台会话状态恢复（面板重载/重连后立即显示当前计划，而非"拆解中"占位）
  cache.status = (s.state === 'working' || s.state === 'awaiting_nav') ? 'working'
    : s.state === 'waiting_user' ? 'waiting_user' : 'idle';
  cache.statusLabel = cache.status === 'working' ? '运行中…'
    : cache.status === 'waiting_user' ? askStatusLabel(cache.askMode)
    : '等待指令';
  cache.statusClass = cache.status === 'working' ? 'running'
    : cache.status === 'waiting_user' ? askStatusClass(cache.askMode)
    : '';
  let renderedAsk = false;
  // 混合类型按时间交错恢复：对话记录与动作轨迹各自带 t 时间戳，合并排序还原真实时间顺序
  // （此前 activities 无时间戳，重载后只能"对话在前、活动全在后"两坨，混合类型的交错顺序丢失）
  let lastConvT = 0;
  for (const c of s.conversation || []) lastConvT = Math.max(lastConvT, c.t || 0);
  const items = [];
  for (const c of s.conversation || []) {
    items.push({ t: c.t || lastConvT, make: () => {
      if (c.ask) { renderedAsk = true; return { kind: 'ask', text: c.text, mode: c.mode || 'page' }; }
      if (c.kind === 'nudge') return { kind: 'nudge', text: c.text };
      return c.role === 'user' ? { kind: 'user', text: c.text } : { kind: 'agent', text: c.text, ok: c.ok !== false };
    } });
  }
  // 最近动作轨迹：重载后从后台会话恢复（对话记录不含活动行，实时广播是临时的）
  // 旧数据活动行缺 t 时按最后一条对话时间兜底（动作日志本就是"最近轨迹"，排对话之后符合语义），避免误排到顶部
  for (const a of s.activities || []) {
    items.push({ t: a.t || lastConvT, make: () => ({ kind: 'activity', text: a.text, inBatch: !!a.inBatch }) });
  }
  items.sort((x, y) => x.t - y.t); // 稳定排序（V8 保证相同 t 保持插入序）
  for (const it of items) cache.msgs.push(it.make());
  // 兜底：等待中但求助气泡不在对话记录里（如记录被裁剪）
  if (s.state === 'waiting_user' && !renderedAsk && s.askText) cache.msgs.push({ kind: 'ask', text: s.askText, mode: s.askMode || 'page' });
  return cache;
}

async function restoreState() {
  try {
    const { activeId, sessions } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    for (const k of Object.keys(sessionCache)) delete sessionCache[k]; // 重建缓存，避免残留
    for (const s of sessions || []) hydrateCache(s);
    activeSid = activeId;
    renderSessionBar();
    renderHeaderTokens();
    switchSession(activeSid);
  } catch (e) { /* 恢复失败：面板留空，等待下次刷新 */ }
}

async function init() {
  wireSettings();
  await loadConfig();
  await refreshTab();
  await restoreState();

  $('#sendBtn').addEventListener('click', onSend);
  $('#input').addEventListener('keydown', (e) => {
    // 输入法组词/选词中按回车（isComposing 或 keyCode 229）不算发送，等上词完成后真正敲回车才发
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      onSend();
    }
  });
  $('#stopBtn').addEventListener('click', onStop);
  $('#diagBtn').addEventListener('click', onDiag);
  $('#logToggle').addEventListener('click', onLogExport);
  // 技巧按钮可切换：开着再点收起，关着点开（重开时刷新列表）
  $('#tipsBtn').addEventListener('click', () => {
    const p = $('#tipsPanel');
    if (p.hidden) openTipsPanel();
    else p.hidden = true;
  });
  $('#tipsClose').addEventListener('click', () => { $('#tipsPanel').hidden = true; });
  updateTipsBtn(); // 顶栏技巧按钮显示当前全站技巧总数
  $('#clearBtn').addEventListener('click', onClear);

  // 广播消息：按 msg.sid 路由到所属会话；非当前会话只更新缓存与会话栏状态点，不碰 DOM
  chrome.runtime.onMessage.addListener((msg) => {
    const sid = msg.sid || activeSid;
    if (!sid) return; // 没有可用会话时不处理（面板通常总有一个会话）
    const cache = ensureCache(sid);
    switch (msg.type) {
      case 'AGENT_MESSAGE':
        pushMsg(sid, { kind: 'agent', text: msg.text, ok: msg.ok });
        break;
      case 'AGENT_ASK':
        if ((msg.mode || 'page') === 'teach') cache.teachSteps = 0; // 每次新教卡都是新录制，上一轮残留的步数不带到新卡（教卡的实时步数由 AGENT_TEACH_STEPS 续接）
        pushMsg(sid, { kind: 'ask', text: msg.text, mode: msg.mode || 'page' });
        break;
      case 'AGENT_ACTIVITY':
        pushMsg(sid, { kind: 'activity', text: msg.text, inBatch: msg.inBatch });
        break;
      case 'AGENT_ACTIVITY_UPDATE': {
        // 改写缓存里最后一行动作行（如"正在打开页面，等待就绪…"补上就绪时间）
        const arr = cache.msgs;
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i].kind === 'activity') { arr[i].text = msg.text; arr[i].inBatch = msg.inBatch; break; }
        }
        if (sid === activeSid) {
          const acts = document.querySelectorAll('.msg.activity');
          if (acts.length) {
            fillActivity(acts[acts.length - 1], msg.text);
            acts[acts.length - 1].classList.toggle('batch', !!msg.inBatch);
          }
        }
        break;
      }
      case 'AGENT_TEACH_STEPS': // 教我模式实时步数
        cache.teachSteps = msg.count || 0;
        renderSessionBar();
        if (sid === activeSid && teachStepEl) teachStepEl.textContent = '已记录 ' + cache.teachSteps + ' 步';
        break;
      case 'AGENT_STATUS': {
        if (msg.status === 'idle') {
          cache.status = 'idle'; cache.statusLabel = '等待指令'; cache.statusClass = '';
        } else if (msg.status === 'waiting_user') {
          cache.status = 'waiting_user';
          cache.askMode = msg.askMode || cache.askMode || 'page';
          cache.statusLabel = askStatusLabel(cache.askMode);
          cache.statusClass = askStatusClass(cache.askMode);
        } else {
          cache.status = 'working'; cache.statusLabel = '运行中…'; cache.statusClass = 'running';
          if (sid === activeSid) disablePendingAsks('已取消'); // Agent 恢复执行时不再等用户，待确认按钮作废
        }
        renderSessionBar();
        if (sid === activeSid) setSessionStatus(cache);
        renderStepPlan(sid); // 状态变化同步浮层（working 无计划→占位；idle 有计划→保留全划线）
        break;
      }
      case 'AGENT_TOKENS': // 某会话 token 用量更新：刷新总消耗；若正是当前会话，状态栏一并更新
        cache.tokens = msg.tokens || 0;
        cache.cacheHit = msg.cacheHit || 0;
        cache.cacheMiss = msg.cacheMiss || 0;
        renderHeaderTokens();
        if (sid === activeSid) setSessionStatus(cache);
        break;
      case 'AGENT_PLAN': // 步骤计划更新：缓存并渲染浮层（模型每轮随 actions 顺带输出，完成一步划一线）
        cache.plan = Array.isArray(msg.steps) ? msg.steps : [];
        renderStepPlan(sid);
        break;
      case 'TIMER': // 任务计时器状态变化（开始/暂停/恢复/停止/清空）
        cache.timer = msg.timer || null;
        if (sid === activeSid) setSessionStatus(cache);
        break;
      case 'AGENT_TABS':
        cache.tabs = msg.tabs || [];
        if (sid === activeSid) renderTabs(cache.tabs);
        break;
      case 'AGENT_NUDGE': // 非阻塞提示（如输入卡住提醒介入）：仅提示，不改状态、不等待
        pushMsg(sid, { kind: 'nudge', text: msg.text || '' });
        break;
      case 'AGENT_CLEARED': // 后台清空某会话（CLEAR）
        resetSessionUI(sid);
        break;
      case 'TIPS_CHANGED': // 后台复盘/教我沉淀了新技巧：刷新技巧按钮数字；面板开着时顺带刷新列表
        updateTipsBtn();
        if (!$('#tipsPanel').hidden) openTipsPanel();
        break;
      default:
        break;
    }
  });

  // 当前标签变化
  chrome.tabs.onActivated.addListener(refreshTab);
  chrome.tabs.onUpdated.addListener((_id, _info, tab) => {
    if (tab.active) refreshTab();
  });

  // 任务计时本地秒级刷新：仅当前会话计时器运行时每秒重绘状态栏（开始/暂停/停止等变化靠后台 TIMER/AGENT_STATUS 广播驱动）
  setInterval(() => {
    const cache = sessionCache[activeSid];
    if (cache && cache.timer && cache.timer.running) setSessionStatus(cache);
  }, 1000);

  $('#input').focus();
}

document.addEventListener('DOMContentLoaded', init);
