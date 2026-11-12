/** FlowPilot 流程编辑器逻辑 */

const FLOWS_KEY = 'fp_flows';

const $ = id => document.getElementById(id);

let flows = [];
let currentId = null;          // 当前编辑流程 id
let editingStepIndex = -1;     // -1 = 新增
let editingStep = null;        // 弹窗编辑中的步骤对象

const STEP_TYPE_TEXT = { click: '点击', input: '输入', wait: '等待', navigate: '打开网址' };

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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

function currentFlow() {
  return flows.find(f => f.id === currentId) || null;
}

/* ================= 流程列表 ================= */

function renderFlowList() {
  const list = $('flowList');
  list.innerHTML = '';
  flows.forEach(f => {
    const item = document.createElement('div');
    item.className = 'flow-item' + (f.id === currentId ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'fi-name';
    name.textContent = f.name;
    const meta = document.createElement('div');
    meta.className = 'fi-meta';
    meta.textContent = (f.steps || []).length + ' 步';
    item.append(name, meta);
    item.addEventListener('click', () => selectFlow(f.id));
    list.appendChild(item);
  });
}

function selectFlow(id) {
  currentId = id;
  renderFlowList();
  renderEditor();
}

function renderEditor() {
  const flow = currentFlow();
  $('emptyTip').classList.toggle('hidden', !!flow);
  $('editor').classList.toggle('hidden', !flow);
  if (!flow) return;

  $('fName').value = flow.name || '';
  $('fTimeout').value = flow.stepTimeout != null ? flow.stepTimeout : 15;
  $('fMaxRetries').value = flow.maxRetries != null ? flow.maxRetries : 3;
  renderStepList();
}

/* ================= 步骤列表 ================= */

function renderStepList() {
  const flow = currentFlow();
  if (!flow) return;
  const list = $('stepList');
  list.innerHTML = '';
  (flow.steps || []).forEach((step, i) => {
    const card = document.createElement('div');
    card.className = 'step-card';

    const idx = document.createElement('div');
    idx.className = 'sc-idx';
    idx.textContent = i + 1;

    const main = document.createElement('div');
    main.className = 'sc-main';
    const desc = document.createElement('div');
    desc.className = 'sc-desc';
    desc.textContent = step.desc || STEP_TYPE_TEXT[step.type] || step.type;
    const detail = document.createElement('div');
    detail.className = 'sc-detail';
    detail.textContent = stepDetailText(step);
    main.append(desc, detail);

    const tags = document.createElement('div');
    tags.className = 'sc-tags';
    if (step.reactions && step.reactions.length) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = '反应监测 ×' + step.reactions.length;
      tags.appendChild(t);
    } else {
      const t = document.createElement('span');
      t.className = 'tag warn';
      t.textContent = '无反应监测（执行完直接下一步）';
      tags.appendChild(t);
    }
    main.appendChild(tags);

    const actions = document.createElement('div');
    actions.className = 'sc-actions';
    actions.appendChild(mkBtn('编辑', 'small', () => openStepModal(i)));
    actions.appendChild(mkBtn('↑', 'small', () => moveStep(i, -1)));
    actions.appendChild(mkBtn('↓', 'small', () => moveStep(i, 1)));
    actions.appendChild(mkBtn('删除', 'small danger', () => removeStep(i)));

    card.append(idx, main, actions);
    list.appendChild(card);
  });
}

function stepDetailText(step) {
  if (step.type === 'wait') return '等待（由反应监测控制时长）';
  if (step.type === 'navigate') return '打开: ' + (step.value || '');
  if (step.type === 'input') return '输入「' + (step.value || '') + '」→ ' + selText(step.selectors);
  return '点击 → ' + selText(step.selectors);
}

