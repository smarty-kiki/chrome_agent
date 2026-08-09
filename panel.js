/**
 * panel.js — 侧边栏面板逻辑（持续对话模式）
 *
 * 职责：设置（API Key / Base URL / 模型 / 温度 / 最大步数 / 搜索模板）、
 * 聊天消息流（用户气泡 + 助手气泡 + 步骤活动行）、发送/停止/新对话、
 * 渲染 background 广播的聊天消息与活动日志。
 */
'use strict';

const $ = (s) => document.querySelector(s);
let currentTabId = null;
let teachStepEl = null; // 教我模式卡里实时步数元素（AGENT_TEACH_STEPS 更新）
let pickActive = false; // 元素排查模式是否开启（调试工具，AGENT_DEBUG_PICK_STATE 同步）

// ---------------- 设置 ----------------
async function loadConfig() {
  const { config } = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  $('#apiKey').value = config.apiKey || '';
  $('#baseUrl').value = config.baseUrl || 'https://api.deepseek.com/v1';
  $('#model').value = config.model || 'deepseek-chat';
  $('#temperature').value = config.temperature ?? 0.2;
  $('#maxSteps').value = config.maxSteps || 25;
  $('#searchTemplate').value = config.searchTemplate || 'https://www.bing.com/search?q=';
  $('#contextWindow').value = config.contextWindow || 1000000;
  $('#compressThreshold').value = config.compressThreshold ?? 70;
}

function wireSettings() {
  const save = () => {
    chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      config: {
        apiKey: $('#apiKey').value.trim(),
        baseUrl: $('#baseUrl').value.trim(),
        model: $('#model').value.trim(),
        temperature: parseFloat($('#temperature').value),
        maxSteps: parseInt($('#maxSteps').value, 10) || 25,
        searchTemplate: $('#searchTemplate').value.trim(),
        contextWindow: parseInt($('#contextWindow').value, 10) || 1000000,
        compressThreshold: parseInt($('#compressThreshold').value, 10) || 70
      }
    });
  };
  ['apiKey', 'baseUrl', 'model', 'temperature', 'maxSteps', 'searchTemplate', 'contextWindow', 'compressThreshold'].forEach((id) => {
    $('#' + id).addEventListener('change', save);
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
  bar.textContent = text;
  bar.className = cls || '';
}

// 等待使用者协助的状态栏文案/样式（page=手动操作、reply=对话回复、teach=教我演示、confirm=复述确认）
function askStatusLabel(mode) {
  return mode === 'reply' ? '等待你在对话中回复…' : mode === 'teach' ? '等待你演示操作…' : mode === 'confirm' ? '等待你确认…' : '需要你手动操作…';
}
function askStatusClass(mode) {
  return mode === 'reply' ? 'askreply' : mode === 'teach' ? 'teach' : 'wait'; // confirm 用绿色 wait
}

function appendMsg(el, silent) {
  const box = $('#messages');
  box.appendChild(el);
  if (!silent) box.scrollTop = box.scrollHeight;
}

function appendUser(text, silent) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  appendMsg(el, silent);
}

function appendAgent(text, ok, silent) {
  const el = document.createElement('div');
  el.className = 'msg agent' + (ok === false ? ' err' : '');
  el.textContent = text;
  appendMsg(el, silent);
}

function appendActivity(text, silent) {
  const el = document.createElement('div');
  el.className = 'msg activity';
  el.textContent = text;
  appendMsg(el, silent);
  // 活动行只保留最近 60 条，避免刷屏淹没对话
  const acts = document.querySelectorAll('.msg.activity');
  if (acts.length > 60) acts[0].remove();
}

