/**
 * FlowPilot background service worker
 * 职责：流程执行引擎 / 录制协调 / 超时重跑控制 / 状态广播
 */

const STATE_KEY = 'fp_session_state';
const FLOWS_KEY = 'fp_flows';

/* ================= 状态 ================= */

let state = {
  mode: 'idle',            // idle | recording | running
  recordingTabId: null,
  recordingFlow: null,     // { name, steps: [] }
  running: null            // { flowId, flow, tabId, stepIndex, retry, pending, watchTimer, startedAt, logs: [] }
};

async function saveState() {
  try {
    const s = {
      mode: state.mode,
      recordingTabId: state.recordingTabId,
      recordingFlow: state.recordingFlow,
      running: state.running ? {
        flowId: state.running.flowId,
        flow: state.running.flow,
        tabId: state.running.tabId,
        stepIndex: state.running.stepIndex,
        retry: state.running.retry,
        startedAt: state.running.startedAt,
        logs: state.running.logs
      } : null
    };
    await chrome.storage.session.set({ [STATE_KEY]: s });
  } catch (e) { /* ignore */ }
}

async function loadState() {
  try {
    const data = await chrome.storage.session.get(STATE_KEY);
    const s = data && data[STATE_KEY];
    if (s) {
      state.mode = s.mode || 'idle';
      state.recordingTabId = s.recordingTabId || null;
      state.recordingFlow = s.recordingFlow || null;
      state.running = s.running || null;
    }
  } catch (e) { /* ignore */ }
}

// SW 启动即恢复状态（若此前正在运行，恢复挂起的等待）
loadState().then(() => {
  if (state.mode === 'running' && state.running) {
    const r = state.running;
    r.pending = true; // 标记待恢复
    setTimeout(() => resumeAfterRestart(), 500);
  }
});

async function resumeAfterRestart() {
  const r = state.running;
  if (!r || state.mode !== 'running') return;
  // SW 重启后无法确认中间状态，安全起见：重跑当前步（从当前步继续而不是整个流程重跑，
  // 避免重复点击提交等不可逆操作）
  try {
    await runCurrentStep();
  } catch (e) { /* ignore */ }
}

/* ================= 流程存储 ================= */

async function getFlows() {
  const data = await chrome.storage.local.get(FLOWS_KEY);
  return (data && data[FLOWS_KEY]) || [];
}

async function saveFlows(flows) {
  await chrome.storage.local.set({ [FLOWS_KEY]: flows });
}

/* ================= 工具 ================= */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function broadcastState() {
  try { chrome.runtime.sendMessage({ type: 'FP_STATE_CHANGED', state: publicState() }); } catch (e) { /* popup 未打开 */ }
}

function publicState() {
  return {
    mode: state.mode,
    recordingTabId: state.recordingTabId,
    recordedCount: state.recordingFlow ? state.recordingFlow.steps.length : 0,
    recordingName: state.recordingFlow ? state.recordingFlow.name : '',
    running: state.running ? {
      flowId: state.running.flowId,
      flowName: state.running.flow.name,
      stepIndex: state.running.stepIndex,
      total: state.running.flow.steps.length,
      retry: state.running.retry,
      maxRetries: state.running.flow.maxRetries != null ? state.running.flow.maxRetries : 3,
      logs: (state.running.logs || []).slice(0, 8)
    } : null
  };
}

async function ensureContentScript(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'FP_PING' });
    if (resp && resp.ok) return true;
  } catch (e) { /* 未注入 */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(400);
    const resp2 = await chrome.tabs.sendMessage(tabId, { type: 'FP_PING' });
    return !!(resp2 && resp2.ok);
  } catch (e) {
    return false;
  }
}

/* ================= 执行引擎 ================= */

async function startRunning(flow, tabId) {
  state.mode = 'running';
  state.running = {
    flowId: flow.id,
    flow: flow,
    tabId: tabId,
    stepIndex: 0,
    retry: 0,
    pending: false,
    watchTimer: null,
    startedAt: Date.now(),
    logs: ['开始执行流程']
  };
  await saveState();
  broadcastState();
  runCurrentStep();
}

function scheduleWatchTimeout(step) {
  const r = state.running;
  if (!r) return;
  if (r.watchTimer) clearTimeout(r.watchTimer);
  const timeoutSec = (step && step.timeout) || (r.flow && r.flow.stepTimeout) || 15;
  r.watchTimer = setTimeout(() => {
    // 兜底：等待反应超时 → 本轮失败，从头重跑
    failStep('等待反应超时（' + timeoutSec + 's）');
  }, timeoutSec * 1000 + 6000); // 额外 6s 余量给导航/注入
}

function clearWatchTimeout() {
  const r = state.running;
  if (r && r.watchTimer) { clearTimeout(r.watchTimer); r.watchTimer = null; }
}