function selText(selectors) {
  return (selectors || []).slice(0, 2).join(' , ') || '(无选择器)';
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function moveStep(i, dir) {
  const flow = currentFlow();
  const j = i + dir;
  if (!flow || j < 0 || j >= flow.steps.length) return;
  const steps = flow.steps;
  [steps[i], steps[j]] = [steps[j], steps[i]];
  renderStepList();
}

function removeStep(i) {
  const flow = currentFlow();
  if (!flow) return;
  flow.steps.splice(i, 1);
  renderStepList();
}

/* ================= 步骤编辑弹窗 ================= */

function openStepModal(index) {
  const flow = currentFlow();
  if (!flow) return;
  editingStepIndex = index;
  editingStep = index >= 0 ? JSON.parse(JSON.stringify(flow.steps[index])) : {
    id: 's' + Date.now(),
    type: 'click',
    selectors: [],
    value: '',
    desc: '',
    waitAfter: 500,
    timeout: null,
    reactions: []
  };

  $('modalTitle').textContent = index >= 0 ? '编辑步骤 ' + (index + 1) : '添加步骤';
  $('sType').value = editingStep.type;
  $('sSelectors').value = (editingStep.selectors || []).join('\n');
  $('sValue').value = editingStep.value || '';
  $('sTimeout').value = editingStep.timeout != null ? editingStep.timeout : '';
  $('sWaitAfter').value = editingStep.waitAfter != null ? editingStep.waitAfter : 500;
  $('sDesc').value = editingStep.desc || '';
  renderReactions();
  updateValueFieldVisibility();
  $('stepModal').classList.remove('hidden');
}

function updateValueFieldVisibility() {
  const t = $('sType').value;
  $('fieldValue').classList.toggle('hidden', !(t === 'input' || t === 'navigate'));
  $('sSelectors').disabled = (t === 'wait' || t === 'navigate');
}

function renderReactions() {
  const list = $('reactionList');
  list.innerHTML = '';
  (editingStep.reactions || []).forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'reaction-item';

    // 第一行：反应类型 + 匹配值
    const row1 = document.createElement('div');
    row1.className = 'ri-row';
    const ifLabel = document.createElement('span');
    ifLabel.className = 'ri-if';
    ifLabel.textContent = '如果页面';
    const selType = document.createElement('select');
    selType.className = 'ri-type';
    selType.innerHTML = '<option value="text">出现文字</option><option value="element">出现元素</option><option value="url">网址包含</option>';
    selType.value = r.type || 'text';
    const pattern = document.createElement('input');
    pattern.className = 'ri-pattern';
    pattern.placeholder = { text: '如：提交成功', element: '如：text=确定 或 #okBtn', url: '如：/success' }[selType.value] || '';
    pattern.value = r.pattern || '';
    selType.addEventListener('change', () => {
      pattern.placeholder = { text: '如：提交成功', element: '如：text=确定 或 #okBtn', url: '如：/success' }[selType.value] || '';
    });
    const del = document.createElement('button');
    del.className = 'ri-del';
    del.textContent = '删除';
    del.addEventListener('click', () => { editingStep.reactions.splice(i, 1); renderReactions(); });
    row1.append(ifLabel, selType, pattern, del);

    // 第二行：对应动作
    const row2 = document.createElement('div');
    row2.className = 'ri-row';
    const thenLabel = document.createElement('span');
    thenLabel.className = 'ri-then';
    thenLabel.textContent = '则';
    const selAction = document.createElement('select');
    selAction.className = 'ri-action-type';
    selAction.innerHTML = '<option value="none">不做动作，直接下一步</option><option value="click">点击元素</option><option value="input">输入内容</option>';
    selAction.value = (r.action && r.action.type) || 'none';
    const actionSel = document.createElement('input');
    actionSel.className = 'ri-action-sel';
    actionSel.placeholder = '目标选择器，如 #nextBtn';
    actionSel.value = (r.action && r.action.selector) || '';
    const actionVal = document.createElement('input');
    actionVal.className = 'ri-action-val';
    actionVal.placeholder = '输入内容';
    actionVal.value = (r.action && r.action.value) || '';
    const syncActionFields = () => {
      actionSel.style.display = selAction.value === 'none' ? 'none' : '';
      actionVal.style.display = selAction.value === 'input' ? '' : 'none';
    };
    selAction.addEventListener('change', syncActionFields);
    syncActionFields();
    row2.append(thenLabel, selAction, actionSel, actionVal);

    item.append(row1, row2);
    list.appendChild(item);
  });
}

function collectReactions() {
  const items = document.querySelectorAll('#reactionList .reaction-item');
  const reactions = [];
  items.forEach(item => {
    const type = item.querySelector('.ri-type').value;
    const pattern = item.querySelector('.ri-pattern').value.trim();
    const actionType = item.querySelector('.ri-action-type').value;
    const actionSel = item.querySelector('.ri-action-sel').value.trim();
    const actionVal = item.querySelector('.ri-action-val').value;
    if (!pattern) return;
    const r = { type, pattern };
    if (actionType && actionType !== 'none' && actionSel) {
      r.action = { type: actionType, selector: actionSel, value: actionVal };
    }
    reactions.push(r);
  });
  return reactions;
}

