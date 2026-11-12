/**
 * FlowPilot content script
 * 注入所有页面，负责：录制用户操作 / 执行流程动作 / 监测页面反应
 */
(() => {
  if (window.__flowPilotInjected) return;
  window.__flowPilotInjected = true;

  let recording = false;
  let executing = false;
  let badgeEl = null;

  const EXT_URL = chrome.runtime.getURL('');

  /* ================= 通用工具 ================= */

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function cssEscape(s) {
    try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'); }
    catch (e) { return String(s); }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  const CLICKABLE = 'button,a,[role="button"],input[type="submit"],input[type="button"],input[type="reset"],input[type="radio"],input[type="checkbox"],label,summary,li,td,th,[onclick],[tabindex]';

  /* ================= 选择器引擎 ================= */

  // 为元素生成主+备选选择器列表（执行时按顺序尝试）
  function buildSelectors(el) {
    const sels = [];
    try {
      const tag = (el.tagName || '').toLowerCase();
      if (el.id) sels.push('#' + cssEscape(el.id));
      const name = el.getAttribute && el.getAttribute('name');
      if (name) sels.push(`${tag}[name="${name}"]`);
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-id']) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v) sels.push(`${tag}[${attr}="${v}"]`);
      }
      if (el.type === 'submit') sels.push('input[type="submit"]');
      const txt = ((el.innerText || el.value || '') + '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const clickable = el.matches && el.matches(CLICKABLE);
      if (clickable && txt) sels.push('text=' + txt);
      sels.push(cssPath(el));
    } catch (e) { /* ignore */ }
    return Array.from(new Set(sels.filter(Boolean)));
  }

  // 生成 CSS 路径（最多 6 层，遇到 id 提前结束）
  function cssPath(el) {
    const parts = [];
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(sel + '#' + cssEscape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, c => c.tagName === node.tagName);
        if (same.length > 1) {
          const idx = same.indexOf(node);
          if (idx >= 0) sel += `:nth-of-type(${idx + 1})`;
        }
      }
      parts.unshift(sel);
      node = parent;
      depth++;
    }
    return parts.join(' > ') || (el.tagName || 'body').toLowerCase();
  }

  // 按选择器查找元素。支持特殊前缀 text=xxx（按可见文本模糊匹配可点击元素）
  function findBySelector(sel) {
    sel = (sel || '').trim();
    if (!sel) return null;
    try {
      if (sel.startsWith('text=')) {
        const txt = sel.slice(5).trim().toLowerCase();
        if (!txt) return null;
        const nodes = document.querySelectorAll(CLICKABLE);
        for (const n of nodes) {
          if (!isVisible(n)) continue;
          const t = ((n.innerText || n.value || '') + '').trim().toLowerCase();
          if (t && t.includes(txt)) return n;
        }
        return null;
      }
      return document.querySelector(sel);
    } catch (e) { return null; }
  }

  // 依次尝试多个候选选择器
  function findElement(selectors) {
    for (const s of (selectors || [])) {
      const el = findBySelector(s);
      if (el) return el;
    }
    return null;
  }

  /* ================= 动作执行 ================= */

  // 用原生 setter 赋值，兼容 React/Vue 等框架
  function setNativeValue(el, value) {
    let proto;
    if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
    else if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
    else proto = HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 执行单步动作，返回 {ok, error?, navigating?}
  function executeAction(step) {
    if (!step) return { ok: false, error: '步骤为空' };
    if (step.type === 'wait') return { ok: true };
    if (step.type === 'navigate') {
      if (step.value) { location.href = step.value; return { ok: true, navigating: true }; }
      return { ok: false, error: '导航地址为空' };
    }
    const el = findElement(step.selectors);
    if (!el) {
      return { ok: false, error: '未找到元素: ' + ((step.selectors || []).join(' , ') || '(无选择器)') };
    }
    try {
      if (step.type === 'click') {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        el.click();
        return { ok: true };
      }
      if (step.type === 'input') {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        el.focus();
        setNativeValue(el, step.value != null ? String(step.value) : '');
        return { ok: true };
      }
      return { ok: false, error: '未知步骤类型: ' + step.type };
    } catch (e) {
      return { ok: false, error: '执行出错: ' + (e && e.message) };
    }
  }

  /* ================= 反应监测 ================= */

  // 检查反应列表，返回第一个满足的反应下标，无则 -1
  // reaction: { type: 'text'|'element'|'url', pattern, action? }
  function checkReactions(reactions) {
    const list = reactions || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || !r.pattern) continue;
      let ok = false;
      try {
        if (r.type === 'text') {
          ok = ((document.body && document.body.innerText) || '').includes(r.pattern);
        } else if (r.type === 'element') {
          ok = !!findBySelector(r.pattern);
        } else if (r.type === 'url') {
          ok = location.href.includes(r.pattern);
        }
      } catch (e) { ok = false; }
      if (ok) return i;
    }
    return -1;
  }

  // 轮询等待反应（250ms 一次），超时返回 {ok:false}
  function watchReactions(reactions, timeoutMs) {
    return new Promise(resolve => {
      const start = Date.now();
      let done = false;
      const finish = res => { if (!done) { done = true; clearInterval(timer); resolve(res); } };
      const timer = setInterval(() => {
        const idx = checkReactions(reactions);
        if (idx >= 0) finish({ ok: true, index: idx });
        else if (Date.now() - start >= timeoutMs) finish({ ok: false, reason: 'timeout' });
      }, 250);
      setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs + 800);
    });
  }

  // 反应命中后执行其对应动作
  function runReactionAction(reaction) {
    const act = reaction && reaction.action;
    if (!act || !act.type || act.type === 'none') return { ok: true, skipped: true };
    return executeAction({ type: act.type, selectors: act.selector ? [act.selector] : [], value: act.value });
  }

  /* ================= 录制 ================= */

  function sendStep(step) {
    step.url = location.href;
    step.ts = Date.now();
    try { chrome.runtime.sendMessage({ type: 'FP_REC_STEP', step }); } catch (e) { /* ignore */ }
  }

  function onCaptureClick(e) {
    if (!recording) return;
    // 忽略扩展自身页面
    if (location.href.startsWith(EXT_URL)) return;
    const t = e.target;
    if (!t || !t.closest) return;
    // 输入类元素不记录点击（由 change 统一记录），避免冗余步骤
    if (t.closest('input[type="text"],input[type="password"],input[type="number"],input[type="email"],input[type="search"],input[type="tel"],input[type="url"],input:not([type]),textarea,select')) return;
    const el = t.closest(CLICKABLE) || t;
    sendStep({
      type: 'click',
      selectors: buildSelectors(el),
      desc: '点击: ' + ((el.innerText || el.value || el.tagName || '') + '').trim().replace(/\s+/g, ' ').slice(0, 30)
    });
  }

  function onCaptureChange(e) {
    if (!recording) return;
    if (location.href.startsWith(EXT_URL)) return;
    const el = e.target;
    if (!el || !el.matches) return;
    if (el.matches('input[type="checkbox"]')) {
      sendStep({ type: 'click', selectors: buildSelectors(el), desc: el.checked ? '勾选: ' + checkboxLabel(el) : '取消勾选: ' + checkboxLabel(el) });
      return;
    }
    if (el.matches('input[type="radio"]')) {
      sendStep({ type: 'click', selectors: buildSelectors(el), desc: '选择: ' + (el.value || checkboxLabel(el)) });
      return;
    }
    if (el.matches('input,textarea,select')) {
      const v = el.value;
      sendStep({
        type: 'input',
        selectors: buildSelectors(el),
        value: v,
        desc: (el.tagName === 'SELECT' ? '选择: ' : '输入: ') + String(v == null ? '' : v).slice(0, 30)
      });
    }
  }

  function checkboxLabel(el) {
    const id = el.id;
    if (id) {
      const lb = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (lb) return (lb.innerText || '').trim().slice(0, 30);
    }
    const wrap = el.closest('label');
    if (wrap) return (wrap.innerText || '').trim().slice(0, 30);
    return el.name || el.value || '选项';
  }

  function attachRecordListeners() {
    document.addEventListener('click', onCaptureClick, true);
    document.addEventListener('change', onCaptureChange, true);
  }

  function removeRecordListeners() {
    document.removeEventListener('click', onCaptureClick, true);
    document.removeEventListener('change', onCaptureChange, true);
  }

  function showBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.textContent = '● FlowPilot 录制中';
    badgeEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#e74c3c;color:#fff;padding:6px 14px;border-radius:20px;font-size:13px;font-family:sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);pointer-events:none;';
    (document.body || document.documentElement).appendChild(badgeEl);
  }

  function hideBadge() {
    if (badgeEl) { badgeEl.remove(); badgeEl = null; }
  }

  function startRecording() {
    recording = true;
    attachRecordListeners();
    showBadge();
  }

  function stopRecording() {
    recording = false;
    removeRecordListeners();
    hideBadge();
  }

  /* ================= 消息处理 ================= */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'FP_PING':
        sendResponse({ ok: true, recording, executing });
        return false;

      case 'FP_REC_START':
        startRecording();
        sendResponse({ ok: true });
        return false;

      case 'FP_REC_STOP':
        stopRecording();
        sendResponse({ ok: true });
        return false;

      // 执行步骤动作并等待反应
      case 'FP_EXECUTE_WATCH': {
        if (executing) { sendResponse({ ok: false, error: '当前页面正在执行其他步骤' }); return false; }
        executing = true;
        (async () => {
          try {
            const r = executeAction(msg.step);
            if (!r.ok) { sendResponse({ ok: false, error: r.error }); return; }
            if (r.navigating) { sendResponse({ ok: true, navigating: true }); return; }
            const reactions = (msg.step && msg.step.reactions) || [];
            if (!reactions.length) {
              await sleep((msg.step && msg.step.waitAfter) || 500);
              sendResponse({ ok: true, noWatch: true });
              return;
            }
            const res = await watchReactions(reactions, ((msg.step && msg.step.timeout) || 15) * 1000);
            if (res.ok) {
              const actRes = runReactionAction(reactions[res.index]);
              sendResponse({ ok: true, index: res.index, actionResult: actRes });
            } else {
              sendResponse({ ok: false, error: '等待反应超时', reason: 'reaction-timeout' });
            }
          } catch (e) {
            sendResponse({ ok: false, error: '执行异常: ' + (e && e.message) });
          } finally {
            executing = false;
          }
        })();
        return true; // 异步 sendResponse
      }

      // 跨页后续：不执行主动作，只等待反应（命中后执行对应反应动作）
      case 'FP_WATCH_ONLY': {
        if (executing) { sendResponse({ ok: false, error: '当前页面正在执行其他步骤' }); return false; }
        executing = true;
        (async () => {
          try {
            const res = await watchReactions(msg.reactions || [], (msg.timeout || 15) * 1000);
            if (res.ok) {
              const reactions = msg.reactions || [];
              const actRes = runReactionAction(reactions[res.index]);
              sendResponse({ ok: true, index: res.index, actionResult: actRes });
            } else {
              sendResponse({ ok: false, reason: 'reaction-timeout', error: '等待反应超时' });
            }
          } finally { executing = false; }
        })();
        return true;
      }

      // 一次性检查（页面刚加载完成时）
      case 'FP_CHECK_REACTIONS': {
        const idx = checkReactions(msg.reactions || []);
        sendResponse({ ok: idx >= 0, index: idx });
        return false;
      }

      default:
        return false;
    }
  });

  /* ================= 启动时向 background 查询模式 ================= */

  (function init() {
    try {
      chrome.runtime.sendMessage({ type: 'FP_QUERY_MODE' }, res => {
        if (chrome.runtime.lastError) return;
        if (res && res.recording) startRecording();
      });
    } catch (e) { /* ignore */ }
  })();
})();
