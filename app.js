import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://djfkixzsvllnjwmhdrzs.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_18lDR9aUrx5KXAKErPVhlQ_k9TWp3L8';
const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const LOGIN_TIME_KEY = 'personal_sop_login_at';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'personal-sop-agent-auth'
  }
});

const moduleSeeds = [
  ['tasks', '个人任务', 5, '把所有模块产生的下一步统一收口成任务池'],
  ['health', '健康管理', 7, '结构化体检指标、补剂轮换、运动恢复和代谢观察'],
  ['learning', '学习系统', 6, '恢复雅思学习闭环，整合阅读、知识库和职业学习'],
  ['life_sop', '生活 SOP', 5, '先固化体检、旅行、购物补货等高频流程'],
  ['inventory', '物品库存', 3, '先从补剂、医美护理品、宠物用品、证件建立起始库存'],
  ['finance', '财务管理', 7, '建立预算、订阅、保险和投资预实对比'],
  ['relationships', '关系维护', 4, '建立重要关系、宠物照护和边界能量记录'],
  ['reviews', '复盘系统', 4, '建立每周9模块评分、预实对比和下周三件事'],
  ['decisions', '决策记录', 5, '把投资、移民、副业、医美等选择沉淀成决策台账']
];

const moduleOrder = moduleSeeds.map(([moduleKey]) => moduleKey);

let currentUser = null;
let inboxCache = [];
let latestModuleStates = [];
let latestActiveTasks = [];
let latestTodayTasks = [];
let todayTaskIndex = 0;
let todayTaskSettling = false;
const TASK_SETTLE_MS = 550;
let todayTaskSettleTimer = null;
let latestInventoryItems = [];
let latestInventoryCount = 0;
let latestHealthLogs = [];
let localAgentConnected = false;
let localAgentProcessing = false;

const $ = (id) => document.getElementById(id);

function setMsg(id, text) {
  const element = $(id);
  if (element) element.textContent = text || '';
}

function showAuthed(isAuthed) {
  $('authView').classList.toggle('hidden', isAuthed);
  $('appView').classList.toggle('hidden', !isAuthed);
  $('logoutBtn').classList.toggle('hidden', !isAuthed);
  $('topNav').classList.toggle('hidden', !isAuthed);
  $('bottomNav').classList.toggle('hidden', !isAuthed);
  if (isAuthed) showPage('homePage');
}

