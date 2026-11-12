/** FlowPilot popup 管理界面逻辑 */

const FLOWS_KEY = 'fp_flows';

const $ = id => document.getElementById(id);

let flows = [];
let lastState = null;

/* ================= 工具 ================= */

function getFlows() {
  return chrome.storage.local.get(FLOWS_KEY).then(d => d[FLOWS_KEY] || []);
}

function saveFlows(f) {
  return chrome.storage.local.set({ [FLOWS_KEY]: f });
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || {});
    });
  });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0].id : null;
}

/* ================= 渲染 ================= */

function renderState(s) {
  lastState = s;
  const badge = $('statusBadge');
  const idleArea = $('idleArea');
  const recArea = $('recordingArea');
  const runArea = $('runningArea');
  const flowSection = $('flowSection');

  badge.className = 'status ' + s.mode;
  badge.textContent = { idle: '空闲', recording: '录制中', running: '执行中' }[s.mode] || '空闲';

  idleArea.classList.toggle('hidden', s.mode !== 'idle');
  recArea.classList.toggle('hidden', s.mode !== 'recording');
  runArea.classList.toggle('hidden', s.mode !== 'running');
  flowSection.classList.toggle('hidden', false);

  if (s.mode === 'recording') {
    $('recCount').textContent = s.recordedCount;
    if (!$('recName').value && s.recordingName) $('recName').value = s.recordingName;
  }

  if (s.mode === 'running' && s.running) {
    const r = s.running;
    $('runName').textContent = '▶ ' + r.flowName;
    $('runStep').textContent = Math.min(r.stepIndex + 1, r.total);
    $('runTotal').textContent = r.total;
    $('runRetry').textContent = r.retry + '/' + r.maxRetries;
    $('runBarFill').style.width = (r.total ? (r.stepIndex / r.total) * 100 : 0) + '%';
    const logs = $('runLogs');
    logs.innerHTML = '';
    (r.logs || []).forEach(l => {
      const div = document.createElement('div');
      div.textContent = l;
      logs.appendChild(div);
    });
  }
}

function renderFlows() {
  const list = $('flowList');
  list.innerHTML = '';
  $('flowEmpty').classList.toggle('hidden', flows.length > 0);
  flows.forEach(f => {
    const card = document.createElement('div');
    card.className = 'flow-card';

    const head = document.createElement('div');
    head.className = 'fc-head';
    const name = document.createElement('span');
    name.className = 'fc-name';
    name.textContent = f.name;
    head.appendChild(name);
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'fc-meta';
    const reactions = (f.steps || []).filter(s => s.reactions && s.reactions.length).length;
    meta.textContent = `${(f.steps || []).length} 个步骤 · ${reactions} 步带反应监测 · 超时重跑上限 ${f.maxRetries != null ? f.maxRetries : 3} 次`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'fc-actions';

    const runBtn = mkBtn('▶ 运行', 'success', () => runFlow(f));
    const editBtn = mkBtn('编辑', '', () => chrome.runtime.openOptionsPage());
    const exportBtn = mkBtn('导出', '', () => exportFlow(f));
    const delBtn = mkBtn('删除', 'danger', () => delFlow(f));

    actions.append(runBtn, editBtn, exportBtn, delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn small ' + cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/* ================= 动作 ================= */

async function startRecord() {
  const tabId = await getActiveTabId();
  if (tabId == null) { toast('未找到活动标签页'); return; }
  const res = await send({ type: 'FP_REC_START', tabId, name: '新流程' });
  if (res.injected === false) toast('当前页面不支持录制（如浏览器设置页）');
  renderState(lastState);
}

async function saveRecord() {
  const name = $('recName').value.trim() || '新流程';
  await send({ type: 'FP_REC_SET_NAME', name });
  const res = await send({ type: 'FP_REC_SAVE' });
  if (res.ok && res.flow) {
    const flow = {
      id: 'f' + Date.now() + Math.floor(Math.random() * 1000),
      name: name,
      steps: res.flow.steps || [],
      maxRetries: 3,
      stepTimeout: 15,
      createdAt: Date.now()
    };
    flows.unshift(flow);
    await saveFlows(flows);
    renderFlows();
    toast('已保存流程「' + name + '」，共 ' + flow.steps.length + ' 步，可在编辑器中补充反应监测');
  }
}

async function cancelRecord() {
  await send({ type: 'FP_REC_CANCEL' });
}

async function runFlow(flow) {
  const tabId = await getActiveTabId();
  if (tabId == null) { toast('未找到活动标签页'); return; }
  const res = await send({ type: 'FP_RUN', flowId: flow.id, tabId });
  if (!res.ok) toast(res.error || '启动失败');
}

async function delFlow(flow) {
  if (!confirm('确定删除流程「' + flow.name + '」吗？')) return;
  flows = flows.filter(f => f.id !== flow.id);
  await saveFlows(flows);
  renderFlows();
}

function exportFlow(flow) {
  const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = flow.name + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importFlow(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : [data];
    let n = 0;
    for (const f of list) {
      if (!f || !f.name || !Array.isArray(f.steps)) continue;
      flows.unshift({
        id: 'f' + Date.now() + Math.floor(Math.random() * 1000),
        name: f.name + (list.length > 1 ? '' : '（导入）'),
        steps: f.steps,
        maxRetries: f.maxRetries != null ? f.maxRetries : 3,
        stepTimeout: f.stepTimeout != null ? f.stepTimeout : 15,
        createdAt: Date.now()
      });
      n++;
    }
    await saveFlows(flows);
    renderFlows();
    toast('导入完成，共 ' + n + ' 个流程');
  } catch (e) {
    toast('导入失败：文件格式不正确');
  }
}

/* ================= 事件绑定 ================= */

$('btnRecord').addEventListener('click', startRecord);
$('btnRecSave').addEventListener('click', saveRecord);
$('btnRecCancel').addEventListener('click', cancelRecord);
$('btnStop').addEventListener('click', () => send({ type: 'FP_STOP' }));
$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', e => {
  if (e.target.files && e.target.files[0]) importFlow(e.target.files[0]);
  e.target.value = '';
});

/* ================= 状态监听与初始化 ================= */

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'FP_STATE_CHANGED' && msg.state) {
    renderState(msg.state);
  }
});

(async function init() {
  flows = await getFlows();
  renderFlows();
  const res = await send({ type: 'FP_GET_STATE' });
  if (res.ok) renderState(res.state);
  // 兜底轮询（service worker 广播可能丢失）
  setInterval(async () => {
    const r = await send({ type: 'FP_GET_STATE' });
    if (r.ok) renderState(r.state);
  }, 1500);
})();