// 求助气泡，分四种模式：
//   page    = 需要使用者在【页面上】操作（验证码/登录等）→ 绿色"我已操作完成，继续"按钮
//   reply   = 需要使用者在【对话中】回复信息 → 不显示按钮，提示直接在输入框回复
//   teach   = 教我模式：使用者手把手演示操作，Agent 记录学习 → 琥珀色教卡 + 实时步数 + "我操作完了"按钮
//   confirm = 复述确认：点「没问题」按钮继续（有出入可直接在输入框纠正）→ 绿色确认按钮 + 纠正提示
function appendAsk(text, silent, mode) {
  disablePendingAsks('已取消（新的确认已接手）'); // 新确认进来，旧确认卡片按钮作废
  const isReply = mode === 'reply';
  const isTeach = mode === 'teach';
  const isConfirm = mode === 'confirm';
  const box = $('#messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg agent ask' + (isReply ? ' reply' : isTeach ? ' teach' : isConfirm ? ' confirm' : '');
  const p = document.createElement('div');
  p.textContent = (isReply ? '请回复我：' : isTeach ? '请你演示操作：' : isConfirm ? '请确认：' : '需要你手动操作：') + text;
  wrap.appendChild(p);
  if (isTeach) {
    const hint = document.createElement('div');
    hint.className = 'reply-hint';
    hint.textContent = '我会记录你在页面上的每一步操作来学习；操作完点下面按钮';
    wrap.appendChild(hint);
    const stepEl = document.createElement('div');
    stepEl.className = 'teach-steps';
    stepEl.textContent = '已记录 0 步';
    teachStepEl = stepEl;
    wrap.appendChild(stepEl);
    const btn = document.createElement('button');
    btn.className = 'resume';
    btn.textContent = '我操作完了，按我教的继续';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '已确认，正在整理你教的步骤…';
      appendUser('（我操作完了，请按我教的继续）');
      try {
        await chrome.runtime.sendMessage({ type: 'RESUME' });
        setStatus('运行中…', 'running');
      } catch (e) {
        setStatus('发送失败', 'fail');
      }
    });
    wrap.appendChild(btn);
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
    const btn = document.createElement('button');
    btn.className = 'resume';
    btn.textContent = isConfirm ? '没问题，按我教的继续' : '我已操作完成，继续';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '已确认，继续执行…';
      appendUser(isConfirm ? '（没问题，请继续）' : '（已完成手动操作，请继续）');
      try {
        await chrome.runtime.sendMessage({ type: 'RESUME' });
        setStatus('运行中…', 'running');
      } catch (e) {
        setStatus('发送失败', 'fail');
      }
    });
    wrap.appendChild(btn);
  }
  box.appendChild(wrap);
  if (!silent) box.scrollTop = box.scrollHeight;
  if (isReply) $('#input').focus(); // 对话回复模式：聚焦输入框，提示用户直接打字
  if (!isTeach) teachStepEl = null; // 非教卡渲染时清掉实时步数引用
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

function clearChat() {
  $('#messages').innerHTML = '';
  teachStepEl = null;
  const hint = document.createElement('div');
  hint.className = 'chat-hint';
  hint.textContent = '持续对话模式：下达指令，完成后可继续追问。';
  $('#messages').appendChild(hint);
}

// ---------------- 发送 / 停止 / 新对话 ----------------
async function onSend() {
  const text = $('#input').value.trim();
  if (!text) return;
  $('#input').value = '';
  appendUser(text);
  disablePendingAsks('已取消（已另发消息）'); // 用户没点卡片按钮而是另发了指令，卡片按钮作废
  if (!currentTabId) {
    await refreshTab();
    if (!currentTabId) {
      appendAgent('未获取到当前标签页，请切换到正常网页后再试', false);
      return;
    }
  }
  try {
    await chrome.runtime.sendMessage({ type: 'SEND', tabId: currentTabId, text });
    setStatus('运行中…', 'running');
  } catch (e) {
    appendAgent('发送失败：' + (e.message || e), false);
    setStatus('失败', 'fail');
  }
}

async function onStop() {
  await chrome.runtime.sendMessage({ type: 'STOP' });
  disablePendingAsks('已取消（已停止）'); // 停止后待确认卡片按钮不再有意义
  setStatus('已停止，可继续对话', '');
}