function showPage(pageId) {
  document.querySelectorAll('.page-view').forEach((section) => {
    section.classList.toggle('hidden', section.id !== pageId);
    section.classList.toggle('active-view', section.id === pageId);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function markLoginFresh() {
  localStorage.setItem(LOGIN_TIME_KEY, String(Date.now()));
}

function isLoginFresh() {
  const loginAt = Number(localStorage.getItem(LOGIN_TIME_KEY) || 0);
  return Boolean(loginAt) && Date.now() - loginAt <= SESSION_TTL_MS;
}

async function signUp() {
  setMsg('authMsg', '注册中...');
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return setMsg('authMsg', error.message);
  if (data.user && data.session) {
    markLoginFresh();
    await handleSession(data.session);
    setMsg('authMsg', '注册成功');
  } else {
    setMsg('authMsg', '注册成功，请按 Supabase 邮件设置完成验证后再登录。');
  }
}

async function login() {
  setMsg('authMsg', '登录中...');
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return setMsg('authMsg', error.message);
  markLoginFresh();
  await handleSession(data.session);
}

async function logout() {
  localStorage.removeItem(LOGIN_TIME_KEY);
  await supabase.auth.signOut();
  currentUser = null;
  showAuthed(false);
}

async function handleSession(session) {
  currentUser = session?.user || null;
  if (currentUser && !isLoginFresh()) {
    await logout();
    setMsg('authMsg', '登录已超过 3 天，请重新登录。');
    return;
  }

  showAuthed(!!currentUser);
  if (currentUser) {
    await checkLocalAgentBridge();
    await ensureProfile();
    await ensureModuleStates();
    await refreshAll();
  }
}

async function ensureProfile() {
  const { error } = await supabase.from('profiles').upsert({
    user_id: currentUser.id,
    display_name: currentUser.email,
    timezone: 'Asia/Shanghai'
  }, { onConflict: 'user_id' });
  if (error) console.warn('profile seed failed', error);
}

async function ensureModuleStates() {
  const { data, error } = await supabase
    .from('module_states')
    .select('module_key')
    .eq('user_id', currentUser.id)
    .limit(1);
  if (error) return console.warn('module check failed', error);
  if (data && data.length) return;

  const rows = moduleSeeds.map(([module_key, module_name, score, current_focus]) => ({
    user_id: currentUser.id,
    module_key,
    module_name,
    score,
    current_focus,
    status: 'active'
  }));
  const { error: insertError } = await supabase.from('module_states').insert(rows);
  if (insertError) console.warn('module seed failed', insertError);
}

function guessModule(text) {
  if (/买|用完|过期|库存|放在|证件|药|面膜|补剂|数量/.test(text)) return 'inventory';
  if (/任务|待办|计划|目标|下一步|项目|核心事|deadline|截止/.test(text)) return 'tasks';
  if (/出差|旅行|搬家|体检流程|报销|购物|清洁/.test(text)) return 'life_sop';
  if (/睡眠|运动|体重|用药|体检|脱发|饮食|维生素|补剂|熔断|修复/.test(text)) return 'health';
  if (/账单|订阅|预算|资产|保险|投资|支出|定投/.test(text)) return 'finance';
  if (/雅思|课程|书|笔记|复习|阅读|知识/.test(text)) return 'learning';
  if (/家人|朋友|纪念日|礼物|沟通|宠物|圆圆|团团|甜甜/.test(text)) return 'relationships';
  if (/决定|选择|备选|取舍|为什么|复盘/.test(text)) return 'decisions';
  return 'reviews';
}

function updateAgentBridgeUi() {
  const note = $('agentBridgeNote');
  const button = $('quickSaveBtn');
  if (button) button.innerHTML = '↗ 提交';
  if (!note) return;
  note.classList.toggle('hidden', localAgentConnected);
  note.textContent = localAgentConnected ? '' : '未接入Agent 暂计入缓存记录';
}

async function checkLocalAgentBridge() {
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    localAgentConnected = false;
    updateAgentBridgeUi();
    return false;
  }
  try {
    const response = await fetch('/agent/context', { method: 'GET' });
    const result = response.ok ? await response.json() : null;
    localAgentConnected = Boolean(result?.has_access_token);
  } catch {
    localAgentConnected = false;
  }
  updateAgentBridgeUi();
  return localAgentConnected;
}

function moduleLabel(moduleKey) {
  const labels = {
    inventory: '物品库存',
    tasks: '个人任务',
    health: '健康管理',
    finance: '财务管理',
    learning: '学习系统',
    relationships: '关系维护',
    decisions: '决策记录',
    reviews: '复盘系统',
    life_sop: '生活 SOP',
  };
  return labels[moduleKey] || moduleKey || '未归类';
}

function formatDueDateLabel(dueDate) {
  if (!dueDate) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + 'T00:00:00');
  const diff = Math.round((due - today) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return dueDate;
}

function formatAgentProcessTip(result) {
  const records = (result.processed || []).flatMap(item => item.applied_records || []);
  if (!records.length) return 'Agent 已检查缓存，目前没有新的可拆解记录。';

  const groups = records.reduce((acc, record) => {
    const moduleKey = record.module || 'unknown';
    acc[moduleKey] ||= [];
    acc[moduleKey].push(record);
    return acc;
  }, {});

  const parts = Object.entries(groups).map(([moduleKey, moduleRecords]) => {
    const details = moduleRecords
      .map(record => {
        const due = record.due_date ? '，' + formatDueDateLabel(record.due_date) : '';
        return record.title ? record.title + due : '';
      })
      .filter(Boolean)
      .slice(0, 2)
      .join('；');
    return moduleLabel(moduleKey) + ' +' + moduleRecords.length + (details ? '（' + details + '）' : '');
  });

  return '已拆解并写入：' + parts.join('；') + '。';
}

async function requestLocalAgentProcessing() {
  if (!localAgentConnected || localAgentProcessing) return;
  localAgentProcessing = true;
  try {
    const response = await fetch('/agent/process', { method: 'POST' });
    if (response.ok) {
      const result = await response.json();
      if (result.processed_count > 0) {
        setMsg('quickMsg', formatAgentProcessTip(result));
        await refreshAll();
      }
    } else if (response.status === 404) {
      localAgentConnected = false;
      updateAgentBridgeUi();
    }
  } catch (error) {
    console.warn('local agent process failed', error);
  } finally {
    localAgentProcessing = false;
  }
}

async function syncLocalAgentContext(rows) {
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    localAgentConnected = false;
    updateAgentBridgeUi();
    return;
  }
  if (!currentUser) return;
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return;
    const response = await fetch('/agent/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supabase_url: SUPABASE_URL,
        publishable_key: SUPABASE_PUBLISHABLE_KEY,
        user_id: currentUser.id,
        access_token: accessToken,
        rows,
      }),
    });
    const result = response.ok ? await response.json() : null;
    localAgentConnected = Boolean(result?.has_access_token);
    updateAgentBridgeUi();
    if (localAgentConnected && rows.length) await requestLocalAgentProcessing();
  } catch (error) {
    localAgentConnected = false;
    updateAgentBridgeUi();
    console.warn('local agent sync failed', error);
  }
}