async function saveStepModal() {
  const flow = currentFlow();
  if (!flow) return;
  const type = $('sType').value;
  const selectors = $('sSelectors').value.split('\n').map(s => s.trim()).filter(Boolean);
  const value = $('sValue').value;

  if ((type === 'click' || type === 'input') && !selectors.length) {
    toast('请至少填写一个目标选择器');
    return;
  }

  editingStep.type = type;
  editingStep.selectors = selectors;
  editingStep.value = value;
  editingStep.timeout = $('sTimeout').value ? Number($('sTimeout').value) : null;
  editingStep.waitAfter = Number($('sWaitAfter').value) || 0;
  editingStep.desc = $('sDesc').value.trim();
  editingStep.reactions = collectReactions();

  if (!editingStep.desc) {
    editingStep.desc = { click: '点击: ' + selText(selectors), input: '输入: ' + String(value).slice(0, 20), wait: '等待', navigate: '打开: ' + value }[type];
  }

  if (editingStepIndex >= 0) flow.steps[editingStepIndex] = editingStep;
  else flow.steps.push(editingStep);

  $('stepModal').classList.add('hidden');
  renderStepList();
  await persistFlow(false);
}

/* ================= 流程保存 / 删除 / 导入导出 ================= */

async function persistFlow(showTip = true) {
  const flow = currentFlow();
  if (!flow) return;
  flow.name = $('fName').value.trim() || '未命名流程';
  flow.stepTimeout = Number($('fTimeout').value) || 15;
  flow.maxRetries = Number($('fMaxRetries').value);
  if (isNaN(flow.maxRetries) || flow.maxRetries < 0) flow.maxRetries = 3;
  await saveFlows(flows);
  renderFlowList();
  if (showTip) {
    $('saveTip').classList.remove('hidden');
    setTimeout(() => $('saveTip').classList.add('hidden'), 1600);
  }
}

function exportFlow() {
  const flow = currentFlow();
  if (!flow) return;
  const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = flow.name + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteFlow() {
  const flow = currentFlow();
  if (!flow) return;
  if (!confirm('确定删除流程「' + flow.name + '」吗？')) return;
  flows = flows.filter(f => f.id !== flow.id);
  currentId = flows.length ? flows[0].id : null;
  await saveFlows(flows);
  renderFlowList();
  renderEditor();
}

/* ================= 事件绑定 ================= */

$('btnNew').addEventListener('click', async () => {
  const flow = {
    id: 'f' + Date.now() + Math.floor(Math.random() * 1000),
    name: '新流程',
    steps: [],
    maxRetries: 3,
    stepTimeout: 15,
    createdAt: Date.now()
  };
  flows.unshift(flow);
  await saveFlows(flows);
  selectFlow(flow.id);
});

$('btnAddStep').addEventListener('click', () => openStepModal(-1));
$('btnStepOk').addEventListener('click', saveStepModal);
$('btnStepCancel').addEventListener('click', () => $('stepModal').classList.add('hidden'));
$('btnAddReaction').addEventListener('click', () => {
  if (!editingStep.reactions) editingStep.reactions = [];
  editingStep.reactions.push({ type: 'text', pattern: '' });
  renderReactions();
});
$('sType').addEventListener('change', updateValueFieldVisibility);

$('btnSave').addEventListener('click', () => persistFlow(true));
$('btnExport').addEventListener('click', exportFlow);
$('btnDelete').addEventListener('click', deleteFlow);

$('btnImportAll').addEventListener('click', () => $('fileImportAll').click());
$('fileImportAll').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : [data];
    let n = 0;
    for (const f of list) {
      if (!f || !f.name || !Array.isArray(f.steps)) continue;
      flows.unshift({
        id: 'f' + Date.now() + Math.floor(Math.random() * 1000) + n,
        name: f.name,
        steps: f.steps,
        maxRetries: f.maxRetries != null ? f.maxRetries : 3,
        stepTimeout: f.stepTimeout != null ? f.stepTimeout : 15,
        createdAt: Date.now()
      });
      n++;
    }
    await saveFlows(flows);
    renderFlowList();
    toast('导入完成，共 ' + n + ' 个流程');
  } catch (err) {
    toast('导入失败：文件格式不正确');
  }
  e.target.value = '';
});

/* ================= 初始化 ================= */

(async function init() {
  flows = await getFlows();
  renderFlowList();
  if (flows.length) selectFlow(flows[0].id);
  else renderEditor();
})();