function addLog(msg) {
  const r = state.running;
  if (!r) return;
  r.logs = r.logs || [];
  r.logs.unshift('[' + new Date().toLocaleTimeString() + '] ' + msg);
  if (r.logs.length > 30) r.logs.pop();
}

async function runCurrentStep() {
  const r = state.running;
  if (!r || state.mode !== 'running') return;
  const steps = r.flow.steps || [];
  if (r.stepIndex >= steps.length) {
    addLog('流程执行完成');
    broadcastState();
    stopRunning('流程全部步骤执行完成');
    return;
  }
  const step = steps[r.stepIndex];
  r.pending = false;
  broadcastState();

  const injected = await ensureContentScript(r.tabId);
  if (!injected) {
    failStep('无法在当前页面注入脚本（可能是不支持的页面，如浏览器设置页）');
    return;
  }
  scheduleWatchTimeout(step);
  try {
    const resp = await chrome.tabs.sendMessage(r.tabId, { type: 'FP_EXECUTE_WATCH', step });
    handleStepResult(resp, step);
  } catch (e) {
    // 页面正在导航（动作导致跳转），挂起等待 onUpdated
    r.pending = true;
    addLog('第 ' + (r.stepIndex + 1) + ' 步已执行，等待页面跳转...');
    broadcastState();
  }
}

function handleStepResult(resp, step) {
  const r = state.running;
  if (!r || state.mode !== 'running') return;
  clearWatchTimeout();

  if (!resp) { failStep('页面无响应'); return; }
  if (!resp.ok) {
    if (resp.reason === 'reaction-timeout') {
      failStep(resp.error || '等待反应超时');
    } else {
      failStep(resp.error || '步骤执行失败');
    }
    return;
  }

  if (resp.navigating) {
    // navigate 步骤：等 onUpdated 接管
    r.pending = true;
    addLog('正在跳转页面...');
    broadcastState();
    return;
  }

  const stepDesc = (step && step.desc) || (step && step.type) || '';
  if (resp.noWatch) {
    addLog('第 ' + (r.stepIndex + 1) + ' 步完成（无反应监测）: ' + stepDesc);
    advanceStep();
    return;
  }

  // 反应命中
  const reactions = (step && step.reactions) || [];
  const hit = reactions[resp.index];
  if (resp.actionResult && resp.actionResult.ok === false) {
    failStep('反应命中后的动作执行失败: ' + (resp.actionResult.error || ''));
    return;
  }
  addLog('第 ' + (r.stepIndex + 1) + ' 步反应命中「' + (hit ? hit.pattern : '') + '」: ' + stepDesc);
  advanceStep();
}

function advanceStep() {
  const r = state.running;
  if (!r || state.mode !== 'running') return;
  r.stepIndex++;
  r.pending = false;
  saveState();
  setTimeout(() => runCurrentStep(), 300);
}

// 本轮失败 → 从第一步重跑（用户核心需求）；超过最大重试次数则停止
function failStep(reason) {
  const r = state.running;
  if (!r || state.mode !== 'running') return;
  clearWatchTimeout();
  r.retry++;
  const maxRetries = r.flow.maxRetries != null ? r.flow.maxRetries : 3;
  addLog('第 ' + (r.stepIndex + 1) + ' 步未通过：' + reason + (r.retry <= maxRetries ? ' → 从第 1 步重跑（第 ' + r.retry + '/' + maxRetries + ' 次）' : ''));
  broadcastState();
  if (r.retry > maxRetries) {
    stopRunning('重试 ' + maxRetries + ' 次仍未通过，流程已停止');
    return;
  }
  r.stepIndex = 0;
  saveState();
  setTimeout(() => runCurrentStep(), 1200);
}

async function stopRunning(reason) {
  clearWatchTimeout();
  const r = state.running;
  if (r && reason) addLog(reason);
  state.mode = 'idle';
  state.running = null;
  await saveState();
  broadcastState();
}