async function saveQuick() {
  const rawText = $('quickInput').value.trim();
  if (!rawText) return;
  setMsg('quickMsg', '保存中...');
  const moduleGuess = guessModule(rawText);
  const { error } = await supabase.from('inbox_events').insert({
    user_id: currentUser.id,
    source: 'web-pwa',
    raw_text: rawText,
    module_guess: moduleGuess,
    related_modules: [moduleGuess],
    status: 'pending',
    structured_json: {
      local_guess: moduleGuess,
      cache_layer: true,
      agent_status: 'waiting_for_agent',
      destination_log: []
    }
  });
  if (error) return setMsg('quickMsg', error.message);
  $('quickInput').value = '';
  setMsg('quickMsg', localAgentConnected ? '已提交，Agent 正在结构化拆解。' : '已保存到缓存记录。未接入 Agent 时暂不结构化。');
  await refreshAll();
}

async function refreshAll() {
  await Promise.all([
    loadInbox(),
    loadTasks(),
    loadInventory(),
    loadHealthLogs()
  ]);
  await loadModules();
}

async function loadModules() {
  const { data, error } = await supabase
    .from('module_states')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: true });
  if (error) return console.warn(error);

  const orderedModules = [...data].sort((a, b) => {
    const aIndex = moduleOrder.indexOf(a.module_key);
    const bIndex = moduleOrder.indexOf(b.module_key);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });
  latestModuleStates = orderedModules;
  $('modulesGrid').innerHTML = orderedModules.map(row => `
    <button class="module-card" type="button" data-module-key="${row.module_key}">
      <div class="module-head">
        <div><div class="row-title">${escapeHtml(row.module_name)}</div></div>
        <div class="score">${row.score}/10</div>
      </div>
      <div class="bar"><div class="fill" style="width:${Number(row.score || 0) * 10}%"></div></div>
      <div class="module-attention">
        <span>亟待关注</span>
        <strong>${escapeHtml(getModuleAttention(row))}</strong>
      </div>
      <span class="open-module">进入模块</span>
    </button>
  `).join('');

  document.querySelectorAll('[data-module-key]').forEach((card) => {
    card.addEventListener('click', () => openModulePage(card.dataset.moduleKey));
  });
}
async function loadInbox() {
  const { data, error } = await supabase
    .from('inbox_events')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) return console.warn(error);

  inboxCache = data;
  const cacheRows = data.filter(row => ['pending', 'needs_review', 'processing', 'processed'].includes(row.status));
  renderPendingQueue(cacheRows);
  syncLocalAgentContext(cacheRows.filter(row => row.status !== 'processed'));

  $('inboxList').innerHTML = data.length ? data.slice(0, 8).map(row => `
    <div class="row">
      <div class="row-title">${escapeHtml(row.raw_text)}</div>
      <div class="row-meta">${row.module_guess || '未分类'} · ${formatInboxStatus(row.status)} · ${new Date(row.created_at).toLocaleString()}</div>
    </div>
  `).join('') : '<div class="row empty-row">暂无记录。先写下今天的核心事。</div>';
}

