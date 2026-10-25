/* 经济自由本金模型 · 纯 JS 引擎（无 DOM 依赖）
 * 与 src/model.py 使用同一套公式；用于 HTML 计算器与 Node 校验。
 */
(function (global) {
  'use strict';

  const DEFAULTS = __DEFAULTS__;

  // ---------- 基础工具 ----------
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  function deepMerge(base, override) {
    const out = JSON.parse(JSON.stringify(base));
    if (!override) return out;
    for (const k of Object.keys(override)) {
      const v = override[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = JSON.parse(JSON.stringify(v));
      }
    }
    return out;
  }

  function normalize(input) {
    const p = deepMerge(DEFAULTS, input || {});
    const alloc = p.investment.allocation;
    let total = 0;
    for (const k of Object.keys(alloc)) total += Math.max(0, Number(alloc[k]) || 0);
    if (total <= 0) {
      for (const k of Object.keys(alloc)) alloc[k] = 0;
      alloc.cash = 1;
    } else {
      for (const k of Object.keys(alloc)) alloc[k] = Math.max(0, Number(alloc[k]) || 0) / total;
    }
    for (const c of (p.children || [])) {
      if (!p.childCostTable[c.path]) c.path = 'public';
    }
    p.household.adults = Number(p.household.adults) === 2 ? 2 : 1;
    p.household.planUntil = Math.max(Number(p.household.age) + 1, Math.min(110, num(p.household.planUntil, 100)));
    const rawAssets = input && input.assets;
    p.assets = (rawAssets === undefined || rawAssets === null || rawAssets === '') ? 3000000 : Math.max(0, num(rawAssets, 0));
    return p;
  }

  function annuityPayment(principal, rate, years) {
    principal = Number(principal) || 0;
    years = Math.floor(Number(years) || 0);
    if (principal <= 0 || years <= 0) return 0;
    const r = Number(rate) || 0;
    if (Math.abs(r) < 1e-12) return principal / years;
    return principal * r / (1 - Math.pow(1 + r, -years));
  }

  function mortgageBalance(principal, rate, totalYears, paidYears) {
    principal = Number(principal) || 0;
    if (principal <= 0) return 0;
    if (paidYears <= 0) return principal;
    if (paidYears >= totalYears) return 0;
    const r = Number(rate) || 0;
    if (Math.abs(r) < 1e-12) return Math.max(0, principal * (1 - paidYears / totalYears));
    const pmt = annuityPayment(principal, r, totalYears);
    const bal = principal * Math.pow(1 + r, paidYears) - pmt * (Math.pow(1 + r, paidYears) - 1) / r;
    return Math.max(0, bal);
  }

  const MONTHS = { 40:233,41:230,42:226,43:223,44:220,45:216,46:212,47:208,48:204,49:199,50:195,51:190,52:185,53:180,54:175,55:170,56:164,57:158,58:152,59:145,60:139,61:132,62:125,63:117,64:109,65:101,66:93,67:84,68:75,69:65,70:56 };
  function monthsForAge(age) {
    age = Math.max(40, Math.min(70, Math.floor(Number(age) || 60)));
    return MONTHS[age];
  }

  function pensionToday(p, person) {
    const inc = p.income, soc = p.social, h = p.household;
    if (inc.pensionMode === 'none') return 0;
    let years, index, wage, account, startAge, currentAge;
    if (person === 'self') {
      if (inc.pensionMode === 'direct') return Math.max(0, Number(inc.pensionMonthly) || 0);
      years = Number(soc.contribYears) || 0;
      index = Number(soc.contributionIndex) || 1;
      wage = Number(soc.localAverageWage) || 0;
      account = Number(soc.personalAccount) || 0;
      startAge = Number(inc.pensionStartAge) || 60;
      currentAge = Number(h.age) || 40;
    } else {
      if (inc.pensionMode === 'direct') return Math.max(0, Number(inc.spousePensionMonthly) || 0);
      years = Number(soc.spouseContribYears) || 0;
      index = Number(soc.spouseContributionIndex) || 1;
      wage = Number(soc.spouseLocalAverageWage) || 0;
      account = Number(soc.spousePersonalAccount) || 0;
      startAge = Number(inc.spousePensionStartAge) || 55;
      currentAge = Number(h.spouseAge) || Number(h.age) || 40;
    }
    if (years < num(soc.minContribYears, 20)) return 0;
    const n = Math.max(0, startAge - currentAge);
    const infl = Math.max(0, num(p.risk.inflationMean, 0.02));
    const wageG = num(soc.socialWageGrowth, 0.03);
    const acctG = num(soc.accountRate, 0.03);
    const realWageG = (1 + wageG) / (1 + infl) - 1;
    const realAcctG = (1 + acctG) / (1 + infl) - 1;
    const wageToday = wage * Math.pow(1 + realWageG, n);
    const accountToday = account * Math.pow(1 + realAcctG, n);
    const base = wageToday * (1 + index) / 2 * years * 0.01;
    const personal = accountToday > 0 ? accountToday / monthsForAge(startAge) : 0;
    return Math.max(0, base + personal);
  }

  function portfolioStats(p) {
    const inv = p.investment;
    const keys = Object.keys(inv.allocation);
    let muArithGross = 0, variance = 0;
    for (const k of keys) muArithGross += inv.allocation[k] * Number(inv.expected[k]);
    for (let i = 0; i < keys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        const a = keys[i], b = keys[j];
        const corr = a === b ? 1 : Number(inv.corr[a + '-' + b] ?? inv.corr[b + '-' + a] ?? 0);
        variance += inv.allocation[a] * inv.allocation[b] * Number(inv.vol[a]) * Number(inv.vol[b]) * corr;
      }
    }
    variance = Math.max(0, variance);
    let sigma = Math.sqrt(variance);
    let muGeomGross = muArithGross - 0.5 * variance;
    let muGeom = muGeomGross - Number(inv.fee || 0) - Number(inv.taxDrag || 0);
    let muArith = muGeom + 0.5 * variance;
    if (inv.overrideReturn !== null && inv.overrideReturn !== undefined) {
      muGeom = Number(inv.overrideReturn);
      muArith = muGeom + 0.5 * variance;
    }
    if (inv.overrideVol !== null && inv.overrideVol !== undefined) {
      sigma = Number(inv.overrideVol);
      muArith = muGeom + 0.5 * sigma * sigma;
    }
    muGeom = Math.min(0.15, Math.max(-0.05, muGeom));
    sigma = Math.min(0.40, Math.max(0.005, sigma));
    return { arith: muArith, geom: muGeom, vol: sigma, grossArith: muArithGross, grossGeom: muGeomGross };
  }

  function spendCurveFactor(age, fiAge, curve) {
    if (age <= fiAge) return 1;
    const pts = curve.map(x => [Number(x[0]), Number(x[1])]).sort((a, b) => a[0] - b[0]);
    if (age <= pts[0][0]) return pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a1, f1] = pts[i], [a2, f2] = pts[i + 1];
      if (age <= a2) return a2 === a1 ? f2 : f1 + (f2 - f1) * (age - a1) / (a2 - a1);
    }
    return pts[pts.length - 1][1];
  }

  function childStage(age) {
    if (age < 0) return null;
    if (age < 3) return '0-2';
    if (age < 6) return '3-5';
    if (age < 12) return '6-11';
    if (age < 15) return '12-14';
    if (age < 18) return '15-17';
    if (age < 22) return '18-21';
    if (age < 25) return '22-24';
    return null;
  }

  function childAnnualCost(p, child, age) {
    if (age < 0 || age > Number(child.supportUntil ?? 22)) return 0;
    if (age >= 22 && !child.postgrad) return 0;
    const stage = childStage(age);
    if (!stage) return 0;
    const table = p.childCostTable[child.path || 'public'];
    return Number(table[stage] || 0) * Number(child.multiplier ?? 1);
  }

  // ---------- 随机数 ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function makeNormal(rng) {
    let spare = null;
    return function () {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = 0, v = 0, s = 0;
      do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * m;
      return u * m;
    };
  }

  function sampleDeathAge(rng, normal, currentAge, sex, scaleMult) {
    const k = 3.6;
    const scale = (sex === 'female' ? 28.5 : 26.5) * Math.max(0.7, Number(scaleMult) || 1);
    const u = Math.max(1e-12, rng());
    let s;
    if (currentAge <= 60) {
      s = u;
    } else {
      const s0 = Math.exp(-Math.pow((currentAge - 60) / scale, k));
      s = Math.max(1e-12, s0 * u);
    }
    return 60 + scale * Math.pow(-Math.log(s), 1 / k);
  }

  // ---------- 冲击 ----------
  function buildShocks(p, nPaths, seed, mode) {
    mode = mode || 'stochastic';
    seed = seed ?? Number(p.risk.seed) ?? 20261025;
    const rng = mulberry32(seed >>> 0);
    const normal = makeNormal(rng);
    const stats = portfolioStats(p);
    const mu = mode === 'deterministic' ? stats.geom : stats.arith;
    const sigma = stats.vol;
    const h = p.household, risk = p.risk;
    const maxAgeSelf = Math.floor(h.planUntil);
    const maxAgeSpouse = maxAgeSelf;
    const age0 = Math.floor(h.age);
    const adults = Number(h.adults) === 2 ? 2 : 1;
    const spouseAge0 = Math.floor(h.spouseAge || age0);
    const T = Math.max(1, maxAgeSelf - age0 + 1, adults === 2 ? maxAgeSpouse - spouseAge0 + 1 : 1);
    const N = Math.max(1, Math.floor(nPaths));

    const ret = new Float32Array(N * T);
    const pi = new Float32Array(N * T);
    const cpi = new Float32Array(N * T);
    const med = new Float32Array(N * T);
    const edu = new Float32Array(N * T);
    const house = new Float32Array(N * T);
    const deathSelf = new Float32Array(N);
    const deathSpouse = new Float32Array(N);
    const medSelf = new Float32Array(N * T);
    const medSpouse = new Float32Array(N * T);
    const ltcStartSelf = new Int16Array(N);
    const ltcDurSelf = new Int16Array(N);
    const ltcStartSpouse = new Int16Array(N);
    const ltcDurSpouse = new Int16Array(N);
    ltcStartSelf.fill(-1); ltcStartSpouse.fill(-1);

    const df = Math.max(3, Math.round(num(risk.tdf, 5)));
    const rho = num(risk.returnInflationCorr, 0);
    const std = Math.sqrt((df - 2) / df);
    const muPi = num(risk.inflationMean, 0.02);
    const sdPi = num(risk.inflationVol, 0.012);
    const phi = num(risk.inflationPersistence, 0.55);
    const innovSd = sdPi * Math.sqrt(Math.max(0, 1 - phi * phi));
    const crashProb = num(risk.crashProb, 0);
    const crashSize = num(risk.crashSize, -0.2);
    const spreadMed = num(risk.medicalInflationSpread, 0.03);
    const spreadEdu = num(risk.educationInflationSpread, 0.03);
    const spreadHouse = num(risk.housingInflationSpread, 0);

    for (let i = 0; i < N; i++) {
      const base = i * T;
      let prevPi = 0;
      let cpiIdx = 1, medIdx = 1, eduIdx = 1, houseIdx = 1;
      for (let t = 0; t < T; t++) {
        let r, pv;
        if (mode === 'deterministic') {
          r = mu; pv = muPi;
        } else {
          // 二元 t：共同 chi-square 混合，保留收益-通胀相关
          let chi = 0;
          for (let k = 0; k < df; k++) { const g = normal(); chi += g * g; }
          chi /= df;
          const z1 = normal();
          const z2 = rho * z1 + Math.sqrt(Math.max(0, 1 - rho * rho)) * normal();
          const t1 = z1 / Math.sqrt(chi) * std;
          const t2 = z2 / Math.sqrt(chi) * std;
          r = mu + sigma * t1;
          if (t === 0) pv = muPi + sdPi * t2;
          else pv = muPi + phi * (prevPi - muPi) + innovSd * t2;
          pv = Math.max(-0.02, Math.min(0.15, pv));
          if (crashProb > 0 && rng() < crashProb) r += crashSize;
          r = Math.max(-0.9, Math.min(1.5, r));
        }
        prevPi = pv;
        ret[base + t] = r;
        pi[base + t] = pv;
        if (t === 0) {
          cpi[base] = 1; med[base] = 1; edu[base] = 1; house[base] = 1;
        } else {
          cpiIdx *= 1 + Math.max(-0.05, pi[base + t - 1]);
          medIdx *= 1 + Math.max(-0.05, pi[base + t - 1] + spreadMed);
          eduIdx *= 1 + Math.max(-0.05, pi[base + t - 1] + spreadEdu);
          houseIdx *= 1 + Math.max(-0.05, pi[base + t - 1] + spreadHouse);
          cpi[base + t] = cpiIdx; med[base + t] = medIdx; edu[base + t] = eduIdx; house[base + t] = houseIdx;
        }
      }

      if (mode === 'deterministic' || h.longevityMode === 'fixed') {
        deathSelf[i] = maxAgeSelf; deathSpouse[i] = maxAgeSpouse;
      } else {
        deathSelf[i] = Math.min(maxAgeSelf, sampleDeathAge(rng, normal, age0, h.selfSex || 'male', risk.longevityScale));
        deathSpouse[i] = adults === 2 ? Math.min(maxAgeSpouse, sampleDeathAge(rng, normal, spouseAge0, h.spouseSex || 'female', risk.longevityScale)) : 0;
      }

      if (mode !== 'deterministic') {
        const medBase = num(risk.medicalShockBaseProb, 0.006);
        const medSlope = num(risk.medicalShockAgeSlope, 0.0002);
        const medMedian = num(risk.medicalShockMedian, 150000);
        const medSigma = num(risk.medicalShockSigma, 0.85);
        for (let t = 0; t < T; t++) {
          const ageS = age0 + t;
          const pS = Math.min(0.10, medBase + medSlope * Math.max(0, ageS - 40));
          if (rng() < pS) medSelf[base + t] = Math.min(2000000, medMedian * Math.exp(medSigma * normal()));
          if (adults === 2) {
            const ageP = spouseAge0 + t;
            const pP = Math.min(0.10, medBase + medSlope * Math.max(0, ageP - 40));
            if (rng() < pP) medSpouse[base + t] = Math.min(2000000, medMedian * Math.exp(medSigma * normal()));
          }
        }
      }

      if (mode !== 'deterministic') {
        const ltcBase = num(risk.ltcBaseProb, 0.005);
        const ltcSlope = num(risk.ltcAgeSlope, 0.0015);
        const durMean = num(risk.ltcDurationYears, 4);
        for (const person of ['self', 'spouse']) {
          if (person === 'spouse' && adults !== 2) continue;
          const startAge = person === 'self' ? age0 : spouseAge0;
          const death = person === 'self' ? deathSelf[i] : deathSpouse[i];
          let onset = -1;
          for (let t = 0; t < T; t++) {
            const a = startAge + t;
            if (a < 65 || a >= death) continue;
            const prob = Math.min(0.15, ltcBase + ltcSlope * (a - 65));
            if (rng() < prob) { onset = t; break; }
          }
          if (onset >= 0) {
            const dur = Math.max(1, Math.round(durMean * (0.5 + rng())));
            if (person === 'self') { ltcStartSelf[i] = onset; ltcDurSelf[i] = dur; }
            else { ltcStartSpouse[i] = onset; ltcDurSpouse[i] = dur; }
          }
        }
      }
    }

    return { N, T, ret, pi, cpi, med, edu, house, deathSelf, deathSpouse, medSelf, medSpouse, ltcStartSelf, ltcDurSelf, ltcStartSpouse, ltcDurSpouse };
  }

  // ---------- 单路径 ----------
  function simulateOne(p, W0, sh, i, collectWealth, collectFlow, wealth, flow) {
    const h = p.household, inc = p.income, sp = p.spending, hou = p.housing, risk = p.risk, ins = p.insurance;
    const adults = Number(h.adults) === 2 ? 2 : 1;
    const age0 = Math.floor(h.age);
    const fiAge = Math.floor(h.fiAge ?? age0);
    const yearsToFi = Math.max(0, fiAge - age0);
    const T = sh.T;
    const base = i * T;
    const spouseAge0 = Math.floor(h.spouseAge || age0);
    const selfDeath = sh.deathSelf[i];
    const spouseDeath = adults === 2 ? sh.deathSpouse[i] : 0;
    const deathHousehold = adults === 2 ? Math.max(selfDeath, spouseDeath) : selfDeath;

    const monthly = sp.monthly;
    let coreMonthly = 0;
    for (const k of Object.keys(monthly)) if (k !== 'medical' && k !== 'insurance') coreMonthly += Number(monthly[k]) || 0;
    const medicalMonthly = Number(monthly.medical) || 0;
    const monthlyInsurance = Number(monthly.insurance) || 0;
    const insuranceAnnual = Number(ins.annualPremium ?? monthlyInsurance * 12) || 0;
    const coreAnnual = coreMonthly * 12;

    const pensionSelfToday = pensionToday(p, 'self');
    const pensionSpouseToday = adults === 2 ? pensionToday(p, 'spouse') : 0;
    const pensionStartSelf = Number(inc.pensionStartAge) || 60;
    const pensionStartSpouse = Number(inc.spousePensionStartAge) || 55;
    const cola = num(inc.pensionCOLA, 0.02);

    const mortgagePmt = annuityPayment(hou.mortgageBalance, hou.mortgageRate, hou.mortgageYearsLeft);
    let annualExpenseNow = coreAnnual + medicalMonthly * 12 + insuranceAnnual + mortgagePmt;
    annualExpenseNow += (Number(p.parents.annualSupport) || 0);
    for (const c of (p.children || [])) annualExpenseNow += childAnnualCost(p, c, Number(c.age) || 0);
    let savings0 = 0;
    if (inc.savingsMode === 'auto') {
      const salary = (Number(inc.salary) || 0) + (adults === 2 ? Number(inc.spouseSalary) || 0 : 0);
      savings0 = Math.max(0, salary - annualExpenseNow);
    } else {
      savings0 = Math.max(0, Number(inc.savingsAnnual) || 0);
    }
    const sellAge = Number(hou.sellAge) || 0;
    const sellT = sellAge > 0 ? Math.max(0, sellAge - age0) : null;
    const homeValue = Number(hou.homeValue) || 0;
    const houseGrowth = Number(hou.houseGrowth) || 0;
    const propertyTaxRate = Number(hou.propertyTaxRate) || 0;
    const rentAfter = Number(hou.rentAfterSell) || 0;
    const sellCost = Number(hou.sellCostRate ?? 0.03);

    let penSelfNom = null, penSpouseNom = null;
    const ltcStartSelf = sh.ltcStartSelf[i], ltcDurSelf = sh.ltcDurSelf[i];
    const ltcStartSpouse = adults === 2 ? sh.ltcStartSpouse[i] : -1;
    const ltcDurSpouse = adults === 2 ? sh.ltcDurSpouse[i] : 0;

    let W = Number(W0) - (Number(p.parents.medicalReserve) || 0);
    if (W < 0) return { success: false, ruinAge: age0, deathHousehold };

    let ruinAge = null;
    for (let t = 0; t < T; t++) {
      const ageS = age0 + t, ageP = spouseAge0 + t;
      const selfAlive = ageS < selfDeath;
      const spouseAlive = adults === 2 && ageP < spouseDeath;
      if (!selfAlive && !spouseAlive) break;

      const cpi = sh.cpi[base + t], med = sh.med[base + t], edu = sh.edu[base + t], house = sh.house[base + t];

      let income = 0;
      if (t < yearsToFi) income += savings0 * cpi;
      if (selfAlive && ageS >= pensionStartSelf && pensionSelfToday > 0) {
        if (penSelfNom === null) penSelfNom = pensionSelfToday * cpi; else penSelfNom *= 1 + cola;
        income += penSelfNom;
      }
      if (spouseAlive && ageP >= pensionStartSpouse && pensionSpouseToday > 0) {
        if (penSpouseNom === null) penSpouseNom = pensionSpouseToday * cpi; else penSpouseNom *= 1 + cola;
        income += penSpouseNom;
      }
      if (selfAlive || spouseAlive) income += (Number(inc.rentalAnnual) || 0) * cpi;
      if (t < (Number(inc.partTimeYears) || 0) && (selfAlive || spouseAlive)) income += (Number(inc.partTimeAnnual) || 0) * cpi;
      for (const inflow of (inc.oneTimeInflows || [])) {
        if (Number(inflow.age) === ageS) income += (Number(inflow.amount) || 0) * cpi;
      }

      let aliveFactor = 1;
      if (adults === 2 && !(selfAlive && spouseAlive)) aliveFactor = Number(h.singleSpendingFactor ?? 0.72);
      const retireFactor = t < yearsToFi ? 1 : Number(sp.retirementFactor ?? 0.9);
      const curveFactor = spendCurveFactor(ageS, fiAge, sp.curve);
      let core = coreAnnual * cpi * aliveFactor * retireFactor * curveFactor;
      const medicalRoutine = medicalMonthly * 12 * med * aliveFactor;
      const premiumIdx = cpi * Math.pow(1 + num(ins.premiumRealGrowth, 0.03), t);
      const insurancePremium = insuranceAnnual * premiumIdx * aliveFactor;

      let ltcActive = 0;
      if (ltcStartSelf >= 0 && t >= ltcStartSelf && t < ltcStartSelf + ltcDurSelf && selfAlive) ltcActive++;
      if (ltcStartSpouse >= 0 && t >= ltcStartSpouse && t < ltcStartSpouse + ltcDurSpouse && spouseAlive) ltcActive++;
      if (ltcActive) core *= Math.max(0.4, 1 - num(risk.ltcLivingOffset, 0.2) * ltcActive / adults);

      let childCost = 0;
      for (const c of (p.children || [])) {
        const ca = (Number(c.age) || 0) + t;
        childCost += childAnnualCost(p, c, ca) * edu;
        if (Number(c.marriageAge ?? 28) === ca && (Number(c.marriageSupport) || 0) > 0) childCost += Number(c.marriageSupport) * cpi;
      }

      let parentCost = 0;
      if (t < (Number(p.parents.years) || 0)) parentCost = (Number(p.parents.annualSupport) || 0) * cpi;
      const mortgage = t < (Number(hou.mortgageYearsLeft) || 0) ? mortgagePmt : 0;

      let oneoff = 0;
      for (const o of (sp.oneOffs || [])) {
        const start = Number(o.startAge ?? 999), every = Math.max(1, Number(o.every) || 1), end = Number(o.endAge ?? start);
        if (ageS >= start && ageS <= end && (ageS - start) % every === 0) oneoff += (Number(o.amount) || 0) * cpi;
      }

      let medOop = 0;
      const eligibleShare = Number(ins.eligibleShare ?? 0.8);
      const social = Number(ins.medicalReimbursement ?? 0.7);
      const commercial = Number(ins.commercialCoverage ?? 0.6);
      const deductible = Number(ins.deductible) || 0;
      if (selfAlive) {
        const cost = sh.medSelf[base + t];
        if (cost > 0) {
          const eligible = cost * eligibleShare;
          const covered = Math.max(0, eligible - deductible);
          const reimb = covered * social + covered * (1 - social) * commercial;
          medOop += Math.max(0, cost - reimb);
        }
      }
      if (spouseAlive) {
        const cost = sh.medSpouse[base + t];
        if (cost > 0) {
          const eligible = cost * eligibleShare;
          const covered = Math.max(0, eligible - deductible);
          const reimb = covered * social + covered * (1 - social) * commercial;
          medOop += Math.max(0, cost - reimb);
        }
      }

      let ltcCost = 0;
      if (ltcStartSelf >= 0 && t >= ltcStartSelf && t < ltcStartSelf + ltcDurSelf && selfAlive) {
        ltcCost += num(risk.ltcCostMonthly, 8000) * 12 * med * (1 - num(risk.ltcCoverage, 0));
      }
      if (ltcStartSpouse >= 0 && t >= ltcStartSpouse && t < ltcStartSpouse + ltcDurSpouse && spouseAlive) {
        ltcCost += num(risk.ltcCostMonthly, 8000) * 12 * med * (1 - num(risk.ltcCoverage, 0));
      }

      let propertyTax = 0;
      if (homeValue > 0 && (sellT === null || t < sellT)) propertyTax = homeValue * Math.pow(1 + houseGrowth, t) * propertyTaxRate;
      let saleInflow = 0;
      if (sellT !== null && t === sellT) {
        const hv = homeValue * Math.pow(1 + houseGrowth, t);
        const bal = mortgageBalance(hou.mortgageBalance, hou.mortgageRate, hou.mortgageYearsLeft, t);
        saleInflow = hv - bal - hv * sellCost;
        propertyTax = 0;
      }
      let rent = 0;
      if (sellT !== null && t >= sellT) rent = rentAfter * 12 * house;

      const expenses = core + medicalRoutine + insurancePremium + childCost + parentCost + mortgage + oneoff + medOop + ltcCost + propertyTax + rent;
      W = W + income - expenses + saleInflow;
      if (W < 0) { ruinAge = ageS; break; }

      if (collectWealth) wealth[base + t] = W / cpi;
      if (collectFlow) {
        flow.age[t] = ageS;
        flow.core[t] = core / cpi;
        flow.child[t] = childCost / cpi;
        flow.medical[t] = (medicalRoutine + medOop) / cpi;
        flow.ltc[t] = ltcCost / cpi;
        flow.insurance[t] = insurancePremium / cpi;
        flow.housing[t] = (mortgage + propertyTax + rent) / cpi;
        flow.oneoff[t] = oneoff / cpi;
        flow.parents[t] = parentCost / cpi;
        flow.income[t] = income / cpi;
        flow.total[t] = expenses / cpi;
      }

      W *= 1 + sh.ret[base + t];
    }

    if (ruinAge === null) {
      const deathIdx = Math.min(T - 1, Math.max(0, Math.ceil(deathHousehold) - age0));
      const cpiEnd = sh.cpi[base + deathIdx];
      const bequest = (Number(risk.bequest) || 0) * cpiEnd;
      if (W < bequest) ruinAge = Math.ceil(deathHousehold);
    }
    return { success: ruinAge === null, ruinAge, deathHousehold };
  }

  function successRate(p, W0, sh, collect, longAge) {
    longAge = longAge ?? 90;
    let ok = 0, longOk = 0, longN = 0;
    const ruinAges = [];
    let wealth = null;
    if (collect) { wealth = new Float32Array(sh.N * sh.T); wealth.fill(NaN); }
    for (let i = 0; i < sh.N; i++) {
      const r = simulateOne(p, W0, sh, i, collect, false, wealth, null);
      if (r.success) ok++;
      else if (r.ruinAge !== null) ruinAges.push(r.ruinAge);
      if (r.deathHousehold >= longAge) { longN++; if (r.success) longOk++; }
    }
    return { success: sh.N ? ok / sh.N : 0, successLong: longN ? longOk / longN : 0, longN, ruinAges, wealth };
  }

  function requiredCapital(p, confidence, nPaths, seed, mode, maxIter) {
    confidence = confidence ?? 0.9;
    nPaths = nPaths ?? 4000;
    mode = mode || 'stochastic';
    maxIter = maxIter ?? 16;
    const sh = buildShocks(p, nPaths, seed, mode);
    const reserve = Number(p.parents.medicalReserve) || 0;
    const monthly = Object.values(p.spending.monthly).reduce((a, b) => a + Number(b || 0), 0);
    const annual = monthly * 12 + annuityPayment(p.housing.mortgageBalance, p.housing.mortgageRate, p.housing.mortgageYearsLeft);
    let upper = Math.max(2000000, annual * 60, reserve * 2);
    const succ = w => successRate(p, w, sh, false).success;
    while (succ(upper) < confidence && upper < 1e12) upper *= 1.7;
    if (succ(upper) < confidence) return { req: Infinity, shocks: sh, converged: false };
    if (succ(0) >= confidence) return { req: 0, shocks: sh, converged: true };
    let lo = 0, hi = upper;
    for (let k = 0; k < maxIter; k++) {
      const mid = (lo + hi) / 2;
      if (succ(mid) >= confidence) hi = mid; else lo = mid;
    }
    return { req: hi, shocks: sh, converged: true };
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q / 100;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function interpolateRequired(curve, confidence) {
    const arr = curve.slice().sort((a, b) => a.w - b.w);
    if (!arr.length) return NaN;
    if (confidence <= arr[0].success) return 0;
    if (confidence >= arr[arr.length - 1].success) return arr[arr.length - 1].w * 1.5;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      if (a.success <= confidence && confidence <= b.success) {
        if (b.success === a.success) return b.w;
        return a.w + (b.w - a.w) * (confidence - a.success) / (b.success - a.success);
      }
    }
    return arr[arr.length - 1].w;
  }

  function safeCoreSpending(p, req, sh, confidence) {
    const coreKeys = Object.keys(p.spending.monthly).filter(k => k !== 'medical' && k !== 'insurance');
    const coreMonthly = coreKeys.reduce((a, k) => a + Number(p.spending.monthly[k] || 0), 0);
    if (!(req > 0) || !isFinite(req)) return [0, 0];
    const succ = mult => {
      const pp = JSON.parse(JSON.stringify(p));
      for (const k of coreKeys) pp.spending.monthly[k] = Number(pp.spending.monthly[k]) * mult;
      return successRate(pp, req, sh, false).success;
    };
    if (succ(3) >= confidence) return [coreMonthly * 3, coreMonthly * 3 * 12];
    if (succ(1e-6) < confidence) return [0, 0];
    let lo = 0, hi = 3;
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2;
      if (succ(mid) >= confidence) lo = mid; else hi = mid;
    }
    return [coreMonthly * lo, coreMonthly * lo * 12];
  }

  function makeFlow(T) {
    return { age: new Float32Array(T), core: new Float32Array(T), child: new Float32Array(T), medical: new Float32Array(T), ltc: new Float32Array(T), insurance: new Float32Array(T), housing: new Float32Array(T), oneoff: new Float32Array(T), parents: new Float32Array(T), income: new Float32Array(T), total: new Float32Array(T) };
  }

  function runModel(input, nPaths) {
    const p = normalize(input);
    const confidence = num(p.risk.confidence, 0.9);
    const n = Math.max(400, Math.floor(nPaths || p.risk.simulations || 6000));
    const seed = Number(p.risk.seed) || 20261025;

    const main = requiredCapital(p, confidence, n, seed, 'stochastic', 15);
    const req = main.req;
    const sh = main.shocks;

    const finiteReq = isFinite(req);
    const factors = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
    const curve = finiteReq ? factors.map(f => {
      const w = Math.max(0, req * f);
      return { w, success: successRate(p, w, sh, false).success };
    }) : [];
    const current = num(p.assets, 0);
    const currentStats = successRate(p, current, sh, false);
    const reqs = finiteReq ? { 80: interpolateRequired(curve, 0.8), 90: interpolateRequired(curve, 0.9), 95: interpolateRequired(curve, 0.95), 99: interpolateRequired(curve, 0.99) } : { 80: Infinity, 90: Infinity, 95: Infinity, 99: Infinity };
    const confKey = String(Math.round(confidence * 100));
    if (finiteReq && reqs[confKey] !== undefined) reqs[confKey] = req;

    // 确定性路径
    const det = requiredCapital(p, confidence, 1, seed, 'deterministic', 20);
    const detSh = buildShocks(p, 1, seed, 'deterministic');
    const flow = makeFlow(detSh.T);
    simulateOne(p, det.req, detSh, 0, false, true, null, flow);
    const firstYear = {
      total: flow.total[0], core: flow.core[0], medical: flow.medical[0],
      insurance: flow.insurance[0], housing: flow.housing[0], child: flow.child[0],
      oneoff: flow.oneoff[0], parents: flow.parents[0], ltc: flow.ltc[0]
    };
    const lifetime = { core: 0, child: 0, medical: 0, ltc: 0, insurance: 0, housing: 0, oneoff: 0, parents: 0 };
    for (let t = 0; t < detSh.T; t++) {
      lifetime.core += flow.core[t]; lifetime.child += flow.child[t]; lifetime.medical += flow.medical[t];
      lifetime.ltc += flow.ltc[t]; lifetime.insurance += flow.insurance[t]; lifetime.housing += flow.housing[t];
      lifetime.oneoff += flow.oneoff[t]; lifetime.parents += flow.parents[t];
    }

    // 蒙特卡洛分布
    const mc = finiteReq ? successRate(p, req, sh, true, 90) : { ruinAges: [], wealth: null };
    const fan = { ages: [] };
    for (let q of [5, 25, 50, 75, 95]) fan['p' + q] = [];
    if (finiteReq) {
      for (let t = 0; t < sh.T; t++) {
        fan.ages.push(Math.floor(p.household.age) + t);
        const vals = [];
        for (let i = 0; i < sh.N; i++) {
          const v = mc.wealth[i * sh.T + t];
          if (!Number.isNaN(v)) vals.push(v);
        }
        vals.sort((a, b) => a - b);
        for (let q of [5, 25, 50, 75, 95]) fan['p' + q].push(percentile(vals, q));
      }
    }

    const coreMonthly0 = Object.keys(p.spending.monthly).filter(k => k !== 'medical' && k !== 'insurance').reduce((a, k) => a + Number(p.spending.monthly[k] || 0), 0);
    const [safeMonthCurrent, safeAnnualCurrent] = safeCoreSpending(p, current, sh, confidence);
    const fourPctCap = firstYear.total / 0.04;
    const fourPctSuccess = fourPctCap > 0 ? successRate(p, fourPctCap, sh, false).success : 0;

    // 敏感性（同一样本、同一路径数）
    const sensPaths = Math.max(800, Math.floor(n / 5));
    const baseSens = requiredCapital(p, confidence, sensPaths, seed, 'stochastic', 10).req;
    const baseStats = portfolioStats(p);
    const scenarios = [
      ['日常支出', { spending: { monthly: mapValues(p.spending.monthly, v => v * 0.8) } }, { spending: { monthly: mapValues(p.spending.monthly, v => v * 1.2) } }, '-20%', '+20%'],
      ['投资净收益', { investment: { overrideReturn: baseStats.geom + 0.015 } }, { investment: { overrideReturn: baseStats.geom - 0.015 } }, '+1.5%', '-1.5%'],
      ['通胀中枢', { risk: { inflationMean: Math.max(0, p.risk.inflationMean - 0.01) } }, { risk: { inflationMean: p.risk.inflationMean + 0.01 } }, '-1%', '+1%'],
      ['医疗通胀', { risk: { medicalInflationSpread: Math.max(0, p.risk.medicalInflationSpread - 0.02) } }, { risk: { medicalInflationSpread: p.risk.medicalInflationSpread + 0.02 } }, '-2%', '+2%'],
      ['子女成本', { children: p.children.map(c => ({ ...c, multiplier: Number(c.multiplier || 1) * 0.7 })) }, { children: p.children.map(c => ({ ...c, multiplier: Number(c.multiplier || 1) * 1.3 })) }, '-30%', '+30%'],
      ['养老金', { income: { pensionMode: 'direct', pensionMonthly: pensionToday(p, 'self') * 1.2, spousePensionMonthly: pensionToday(p, 'spouse') * 1.2 } }, { income: { pensionMode: 'direct', pensionMonthly: pensionToday(p, 'self') * 0.7, spousePensionMonthly: pensionToday(p, 'spouse') * 0.7 } }, '+20%', '-30%'],
      ['护理成本', { risk: { ltcCostMonthly: p.risk.ltcCostMonthly * 0.5 } }, { risk: { ltcCostMonthly: p.risk.ltcCostMonthly * 1.5 } }, '-50%', '+50%'],
      ['寿命', { risk: { longevityScale: 0.9 } }, { risk: { longevityScale: 1.1 } }, '-10%', '+10%']
    ];
    const sensitivity = [];
    for (const [name, lowOv, highOv, lowLabel, highLabel] of scenarios) {
      const low = requiredCapital(deepMerge(p, lowOv), confidence, sensPaths, seed, 'stochastic', 10).req;
      const high = requiredCapital(deepMerge(p, highOv), confidence, sensPaths, seed, 'stochastic', 10).req;
      sensitivity.push({ name, low, high, base: baseSens, lowLabel, highLabel });
    }

    // 压力测试
    const stressScenarios = [
      ['基准', {}],
      ['退休后前3年连续大跌', { sequenceCrash: true }],
      ['滞胀10年（通胀5%）', { stagflation: true }],
      ['日本化20年（收益1%）', { japan: true }],
      ['养老金下调30%', { pensionCut: 0.3 }],
      ['活到105岁', { longLife: true }]
    ];
    const stress = [];
    for (const [name, opt] of stressScenarios) {
      const pp = JSON.parse(JSON.stringify(p));
      if (opt.pensionCut) {
        pp.income.pensionMode = 'direct';
        pp.income.pensionMonthly = pensionToday(p, 'self') * (1 - opt.pensionCut);
        pp.income.spousePensionMonthly = pensionToday(p, 'spouse') * (1 - opt.pensionCut);
      }
      if (opt.longLife) { pp.household.longevityMode = 'fixed'; pp.household.planUntil = 105; }
      const ssh = buildShocks(pp, Math.max(1000, Math.floor(n / 2)), seed, 'stochastic');
      if (opt.sequenceCrash) {
        for (let t = 0; t < Math.min(3, ssh.T); t++) for (let i = 0; i < ssh.N; i++) ssh.ret[i * ssh.T + t] -= [0.35, 0.25, 0.15][t];
      }
      if (opt.stagflation) {
        for (let t = 0; t < Math.min(10, ssh.T); t++) {
          for (let i = 0; i < ssh.N; i++) { ssh.pi[i * ssh.T + t] = 0.05; ssh.ret[i * ssh.T + t] = -0.02; }
        }
        rebuildIndices(ssh, p.risk);
      }
      if (opt.japan) {
        for (let t = 0; t < Math.min(20, ssh.T); t++) for (let i = 0; i < ssh.N; i++) { ssh.ret[i * ssh.T + t] = 0.01; ssh.pi[i * ssh.T + t] = 0; }
      }
      stress.push({ name, success: successRate(pp, req, ssh, false).success });
    }

    const warnings = [];
    if (!isFinite(req)) warnings.push('在当前假设下，即使本金极高也很难达到目标置信度；请检查支出、寿命或收益假设。');
    if (currentStats.success < confidence) warnings.push(`当前资产的成功率为 ${(currentStats.success * 100).toFixed(1)}%，低于目标 ${(confidence * 100).toFixed(0)}%。`);
    if (p.income.pensionMode === 'formula' && Number(p.social.contribYears) < 20) warnings.push('缴费年限少于 20 年：2030 年后退休的最低缴费年限将逐步提高到 20 年，养老金可能低于模型值。');
    if (p.household.longevityMode === 'fixed') warnings.push('当前使用固定寿命假设；真实长寿风险可能高于此。');
    if (Number(p.risk.ltcCoverage) === 0) warnings.push('长期护理保险覆盖为 0：失能护理费用全部由本金承担。');

    return {
      meta: { asOf: p.meta.asOf, version: p.meta.version, confidence, simulations: n, seed },
      required: req,
      requiredByConfidence: reqs,
      deterministicRequired: det.req,
      currentAssets: current,
      currentSuccess: currentStats.success,
      currentSuccessLong: currentStats.successLong,
      longN: currentStats.longN,
      coverage: req > 0 ? current / req : Infinity,
      successCurve: curve.map(x => ({ wealth: x.w, success: x.success })),
      fan,
      cashflow: {
        ages: Array.from(flow.age),
        core: Array.from(flow.core),
        medical: Array.from(flow.medical),
        insurance: Array.from(flow.insurance),
        housing: Array.from(flow.housing),
        child: Array.from(flow.child),
        parents: Array.from(flow.parents),
        ltc: Array.from(flow.ltc),
        oneoff: Array.from(flow.oneoff),
        total: Array.from(flow.total)
      },
      lifetimeSpending: lifetime,
      firstYearSpending: firstYear,
      annualSpend0: firstYear.total,
      coreMonthly0,
      safeCoreMonthlyCurrent: safeMonthCurrent,
      safeAnnualCurrent,
      currentWithdrawalRate: current > 0 ? safeAnnualCurrent / current : 0,
      firstYearWithdrawalRate: req > 0 ? firstYear.total / req : 0,
      fourPercent: fourPctCap,
      fourPercentSuccess: fourPctSuccess,
      sensitivity,
      stress,
      ruinAge: mc.ruinAges,
      pension: { self: pensionToday(p, 'self'), spouse: pensionToday(p, 'spouse') },
      portfolio: { expected: baseStats.geom, arith: baseStats.arith, vol: baseStats.vol, gross: baseStats.grossGeom },
      warnings,
      assumptions: {
        inflationMean: p.risk.inflationMean,
        medicalInflation: p.risk.inflationMean + p.risk.medicalInflationSpread,
        educationInflation: p.risk.inflationMean + p.risk.educationInflationSpread,
        longevityMode: p.household.longevityMode,
        planUntil: p.household.planUntil,
        fee: p.investment.fee,
        taxDrag: p.investment.taxDrag
      }
    };
  }

  function mapValues(obj, fn) {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = fn(Number(obj[k] || 0), k);
    return out;
  }

  function rebuildIndices(sh, risk) {
    const T = sh.T, N = sh.N;
    const spreads = [0, num(risk.medicalInflationSpread, 0), num(risk.educationInflationSpread, 0), num(risk.housingInflationSpread, 0)];
    const arrays = [sh.cpi, sh.med, sh.edu, sh.house];
    for (let a = 0; a < 4; a++) {
      const spread = spreads[a];
      for (let i = 0; i < N; i++) {
        let idx = 1;
        arrays[a][i * T] = 1;
        for (let t = 1; t < T; t++) {
          idx *= 1 + Math.max(-0.05, sh.pi[i * T + t - 1] + spread);
          arrays[a][i * T + t] = idx;
        }
      }
    }
  }

  const api = { normalize, portfolioStats, pensionToday, buildShocks, successRate, requiredCapital, runModel, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FREngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
