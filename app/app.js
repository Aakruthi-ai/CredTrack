/* CredTrack — single-page frontend (vanilla JS + Chart.js) */

/* ────────────── State ────────────── */
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  page: (location.hash.slice(1) || 'dashboard'),
  expenses: [],
  applications: [],
  streak: { current_streak: 0, longest_streak: 0 },
  charts: {},
  creditResult: null,   // latest /predict or /reassess answer
  currentPayload: null, // the application that produced it
  finalRound: false,    // true after the borderline "confirm details" step
  options: null,        // thresholds from /options (used by the score gauge)
};

const CATEGORIES = ['Food & Dining','Transport','Housing','Utilities','Shopping',
                    'Entertainment','Health','Education','Other'];

const CATEGORY_COLORS = {
  'Food & Dining':'#f97316','Transport':'#3b82f6','Housing':'#8b5cf6',
  'Utilities':'#06b6d4','Shopping':'#ec4899','Entertainment':'#f43f5e',
  'Health':'#10b981','Education':'#eab308','Other':'#64748b',
};

const INCOME_TYPES = ['Businessman','Commercial associate','Maternity leave',
                      'Pensioner','State servant','Student','Unemployed','Working'];

/* ────────────── Helpers ────────────── */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmtMoney = n => '$' + Number(n || 0).toLocaleString('en-US',
                       { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtDate = d => new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// created_at comes from the server in UTC (ends with Z); show it in the viewer's own time zone
const fmtDateTime = d => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => localDateStr(new Date());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, type = 'info') {
  const colors = { info: 'bg-slate-800', success: 'bg-emerald-600', error: 'bg-rose-600' };
  const el = document.createElement('div');
  el.className = `fixed bottom-6 right-6 px-5 py-3 rounded-xl text-white font-medium shadow-2xl z-50 animate-slideUp ${colors[type] || colors.info}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// Turn FastAPI's error shapes (string or list of validation errors) into one readable sentence
function errorText(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(e => {
      const field = (e.loc || []).filter(x => x !== 'body' && x !== 'history').join(' → ');
      const msg = String(e.msg || '').replace(/^Value error, /, '');
      return field && !msg.includes(field) ? `${field}: ${msg}` : msg;
    }).join('; ');
  }
  return JSON.stringify(detail);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/signup')) { logout(); return null; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data.detail || data));
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Request timed out. The backend server might be hanging or not running.');
    throw err;
  }
}

function destroyCharts() {
  if (typeof unmountDashboard3D === 'function') unmountDashboard3D();
  Object.values(state.charts).forEach(c => { try { c.destroy(); } catch (e) {} });
  state.charts = {};
}

/* ────────────── Auth ────────────── */
async function login(email, password) {
  const data = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (!data) return;
  state.token = data.token; state.user = data.user;
  localStorage.setItem('token', data.token);
  navigate('dashboard');
}
async function signup(email, password, fullName) {
  const data = await api('/auth/signup', { method: 'POST', body: { email, password, full_name: fullName } });
  if (!data) return;
  state.token = data.token; state.user = data.user;
  localStorage.setItem('token', data.token);
  navigate('dashboard');
}
function logout() {
  state.token = null; state.user = null;
  state.creditResult = null; state.currentPayload = null; state.finalRound = false;
  localStorage.removeItem('token');
  location.hash = 'login'; render();
}

/* ────────────── Router ────────────── */
async function navigate(page) {
  state.page = page;
  if (location.hash.slice(1) !== page) location.hash = page;
  await render();
}
window.addEventListener('hashchange', () => {
  const p = location.hash.slice(1) || 'dashboard';
  if (p !== state.page) { state.page = p; render(); }
});

async function render() {
  destroyCharts();
  const app = $('#app');

  if (!state.token) {
    if (!['login','signup'].includes(state.page)) state.page = 'login';
    app.innerHTML = renderAuth();
    return bindAuth();
  }
  if (!state.user) {
    app.innerHTML = `<div class="min-h-screen flex items-center justify-center">
      <div class="w-12 h-12 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin"></div>
    </div>`;
    try { state.user = await api('/auth/me'); } catch { return logout(); }
    if (!state.user) return;
  }
  if (!['dashboard','expenses','credit','profile'].includes(state.page)) state.page = 'dashboard';

  try {
    // The nav bar shows the streak on every page, so always refresh it
    const jobs = [api('/streak')];
    if (['dashboard','expenses'].includes(state.page)) jobs.push(api('/expenses'));
    if (state.page === 'dashboard') jobs.push(api('/applications'));
    if (state.page === 'dashboard' && !state.options) { try { state.options = await api('/options'); } catch (e) { /* gauge falls back to 10% / 15% */ } }
    const [streak, expenses, applications] = await Promise.all(jobs);
    state.streak = streak || { current_streak: 0, longest_streak: 0 };
    if (expenses) state.expenses = expenses;
    if (applications) state.applications = applications;
  } catch (err) {
    toast(err.message, 'error');
  }
  if (!state.token) return;

  if (state.page === 'dashboard') {
    // The dashboard is a full-screen 3D story with its own header
    app.innerHTML = renderDashboard();
    window.scrollTo(0, 0);
  } else {
    app.innerHTML = renderNav() + `<main class="max-w-7xl mx-auto px-4 sm:px-6 py-8">${await renderPageContent()}</main>`;
    bindNav();
  }
  bindPage();
}

/* ────────────── Nav ────────────── */
function renderNav() {
  const links = [
    ['dashboard','Dashboard'], ['expenses','Expenses'],
    ['credit','Credit Check'], ['profile','Profile']
  ];
  const streak = state.streak.current_streak || 0;
  return `
  <header class="nx">
    <div class="nx-in">
      <a href="#dashboard" class="nx-logo"><i></i>CredTrack</a>
      <nav class="nx-links" aria-label="Pages">
        ${links.map(([k, label]) => `<a href="#${k}" class="${state.page === k ? 'active' : ''}"${state.page === k ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
      <div class="nx-right">
        <span class="nx-streak" title="Daily streak">${streak} ${streak === 1 ? 'day' : 'days'}</span>
        <span class="nx-user">${escapeHtml(state.user?.full_name || state.user?.email || '')}</span>
        <button id="logout-btn" type="button">Log out</button>
      </div>
    </div>
  </header>`;
}

function bindNav() {
  $('#logout-btn')?.addEventListener('click', logout);
}

/* Auth page */
function renderAuth() {
  const isSignup = state.page === 'signup';
  return `
  <div class="min-h-screen flex">
    <div class="hidden lg:flex lg:w-1/2 auth-art relative overflow-hidden">
      <div class="relative z-10 flex flex-col justify-center px-16 text-white">
        <div class="flex items-center gap-3 mb-10">
          <span class="nx-logo" style="font-size:24px"><i></i>CredTrack</span>
        </div>
        <h1 class="text-5xl font-extrabold leading-tight mb-4">Smart credit checks.<br/>Smarter money habits.</h1>
        <p class="text-lg text-brand-100 mb-10 max-w-md">Track expenses, build daily streaks, and get an explainable credit assessment — all in one place.</p>
      </div>
    </div>
    <div class="flex-1 flex items-center justify-center px-6 py-12">
      <div class="w-full max-w-md">
        <div class="lg:hidden flex items-center gap-3 mb-8">
          <span class="nx-logo"><i></i>CredTrack</span>
        </div>
        <h2 class="text-3xl font-extrabold mb-2">${isSignup ? 'Create your account' : 'Welcome back'}</h2>
        <p class="text-slate-500 mb-8">${isSignup ? 'Start tracking in under a minute.' : 'Log in to continue.'}</p>
        <form id="auth-form" class="space-y-4">
          ${isSignup ? `
          <div>
            <label class="block text-sm font-semibold mb-1.5">Full name</label>
            <input name="full_name" class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none transition" placeholder="Ada Lovelace" />
          </div>` : ''}
          <div>
            <label class="block text-sm font-semibold mb-1.5">Email</label>
            <input name="email" type="email" required class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none transition" placeholder="you@example.com" />
          </div>
          <div>
            <label class="block text-sm font-semibold mb-1.5">Password</label>
            <input name="password" type="password" required minlength="6" class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none transition" placeholder="••••••••" />
          </div>
          <div id="auth-error" class="hidden text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl p-3"></div>
          <button type="submit" class="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold shadow-sm hover:shadow-md transition active:scale-[.99]">
            ${isSignup ? 'Create account' : 'Log in'}
          </button>
          <p class="text-center text-sm text-slate-500">
            ${isSignup ? 'Already have an account?' : 'New here?'}
            <a href="#${isSignup ? 'login' : 'signup'}" class="text-brand-600 font-semibold hover:underline">
              ${isSignup ? 'Log in' : 'Create one'}
            </a>
          </p>
        </form>
      </div>
    </div>
  </div>`;
}
function bindAuth() {
  $('#auth-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const err = $('#auth-error');
    err.classList.add('hidden');
    try {
      if (state.page === 'signup') await signup(fd.get('email'), fd.get('password'), fd.get('full_name') || '');
      else                          await login(fd.get('email'), fd.get('password'));
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
}

/* ────────────── Page Router ────────────── */
async function renderPageContent() {
  switch (state.page) {
    case 'expenses':  return renderExpenses();
    case 'credit':    return renderCredit();
    case 'profile':   return renderProfile();
  }
}

function bindPage() {
  if (state.page === 'dashboard') mountDashboard3D();
  if (state.page === 'expenses') bindExpenses();
  if (state.page === 'credit') bindCredit();
  if (state.page === 'profile') bindProfile();
}

/* ────────────── Dashboard ────────────── */
function expensesInMonth(offset = 0) {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return state.expenses.filter(e => {
    const d = new Date(String(e.expense_date).slice(0, 10) + 'T00:00:00');
    return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth();
  });
}
const monthlyExpenses = () => expensesInMonth(0);
const sumOf = list => list.reduce((s, e) => s + e.amount, 0);

function decisionBadge(d) {
  return d === 'approved' ? 'bg-emerald-100 text-emerald-700' : d === 'borderline' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700';
}
const decisionLabel = d => d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
const DECISION_DOT = { approved: '#10b981', borderline: '#f59e0b', rejected: '#f43f5e' };

// Same formula the API uses, so the gauge zones always match the real decision thresholds
const scoreForRisk = p => Math.round(Math.min(900, Math.max(300, 700 + 50 * Math.log2(((1 - p) / p) / 9))));
const thresholds = () => (state.options && state.options.thresholds) || { approve_below: 0.10, reject_above: 0.15 };

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/* ---- numbers the dashboard needs ---- */
function dashboardStats() {
  const now = new Date();
  const monthly = monthlyExpenses();
  const total = sumOf(monthly), lastTotal = sumOf(expensesInMonth(-1));
  const budget = state.user?.monthly_budget || 0;
  const pct = budget > 0 ? Math.round((total / budget) * 100) : 0;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const projected = dayOfMonth > 0 ? (total / dayOfMonth) * daysInMonth : 0;

  const byDay = {};
  state.expenses.forEach(e => { const k = String(e.expense_date).slice(0, 10); byDay[k] = (byDay[k] || 0) + e.amount; });
  const last = n => Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (n - 1 - i)); return { date: d, key: localDateStr(d), amount: byDay[localDateStr(d)] || 0 }; });
  const week = last(7), fortnight = last(14);

  const cats = {};
  monthly.forEach(e => { cats[e.category] = (cats[e.category] || 0) + e.amount; });
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]);

  let health = null;
  if (budget > 0) {
    const savings = Math.max(0, (budget - total) / budget);
    health = Math.round(savings * 70 + Math.min(20, (state.streak.current_streak || 0) * 2) + Math.min(10, new Set(monthly.map(e => e.category)).size));
    health = Math.max(0, Math.min(100, health));
  }
  return { monthly, total, lastTotal, budget, pct, projected, dayOfMonth, week, fortnight, catList, health,
           loggedDays7: week.filter(d => d.amount > 0).length };
}