function renderPendingQueue(rows) {
  const activeRows = rows.filter(row => row.status !== 'processed');
  $('cacheCount').textContent = `${activeRows.length} 条待处理`;
  if (!rows.length) {
    $('pendingQueue').innerHTML = '<div class="cache-empty">缓存记录是空的。你可以随时随地记录，之后再统一结构化。</div>';
    return;
  }

  $('pendingQueue').innerHTML = rows.slice(0, 16).map(row => {
    const destination = getDestinationText(row);
    return `
      <div class="cache-item ${row.status === 'processed' ? 'processed' : ''}">
        <div>
          <strong>${escapeHtml(row.raw_text)}</strong>
          <span>${new Date(row.created_at).toLocaleString()} · ${formatInboxStatus(row.status)} · 预判：${row.module_guess || '待判断'}</span>
          <small>${destination}</small>
        </div>
        <em>${row.status === 'processed' ? '可清空' : '待处理'}</em>
      </div>
    `;
  }).join('');
}

function getDestinationText(row) {
  const result = row.structured_json?.apply_result;
  if (result?.table) return `去处：${result.table}`;
  if (row.status === 'processed') return '去处：已归档，等待确认清空';
  return '去处：等待 Agent 或手动归类';
}

function formatInboxStatus(status) {
  const statusMap = {
    pending: '待结构化',
    processing: '处理中',
    needs_review: '待复核',
    processed: '已归档'
  };
  return statusMap[status] || status || '待结构化';
}

async function clearProcessedCache() {
  const processedIds = inboxCache.filter(row => row.status === 'processed').map(row => row.id);
  if (!processedIds.length) return setMsg('quickMsg', '没有可清空的已归档缓存记录。');
  const { error } = await supabase
    .from('inbox_events')
    .update({ status: 'archived_cache' })
    .in('id', processedIds)
    .eq('user_id', currentUser.id);
  if (error) return setMsg('quickMsg', error.message);
  setMsg('quickMsg', `已清空 ${processedIds.length} 条已归档缓存记录。`);
  await refreshAll();
}

async function loadTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('due_date', { ascending: true })
    .limit(30);
  if (error) return console.warn(error);

  const activeTasks = data.filter(row => row.status !== 'done');
  latestActiveTasks = activeTasks;
  const todayTasks = activeTasks.filter(isDueToday).sort(compareTaskPriority);
  renderTodayCoreTask(todayTasks);
}

function getModuleAttention(moduleState) {
  const attentionMap = {
    tasks: getTaskAttention,
    health: getHealthAttention,
    learning: getLearningAttention,
    life_sop: getLifeSopAttention,
    inventory: getInventoryAttention,
    finance: getFinanceAttention,
    relationships: getRelationshipAttention,
    reviews: getReviewAttention,
    decisions: getDecisionAttention
  };
  const resolver = attentionMap[moduleState.module_key];
  return resolver ? resolver(moduleState) : getFallbackAttention(moduleState);
}

function getTaskAttention() {
  const todayCount = latestActiveTasks.filter(isDueToday).length;
  if (todayCount) return `今天有 ${todayCount} 个任务 deadline`;

  const overdueCount = latestActiveTasks.filter(task => task.due_date && daysUntil(task.due_date) < 0).length;
  if (overdueCount) return `${overdueCount} 个任务已超期，建议先减压处理`;

  const upcoming = latestActiveTasks
    .filter(task => task.due_date && daysUntil(task.due_date) >= 0 && daysUntil(task.due_date) <= 7)
    .sort((a, b) => daysUntil(a.due_date) - daysUntil(b.due_date));
  if (upcoming.length) return `${upcoming[0].title} 还有 ${daysUntil(upcoming[0].due_date)} days`;

  return '暂无今日 deadline，保持低压推进';
}

function getInventoryAttention() {
  const expiring = getInventoryExpiryAlerts(30);
  if (expiring.length) {
    const first = expiring[0];
    return `${first.name} 还有 ${first.days} days 过期`;
  }
  if (latestInventoryCount) return `有 ${latestInventoryCount} 类库存，暂无近30天过期提醒`;
  return '库存货架已准备好，等待第一批物品记录';
}

