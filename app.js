import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://djfkixzsvllnjwmhdrzs.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_18lDR9aUrx5KXAKErPVhlQ_k9TWp3L8';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const moduleSeeds = [
  ['inventory', '物品库存', 3, '先从补剂、医美护理品、宠物用品、证件建立起始库存'],
  ['tasks', '个人任务', 5, '把所有模块产生的下一步统一收口成任务池'],
  ['life_sop', '生活 SOP', 5, '先固化体检、旅行、购物补货等高频流程'],
  ['health', '健康管理', 7, '结构化体检指标、补剂轮换、运动恢复和代谢观察'],
  ['finance', '财务管理', 7, '建立预算、订阅、保险和投资预实对比'],
  ['learning', '学习系统', 6, '恢复雅思学习闭环，整合阅读、知识库和职业学习'],
  ['relationships', '关系维护', 4, '建立重要关系、宠物照护和边界能量记录'],
  ['decisions', '决策记录', 5, '把投资、移民、副业、医美等选择沉淀成决策台账'],
  ['reviews', '复盘系统', 4, '建立每周9模块评分、预实对比和下周三件事']
];

let currentUser = null;

const $ = (id) => document.getElementById(id);

function setMsg(id, text) {
  $(id).textContent = text || '';
}

function showAuthed(isAuthed) {
  $('authView').classList.toggle('hidden', isAuthed);
  $('appView').classList.toggle('hidden', !isAuthed);
  $('logoutBtn').classList.toggle('hidden', !isAuthed);
}

async function signUp() {
  setMsg('authMsg', '注册中...');
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return setMsg('authMsg', error.message);
  if (data.user && data.session) {
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
  await handleSession(data.session);
}

async function logout() {
  await supabase.auth.signOut();
  currentUser = null;
  showAuthed(false);
}

async function handleSession(session) {
  currentUser = session?.user || null;
  showAuthed(!!currentUser);
  if (currentUser) {
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
  if (/任务|待办|计划|目标|下一步|项目/.test(text)) return 'tasks';
  if (/出差|旅行|搬家|体检流程|报销|购物|清洁/.test(text)) return 'life_sop';
  if (/睡眠|运动|体重|用药|体检|脱发|饮食|维生素|补剂/.test(text)) return 'health';
  if (/账单|订阅|预算|资产|保险|投资|支出|定投/.test(text)) return 'finance';
  if (/雅思|课程|书|笔记|复习|阅读|知识/.test(text)) return 'learning';
  if (/家人|朋友|纪念日|礼物|沟通|宠物|圆圆|团团|甜甜/.test(text)) return 'relationships';
  if (/决定|选择|备选|取舍|为什么|复盘/.test(text)) return 'decisions';
  return 'reviews';
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
    structured_json: { local_guess: moduleGuess }
  });
  if (error) return setMsg('quickMsg', error.message);
  $('quickInput').value = '';
  setMsg('quickMsg', '已同步到云端 inbox。');
  await refreshAll();
}

async function refreshAll() {
  await Promise.all([
    loadModules(),
    loadInbox(),
    loadTasks(),
    loadInventory()
  ]);
}

async function loadModules() {
  const { data, error } = await supabase
    .from('module_states')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: true });
  if (error) return console.warn(error);
  const avg = data.length ? (data.reduce((sum, row) => sum + Number(row.score || 0), 0) / data.length).toFixed(1) : '0';
  $('moduleAvg').textContent = avg;
  $('modulesGrid').innerHTML = data.map(row => `
    <div class="module-card">
      <div class="module-head">
        <div><div class="row-title">${row.module_name}</div><div class="row-meta">${row.current_focus || ''}</div></div>
        <div class="score">${row.score}/10</div>
      </div>
      <div class="bar"><div class="fill" style="width:${Number(row.score || 0) * 10}%"></div></div>
      <div class="row-meta">${row.risk_summary || '暂无风险摘要'}</div>
    </div>
  `).join('');
}

async function loadInbox() {
  const { data, error } = await supabase
    .from('inbox_events')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) return console.warn(error);
  $('pendingCount').textContent = data.filter(row => row.status === 'pending').length;
  $('inboxList').innerHTML = data.length ? data.map(row => `
    <div class="row">
      <div class="row-title">${escapeHtml(row.raw_text)}</div>
      <div class="row-meta">${row.module_guess || '未分类'} · ${row.status} · ${new Date(row.created_at).toLocaleString()}</div>
    </div>
  `).join('') : '<div class="row">暂无记录</div>';
}

async function loadTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) return console.warn(error);
  $('taskCount').textContent = data.filter(row => row.status !== 'done').length;
  $('taskList').innerHTML = data.length ? data.map(row => `
    <div class="row">
      <div class="row-title">${escapeHtml(row.title)}</div>
      <div class="row-meta">${row.module || row.module_key || '未归类'} · ${row.priority || 'P2'} · ${row.status || 'todo'}</div>
    </div>
  `).join('') : '<div class="row">暂无任务。先用一句话记录创建 inbox，后续 Agent 会生成任务。</div>';
}

async function loadInventory() {
  const { data, error } = await supabase
    .from('items')
    .select('*, inventory_batches(*)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return console.warn(error);
  if (!data.length) {
    $('inventoryShelves').innerHTML = '<div class="row">暂无库存。先从一句话记录开始，例如“买了两盒可复美面膜，2027年3月过期”。</div>';
    return;
  }
  const shelves = {};
  data.forEach(item => {
    const shelf = item.shelf_name || item.category || '未分类货架';
    shelves[shelf] ||= [];
    shelves[shelf].push(item);
  });
  $('inventoryShelves').innerHTML = Object.entries(shelves).map(([shelf, items]) => `
    <div class="shelf">
      <h3>${shelf}</h3>
      <div class="products">
        ${items.map(item => {
          const total = (item.inventory_batches || []).reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
          const firstBatch = (item.inventory_batches || [])[0];
          return `<div class="product">
            <div class="row-meta">${escapeHtml(item.brand || '未填品牌')}</div>
            <div class="row-title">${escapeHtml(item.name)}</div>
            <div class="row-meta">${escapeHtml(item.effect || item.spec || '')}</div>
            <strong>${total} ${item.unit || ''}</strong><br />
            <span class="badge">${firstBatch?.expiry_date || '无过期信息'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
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
$('quickInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveQuick();
});

const { data } = await supabase.auth.getSession();
await handleSession(data.session);

supabase.auth.onAuthStateChange((_event, session) => {
  handleSession(session);
});