async function onClear() {
  if (!confirm('新对话会关闭 Agent 自开的标签并清空聊天记录，确定吗？')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR' });
  clearChat();
  renderTabs([]);
  setStatus('就绪', '');
  $('#input').focus();
}

// ---------------- 元素排查调试工具 ----------------
// 点按钮进入"选择元素"模式：页面上悬停高亮、点元素返回诊断（Agent 能否看到 + 原因）。
// 状态由 AGENT_DEBUG_PICK_STATE 广播同步（页面按 Esc 退出时按钮也会复位）。
async function onDebug() {
  if (pickActive) {
    pickActive = false;
    updateDebugBtn();
    await chrome.runtime.sendMessage({ type: 'DEBUG_PICK_STOP', tabId: currentTabId });
    setStatus('排查模式已关闭', '');
    return;
  }
  if (!currentTabId) await refreshTab();
  if (!currentTabId) { setStatus('未获取到当前标签页，请切换到网页后再试', 'fail'); return; }
  try {
    await chrome.runtime.sendMessage({ type: 'DEBUG_PICK_START', tabId: currentTabId });
    pickActive = true;
    updateDebugBtn();
    setStatus('排查模式：悬停高亮元素，点击看 Agent 能否看到；Esc 退出', 'debug');
  } catch (e) {
    setStatus('进入排查模式失败：' + (e.message || e), 'fail');
  }
}

function updateDebugBtn() {
  const b = $('#debugBtn');
  b.textContent = pickActive ? '退出排查' : '排查';
  b.classList.toggle('debug-active', pickActive);
}

// 诊断结果卡：可见（绿）/ 祖先被收录（琥珀）/ 不可见（红），逐行着色，不用 emoji
function renderPickResult(res) {
  const card = document.createElement('div');
  card.className = 'msg debug-pick';
  const win = res.windowName || '窗口';
  const head = document.createElement('div');
  head.textContent = '排查 · ' + win + ' · 你点的元素：<' + String(res.tag || '').toUpperCase() + '>' + (res.label ? ' ' + res.label : '');
  card.appendChild(head);
  if (res.seen) {
    if (res.matched === 'self') {
      const line = document.createElement('div');
      line.className = 'dp-seen';
      line.textContent = '可见 → ref=' + res.ref + (res.dynamic ? '（动态识别）' : '');
      card.appendChild(line);
    } else if (res.matched === 'editor') {
      const line = document.createElement('div');
      line.className = 'dp-editor';
      line.textContent = '你点的元素不可见，但它所在/包裹的可输入区被看到了 → ref=' + res.ref + '（' + (res.label || '') + '）Agent 能点它写入';
      card.appendChild(line);
    } else {
      const line = document.createElement('div');
      line.className = 'dp-ancestor';
      line.textContent = '未直接收录，但祖先被看到 → ref=' + res.ref + '（<' + String(res.ancestorTag || '').toUpperCase() + '> ' + (res.label || '') + '）';
      card.appendChild(line);
    }
  } else {
    if (res.matched === 'editor-uncollected') {
      const line = document.createElement('div');
      line.className = 'dp-editor-uncollected';
      line.textContent = '附近存在可输入区（<' + String(res.tag || '').toUpperCase() + '> ' + (res.label || '') + '），但 Agent 收录不到 → 浏览侧识别缺口';
      card.appendChild(line);
      for (const r of res.reasons || []) {
        const rl = document.createElement('div');
        rl.className = 'dp-reason';
        rl.textContent = '· ' + r;
        card.appendChild(rl);
      }
    } else {
      const line = document.createElement('div');
      line.className = 'dp-notseen';
      line.textContent = '不可见';
      card.appendChild(line);
      for (const r of res.reasons || []) {
        const rl = document.createElement('div');
        rl.className = 'dp-reason';
        rl.textContent = '· ' + r;
        card.appendChild(rl);
      }
    }
  }
  const loc = document.createElement('div');
  loc.className = 'dp-loc';
  loc.textContent = '定位：' + (res.selector || '-');
  card.appendChild(loc);
  appendMsg(card, false);
}

// ---------------- 网站操作技巧管理 ----------------
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
      openTipsPanel();
      setStatus('已删除站点 ' + d, 'done');
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
    setStatus('已保存 ' + domain + ' 的技巧', 'done');
    openTipsPanel();
  });
  delBtn.addEventListener('click', async () => {
    if (!confirm('删除这条技巧？')) return;
    const { tips } = await chrome.runtime.sendMessage({ type: 'GET_TIPS' });
    const list = (tips && tips[domain]) ? tips[domain].slice() : [];
    if (index != null && index < list.length) list.splice(index, 1);
    await chrome.runtime.sendMessage({ type: 'SAVE_TIPS', domain, tips: list });
    setStatus('已删除一条技巧', 'done');
    openTipsPanel();
  });
  return item;
}