function getHealthAttention(moduleState) {
  const abnormal = latestHealthLogs.find(row => /异常|尿蛋白|蛋白\+|疼|痛|熬夜|失眠|疲惫|高压|低|高|炎|过敏|不适|风险/.test(row.summary || ''));
  if (abnormal) return explainHealthSignal(abnormal.summary);
  if (latestHealthLogs[0]) return `最近记录：${latestHealthLogs[0].summary}`;
  return getFallbackAttention(moduleState, '暂无异常指标，先保持睡眠和补剂节奏');
}

function explainHealthSignal(summary) {
  const text = String(summary || '');
  const rules = [
    [/尿蛋白|蛋白\+/, '尿蛋白异常：注意尿路感染、运动后波动或肾脏压力，建议复查尿常规'],
    [/尿酸/, '尿酸异常：注意饮水、嘌呤摄入和关节疼痛信号'],
    [/血糖|糖化|HbA1c/i, '血糖指标异常：关注餐后血糖、睡眠压力和碳水节奏'],
    [/甘油三酯|胆固醇|低密度|LDL/i, '血脂指标异常：关注饮食油脂、运动和复查时间'],
    [/维生素D|维D|25-OH/i, '维D偏低：关注补剂剂量、日照和复查节奏'],
    [/铁蛋白|贫血|血红蛋白/, '铁相关指标异常：关注疲劳、经期和补铁节奏'],
    [/肝|ALT|AST/i, '肝功能信号异常：关注熬夜、饮酒、药物和复查'],
    [/肾|肌酐|尿素/, '肾功能信号异常：关注饮水、用药和复查']
  ];
  const matched = rules.find(([pattern]) => pattern.test(text));
  return matched ? matched[1] : `关注：${text}`;
}

function getLearningAttention(moduleState) {
  const task = getUpcomingModuleTask('learning');
  if (task) return task;
  return getFallbackAttention(moduleState, '学习进度待接入；后续关注中断 days 与 delay');
}

function getLifeSopAttention(moduleState) {
  const task = getUpcomingModuleTask('life_sop');
  if (task) return task;
  return getFallbackAttention(moduleState, '近期流程、旅行、购物价格提醒待接入');
}

function getFinanceAttention(moduleState) {
  const task = getUpcomingModuleTask('finance');
  if (task) return task;
  return getFallbackAttention(moduleState, '预算预实对比待接入；关注超期与结余');
}

function getRelationshipAttention(moduleState) {
  const task = getUpcomingModuleTask('relationships');
  if (task) return task;
  return getFallbackAttention(moduleState, '纪念日、宠物疫苗和边界事项待接入');
}

function getReviewAttention(moduleState) {
  const task = getUpcomingModuleTask('reviews');
  if (task) return task;
  return getFallbackAttention(moduleState, '复盘关键词待生成；关注高压与减负信号');
}

function getDecisionAttention(moduleState) {
  const task = getUpcomingModuleTask('decisions');
  if (task) return task;
  return getFallbackAttention(moduleState, '决策复盘和预演待接入；保留关键提醒');
}

function getUpcomingModuleTask(moduleKey) {
  const moduleTasks = latestActiveTasks
    .filter(task => task.module_key === moduleKey && task.due_date)
    .sort((a, b) => daysUntil(a.due_date) - daysUntil(b.due_date));
  if (!moduleTasks.length) return '';
  const first = moduleTasks[0];
  const days = daysUntil(first.due_date);
  if (days < 0) return `${first.title} 已超期 ${Math.abs(days)} days`;
  if (days === 0) return `${first.title} 今天要处理`;
  return `${first.title} 还有 ${days} days`;
}

function getFallbackAttention(moduleState, defaultText = '暂无亟待关注事项') {
  return moduleState.risk_summary || moduleState.current_focus || defaultText;
}

function getInventoryExpiryAlerts(windowDays) {
  return latestInventoryItems.flatMap(item => (item.inventory_batches || [])
    .filter(batch => batch.expiry_date)
    .map(batch => ({
      name: item.name,
      days: daysUntil(batch.expiry_date),
      quantity: Number(batch.quantity || 0),
      unit: item.unit || batch.unit || ''
    }))
  ).filter(alert => alert.days >= 0 && alert.days <= windowDays)
    .sort((a, b) => a.days - b.days);
}