function emptyState(msg, link) {
  return `<div class="text-center py-10 text-slate-500">
    <div class="text-4xl mb-3">💸</div>
    <p class="text-sm">${msg}</p>
    <a href="#${link}" class="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline">Add one →</a>
  </div>`;
}

/* ────────────── Expenses ────────────── */
function renderExpenses() {
  const monthly = monthlyExpenses();
  const total = sumOf(monthly);

  return `
  <div class="space-y-6 animate-fadeIn">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-3xl font-extrabold text-slate-900">Expenses</h1>
        <p class="text-slate-500 mt-1">Log today's spending and keep your streak alive 🔥</p>
      </div>
      <div class="text-right">
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide">This month</div>
        <div class="text-2xl font-extrabold text-slate-900">${fmtMoney(total)}</div>
      </div>
    </header>

    <div class="grid lg:grid-cols-3 gap-6">
      <section class="bg-white rounded-2xl border border-slate-200 p-6">
        <h2 class="font-bold text-slate-900 mb-4">Add an expense</h2>
        <form id="expense-form" class="space-y-3">
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1">Amount</label>
            <input name="amount" type="number" step="0.01" min="0.01" required class="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" placeholder="0.00" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1">Category</label>
            <select name="category" class="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none bg-white">
              ${CATEGORIES.map(c => `<option>${c}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1">Description</label>
            <input name="description" maxlength="200" class="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" placeholder="Groceries" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1">Date</label>
            <input name="expense_date" type="date" required max="${todayStr()}" value="${todayStr()}" class="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
          </div>
          <button type="submit" class="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold shadow-sm transition">Log expense</button>
        </form>
      </section>

      <section class="lg:col-span-2 bg-white rounded-2xl border border-slate-200 p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold text-slate-900">All expenses</h2>
          <div class="text-xs text-slate-400 font-medium">${plural(state.expenses.length, 'entry', 'entries')}</div>
        </div>
        ${state.expenses.length === 0
          ? emptyState('Nothing here yet — log your first expense.', 'expenses')
          : `<ul id="expense-list" class="divide-y divide-slate-100 max-h-[520px] overflow-y-auto -mr-2 pr-2">
              ${state.expenses.map(e => `
                <li class="py-3 flex items-center justify-between group">
                  <div class="flex items-center gap-3 min-w-0">
                    <span class="w-9 h-9 rounded-lg flex items-center justify-center text-white text-xs font-bold" style="background:${CATEGORY_COLORS[e.category] || '#64748b'}">
                      ${escapeHtml(e.category.slice(0, 1))}
                    </span>
                    <div class="min-w-0">
                      <div class="font-semibold text-slate-800 truncate">${escapeHtml(e.description || e.category)}</div>
                      <div class="text-xs text-slate-500">${fmtDate(e.expense_date)} · ${escapeHtml(e.category)}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-3 ml-3">
                    <span class="font-bold text-slate-900">${fmtMoney(e.amount)}</span>
                    <button data-id="${e.id}" class="del-expense text-slate-300 hover:text-rose-500 transition text-lg" title="Delete">×</button>
                  </div>
                </li>`).join('')}
             </ul>`}
      </section>
    </div>
  </div>`;
}

function bindExpenses() {
  const form = $('#expense-form');
  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/expenses', { method: 'POST', body: {
          amount: Number(fd.get('amount')),
          category: fd.get('category'),
          description: fd.get('description'),
          expense_date: fd.get('expense_date')
        }});
        toast('Expense logged! Streak extended.', 'success');
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  $$('.del-expense').forEach(btn => {
    btn.addEventListener('click', async e => {
      if (!confirm('Delete this expense?')) return;
      try {
        await api(`/expenses/${e.currentTarget.dataset.id}`, { method: 'DELETE' });
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

/* ────────────── Credit Check ────────────── */
const INPUT_CLS = 'w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none mt-1';
const numField = (name, label, attrs, hint = '') => `
  <label class="block">
    <span class="text-xs font-semibold text-slate-600">${label}</span>
    <input name="${name}" type="number" ${attrs} class="${INPUT_CLS}" />
    ${hint ? `<span class="text-[11px] text-slate-400">${hint}</span>` : ''}
  </label>`;

const sliderField = (name, label, hint, value) => `
  <label class="block">
    <span class="text-xs font-semibold text-slate-600">${label}: <span id="${name}-val" class="font-bold text-brand-700">${value}%</span></span>
    <input name="${name}" id="${name}" type="range" min="0" max="100" step="1" value="${value}" class="w-full mt-2 accent-brand-600" />
    <span class="text-[11px] text-slate-400">${hint}</span>
  </label>`;

function contactBox(flag, inputName, inputId, label, placeholder, type, saved) {
  return `<div class="p-3 border border-slate-200 rounded-xl">
    <label class="flex items-center gap-3 cursor-pointer">
      <input type="checkbox" name="${flag}" ${saved ? 'checked' : ''} class="w-4 h-4 accent-brand-600 contact-toggle" data-target="${inputId}" />
      <span class="text-sm font-medium">${label}</span>
    </label>
    <input type="${type}" name="${inputName}" id="${inputId}" value="${escapeHtml(saved || '')}" placeholder="${placeholder}"
      class="${saved ? '' : 'hidden '}w-full px-4 py-2 mt-2 rounded-xl border border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
  </div>`;
}

function renderCredit() {
  const u = state.user || {};
  return `
  <div class="space-y-6 animate-fadeIn">
    <header>
      <h1 class="text-3xl font-extrabold text-slate-900">Explainable Credit Risk Assessment</h1>
      <p class="text-slate-500 mt-1">Answer a few questions. You get a risk estimate, a credit score from 300 to 900, a decision and plain-language reasons.</p>
    </header>

    <div class="flex gap-2 mb-4 border-b border-slate-200 pb-4 overflow-x-auto">
      <button type="button" class="px-4 py-2 rounded-lg font-semibold bg-brand-600 text-white shadow-sm whitespace-nowrap" id="tab-btn-form">1. Application</button>
      <button type="button" class="px-4 py-2 rounded-lg font-semibold text-slate-500 hover:bg-slate-100 whitespace-nowrap opacity-50 cursor-not-allowed" id="tab-btn-result" disabled>2. Result</button>
      <button type="button" class="px-4 py-2 rounded-lg font-semibold text-slate-500 hover:bg-slate-100 whitespace-nowrap opacity-50 cursor-not-allowed" id="tab-btn-stress" disabled>3. Stress test</button>
      <button type="button" class="px-4 py-2 rounded-lg font-semibold text-slate-500 hover:bg-slate-100 whitespace-nowrap opacity-50 cursor-not-allowed" id="tab-btn-letter" disabled>4. Letter and advice</button>
    </div>

    <div id="tab-content-form" class="grid lg:grid-cols-3 gap-6">
      <form id="credit-form" class="lg:col-span-2 space-y-6" novalidate>
        <section class="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h2 class="font-bold text-slate-900 text-lg">📋 Loan Request</h2>
          <div class="grid sm:grid-cols-2 gap-4">
            ${numField('annual_income', 'Yearly income', 'required min="1" value="450000"', 'Use the same currency for income, loan and instalment')}
            ${numField('loan_amount', 'Loan amount you want', 'required min="1" value="500000"')}
            ${numField('instalment_amount', 'Size of each repayment instalment', 'required min="1" value="25000"', 'Must be under 60% of income and not larger than the loan')}
            <label class="block">
              <span class="text-xs font-semibold text-slate-600">Main source of income</span>
              <select name="income_type" class="${INPUT_CLS} bg-white">
                ${INCOME_TYPES.map(t => `<option ${t === 'Working' ? 'selected' : ''}>${t}</option>`).join('')}
              </select>
            </label>
          </div>
        </section>

        <section class="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h2 class="font-bold text-slate-900 text-lg">💼 Employment & Family</h2>
          <div class="grid sm:grid-cols-2 gap-4">
            <label class="block">
              <span class="text-xs font-semibold text-slate-600">Are you currently employed?</span>
              <select name="employed" class="${INPUT_CLS} bg-white"><option value="yes" selected>Yes</option><option value="no">No</option></select>
            </label>
            ${numField('years_employed', 'Years in your current job', 'min="0" max="60" step="0.5" value="3"')}
            ${numField('children', 'Number of children', 'min="0" max="20" step="1" value="0"')}
            ${numField('family_members', 'People in your family', 'min="1" max="20" step="1" value="2"')}
            ${numField('years_since_phone_change', 'Years you have kept the same phone number', 'min="0" max="60" step="0.5" value="2"')}
          </div>
        </section>

        <section class="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h2 class="font-bold text-slate-900 text-lg">🧾 Have you repaid loans before?</h2>
          <label class="block">
            <select id="has-history" class="${INPUT_CLS} bg-white sm:max-w-sm">
              <option value="no" selected>No, I am new to credit</option>
              <option value="yes">Yes, I have a payment history</option>
            </select>
          </label>
          <p class="text-xs text-slate-500">New to credit is fine: you are scored like a typical new borrower, with no reward and no penalty. If you have repaid loans, tell us how it went; a good record helps you.</p>
          <div id="history-fields" class="hidden grid sm:grid-cols-2 gap-4">
            ${numField('n_installments', 'How many instalments have you paid so far?', 'min="1" max="2000" step="1" value="12"')}
            ${sliderField('late_pct', 'Paid after the due date', 'Out of 100 instalments, how many were late?', 0)}
            ${numField('avg_days_late', 'Average days late', 'min="0" max="3650" step="1" value="0"', 'Enter 0 if usually on time')}
            ${numField('max_days_late', 'Longest delay (days)', 'min="0" max="3650" step="1" value="0"')}
            ${sliderField('underpaid_pct', 'Paid only in part', 'Out of 100 instalments, how many were not paid in full?', 0)}
            ${sliderField('payment_ratio_pct', 'Usually paid of each instalment', 'On average, how much of each instalment did you pay?', 100)}
            ${sliderField('recent_late_pct', 'Late in the last 12 months', 'Out of your instalments in the last year', 0)}
          </div>
        </section>

        <section class="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h2 class="font-bold text-slate-900 text-lg">📞 Contact details you can give</h2>
          <p class="text-xs text-slate-500 mb-2">Check a box to tell us you can provide that contact — you can then type the value (optional but improves your profile). Saved profile details are filled in for you.</p>
          <div class="space-y-3">
            ${contactBox('has_work_phone', 'work_phone', 'work_phone_input', 'I have a work phone', 'Enter work phone number', 'text', u.work_phone)}
            ${contactBox('has_home_phone', 'home_phone', 'home_phone_input', 'I have a home phone', 'Enter home phone number', 'text', u.home_phone)}
            ${contactBox('has_email', 'email_address', 'email_input', 'I have an email address', 'Enter email address', 'email', u.email_address)}
          </div>
        </section>

        <button type="submit" id="btn-submit-credit" class="w-full py-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-bold text-lg shadow-md transition active:scale-[.99]">
          Check My Credit Score
        </button>
        <p class="text-xs text-slate-400 text-center">We do not use gender, age, education or any bureau credit score.</p>
      </form>

      <div class="lg:col-span-1">
        <div class="bg-slate-100 rounded-2xl border border-slate-200 p-6 flex flex-col items-center justify-center text-center sticky top-24 min-h-[260px]">
          <div class="text-5xl mb-4">📊</div>
          <h3 class="font-bold text-slate-700 mb-2">Awaiting Details</h3>
          <p class="text-sm text-slate-500">Fill out the form and click "Check My Credit Score" to see your assessment.</p>
        </div>
      </div>
    </div>

    <div id="tab-content-result" class="hidden"></div>
    <div id="tab-content-stress" class="hidden"></div>
    <div id="tab-content-letter" class="hidden"></div>
  </div>`;
}

// Read the form into the JSON the API expects. Returns { payload } or { error }.
function readCreditForm(form) {
  const fd = new FormData(form);
  const num = (k, d = 0) => { const v = fd.get(k); return v === null || v === '' ? d : Number(v); };
  const income = num('annual_income'), loan = num('loan_amount'), inst = num('instalment_amount');
  if (!(income > 0) || !(loan > 0) || !(inst > 0)) return { error: 'Income, loan amount and monthly instalment must all be above zero.' };
  if (inst > loan) return { error: 'The monthly instalment cannot be larger than the whole loan amount.' };
  const employed = fd.get('employed') === 'yes';
  const payload = {
    annual_income: income, loan_amount: loan, instalment_amount: inst,
    income_type: fd.get('income_type') || 'Working',
    employed,
    years_employed: employed ? num('years_employed') : 0,
    children: Math.round(num('children')),
    family_members: Math.max(1, Math.round(num('family_members', 2))),
    years_since_phone_change: num('years_since_phone_change', 2),
    has_work_phone: fd.get('has_work_phone') === 'on',
    has_home_phone: fd.get('has_home_phone') === 'on',
    has_email: fd.get('has_email') === 'on',
    work_phone: fd.get('work_phone') || null,
    home_phone: fd.get('home_phone') || null,
    email_address: fd.get('email_address') || null,
  };
  if ($('#has-history').value === 'yes') {
    const n = Math.round(num('n_installments'));
    if (n < 1) return { error: 'Past repayment history needs at least 1 instalment. Turn it off if you are new to credit.' };
    const pct = k => Math.min(1, Math.max(0, num(k) / 100));
    payload.history = {
      n_installments: n,
      late_payment_share: pct('late_pct'),
      underpaid_share: pct('underpaid_pct'),
      avg_days_late: num('avg_days_late'),
      max_days_late: num('max_days_late'),
      avg_payment_ratio: Math.min(2, Math.max(0, num('payment_ratio_pct', 100) / 100)),
      recent_late_share: pct('recent_late_pct'),
    };
  }
  return { payload };
}

function enableCreditTabs() {
  ['result', 'stress', 'letter'].forEach(t => {
    const btn = $(`#tab-btn-${t}`);
    if (btn) { btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed'); }
  });
}