// ---------------- 初始化 ----------------
async function restoreState() {
  try {
    const { task } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!task) return;
    renderTabs(task.tabs);
    // 恢复对话气泡（按时间顺序；活动动作行不做持久化，只保留当前会话的实时显示）
    let renderedAsk = false;
    for (const c of task.conversation || []) {
      if (c.ask) {
        appendAsk(c.text, true, c.mode || 'page');
        renderedAsk = true;
      } else {
        c.role === 'user' ? appendUser(c.text, true) : appendAgent(c.text, !!c.ok, true);
      }
    }
    // 兜底：等待中但求助气泡不在对话记录里（如记录被裁剪）
    if (task.state === 'waiting_user' && !renderedAsk && task.askText) {
      appendAsk(task.askText, true, task.askMode || 'page');
    }
    // 恢复时只有"确实在等用户"的那张确认卡按钮有效（appendAsk 已把更早的卡禁用）；
    // 若恢复后 Agent 并不在等用户（已继续/已停止/已空闲），历史确认卡的按钮一律作废，避免误点。
    if (task.state !== 'waiting_user') disablePendingAsks('已取消');
    // 教我模式：把已持久化的录制步数恢复进教卡的实时计数（worker 回收后恢复）
    if (teachStepEl && task.teachEvents && task.teachEvents.length) {
      teachStepEl.textContent = '已记录 ' + task.teachEvents.length + ' 步';
    }
    $('#messages').scrollTop = $('#messages').scrollHeight;
    if (task.state === 'working' || task.state === 'awaiting_nav') {
      setStatus('运行中…', 'running');
    } else if (task.state === 'waiting_user') {
      const mode = task.askMode || 'page';
      setStatus(askStatusLabel(mode), askStatusClass(mode));
    }
  } catch (e) {}
}

async function init() {
  clearChat();
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
  $('#debugBtn').addEventListener('click', onDebug);
  $('#tipsBtn').addEventListener('click', openTipsPanel);
  $('#tipsClose').addEventListener('click', () => { $('#tipsPanel').hidden = true; });
  $('#clearBtn').addEventListener('click', onClear);

  // 广播消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AGENT_MESSAGE') appendAgent(msg.text, msg.ok);
    else if (msg.type === 'AGENT_ASK') appendAsk(msg.text, false, msg.mode || 'page');
    else if (msg.type === 'AGENT_ACTIVITY') appendActivity(msg.text);
    else if (msg.type === 'AGENT_ACTIVITY_UPDATE') {
      // 改写最后一行动作行（如"正在打开页面，等待就绪…"补上就绪时间）
      const acts = document.querySelectorAll('.msg.activity');
      if (acts.length) acts[acts.length - 1].textContent = msg.text;
    }
    else if (msg.type === 'AGENT_TEACH_STEPS') {
      // 教我模式实时步数
      if (teachStepEl) teachStepEl.textContent = '已记录 ' + (msg.count || 0) + ' 步';
    }
    else if (msg.type === 'AGENT_STATUS') {
      if (msg.status === 'working') {
        setStatus('运行中…', 'running');
        disablePendingAsks('已取消'); // Agent 恢复执行时不再等用户，待确认按钮作废
      }
      else if (msg.status === 'idle') setStatus('就绪（等待指令）', '');
      else if (msg.status === 'waiting_user') setStatus(askStatusLabel(msg.askMode), askStatusClass(msg.askMode));
    } else if (msg.type === 'AGENT_TABS') renderTabs(msg.tabs);
    else if (msg.type === 'AGENT_DEBUG_PICK_STATE') {
      pickActive = !!msg.on;
      updateDebugBtn();
      if (!pickActive) setStatus('就绪', '');
    }
    else if (msg.type === 'AGENT_DEBUG_PICK_RESULT') renderPickResult(msg.result);
    else if (msg.type === 'AGENT_CLEARED') {
      clearChat();
      renderTabs([]);
      setStatus('就绪', '');
    }
  });

  // 当前标签变化
  chrome.tabs.onActivated.addListener(refreshTab);
  chrome.tabs.onUpdated.addListener((_id, _info, tab) => {
    if (tab.active) refreshTab();
  });

  $('#input').focus();
}

document.addEventListener('DOMContentLoaded', init);