function renderTodayCoreTask(tasks) {
  $('todaySection').classList.toggle('hidden', !tasks.length);
  latestTodayTasks = tasks;
  if (!tasks.length) {
    $('todayCoreTask').innerHTML = '';
    todayTaskIndex = 0;
    return;
  }

  if (todayTaskIndex >= tasks.length) todayTaskIndex = 0;
  $('todayCoreTask').innerHTML = `
    <div class="task-deck ${tasks.length > 1 ? 'is-shuffleable' : ''} ${todayTaskSettling ? 'is-settling' : ''}" role="button" tabindex="0" aria-label="今天任务纸牌，点击切换下一张">
      ${tasks.map((task, index) => renderTodayTaskSlip(task, index, tasks.length)).join('')}
    </div>
    ${tasks.length > 1 ? `<div class="core-more">点击今日任务区任意位置，立刻切换下一张 · 第 ${todayTaskIndex + 1} / ${tasks.length} 张</div>` : ''}
  `;
}

function renderTodayTaskSlip(task, index, total) {
  const displayPriority = `P${index + 1}`;
  return `
    <div class="task-slip ${getTodayTaskSlipClass(index, total)}" aria-hidden="${index !== todayTaskIndex}">
      <span class="priority">${displayPriority}</span>
      <div>
        <strong>${escapeHtml(task.title)}</strong>
        <p>${escapeHtml(task.next_action || '说明：这是今天优先级最高、需要先完成的核心事。')}</p>
      </div>
    </div>
  `;
}

function getTodayTaskSlipClass(index, total) {
  if (index === todayTaskIndex) return 'is-active';
  if (index === (todayTaskIndex + 1) % total) return 'is-behind-one';
  if (index === (todayTaskIndex + 2) % total) return 'is-behind-two';
  return 'is-behind-many';
}

function cycleTodayTask() {
  if (latestTodayTasks.length <= 1) return;
  if (todayTaskSettleTimer) clearTimeout(todayTaskSettleTimer);
  todayTaskIndex = (todayTaskIndex + 1) % latestTodayTasks.length;
  todayTaskSettling = true;
  renderTodayCoreTask(latestTodayTasks);
  todayTaskSettleTimer = setTimeout(() => {
    todayTaskSettling = false;
    $('todayCoreTask')?.querySelector('.task-deck')?.classList.remove('is-settling');
  }, TASK_SETTLE_MS);
}

function handleTaskDeckPointer(event) {
  const todaySection = event.target.closest?.('#todaySection');
  if (!todaySection || $('todaySection')?.classList.contains('hidden')) return;
  event.preventDefault();
  cycleTodayTask();
}

function handleTaskDeckKeydown(event) {
  if (!['Enter', ' '].includes(event.key)) return;
  const deck = event.target.closest?.('.task-deck');
  if (!deck || !$('todayCoreTask')?.contains(deck)) return;
  event.preventDefault();
  cycleTodayTask();
}

function compareTaskPriority(a, b) {
  return priorityValue(a.priority) - priorityValue(b.priority);
}

function priorityValue(priority) {
  const valueMap = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return valueMap[String(priority || 'P2').toUpperCase()] ?? 2;
}

function openModulePage(moduleKey) {
  const moduleState = latestModuleStates.find(row => row.module_key === moduleKey);
  if (!moduleState) return;

  $('modulePageEyebrow').textContent = 'Personal SOP / Module';
  $('modulePageTitle').textContent = moduleState.module_name;
  $('modulePageHint').textContent = moduleState.current_focus || '这个模块的专属页面已建立。你后面给具体页面要求后，我会继续补充模块化交互。';
  $('modulePageBody').innerHTML = renderModuleBody(moduleState);
  showPage('modulePage');
}