function bindCredit() {
  const form = $('#credit-form');
  if (!form) return;
  const btnSubmit = $('#btn-submit-credit');

  $$('.contact-toggle').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const target = $('#' + e.currentTarget.dataset.target);
      if (e.currentTarget.checked) { target.classList.remove('hidden'); target.focus(); }
      else { target.classList.add('hidden'); target.value = ''; }
    });
  });
  $('#has-history').addEventListener('change', e => $('#history-fields').classList.toggle('hidden', e.target.value !== 'yes'));
  $$('input[type=range]').forEach(r => r.addEventListener('input', () => { $('#' + r.id + '-val').textContent = r.value + '%'; }));
  const empl = form.elements['employed'], yrs = form.elements['years_employed'];
  const syncEmployed = () => { const on = empl.value === 'yes'; yrs.disabled = !on; yrs.classList.toggle('opacity-50', !on); };
  empl.addEventListener('change', syncEmployed); syncEmployed();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const parsed = readCreditForm(form);
    if (parsed.error) return toast(parsed.error, 'error');
    btnSubmit.innerHTML = 'Analyzing...';
    btnSubmit.disabled = true;
    state.finalRound = false;
    try {
      await runAssessment(parsed.payload, '/predict');
    } finally {
      btnSubmit.innerHTML = 'Check My Credit Score';
      btnSubmit.disabled = false;
    }
  });

  $('#tab-btn-form').addEventListener('click', () => switchCreditTab('form'));
  $('#tab-btn-result').addEventListener('click', () => switchCreditTab('result'));
  $('#tab-btn-stress').addEventListener('click', () => { switchCreditTab('stress'); loadStressTest(); });
  $('#tab-btn-letter').addEventListener('click', () => { switchCreditTab('letter'); loadLetter(); });

  // Coming back to this page: show the last result again
  if (state.creditResult && state.currentPayload) {
    enableCreditTabs();
    renderCreditResult(state.creditResult);
  }
}