/* ================= 标签页导航监听（跨页续接） ================= */

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (state.mode !== 'running') return;
  const r = state.running;
  if (!r || r.tabId !== tabId) return;

  if (info.status === 'complete') {
    if (!r.pending) return; // 非挂起状态下的刷新，忽略
    const step = (r.flow.steps || [])[r.stepIndex];
    if (!step) { stopRunning('流程步骤为空'); return; }
    // 等新页面渲染
    await sleep(900);
    if (state.mode !== 'running' || !r.pending) return;
    const reactions = (step && step.reactions) || [];
    try {
      const ok = await ensureContentScript(tabId);
      if (!ok) { failStep('新页面无法注入脚本'); return; }
      if (!reactions.length) {
        // 该步无反应监测，直接进入下一步
        addLog('页面跳转完成: ' + (step.desc || step.type));
        advanceStep();
        return;
      }
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'FP_CHECK_REACTIONS', reactions });
      if (resp && resp.ok) {
        // 反应已出现（或已在新页面出现），直接执行其对应动作
        if (resp.index != null && resp.index >= 0) {
          const reaction = reactions[resp.index];
          const act = reaction && reaction.action;
          if (act && act.type && act.type !== 'none') {
            const actResp = await chrome.tabs.sendMessage(tabId, { type: 'FP_EXECUTE_WATCH', step: { type: act.type, selectors: act.selector ? [act.selector] : [], value: act.value, reactions: [] } });
            if (actResp && actResp.ok === false) { failStep('反应命中后的动作执行失败: ' + (actResp.error || '')); return; }
          }
        }
        addLog('第 ' + (r.stepIndex + 1) + ' 步反应命中: ' + (step.desc || ''));
        advanceStep();
      } else {
        // 未出现 → 继续 WATCH
        scheduleWatchTimeout(step);
        try {
          const resp2 = await chrome.tabs.sendMessage(tabId, { type: 'FP_WATCH_ONLY', reactions, timeout: ((step && step.timeout) || 15) });
          if (state.mode !== 'running') return;
          clearWatchTimeout();
          if (resp2 && resp2.ok) {
            addLog('第 ' + (r.stepIndex + 1) + ' 步反应命中: ' + (step.desc || ''));
            advanceStep();
          } else {
            failStep((resp2 && resp2.error) || '等待反应超时');
          }
        } catch (e) {
          if (state.mode === 'running') failStep('页面监听中断');
        }
      }
    } catch (e) {
      if (state.mode === 'running') failStep('页面检查异常');
    }
  }
});

/* ================= 消息处理 ================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'FP_QUERY_MODE': {
      // content script 加载时询问当前模式
      const isRecTab = state.mode === 'recording' && sender.tab && sender.tab.id === state.recordingTabId;
      sendResponse({ recording: !!isRecTab });
      return false;
    }

    case 'FP_GET_STATE':
      sendResponse({ ok: true, state: publicState() });
      return false;

    /* ---------- 录制 ---------- */

    case 'FP_REC_START': {
      (async () => {
        const tabId = msg.tabId;
        state.mode = 'recording';
        state.recordingTabId = tabId;
        state.recordingFlow = { name: msg.name || '新流程', steps: [] };
        await saveState();
        const ok = await ensureContentScript(tabId);
        if (ok) {
          try { await chrome.tabs.sendMessage(tabId, { type: 'FP_REC_START' }); } catch (e) { /* ignore */ }
        }
        broadcastState();
        sendResponse({ ok: true, injected: ok });
      })();
      return true;
    }

    case 'FP_REC_STEP': {
      if (state.mode === 'recording' && sender.tab && sender.tab.id === state.recordingTabId && state.recordingFlow) {
        state.recordingFlow.steps.push(msg.step);
        saveState();
        broadcastState();
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'FP_REC_SAVE': {
      (async () => {
        const flow = state.recordingFlow;
        try { if (state.recordingTabId != null) await chrome.tabs.sendMessage(state.recordingTabId, { type: 'FP_REC_STOP' }); } catch (e) { /* ignore */ }
        state.mode = 'idle';
        state.recordingTabId = null;
        state.recordingFlow = null;
        await saveState();
        broadcastState();
        sendResponse({ ok: true, flow: flow });
      })();
      return true;
    }

    case 'FP_REC_CANCEL': {
      (async () => {
        try { if (state.recordingTabId != null) await chrome.tabs.sendMessage(state.recordingTabId, { type: 'FP_REC_STOP' }); } catch (e) { /* ignore */ }
        state.mode = 'idle';
        state.recordingTabId = null;
        state.recordingFlow = null;
        await saveState();
        broadcastState();
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'FP_REC_SET_NAME': {
      if (state.recordingFlow) {
        state.recordingFlow.name = msg.name || state.recordingFlow.name;
        saveState();
      }
      sendResponse({ ok: true });
      return false;
    }

    /* ---------- 运行 ---------- */

    case 'FP_RUN': {
      (async () => {
        const flows = await getFlows();
        const flow = flows.find(f => f.id === msg.flowId);
        if (!flow) { sendResponse({ ok: false, error: '流程不存在' }); return; }
        if (!flow.steps || !flow.steps.length) { sendResponse({ ok: false, error: '流程没有步骤' }); return; }
        if (state.mode === 'running') { sendResponse({ ok: false, error: '已有流程在执行，请先停止' }); return; }
        const tabId = msg.tabId;
        sendResponse({ ok: true });
        startRunning(JSON.parse(JSON.stringify(flow)), tabId);
      })();
      return true;
    }

    case 'FP_STOP': {
      (async () => {
        if (state.mode === 'running') {
          await stopRunning('手动停止');
        } else if (state.mode === 'recording') {
          // 手动取消录制
          try { if (state.recordingTabId != null) await chrome.tabs.sendMessage(state.recordingTabId, { type: 'FP_REC_STOP' }); } catch (e) { /* ignore */ }
          state.mode = 'idle';
          state.recordingTabId = null;
          state.recordingFlow = null;
          await saveState();
          broadcastState();
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    default:
      return false;
  }
});