function renderModuleBody(moduleState) {
  if (moduleState.module_key === 'tasks') {
    return latestActiveTasks.length ? `
      <div class="module-page-list">
        ${latestActiveTasks.map(renderTaskRow).join('')}
      </div>
    ` : '<div class="module-empty">个人任务模块已准备好。当前没有任务数据。</div>';
  }

  if (moduleState.module_key === 'inventory') {
    return latestInventoryItems.length ? renderInventoryShelves(latestInventoryItems) : '<div class="module-empty">物品库存模块已准备好。当前没有库存数据。</div>';
  }

  if (moduleState.module_key === 'health') {
    return latestHealthLogs.length ? `
      <div class="module-page-list">
        ${latestHealthLogs.map(renderHealthLogRow).join('')}
      </div>
    ` : '<div class="module-empty">健康管理模块已准备好。当前没有健康记录。</div>';
  }

  return `
    <div class="module-placeholder">
      <strong>${escapeHtml(moduleState.module_name)} 页面已创建</strong>
      <span>下一步可以为这个模块定制：数据源、记录方式、展示样式、风险提示和评分逻辑。</span>
    </div>
  `;
}
function renderTaskRow(row) {
  return `
    <div class="row">
      <div class="row-title">${escapeHtml(row.title)}</div>
      <div class="row-meta">${escapeHtml(row.module_key || '未归类')} · ${escapeHtml(row.priority || 'P2')} · ${escapeHtml(row.status || 'todo')} · ${row.due_date || '无截止日期'}</div>
    </div>
  `;
}

function isDueToday(task) {
  if (!task.due_date) return false;
  return daysUntil(task.due_date) === 0;
}

function daysUntil(dateString) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(`${dateString}T00:00:00`);
  return Math.ceil((dueDate - today) / 86400000);
}

async function loadInventory() {
  const { data, error, count } = await supabase
    .from('items')
    .select('*, inventory_batches(*)', { count: 'exact' })
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return console.warn(error);
  latestInventoryItems = data || [];
  latestInventoryCount = count || latestInventoryItems.length;
}

function renderInventoryShelves(items) {
  const shelves = {};
  items.forEach(item => {
    const shelf = item.shelf_name || item.category || '未分类货架';
    shelves[shelf] ||= [];
    shelves[shelf].push(item);
  });
  return Object.entries(shelves).map(([shelf, shelfItems]) => `
    <div class="shelf">
      <h3>${escapeHtml(shelf)}</h3>
      <div class="products">
        ${shelfItems.map(item => {
          const total = (item.inventory_batches || []).reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
          const firstBatch = (item.inventory_batches || [])[0];
          return `<div class="product">
            <div class="row-meta">${escapeHtml(item.brand || '未填品牌')}</div>
            <div class="row-title">${escapeHtml(item.name)}</div>
            <div class="row-meta">${escapeHtml(item.effect || item.spec || item.category || '')}</div>
            <strong>${total} ${escapeHtml(item.unit || '')}</strong><br />
            <span class="badge">${firstBatch?.expiry_date || '无过期信息'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

async function loadHealthLogs() {
  const { data, error } = await supabase
    .from('health_logs')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('logged_at', { ascending: false })
    .limit(30);
  if (error) return console.warn(error);
  latestHealthLogs = data || [];
}

function renderHealthLogRow(row) {
  return `
    <div class="row">
      <div class="row-title">${escapeHtml(row.summary)}</div>
      <div class="row-meta">${escapeHtml(row.log_type || 'note')} · ${new Date(row.logged_at || row.created_at).toLocaleString()}</div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

$('signupBtn').addEventListener('click', signUp);
$('loginBtn').addEventListener('click', login);
$('logoutBtn').addEventListener('click', logout);
$('quickSaveBtn').addEventListener('click', saveQuick);
$('clearProcessedBtn').addEventListener('click', clearProcessedCache);
document.getElementById('moduleBackBtn').addEventListener('click', () => showPage('homePage'));
document.querySelectorAll('[data-page]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showPage(link.dataset.page);
  });
});
$('quickInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  saveQuick();
});
document.addEventListener('pointerup', handleTaskDeckPointer);
document.addEventListener('keydown', handleTaskDeckKeydown);

const { data } = await supabase.auth.getSession();
await handleSession(data.session);

supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.user && !localStorage.getItem(LOGIN_TIME_KEY)) markLoginFresh();
  handleSession(session);
});