// Send the application to /predict (first round) or /reassess (final round) and show the answer
async function runAssessment(payload, endpoint) {
  try {
    state.currentPayload = payload;
    const res = await api(endpoint, { method: 'POST', body: payload });
    if (!res) return;
    state.creditResult = res;
    enableCreditTabs();
    renderCreditResult(res);
    switchCreditTab('result');
  } catch (err) {
    console.error('API Error:', err);
    enableCreditTabs();
    $('#tab-content-result').innerHTML = `
      <div class="bg-rose-50 rounded-2xl border border-rose-200 p-8 text-center text-rose-700">
        <h3 class="text-xl font-bold mb-2">Analysis Failed</h3>
        <p class="font-mono text-sm bg-white p-3 rounded border border-rose-200 inline-block">${escapeHtml(err.message)}</p>
        <div class="mt-4"><button type="button" id="back-to-form" class="px-4 py-2 rounded-lg bg-white border border-rose-200 font-semibold text-sm">← Edit my application</button></div>
      </div>`;
    $('#back-to-form')?.addEventListener('click', () => switchCreditTab('form'));
    switchCreditTab('result');
  }
}

function switchCreditTab(tab) {
  ['form', 'result', 'stress', 'letter'].forEach(t => {
    $(`#tab-content-${t}`).classList.add('hidden');
    const btn = $(`#tab-btn-${t}`);
    if (btn) {
      btn.className = btn.disabled
        ? "px-4 py-2 rounded-lg font-semibold text-slate-500 hover:bg-slate-100 whitespace-nowrap opacity-50 cursor-not-allowed"
        : "px-4 py-2 rounded-lg font-semibold text-slate-500 hover:bg-slate-100 whitespace-nowrap";
    }
  });
  $(`#tab-content-${tab}`).classList.remove('hidden');
  const activeBtn = $(`#tab-btn-${tab}`);
  if (activeBtn) activeBtn.className = "px-4 py-2 rounded-lg font-semibold bg-brand-600 text-white shadow-sm whitespace-nowrap";
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Fill the form with a suggested change (smaller loan / smaller instalment) and run it again
function applySuggestion(apply) {
  const p = { ...state.currentPayload };
  p.loan_amount = Math.max(1, Math.round(p.loan_amount * apply.loan_factor));
  p.instalment_amount = Math.max(1, Math.round(Math.min(p.instalment_amount * apply.instalment_factor, p.loan_amount)));
  const form = $('#credit-form');
  if (form) { form.elements['loan_amount'].value = p.loan_amount; form.elements['instalment_amount'].value = p.instalment_amount; }
  // A borderline application is allowed one final re-run; everything else is a fresh first check
  const endpoint = state.creditResult?.decision === 'borderline' ? '/reassess' : '/predict';
  state.finalRound = endpoint === '/reassess';
  runAssessment(p, endpoint);
}

function factorRows(list, tone) {
  if (!list.length) return '<p class="text-sm text-slate-500">None significant.</p>';
  const max = Math.max(...list.map(f => Math.abs(f.effect)), 0.001);
  return list.map(f => `
    <div class="border-b border-slate-200 py-2">
      <div class="flex justify-between items-center text-sm">
        <span class="text-slate-600 pr-2">${escapeHtml(f.factor)}</span>
        <span class="font-bold text-${tone}-600">${f.effect > 0 ? '+' : ''}${f.effect}</span>
      </div>
      <div class="mt-1 h-1 rounded-full bg-slate-100"><div class="h-1 rounded-full bg-${tone}-400" style="width:${Math.round(Math.abs(f.effect) / max * 100)}%"></div></div>
    </div>`).join('');
}

function scoreScale(score) {
  const pos = Math.min(100, Math.max(0, ((score - 300) / 600) * 100));
  return `<div class="w-full mt-4">
    <div class="relative h-2 rounded-full" style="background:linear-gradient(90deg,#f43f5e 0%,#f59e0b 45%,#10b981 100%)">
      <div class="absolute -top-1 w-4 h-4 rounded-full bg-white border-2 border-slate-800 shadow" style="left:calc(${pos}% - 8px)"></div>
    </div>
    <div class="flex justify-between text-[10px] text-slate-400 mt-1"><span>300</span><span>600</span><span>900</span></div>
  </div>`;
}

function renderCreditResult(res) {
  const color = res.decision === 'approved' ? 'emerald' : res.decision === 'borderline' ? 'amber' : 'rose';
  const icon = res.decision === 'approved' ? '✅' : res.decision === 'borderline' ? '⚠️' : '❌';
  const th = res.thresholds || { approve_below: 0.1, reject_above: 0.15 };
  const rules = res.rule_reasons || [];
  const next = res.next_step;

  $('#tab-content-result').innerHTML = `
    <div class="space-y-6">
    <div class="bg-${color}-50 rounded-2xl border border-${color}-200 p-8 flex flex-col md:flex-row gap-8">
      <div class="text-center md:w-1/3 flex flex-col items-center justify-center">
        ${res.final ? '<div class="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Final decision</div>' : ''}
        <div class="text-6xl mb-4">${icon}</div>
        <h3 class="font-extrabold text-3xl text-${color}-700 capitalize mb-2">${escapeHtml(res.decision)}</h3>
        <div class="bg-white rounded-xl px-6 py-4 shadow-sm w-full max-w-[240px]">
          <p class="text-sm text-slate-500 font-medium">Credit Score</p>
          <p class="text-3xl font-extrabold text-slate-900">${res.score} <span class="text-sm text-slate-400">/ 900</span></p>
          ${scoreScale(res.score)}
        </div>
        <p class="text-sm text-slate-600 mt-3">Estimated risk of repayment trouble: <strong>${res.risk_percent}%</strong>
          ${res.risk_change_points !== undefined ? `<br><span class="text-xs text-slate-500">${res.risk_change_points > 0 ? '+' : ''}${res.risk_change_points} points since the first check</span>` : ''}</p>
      </div>

      <div class="md:w-2/3">
        <div class="bg-white rounded-xl p-5 shadow-sm mb-4 text-slate-700">
          <strong>Decision:</strong> ${escapeHtml(res.decision_text)}
        </div>
        ${res.history_note ? `<div class="bg-sky-50 border border-sky-200 rounded-xl p-3 mb-4 text-xs text-sky-800">ℹ️ ${escapeHtml(res.history_note)}</div>` : ''}
        <p class="text-xs text-slate-500 mb-4">We approve below ${Math.round(th.approve_below * 100)}% risk, ask you to confirm between
          ${Math.round(th.approve_below * 100)}% and ${Math.round(th.reject_above * 100)}%, and reject above ${Math.round(th.reject_above * 100)}%.</p>

        ${rules.length ? `<div class="bg-rose-50 border border-rose-200 rounded-xl p-4 mb-4 text-sm text-rose-700">
          <div class="font-bold mb-1">Lending limit reached</div>
          <ul class="list-disc pl-5 space-y-0.5">${rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
          <div class="text-xs mt-2 text-rose-600">The score is capped at 650 when a limit is reached, whatever the risk model says.</div></div>` : ''}

        <div class="grid sm:grid-cols-2 gap-6">
          <div>
            <h4 class="font-bold text-sm uppercase tracking-wide mb-3 text-rose-600">Top Risk Factors</h4>
            ${factorRows(res.top_risk_factors || [], 'rose')}
          </div>
          <div>
            <h4 class="font-bold text-sm uppercase tracking-wide mb-3 text-emerald-600">Protective Factors</h4>
            ${factorRows(res.top_protective_factors || [], 'emerald')}
          </div>
        </div>
        <p class="text-[11px] text-slate-400 mt-3">${escapeHtml(res.note || 'Bigger bars mean a bigger push on the result.')}</p>
        ${res.warning ? `<p class="text-[11px] text-slate-400 mt-1">${escapeHtml(res.warning)}</p>` : ''}
      </div>
    </div>

    ${next ? `<div class="bg-white rounded-2xl border border-amber-200 p-6">
      <h3 class="font-bold text-slate-900 mb-1">Your application is borderline</h3>
      <p class="text-sm text-slate-600 mb-4">${escapeHtml(next.message)}</p>
      ${next.offers && next.offers.length ? `<div class="space-y-2 mb-4">
        ${next.offers.map((o, i) => `
          <div class="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-emerald-50 border border-emerald-200">
            <div class="text-sm"><span class="font-semibold text-slate-800">${escapeHtml(o.action)}</span>
              <span class="text-slate-500"> — risk would drop to about ${o.new_risk_percent}%</span></div>
            <button type="button" data-offer="${i}" class="apply-offer px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold">Apply and get final decision</button>
          </div>`).join('')}</div>` : ''}
      <div class="flex flex-wrap gap-2">
        <button type="button" id="btn-confirm" class="px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold">Confirm my details — final decision</button>
        <button type="button" id="btn-edit" class="px-5 py-2.5 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 font-semibold text-slate-700">Edit my application</button>
      </div>
    </div>` : `<div class="flex flex-wrap gap-2">
      <button type="button" id="btn-edit" class="px-5 py-2.5 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 font-semibold text-slate-700">← Edit my application</button>
      <button type="button" id="btn-goto-stress" class="px-5 py-2.5 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 font-semibold text-slate-700">See the stress test</button>
      ${res.decision !== 'approved' ? '<button type="button" id="btn-goto-letter" class="px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold">See the letter and advice</button>' : ''}
    </div>`}
    </div>`;

  $('#btn-edit')?.addEventListener('click', () => switchCreditTab('form'));
  $('#btn-goto-stress')?.addEventListener('click', () => { switchCreditTab('stress'); loadStressTest(); });
  $('#btn-goto-letter')?.addEventListener('click', () => { switchCreditTab('letter'); loadLetter(); });
  $('#btn-confirm')?.addEventListener('click', async e => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Checking…';
    state.finalRound = true;
    const first = state.creditResult.risk_percent;
    try {
      const res = await api(`/reassess?first_round_risk_percent=${first}`, { method: 'POST', body: state.currentPayload });
      if (!res) return;
      state.creditResult = res; renderCreditResult(res);
    } catch (err) { toast(err.message, 'error'); state.finalRound = false; renderCreditResult(state.creditResult); }
  });
  $$('.apply-offer').forEach(b => b.addEventListener('click', e => applySuggestion(next.offers[Number(e.currentTarget.dataset.offer)].apply)));
}

async function loadStressTest() {
  const container = $('#tab-content-stress');
  container.innerHTML = `<div class="text-center py-10 text-slate-500 animate-pulse">Running stress test scenarios...</div>`;
  try {
    const res = await api('/stress-test', { method: 'POST', body: state.currentPayload });
    if (!res) return;
    const tone = d => d === 'approved' ? 'emerald' : d === 'borderline' ? 'amber' : 'rose';

    const detail = i => {
      const s = res.scenarios[i];
      return `
        <h4 class="font-bold mb-2">${escapeHtml(s.label)} — detail</h4>
        <p class="text-sm text-slate-300 mb-4">${escapeHtml(s.assumption)}</p>
        <ul class="text-sm text-slate-400 space-y-1">
          <li>• Income: ${fmtNum(s.income_after)}</li>
          <li>• Instalment: ${fmtNum(s.instalment_after)} (${s.instalment_share_of_income_percent}% of income)</li>
          <li>• Result: score ${s.score} (${s.score_change > 0 ? '+' : ''}${s.score_change} vs normal times), ${s.risk_percent}% risk
              (${s.risk_change_points > 0 ? '+' : ''}${s.risk_change_points} points)</li>
          ${s.rule_triggered ? `<li class="text-rose-400">• ${escapeHtml((s.rule_reasons || [])[0] || 'A lending limit is reached in this scenario.')}</li>` : ''}
        </ul>`;
    };

    container.innerHTML = `
      <div class="bg-slate-800 text-white rounded-2xl border border-slate-700 p-6">
        <h3 class="text-xl font-bold mb-2">What if the economy changes?</h3>
        <p class="text-sm text-slate-400 mb-6">${escapeHtml(res.warning)} Select a scenario to see its detail.</p>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8" id="scenario-cards">
          ${res.scenarios.map((s, i) => `
            <button type="button" data-i="${i}" class="scenario-card text-left bg-slate-900 border ${i === 0 ? 'border-brand-400' : 'border-slate-700'} rounded-xl p-4 hover:border-brand-400 transition">
              <div class="font-bold text-sm mb-2">${escapeHtml(s.label)}</div>
              <div class="inline-block px-2 py-1 rounded bg-${tone(s.decision)}-900/50 text-${tone(s.decision)}-400 text-xs font-bold uppercase mb-2">${escapeHtml(s.decision)}</div>
              <div class="text-xs text-slate-400">Score ${s.score} (${s.score_change > 0 ? '+' : ''}${s.score_change})</div>
              <div class="text-xs text-slate-400">Risk ${s.risk_percent}%</div>
            </button>`).join('')}
        </div>
        <div id="scenario-detail" class="bg-slate-900 rounded-xl p-5 border border-slate-700">${detail(0)}</div>
      </div>`;
    $$('.scenario-card', container).forEach(btn => btn.addEventListener('click', e => {
      const i = Number(e.currentTarget.dataset.i);
      $$('.scenario-card', container).forEach(b => { b.classList.toggle('border-brand-400', b === e.currentTarget); b.classList.toggle('border-slate-700', b !== e.currentTarget); });
      $('#scenario-detail', container).innerHTML = detail(i);
    }));
  } catch (err) {
    container.innerHTML = `<div class="text-center py-10 text-rose-500">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadLetter() {
  const container = $('#tab-content-letter');
  container.innerHTML = `<div class="text-center py-10 text-slate-500 animate-pulse">Generating decision letter...</div>`;
  try {
    const res = await api(`/notice?final=${state.finalRound ? 'true' : 'false'}`, { method: 'POST', body: state.currentPayload });
    if (!res) return;

    if (!res.issued) {
      const border = res.decision === 'borderline';
      container.innerHTML = `
        <div class="${border ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'} rounded-2xl border p-8 text-center">
          <div class="text-4xl mb-4">${border ? '⚠️' : '🎉'}</div>
          <h3 class="text-xl font-bold">${border ? 'No letter yet — your application is borderline' : 'No rejection letter needed!'}</h3>
          <p class="mt-2">${escapeHtml(res.message)}</p>
          ${border ? '<button type="button" id="goto-result" class="mt-4 px-5 py-2.5 rounded-xl bg-brand-600 text-white font-semibold">Go to the result</button>' : ''}
        </div>`;
      $('#goto-result')?.addEventListener('click', () => switchCreditTab('result'));
      return;
    }

    const sugg = res.suggestions || [];
    container.innerHTML = `
      <div class="space-y-6">
        <div class="bg-white rounded-2xl border border-slate-200 p-6">
          <h3 class="font-bold text-slate-900 mb-3">Main reasons</h3>
          <ol class="list-decimal pl-5 space-y-1 text-sm text-slate-700">${(res.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ol>
        </div>
        ${sugg.length ? `<div class="bg-white rounded-2xl border border-slate-200 p-6">
          <h3 class="font-bold text-slate-900 mb-1">What may improve your chances</h3>
          <p class="text-xs text-slate-500 mb-3">Estimates from the model, not guarantees.</p>
          <div class="space-y-2">
            ${sugg.map((s, i) => `
              <div class="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl ${s.reaches_approval ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-50 border border-slate-200'}">
                <div class="text-sm"><span class="font-semibold text-slate-800">${escapeHtml(s.action)}</span>
                  <span class="text-slate-500"> — risk about ${s.new_risk_percent}% (${s.risk_change_points > 0 ? '+' : ''}${s.risk_change_points} points)${s.reaches_approval ? ', would be approved' : ''}</span></div>
                ${s.apply ? `<button type="button" data-s="${i}" class="apply-sugg px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold">Try this</button>` : `<span class="text-xs text-slate-400">Takes time</span>`}
              </div>`).join('')}
          </div>
        </div>` : ''}
        <div class="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm">
          <div class="flex justify-end mb-3"><button type="button" id="copy-letter" class="text-sm font-semibold text-brand-600 hover:underline">Copy letter</button></div>
          <div id="letter-text" class="max-w-none text-slate-700 whitespace-pre-wrap font-mono text-sm leading-relaxed bg-slate-50 p-6 rounded-xl border border-slate-100">${escapeHtml(res.letter)}</div>
        </div>
      </div>`;
    $('#copy-letter')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(res.letter); toast('Letter copied', 'success'); }
      catch { toast('Could not copy. Select the text and copy it.', 'error'); }
    });
    $$('.apply-sugg', container).forEach(b => b.addEventListener('click', e => applySuggestion(sugg[Number(e.currentTarget.dataset.s)].apply)));
  } catch (err) {
    container.innerHTML = `<div class="text-center py-10 text-rose-500">Error: ${escapeHtml(err.message)}</div>`;
  }
}

/* ────────────── Profile ────────────── */
function renderProfile() {
  const u = state.user || {};
  return `
  <div class="max-w-2xl mx-auto space-y-6 animate-fadeIn">
    <header>
      <h1 class="text-3xl font-extrabold text-slate-900">Profile</h1>
      <p class="text-slate-500 mt-1">Manage your contact details and monthly budget.</p>
    </header>

    <form id="profile-form" class="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
      <div class="grid sm:grid-cols-2 gap-4">
        <label class="block">
          <span class="text-xs font-semibold text-slate-600">Full Name</span>
          <input name="full_name" type="text" value="${escapeHtml(u.full_name || '')}" class="${INPUT_CLS}" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold text-slate-600">Email</span>
          <input type="email" value="${escapeHtml(u.email)}" disabled class="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-slate-500 outline-none mt-1" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold text-slate-600">Work Phone</span>
          <input name="work_phone" type="text" value="${escapeHtml(u.work_phone || '')}" placeholder="e.g. +1 555 0100" class="${INPUT_CLS}" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold text-slate-600">Home Phone</span>
          <input name="home_phone" type="text" value="${escapeHtml(u.home_phone || '')}" placeholder="e.g. +1 555 0101" class="${INPUT_CLS}" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold text-slate-600">Email Address</span>
          <input name="email_address" type="email" value="${escapeHtml(u.email_address || '')}" placeholder="e.g. ada@example.com" class="${INPUT_CLS}" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold text-slate-600">Monthly Budget ($)</span>
          <input name="monthly_budget" type="number" min="0" step="0.01" value="${u.monthly_budget || ''}" placeholder="e.g. 2000" class="${INPUT_CLS}" />
        </label>
      </div>
      <button type="submit" class="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold shadow-sm transition mt-4">
        Save Changes
      </button>
    </form>
  </div>`;
}

async function bindProfile() {
  const form = $('#profile-form');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.innerHTML = 'Saving...';
    btn.disabled = true;

    const fd = new FormData(form);
    // The API treats an empty string as "clear this field", and null as "leave it alone".
    const payload = {
      full_name: fd.get('full_name'),
      work_phone: fd.get('work_phone') ?? '',
      home_phone: fd.get('home_phone') ?? '',
      email_address: fd.get('email_address') ?? '',
      monthly_budget: fd.get('monthly_budget') ? Number(fd.get('monthly_budget')) : null,
    };

    try {
      const updatedUser = await api('/profile', { method: 'PUT', body: payload });
      if (updatedUser) { state.user = updatedUser; toast('Profile updated successfully!', 'success'); }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.innerHTML = 'Save Changes';
      btn.disabled = false;
    }
  });
}

/* ────────────── Init ────────────── */
async function init() {
  await render();
}

init();
