/**
 * picker.js — 本地文件选择弹窗（uploadFile pick:true）
 *
 * background 打开本页并带 ?pickId= 参数；使用者选完本地文件后，用 FileReader 读成 base64，
 * 经 PICK_FILE_RESULT 消息回传 background（带 windowId 供其关闭本窗）。取消则发 cancelled。
 * 本页不自关窗口——由 background 统一 remove，避免竞态。
 */
(() => {
  const pickId = new URLSearchParams(location.search).get('pickId') || '';
  const input = document.getElementById('file');
  const meta = document.getElementById('meta');
  const cancelBtn = document.getElementById('cancel');
  let done = false; // 已发送结果后不再重复发（change 只触发一次，但取消/文件都走后要互斥）

  // 保持 background 存活：picker 打开期间维持一条长连接，MV3 服务 worker 不会因空闲被回收——
  // 回收会丢掉 background 里正在等的 pickLocalFile（Promise 随 SW 终止一起丢失，选完文件也接不回来）。
  const keepPort = chrome.runtime.connect({ name: 'picker-keepalive' });
  window.addEventListener('pagehide', () => { try { keepPort.disconnect(); } catch (e) {} });

  const UPLOAD_MAX = 5 * 1024 * 1024; // 与 content.js UPLOAD_MAX 一致：5MB
  const getWindowId = () => new Promise((r) => {
    try { chrome.windows.getCurrent({}, (w) => r(w && w.id != null ? w.id : null)); } catch (e) { r(null); }
  });
  const send = async (payload) => {
    if (done) return;
    done = true;
    const windowId = await getWindowId();
    chrome.runtime.sendMessage(Object.assign({ type: 'PICK_FILE_RESULT', pickId, windowId }, payload)).catch(() => {});
  };

  cancelBtn.addEventListener('click', () => send({ cancelled: true }));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') send({ cancelled: true }); });

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) { send({ cancelled: true }); return; }
    if (file.size > UPLOAD_MAX) {
      meta.textContent = '文件过大：' + file.name + '（超过 5MB 上限），请换小文件';
      return;
    }
    meta.textContent = file.name + '（' + Math.max(1, Math.round(file.size / 1024)) + ' KB），正在读取…';
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || '').replace(/^data:[^;]*;base64,/, '');
      send({ base64: b64, filename: file.name, mime: file.type || '' });
    };
    reader.onerror = () => { meta.textContent = '读取失败，请重试'; };
    reader.readAsDataURL(file);
  });
})();
