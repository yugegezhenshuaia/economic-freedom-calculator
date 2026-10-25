(function () {
  'use strict';

  const DEFAULTS = FREngine.DEFAULTS;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clone = obj => JSON.parse(JSON.stringify(obj));

  let state = clone(DEFAULTS);
  state.assets = 3000000;
  let lastResult = null;
  let dirty = false;
  let pending = false;
  let worker = null;
  let workerUrl = null;

  // ---------- 格式化 ----------
  const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  function fmtWan(x) {
    if (!isFinite(x)) return '—';
    const v = x / 10000;
    return (Math.abs(v) >= 100 ? nf0.format(v) : nf1.format(v)) + ' 万';
  }
  function fmtWanShort(x) {
    if (!isFinite(x)) return '—';
    const v = x / 10000;
    return Math.abs(v) >= 100 ? nf0.format(v) : nf1.format(v);
  }
  function fmtYuan(x) {
    if (!isFinite(x)) return '—';
    return '¥' + nf0.format(Math.round(x));
  }
  function fmtPct(x, digits) {
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(digits == null ? 1 : digits) + '%';
  }
  function fmtMultiple(x, base) {
    if (!base || !isFinite(x)) return '—';
    return (x / base).toFixed(1) + '×';
  }
  function splitBig(x) {
    if (!isFinite(x)) return { num: '—', unit: '' };
    if (Math.abs(x) >= 1e8) return { num: (x / 1e8).toFixed(2), unit: '亿元' };
    return { num: nf0.format(x / 10000), unit: '万元' };
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 路径读写 ----------
  function getPath(obj, path) {
    if (path.startsWith('spending.curve.')) {
      const age = Number(path.split('.')[2]);
      const p = (obj.spending.curve || []).find(x => Number(x[0]) === age);
      return p ? p[1] : 1;
    }
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    if (path.startsWith('spending.curve.')) {
      const age = Number(path.split('.')[2]);
      const idx = (obj.spending.curve || []).findIndex(x => Number(x[0]) === age);
      if (idx >= 0) obj.spending.curve[idx][1] = value;
      else obj.spending.curve.push([age, value]);
      return;
    }
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    const raw = el.value;
    if (raw === '' || raw == null) return null;
    if (el.tagName === 'SELECT') return raw;
    let v = Number(raw);
    if (!isFinite(v)) return null;
    const unit = el.dataset.unit;
    if (unit === 'wan') v *= 10000;
    if (unit === 'pct' || unit === 'pctpoint') v /= 100;
    return v;
  }

  function writeInput(el) {
    const path = el.dataset.path;
    let v = getPath(state, path);
    if (v == null) { el.value = ''; return; }
    const unit = el.dataset.unit;
    if (unit === 'wan') v = v / 10000;
    if (unit === 'pct' || unit === 'pctpoint') v = v * 100;
    if (typeof v === 'number') {
      if (Math.abs(v) >= 1000) v = Math.round(v);
      else if (Math.abs(v) >= 10) v = Math.round(v * 10) / 10;
      else v = Math.round(v * 100) / 100;
    }
    el.value = v;
  }

  // ---------- 表单刷新 ----------
  function refreshForm() {
    $$('[data-path]').forEach(writeInput);
    updateVisibility();
    renderChildren();
    renderOneOffs();
    $('#children-count').value = String((state.children || []).length);
    updatePortfolioStats();
  }

  function updateVisibility() {
    const adults = Number(state.household.adults) === 2 ? 2 : 1;
    $$('.spouse-only').forEach(el => { el.style.display = adults === 2 ? '' : 'none'; });
    $$('#adults-seg button').forEach(b => b.classList.toggle('active', Number(b.dataset.adults) === adults));
    $('#savings-manual').style.display = state.income.savingsMode === 'manual' ? '' : 'none';
    $$('.pension-formula').forEach(el => { el.style.display = state.income.pensionMode === 'formula' ? '' : 'none'; });
    $$('.pension-direct').forEach(el => { el.style.display = state.income.pensionMode === 'direct' ? '' : 'none'; });
  }

  function updatePortfolioStats() {
    const st = FREngine.portfolioStats(state);
    $('#port-geom').textContent = fmtPct(st.geom);
    $('#port-vol').textContent = fmtPct(st.vol);
    const sum = Object.values(state.investment.allocation).reduce((a, b) => a + (Number(b) || 0), 0) * 100;
    $('#alloc-sum').textContent = sum.toFixed(0) + '%';
  }

  // ---------- 子女 ----------
  const CHILD_PATHS = { public: '公立路线', private: '私立路线', international: '国际路线' };
  function defaultChild(age) {
    return { age: age == null ? 6 : age, path: 'public', multiplier: 1, supportUntil: 22, postgrad: false, marriageSupport: 0, marriageAge: 28 };
  }
  function renderChildren() {
    const list = $('#children-list');
    const children = state.children || [];
    if (!children.length) {
      list.innerHTML = '<p class="help">暂无子女。可在上方选择数量。</p>';
      return;
    }
    list.innerHTML = children.map((c, i) => `
      <div class="child-row" data-child="${i}">
        <div class="child-head"><strong>孩子 ${i + 1}</strong><button type="button" class="mini" data-child-remove="${i}">移除</button></div>
        <div class="field"><label>当前年龄</label><div class="input-wrap"><input type="number" min="0" max="40" step="1" data-child-field="age" value="${Number(c.age) || 0}"><span class="suffix">岁</span></div></div>
        <div class="field"><label>养育路线</label><div class="input-wrap"><select data-child-field="path">${Object.keys(CHILD_PATHS).map(k => `<option value="${k}" ${c.path === k ? 'selected' : ''}>${CHILD_PATHS[k]}</option>`).join('')}</select></div></div>
        <div class="field"><label>支持到</label><div class="input-wrap"><input type="number" min="16" max="30" step="1" data-child-field="supportUntil" value="${Number(c.supportUntil) || 22}"><span class="suffix">岁</span></div></div>
        <div class="field"><label>婚房 / 创业支持</label><div class="input-wrap"><input type="number" min="0" step="10" data-child-field="marriageSupport" data-wan="1" value="${(Number(c.marriageSupport) || 0) / 10000}"><span class="suffix">万元</span></div></div>
      </div>`).join('');
    $$('[data-child-remove]', list).forEach(btn => btn.addEventListener('click', () => {
      state.children.splice(Number(btn.dataset.childRemove), 1);
      renderChildren();
      $('#children-count').value = String(state.children.length);
      markDirty();
    }));
    $$('[data-child-field]', list).forEach(el => {
      el.addEventListener('input', onChildInput);
      el.addEventListener('change', onChildInput);
    });
  }
  function onChildInput(e) {
    const row = e.target.closest('[data-child]');
    if (!row) return;
    const idx = Number(row.dataset.child);
    const field = e.target.dataset.childField;
    let v = e.target.value;
    if (['age', 'supportUntil', 'marriageSupport'].includes(field)) {
      v = Number(v) || 0;
      if (field === 'marriageSupport') v *= 10000;
    }
    state.children[idx][field] = v;
    markDirty();
  }

  // ---------- 大件 ----------
  function renderOneOffs() {
    const list = $('#oneoffs-list');
    const items = state.spending.oneOffs || [];
    if (!items.length) {
      list.innerHTML = '<p class="help">暂无大件支出。</p>';
      return;
    }
    list.innerHTML = items.map((o, i) => `
      <div class="oneoff-row" data-oneoff="${i}">
        <div class="oneoff-head"><input type="text" data-oneoff-field="name" value="${escapeHtml(o.name || '项目')}" aria-label="项目名称"><button type="button" class="mini" data-oneoff-remove="${i}">移除</button></div>
        <div class="oneoff-grid">
          <div class="field"><label>金额</label><div class="input-wrap"><input type="number" min="0" step="1" data-oneoff-field="amount" data-wan="1" value="${(Number(o.amount) || 0) / 10000}"><span class="suffix">万</span></div></div>
          <div class="field"><label>开始年龄</label><div class="input-wrap"><input type="number" min="18" max="100" step="1" data-oneoff-field="startAge" value="${Number(o.startAge) || 50}"><span class="suffix">岁</span></div></div>
          <div class="field"><label>每隔</label><div class="input-wrap"><input type="number" min="1" max="30" step="1" data-oneoff-field="every" value="${Number(o.every) || 1}"><span class="suffix">年</span></div></div>
          <div class="field"><label>结束年龄</label><div class="input-wrap"><input type="number" min="18" max="110" step="1" data-oneoff-field="endAge" value="${Number(o.endAge) || 80}"><span class="suffix">岁</span></div></div>
        </div>
      </div>`).join('');
    $$('[data-oneoff-remove]', list).forEach(btn => btn.addEventListener('click', () => {
      state.spending.oneOffs.splice(Number(btn.dataset.oneoffRemove), 1);
      renderOneOffs();
      markDirty();
    }));
    $$('[data-oneoff-field]', list).forEach(el => {
      el.addEventListener('input', onOneOffInput);
      el.addEventListener('change', onOneOffInput);
    });
  }
  function onOneOffInput(e) {
    const row = e.target.closest('[data-oneoff]');
    if (!row) return;
    const idx = Number(row.dataset.oneoff);
    const field = e.target.dataset.oneoffField;
    let v = e.target.value;
    if (field === 'name') {
      state.spending.oneOffs[idx].name = v;
    } else {
      v = Number(v) || 0;
      if (field === 'amount') v *= 10000;
      state.spending.oneOffs[idx][field] = v;
    }
    markDirty();
  }

  // ---------- 交互 ----------
  function markDirty() {
    dirty = true;
    $('#dirty').classList.add('show');
    $('#calc-btn').textContent = '计算并更新';
    updatePortfolioStats();
  }

  function bindInputs() {
    $$('[data-path]').forEach(el => {
      const handler = () => {
        const path = el.dataset.path;
        let v = readInput(el);
        if (path === 'investment.overrideReturn' || path === 'investment.overrideVol') {
          if (el.value === '') v = null;
        }
        if (v == null && !path.startsWith('investment.override')) return;
        setPath(state, path, v);
        if (path === 'household.adults') updateVisibility();
        if (path === 'income.savingsMode' || path === 'income.pensionMode') updateVisibility();
        markDirty();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    $$('#adults-seg button').forEach(btn => btn.addEventListener('click', () => {
      state.household.adults = Number(btn.dataset.adults) === 2 ? 2 : 1;
      updateVisibility();
      markDirty();
    }));
    $('#children-count').addEventListener('change', e => {
      const n = Number(e.target.value) || 0;
      if (!state.children) state.children = [];
      while (state.children.length < n) state.children.push(defaultChild(6 + state.children.length * 3));
      state.children.length = n;
      renderChildren();
      markDirty();
    });
    $('#add-oneoff').addEventListener('click', () => {
      const age = Number(state.household.age) || 40;
      state.spending.oneOffs.push({ name: '新项目', amount: 100000, startAge: age + 5, every: 1, endAge: age + 5 });
      renderOneOffs();
      markDirty();
    });
    $$('#tabs .tab').forEach(btn => btn.addEventListener('click', () => {
      $$('#tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
    }));
    $$('#presets .preset').forEach(btn => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));
    $('#calc-btn').addEventListener('click', calculate);
    $('#reset-all').addEventListener('click', () => {
      state = clone(DEFAULTS);
      state.assets = 3000000;
      refreshForm();
      markDirty();
      calculate();
    });
    $('#mobile-params').addEventListener('click', () => {
      $('#sidebar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ---------- 预设 ----------
  function applyPreset(name) {
    let s = clone(DEFAULTS);
    s.assets = 3000000;
    if (name === 'tier1') {
      s.household.age = 40; s.household.spouseAge = 38; s.household.fiAge = 40;
      s.spending.monthly = { food: 7000, housing: 8000, transport: 2500, clothing: 1200, leisure: 2000, social: 1500, medical: 1500, insurance: 0, childcare: 0, education: 0, other: 1500 };
      s.children = [{ age: 8, path: 'private', multiplier: 1, supportUntil: 22, postgrad: false, marriageSupport: 1000000, marriageAge: 28 }, { age: 3, path: 'public', multiplier: 1, supportUntil: 22, postgrad: false, marriageSupport: 500000, marriageAge: 28 }];
      s.housing.homeValue = 8000000; s.housing.mortgageBalance = 3000000; s.housing.mortgageRate = 0.032; s.housing.mortgageYearsLeft = 20;
      s.insurance.annualPremium = 30000;
      s.income.salary = 800000; s.income.spouseSalary = 400000;
      s.social.localAverageWage = 12000; s.social.spouseLocalAverageWage = 12000;
      s.social.personalAccount = 500000; s.social.spousePersonalAccount = 300000;
      s.assets = 8000000;
      s.parents.annualSupport = 20000; s.parents.years = 15;
    } else if (name === 'single') {
      s.household.adults = 1; s.household.age = 32; s.household.fiAge = 32;
      s.spending.monthly = { food: 2500, housing: 3500, transport: 800, clothing: 500, leisure: 800, social: 500, medical: 500, insurance: 0, childcare: 0, education: 0, other: 500 };
      s.children = [];
      s.housing.homeValue = 0; s.housing.mortgageBalance = 0; s.housing.mortgageYearsLeft = 0;
      s.insurance.annualPremium = 6000;
      s.income.salary = 300000; s.income.pensionMode = 'formula'; s.social.contribYears = 10; s.social.localAverageWage = 9000;
      s.social.personalAccount = 120000; s.assets = 1500000;
    } else if (name === 'dink') {
      s.household.age = 35; s.household.spouseAge = 35; s.household.fiAge = 40;
      s.spending.monthly = { food: 4500, housing: 5000, transport: 1500, clothing: 800, leisure: 1500, social: 800, medical: 800, insurance: 0, childcare: 0, education: 0, other: 1000 };
      s.children = [];
      s.housing.homeValue = 5000000; s.housing.mortgageBalance = 2000000; s.housing.mortgageYearsLeft = 20;
      s.insurance.annualPremium = 15000;
      s.income.salary = 500000; s.income.spouseSalary = 400000;
      s.social.localAverageWage = 10000; s.social.spouseLocalAverageWage = 10000;
      s.assets = 4000000;
    } else if (name === 'retired') {
      s.household.age = 65; s.household.spouseAge = 63; s.household.fiAge = 65;
      s.spending.monthly = { food: 4000, housing: 2500, transport: 800, clothing: 500, leisure: 1000, social: 800, medical: 2000, insurance: 0, childcare: 0, education: 0, other: 800 };
      s.children = [];
      s.housing.homeValue = 3000000; s.housing.mortgageBalance = 0; s.housing.mortgageYearsLeft = 0;
      s.insurance.annualPremium = 12000;
      s.income.salary = 0; s.income.pensionMode = 'direct'; s.income.pensionMonthly = 5500; s.income.spousePensionMonthly = 3800;
      s.assets = 5000000;
    } else {
      s = clone(DEFAULTS); s.assets = 3000000;
    }
    state = s;
    refreshForm();
    markDirty();
    calculate();
  }

  // ---------- 计算 ----------
  function setupWorker() {
    try {
      const source = $('#engine-code').textContent;
      const workerSource = source + `\nself.onmessage = function (e) { try { const r = FREngine.runModel(e.data.params, e.data.n); self.postMessage({ ok: true, result: r }); } catch (err) { self.postMessage({ ok: false, error: String(err && err.stack || err) }); } };`;
      const blob = new Blob([workerSource], { type: 'text/javascript' });
      workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);
      worker.onmessage = e => {
        if (e.data && e.data.ok) handleResult(e.data.result);
        else {
          console.error(e.data && e.data.error);
          worker = null;
          calculateFallback();
        }
      };
      worker.onerror = err => {
        console.error('Worker error', err.message || err);
        worker = null;
        calculateFallback();
      };
    } catch (e) {
      console.warn('Worker unavailable, fallback to main thread', e);
      worker = null;
    }
  }

  function normalizeStateForCalc() {
    const age = Math.max(18, Math.min(90, Number(state.household.age) || 40));
    state.household.age = age;
    state.household.fiAge = Math.max(age, Math.min(100, Number(state.household.fiAge) || age));
    state.household.planUntil = Math.max(age + 1, Math.min(110, Number(state.household.planUntil) || age + 1));
    state.assets = Math.max(0, Number(state.assets) || 0);
  }

  function calculate() {
    if (pending) return;
    normalizeStateForCalc();
    $$('[data-path]').forEach(writeInput);
    pending = true;
    dirty = false;
    $('#dirty').classList.remove('show');
    $('#calc-btn').disabled = true;
    $('#calc-btn').textContent = '计算中…';
    $('#loading').classList.add('show');
    $('#loading-sub').textContent = `正在抽样 ${Number(state.risk.simulations) || 4000} 条人生路径…`;
    if (worker) {
      worker.postMessage({ params: clone(state), n: Number(state.risk.simulations) || 4000 });
    } else {
      setTimeout(() => {
        try {
          const r = FREngine.runModel(clone(state), Number(state.risk.simulations) || 4000);
          handleResult(r);
        } catch (e) {
          console.error(e);
          $('#loading-sub').textContent = '计算失败：' + (e.message || e);
          pending = false;
          $('#calc-btn').disabled = false;
          $('#calc-btn').textContent = '重新计算';
        }
      }, 50);
    }
  }

  function calculateFallback() {
    try {
      const r = FREngine.runModel(clone(state), Number(state.risk.simulations) || 4000);
      handleResult(r);
    } catch (e) {
      console.error(e);
      $('#loading-sub').textContent = '计算失败：' + (e.message || e);
      pending = false;
      $('#calc-btn').disabled = false;
      $('#calc-btn').textContent = '重新计算';
    }
  }

  function handleResult(r) {
    lastResult = r;
    pending = false;
    $('#loading').classList.remove('show');
    $('#calc-btn').disabled = false;
    $('#calc-btn').textContent = '重新计算';
    render(r);
    if (window.innerWidth <= 860) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---------- 渲染 ----------
  function render(r) {
    const conf = Number(r.meta.confidence) || 0.9;
    const key = String(Math.round(conf * 100));
    const rawReq = r.required;
    const req = isFinite(rawReq) ? (r.requiredByConfidence[key] ?? rawReq) : Infinity;
    const reqFinite = isFinite(req);
    const big = splitBig(req);
    $('#hero-number').textContent = reqFinite ? big.num : '—';
    $('#hero-unit').textContent = reqFinite ? big.unit : '';
    $('#hero-confidence').textContent = `${Math.round(conf * 100)}% 置信度`;
    const coverage = reqFinite && req > 0 ? r.currentAssets / req : 0;
    const gap = reqFinite ? req - r.currentAssets : 0;
    if (!reqFinite) {
      $('#hero-sub').innerHTML = '当前参数下无法求出有限本金：固定支出/风险已经超过任何可投资资产能覆盖的范围。请降低支出、提高收益假设或延长工作年限。';
    } else {
      $('#hero-sub').innerHTML = coverage >= 1
        ? `按 ${Math.round(conf * 100)}% 置信度、规划到 ${state.household.planUntil} 岁：当前资产已覆盖目标，剩余安全垫约 <strong>${fmtWan(r.currentAssets - req)}</strong>。`
        : `按 ${Math.round(conf * 100)}% 置信度、规划到 ${state.household.planUntil} 岁：还差 <strong>${fmtWan(gap)}</strong>；当前覆盖率 ${fmtPct(coverage, 0)}。`;
    }
    $('#hero-assets').textContent = fmtWan(r.currentAssets);
    $('#hero-coverage').textContent = reqFinite ? fmtPct(coverage, 0) : '—';
    $('#hero-success').textContent = fmtPct(r.currentSuccess, 0);
    $('#hero-success-long').textContent = r.longN > 0 ? fmtPct(r.currentSuccessLong, 0) : '—';
    $('#hero-progress').style.width = reqFinite ? Math.min(100, coverage * 100) + '%' : '0%';
    $('#hero-progress-label').textContent = reqFinite ? `目标 ${fmtWan(req)}` : '无法求解';

    // metrics
    const safe = r.safeCoreMonthlyCurrent;
    const core = r.coreMonthly0;
    $('#metric-safe-value').textContent = fmtYuan(safe) + '/月';
    $('#metric-safe-sub').textContent = safe <= 0
      ? `按 ${fmtPct(conf, 0)} 置信度，当前资产连固定支出都无法覆盖`
      : `当前核心支出 ${fmtYuan(core)}/月 · 目标 ${fmtPct(conf, 0)} 把握`;
    $('#metric-safe-tag').textContent = safe >= core ? '足够' : '不足';
    $('#metric-safe-tag').className = 'tag ' + (safe >= core ? '' : 'red');
    $('#metric-safe').className = 'metric ' + (safe >= core ? 'good' : 'bad');

    $('#metric-four-value').textContent = fmtWan(r.fourPercent);
    $('#metric-four-sub').textContent = `按本模型成功率 ${fmtPct(r.fourPercentSuccess, 0)} · 4% 不是保证`;
    $('#metric-four').className = 'metric ' + (r.fourPercentSuccess >= conf ? 'good' : 'bad');

    $('#metric-spend-value').textContent = fmtWan(r.firstYearSpending.total);
    $('#metric-spend-sub').textContent = `核心 ${fmtWan(r.firstYearSpending.core)} · 房贷/住 ${fmtWan(r.firstYearSpending.housing)}`;
    $('#metric-spend').className = 'metric';

    $('#metric-return-value').textContent = fmtPct(r.portfolio.expected);
    $('#metric-return-sub').textContent = `实际约 ${fmtPct(r.portfolio.expected - r.assumptions.inflationMean)} · 波动 ${fmtPct(r.portfolio.vol, 0)}`;
    $('#metric-return').className = 'metric ' + (r.portfolio.expected - r.assumptions.inflationMean > 0.02 ? 'good' : 'warn');

    renderVerdict(r, req, coverage, gap);
    renderConfidenceTable(r, req, conf);
    renderFirstYear(r);
    drawSuccessChart(r, req, conf);
    renderWhy(r, req, conf);
    drawFanChart(r);
    renderLifetime(r);
    drawCashflow(r);
    drawTornado(r);
    renderStress(r);
    renderWarnings(r);
    renderAssumptions(r);
  }

  function renderWarnings(r) {
    const box = $('#warnings');
    const list = (r.warnings || []).filter(Boolean);
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = list.map(w => `<div class="callout" style="margin-bottom:8px">${escapeHtml(w)}</div>`).join('');
  }

  function renderVerdict(r, req, coverage, gap) {
    const conf = r.meta.confidence;
    if (!isFinite(req)) {
      $('#verdict').innerHTML = `<div class="callout red"><strong>当前参数下无法求出有限本金。</strong><br>这通常意味着固定支出、医疗/护理风险或收益假设过于极端。请先把支出降到可解释的范围，再逐步调高置信度。</div>`;
      return;
    }
    const multiple = r.firstYearSpending.total > 0 ? req / r.firstYearSpending.total : null;
    let color = coverage >= 1 ? 'green' : 'red';
    const title = coverage >= 1
      ? `按当前参数，你已经达到 ${Math.round(conf * 100)}% 置信度的目标。`
      : `按当前参数，距离 ${Math.round(conf * 100)}% 置信度的目标还差 ${fmtWan(gap)}。`;
    const body = coverage >= 1
      ? `这不是“永远不会破产”的保证，而是 ${Math.round(conf * 100)}% 的模拟情景下不破产。建议保留至少 6–12 个月现金，并每年复盘。`
      : (r.safeCoreMonthlyCurrent <= 0
        ? `按 ${Math.round(conf * 100)}% 置信度，当前资产连固定房贷、保险、医疗和子女支出都无法覆盖，更不用说 ${fmtYuan(r.coreMonthly0)}/月的核心生活。`
        : `当前资产只能支撑约 ${fmtYuan(r.safeCoreMonthlyCurrent)}/月的核心生活费（按 ${Math.round(conf * 100)}% 置信度），低于你设定的 ${fmtYuan(r.coreMonthly0)}/月。`);
    const html = `
      <div class="callout ${color}"><strong>${title}</strong><br>${body}</div>
      <ul class="tight">
        <li><strong>${Math.round(conf * 100)}% 置信度</strong>意味着大约每 ${Math.max(2, Math.round(1 / Math.max(0.001, 1 - conf)))} 条人生路径中有 1 条会失败；要更高把握，看 95% / 99% 区间。</li>
        <li>目标本金约等于 <strong>${multiple ? multiple.toFixed(1) : '—'} 倍</strong>首年总支出（${fmtWan(r.firstYearSpending.total)}）。这不是 25 倍，因为期限约 ${Math.max(0, Number(state.household.planUntil) - Number(state.household.age))} 年，且收益假设更低。</li>
        <li>4% 法则给出 <strong>${fmtWan(r.fourPercent)}</strong>；在本模型下成功率只有 <strong>${fmtPct(r.fourPercentSuccess, 0)}</strong>。4% 是“美国、30 年、特定股债组合”的历史经验，不是自然常数。</li>
        <li>当前资产若现在停止工作，按模型只有 <strong>${fmtPct(r.currentSuccess, 0)}</strong> 的成功率；${r.longN > 0 ? `若活到 90 岁，条件成功率是 <strong>${fmtPct(r.currentSuccessLong, 0)}</strong>。` : `规划终点早于 90 岁，“活到 90 岁条件成功率”不适用。`}</li>
      </ul>`;
    $('#verdict').innerHTML = html;
  }

  function renderConfidenceTable(r, req, conf) {
    const tbody = $('#confidence-table tbody');
    const rows = [80, 90, 95, 99].map(k => {
      const v = r.requiredByConfidence[String(k)] ?? r.required;
      const cls = Math.round(conf * 100) === k ? 'strong' : '';
      return `<tr><td>${k}% ${k === 90 ? '· 推荐' : ''}</td><td class="${cls}">${fmtWan(v)}</td><td>${fmtMultiple(v, r.firstYearSpending.total)}</td></tr>`;
    });
    tbody.innerHTML = rows.join('');
    $('#confidence-note').textContent = '99% 对路径数很敏感：4,000 条路径下的误差约 ±1–2 个百分点，建议用 8,000 条复算；80/90/95% 更稳定。';
  }

  function renderFirstYear(r) {
    const f = r.firstYearSpending;
    const rows = [
      ['核心生活', f.core],
      ['医疗（日常）', f.medical],
      ['商业保险', f.insurance],
      ['房贷 / 居住', f.housing],
      ['子女', f.child],
      ['父母赡养', f.parents || 0],
      ['长期护理', f.ltc || 0],
      ['大件（首年）', f.oneoff || 0],
      ['合计', f.total]
    ];
    $('#first-year-kv').innerHTML = rows.map(([k, v], i) => `<span class="k" ${i === rows.length - 1 ? 'style="font-weight:700;color:#17211b"' : ''}>${k}</span><span class="v" ${i === rows.length - 1 ? 'style="color:#0d5744"' : ''}>${fmtWan(v)}</span>`).join('');
  }

  // ---------- 图表 ----------
  function svgText(x, y, text, anchor, cls) {
    return `<text x="${x}" y="${y}" text-anchor="${anchor || 'middle'}" ${cls ? `class="${cls}"` : ''}>${escapeHtml(text)}</text>`;
  }
  function pathFrom(points) {
    return points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  }

  function drawSuccessChart(r, req, conf) {
    if (!isFinite(req) || req <= 0) {
      $('#chart-success').innerHTML = '<text x="320" y="140" text-anchor="middle" fill="#65706a">当前假设下无法给出有限本金</text>';
      return;
    }
    const W = 640, H = 280, L = 48, R = 14, T = 14, B = 36;
    const iw = W - L - R, ih = H - T - B;
    const xMax = Math.max(req * 2.5, r.currentAssets * 1.15, 1);
    const pts = r.successCurve.filter(p => isFinite(p.wealth)).map(p => {
      const x = L + Math.min(1, p.wealth / xMax) * iw;
      const y = T + ih - p.success * ih;
      return [x, y];
    });
    if (!pts.length) { $('#chart-success').innerHTML = ''; return; }
    let g = '';
    for (let q = 0; q <= 100; q += 25) {
      const y = T + ih - q / 100 * ih;
      g += `<line class="grid" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text x="${L - 8}" y="${y + 3}" text-anchor="end">${q}%</text>`;
    }
    for (let k = 0; k <= 5; k++) {
      const xv = xMax * k / 5;
      const x = L + k / 5 * iw;
      g += `<line class="axis" x1="${x}" y1="${T + ih}" x2="${x}" y2="${T + ih + 4}"/><text x="${x}" y="${H - 12}">${fmtWanShort(xv)}</text>`;
    }
    g += svgText(L + iw / 2, H - 2, '可投资本金（万元）', 'middle');
    g += svgText(14, T + ih / 2, '成功率', 'middle');
    // target
    const yTarget = T + ih - conf * ih;
    g += `<line class="target" x1="${L}" y1="${yTarget}" x2="${W - R}" y2="${yTarget}"/><text x="${W - R}" y="${yTarget - 5}" text-anchor="end" fill="#b8893f">目标 ${Math.round(conf * 100)}%</text>`;
    // area + line
    const area = `M${L},${T + ih} ` + pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0].toFixed(1)},${T + ih} Z`;
    g += `<path class="area" d="${area}"/><path class="line" d="${pathFrom(pts)}"/>`;
    // current
    const xCur = L + Math.min(1, r.currentAssets / xMax) * iw;
    g += `<line class="marker" x1="${xCur}" y1="${T}" x2="${xCur}" y2="${T + ih}"/>`;
    const yCur = T + ih - Math.min(1, r.currentSuccess) * ih;
    g += `<circle class="dot" cx="${xCur}" cy="${yCur}" r="4"/><text x="${Math.min(W - 60, xCur + 6)}" y="${Math.max(T + 12, yCur - 6)}" fill="#a63d35">当前 ${fmtPct(r.currentSuccess, 0)}</text>`;
    // required
    const xReq = L + Math.min(1, req / xMax) * iw;
    g += `<line x1="${xReq}" y1="${T}" x2="${xReq}" y2="${T + ih}" stroke="#0d5744" stroke-dasharray="2 4"/><text x="${Math.min(W - 30, xReq + 5)}" y="${T + 12}" fill="#0d5744">目标 ${fmtWanShort(req)}</text>`;
    $('#chart-success').innerHTML = g;
    $('#curve-tag').textContent = `${Math.round(conf * 100)}% 目标`;
  }

  function drawFanChart(r) {
    const W = 900, H = 300, L = 62, R = 18, T = 16, B = 36;
    const iw = W - L - R, ih = H - T - B;
    const fan = r.fan;
    if (!fan || !fan.ages || !fan.ages.length) {
      $('#chart-fan').innerHTML = '<text x="450" y="150" text-anchor="middle" fill="#65706a">当前参数下没有可展示的资产路径</text>';
      return;
    }
    const ages = fan.ages;
    const maxY = Math.max(1, ...fan.p95);
    const x = a => L + (a - ages[0]) / Math.max(1, ages[ages.length - 1] - ages[0]) * iw;
    const y = v => T + ih - Math.max(0, v) / maxY * ih;
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const v = maxY * k / 4;
      const yy = y(v);
      g += `<line class="grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/><text x="${L - 8}" y="${yy + 3}" text-anchor="end">${fmtWanShort(v)}</text>`;
    }
    const p95 = fan.p95.map((v, i) => [x(ages[i]), y(v)]);
    const p5 = fan.p5.map((v, i) => [x(ages[i]), y(v)]);
    const p75 = fan.p75.map((v, i) => [x(ages[i]), y(v)]);
    const p25 = fan.p25.map((v, i) => [x(ages[i]), y(v)]);
    const med = fan.p50.map((v, i) => [x(ages[i]), y(v)]);
    const area = arrTop => pathFrom(arrTop) + ' L' + p5.slice().reverse().map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' Z';
    // 5-95 uses p95 top; 25-75 uses p75 top and p25 bottom
    const area95 = pathFrom(p95) + ' L' + p5.slice().reverse().map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' Z';
    const area75 = pathFrom(p75) + ' L' + p25.slice().reverse().map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' Z';
    g += `<path class="band" d="${area95}"/><path class="band2" d="${area75}"/><path class="median" d="${pathFrom(med)}"/>`;
    for (let a = Math.ceil(ages[0] / 10) * 10; a <= ages[ages.length - 1]; a += 10) {
      g += `<text x="${x(a)}" y="${H - 12}">${a}岁</text>`;
    }
    g += svgText(L + iw / 2, H - 1, '年龄', 'middle');
    g += svgText(14, T + ih / 2, '资产（今天币值，万元）', 'middle');
    $('#chart-fan').innerHTML = g;
  }

  function drawCashflow(r) {
    const flow = r.cashflow;
    if (!flow || !flow.ages) { $('#chart-cashflow').innerHTML = ''; return; }
    const W = 640, H = 280, L = 46, R = 8, T = 12, B = 38;
    const iw = W - L - R, ih = H - T - B;
    const idx = [];
    for (let i = 0; i < flow.ages.length; i += 5) idx.push(i);
    const totals = idx.map(i => flow.total[i]);
    const maxY = Math.max(1, ...totals);
    const bw = iw / Math.max(1, idx.length) * 0.62;
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const v = maxY * k / 4;
      const yy = T + ih - v / maxY * ih;
      g += `<line class="grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end">${fmtWanShort(v)}</text>`;
    }
    const cats = [['core', 'bar-core'], ['medical', 'bar-med'], ['insurance', 'bar-ins'], ['housing', 'bar-house'], ['child', 'bar-child'], ['parents', 'bar-parents'], ['ltc', 'bar-ltc'], ['oneoff', 'bar-oneoff']];
    idx.forEach((i, j) => {
      const cx = L + (j + 0.5) * (iw / Math.max(1, idx.length));
      let base = T + ih;
      for (const [k, cls] of cats) {
        const v = flow[k][i] || 0;
        const h = v / maxY * ih;
        if (h > 0) {
          base -= h;
          g += `<rect class="${cls}" x="${cx - bw / 2}" y="${base}" width="${bw}" height="${h}" rx="1.5"/>`;
        }
      }
      g += `<text x="${cx}" y="${H - 12}">${flow.ages[i]}岁</text>`;
    });
    g += svgText(L + iw / 2, H - 1, '年龄（每 5 年）', 'middle');
    g += svgText(14, T + ih / 2, '年支出（万元）', 'middle');
    $('#chart-cashflow').innerHTML = g;
    const labels = [['核心', 'bar-core'], ['医疗', 'bar-med'], ['保险', 'bar-ins'], ['居住', 'bar-house'], ['子女', 'bar-child'], ['父母', 'bar-parents'], ['护理', 'bar-ltc'], ['大件', 'bar-oneoff']];
    $('#cashflow-legend').innerHTML = labels.map(([n, c]) => `<span><i class="${c}"></i>${n}</span>`).join('');
  }

  function drawTornado(r) {
    const list = (r.sensitivity || []).slice().sort((a, b) => Math.abs(b.high - b.low) - Math.abs(a.high - a.low));
    if (!list.length || !list.every(s => isFinite(s.low) && isFinite(s.high) && isFinite(s.base))) {
      $('#chart-tornado').innerHTML = '<text x="450" y="170" text-anchor="middle" fill="#65706a">当前参数下无法完成敏感性分析</text>';
      return;
    }
    const W = 900, H = 360, L = 128, R = 30, T = 20, B = 26;
    const iw = W - L - R, ih = H - T - B;
    let lo = Infinity, hi = -Infinity;
    for (const s of list) { lo = Math.min(lo, s.low, s.high, s.base); hi = Math.max(hi, s.low, s.high, s.base); }
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad; hi += pad;
    const x = v => L + (v - lo) / (hi - lo) * iw;
    const rowH = ih / list.length;
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4;
      g += `<line class="grid" x1="${x(v)}" y1="${T}" x2="${x(v)}" y2="${T + ih}"/><text x="${x(v)}" y="${H - 8}">${fmtWanShort(v)}</text>`;
    }
    const xb = x(list[0].base);
    g += `<line x1="${xb}" y1="${T}" x2="${xb}" y2="${T + ih}" stroke="#b8893f" stroke-dasharray="3 4"/>`;
    list.forEach((s, i) => {
      const cy = T + i * rowH + rowH / 2;
      const x1 = x(Math.min(s.low, s.high)), x2 = x(Math.max(s.low, s.high));
      g += `<text x="${L - 10}" y="${cy + 3}" text-anchor="end" fill="#38443d">${escapeHtml(s.name)}</text>`;
      g += `<rect x="${x1}" y="${cy - 6}" width="${Math.max(2, x2 - x1)}" height="12" rx="6" fill="#dcebe4" stroke="#0d5744" stroke-width="0.8"/>`;
      g += `<circle cx="${x1}" cy="${cy}" r="3" fill="#0d5744"/><circle cx="${x2}" cy="${cy}" r="3" fill="#a63d35"/>`;
      g += `<text x="${x1 - 4}" y="${cy - 9}" text-anchor="end" fill="#0d5744">${s.lowLabel || ''} ${fmtWanShort(s.low)}</text>`;
      g += `<text x="${x2 + 4}" y="${cy - 9}" fill="#a63d35">${s.highLabel || ''} ${fmtWanShort(s.high)}</text>`;
    });
    g += svgText(L + iw / 2, H - 1, '所需本金（万元，今天币值）', 'middle');
    $('#chart-tornado').innerHTML = g;
  }

  function renderLifetime(r) {
    const labels = [
      ['core', '核心生活'],
      ['medical', '医疗（日常+大额自付）'],
      ['insurance', '商业保险'],
      ['housing', '房贷/居住'],
      ['child', '子女'],
      ['oneoff', '大件/一次性'],
      ['ltc', '长期护理'],
      ['parents', '父母赡养']
    ];
    const vals = labels.map(([k, n]) => [n, r.lifetimeSpending[k] || 0]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const total = vals.reduce((a, b) => a + b[1], 0) || 1;
    const max = vals.length ? vals[0][1] : 1;
    $('#lifetime-bars').innerHTML = vals.map(([n, v]) => `
      <div class="bar-row"><span>${n}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div><span class="amt"><strong>${fmtWan(v)}</strong><br>${(v / total * 100).toFixed(0)}%</span></div>`).join('');
  }

  function renderStress(r) {
    const grid = $('#stress-grid');
    grid.innerHTML = (r.stress || []).map(s => {
      const p = s.success;
      const cls = p >= 0.8 ? 'ok' : p >= 0.5 ? 'mid' : 'bad';
      const color = p >= 0.8 ? '#0d5744' : p >= 0.5 ? '#b8893f' : '#a63d35';
      return `<div class="stress-item"><div class="n">${escapeHtml(s.name)}</div><div class="v ${cls}">${fmtPct(p, 1)}</div><div class="bar"><i style="width:${Math.max(0, Math.min(100, p * 100))}%;background:${color}"></i></div></div>`;
    }).join('');
  }

  function renderWhy(r, req, conf) {
    if (!isFinite(req)) {
      $('#why-list').innerHTML = '<div class="callout red">当前参数下无法给出有限本金。先检查支出是否填错（例如多了一个 0），再检查收益假设是否低到无法覆盖固定支出。</div>';
      return;
    }
    const real = r.portfolio.expected - r.assumptions.inflationMean;
    const horizon = Math.max(0, Number(state.household.planUntil) - Number(state.household.age));
    const items = [
      `你的规划期限约 <strong>${horizon} 年</strong>。4% 法则来自美国 1926–1992、30 年、50/50 股债的历史回测；期限翻倍，安全提取率通常要下降。`,
      `组合费后几何收益 <strong>${fmtPct(r.portfolio.expected)}</strong>，通胀中枢 <strong>${fmtPct(r.assumptions.inflationMean)}</strong>，实际约 <strong>${fmtPct(real)}</strong>。在低利率环境里，这是比“8% 复利”更现实的假设。`,
      `本模型把医疗、护理、子女、大额支出、长寿、收益率序列和黑天鹅都单独建模；4% 法则没有这些。`,
      `目标本金是 <strong>${Math.round(conf * 100)}% 置信度</strong>下的分位点，不是平均值；零波动几何路径所需本金约 <strong>${fmtWan(r.deterministicRequired)}</strong>，但真实人生会偏离这条路径。`
    ];
    $('#why-list').innerHTML = `<ul class="tight">${items.map(x => `<li>${x}</li>`).join('')}</ul>
      <div class="callout" style="margin-top:10px">“完全”在数学上不存在；本模型把“完全”翻译成“在 90% / 95% / 99% 的模拟人生里不破产”。想要 100%，任何有限本金都无法保证。</div>`;
  }

  // ---------- 假设与来源 ----------
  function renderAssumptions(r) {
    $('#assumptions').innerHTML = `
      <p><strong>口径：</strong>所有金额为今天（2026 年）购买力；年度步长；支出在年初发生；成功 = 死亡前资产从未为负，且死亡时资产 ≥ 遗产目标（按 CPI 指数化）。自住房不计入可投资资产，卖房才计入。</p>
      <p><strong>收益：</strong>资产预期收益按“费后几何年化”理解；蒙特卡洛用算术均值 = 几何 + 0.5×方差；组合波动由配置与相关矩阵计算。当前默认组合费后几何 ${fmtPct(r.portfolio.expected)}、波动 ${fmtPct(r.portfolio.vol)}。</p>
      <p><strong>养老金：</strong>默认按国发〔2005〕38 号公式：基础养老金 =（退休时当地上年度在岗职工月平均工资 + 本人指数化月平均缴费工资）÷2×缴费年限×1%；个人账户养老金 = 个人账户储存额÷计发月数（63 岁 117 个月）。个人账户按记账利率增长，社平工资按名义增长折算成今天币值。实际政策、缴费基数和视同缴费年限会带来偏差。</p>
      <p><strong>关键数据（官方 / 研究 / 行业报价，截至 2026-10）：</strong></p>
      <ul class="tight">
        <li>2025 年全国居民人均消费支出 <strong>29,476 元</strong>，城镇 <strong>35,869 元</strong>；2024 年为 28,227 / 34,557 元（国家统计局）。2025 年北京城镇 54,122 元、上海城镇 57,076 元。</li>
        <li>2024 年 CPI +0.2%，2025 年 0.0%，2026 年 9 月 +0.9%；模型默认 2.0% 是长期中枢假设，不是当前值。</li>
        <li>2025 年人均预期寿命 <strong>79.25 岁</strong>；60 岁后的条件余命没有统一官方单一值，模型用 Weibull 生存曲线近似，属于假设。</li>
        <li>2025 年卫生总费用 93,367.2 亿元，人均 6,637.9 元，个人卫生支出占 27.1%；2025 年职工医保目录内住院报销 84.1%、居民 66.0%。</li>
        <li>2023 年企业退休人员月人均基本养老金 <strong>3,162 元</strong>；2024 年上调 3%、2025 年上调 2%。2026 年城乡居民基础养老金国家最低标准 <strong>163 元/月</strong>。2026 年退休人员调整文件截至数据日未见正式发布，模型不假设“已上调”。</li>
        <li>延迟退休：2025-01-01 起男职工 60→63、女职工 55→58 / 50→55；最低缴费年限 2030 年起由 15 年逐步提高到 20 年。个人养老金：12,000 元/年限额税前扣除，领取时 3% 单独计税。</li>
        <li>2026-10-23：中国 10 年期国债 1.64%，1 年期定存约 0.95%–0.98%，美国 10 年期约 5%。这是“低利率 + 高波动”的现实起点。</li>
        <li>生育成本：育娲人口《中国生育成本报告 2024 版》全国 0–17 岁平均 53.8 万元、0–本科 68 万元（2022 年价格）；本模型子女表是“增量成本”假设，不含家庭共同住房，和报告口径不同。</li>
        <li>保险报价：30 岁男 50 万重疾保至 70 岁约 5,600 元/年；100 万定期寿险保至 60 岁约 1,100–1,250 元/年；百万医疗 30 岁约 300–500 元/年。默认 1.2 万元/年是全家混合假设，实际随产品/体况/缴费期变化。</li>
        <li>护理：芜湖镜湖区政府公示（2025-12）全护理约 2,200–4,600 元/月；一线城市护理型机构常见 9,800–27,400 元/月（行业报价）。模型默认 8,000 元/月，是可编辑假设。</li>
      </ul>
      <p><strong>主要来源：</strong>
        <a href="https://www.stats.gov.cn/xxgk/sjfb/zxfb2020/202601/t20260119_1962321.html" target="_blank" rel="noopener">国家统计局 2025 年居民收支</a> ·
        <a href="https://www.stats.gov.cn/sj/zxfb/202502/t20250228_1958817.html" target="_blank" rel="noopener">2024 年统计公报</a> ·
        <a href="https://www.gov.cn/zhengce/zhengceku/202507/content_7031449.htm" target="_blank" rel="noopener">2025 年养老金调整通知</a> ·
        <a href="https://www.gov.cn/zhengce/202409/content_6974294.htm" target="_blank" rel="noopener">渐进式延迟退休决定</a> ·
        <a href="http://zfgb.fj.gov.cn//6655" target="_blank" rel="noopener">国发〔2005〕38 号</a> ·
        <a href="https://www.chinabond.com.cn/zzsj/zzsj_zzjgcp/zzjgcp_cpdt/cpdt_cpbg/cpbg_qxhzsrp/202610/t20261023_855472794.html" target="_blank" rel="noopener">中债 2026-10-23 收益率</a> ·
        <a href="https://news.cnr.cn/native/gd/20240221/t20240221_526602847.shtml" target="_blank" rel="noopener">生育成本报告报道</a>
      </p>
      <p><strong>没有建模 / 简化：</strong>个人养老金账户税优、海外资产汇率、房产税全国推开、遗产税、离婚/丧偶状态机、子女啃老、诈骗/诉讼、保险拒赔、医保目录变化、地方养老金差异。它们会改变结果，方向不一定。</p>
      <p class="src">模型版本 ${r.meta.version} · 数据日 ${r.meta.asOf} · 本次 ${r.meta.simulations.toLocaleString()} 条路径 · 随机种子 ${r.meta.seed}。结果可复现，但不同随机种子会有约 1–2 个百分点/几个百分点的波动。</p>`;
  }

  // ---------- 启动 ----------
  function init() {
    refreshForm();
    bindInputs();
    setupWorker();
    $('#assumptions').innerHTML = '<p class="help">完成一次计算后显示数据来源、公式和模型边界。</p>';
    setTimeout(calculate, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
