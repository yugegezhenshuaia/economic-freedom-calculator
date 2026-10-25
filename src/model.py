"""经济自由本金模型（Python 参考实现 v1.1）。

口径契约
--------
1. 所有输入金额均为“今天”（2026 年）的购买力；输出也以今天币值表示。
2. 年度步长。每年年初发生支出/收入/缴费，剩余资产获得当年收益。
3. 成功 = 死亡前资产从未为负，且死亡时资产 ≥ 遗产目标（按 CPI 指数化）。
4. 收益输入为“费后几何年化”；蒙特卡洛用算术均值 = 几何 + 0.5×方差。
5. 养老金输入为今天币值；名义养老金按 COLA 增长，若 COLA < CPI 则实际购买力下降。
6. 自住房不计入可投资资产；可选卖出，扣除贷款与交易费用后进入组合。
7. 这是规划模型，不是收益承诺。预期收益、通胀、寿命、护理发生率均为假设。
"""

from __future__ import annotations

import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent
DEFAULTS_PATH = ROOT / "defaults.json"


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def deep_merge(base: dict, override: dict) -> dict:
    out = deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = deepcopy(v)
    return out


def load_defaults() -> dict:
    with open(DEFAULTS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize(params: dict | None = None) -> dict:
    p = deep_merge(load_defaults(), params or {})
    alloc = p["investment"]["allocation"]
    total = sum(max(0.0, float(v)) for v in alloc.values())
    if total <= 0:
        alloc = {k: 0.0 for k in alloc}
        alloc["cash"] = 1.0
    else:
        alloc = {k: max(0.0, float(v)) / total for k, v in alloc.items()}
    p["investment"]["allocation"] = alloc
    for c in p.get("children", []):
        if c.get("path") not in p["childCostTable"]:
            c["path"] = "public"
    p["household"]["adults"] = 2 if int(p["household"].get("adults", 2)) == 2 else 1
    p["household"]["planUntil"] = max(int(p["household"].get("age", 40)) + 1,
                                      min(110, int(p["household"].get("planUntil", 100))))
    p["assets"] = max(0.0, float(params.get("assets", 3_000_000))) if params else 3_000_000.0
    return p


def annuity_payment(principal: float, annual_rate: float, years: int) -> float:
    if principal <= 0 or years <= 0:
        return 0.0
    r = float(annual_rate)
    n = int(years)
    if abs(r) < 1e-12:
        return principal / n
    return principal * r / (1 - (1 + r) ** (-n))


def mortgage_balance(principal: float, annual_rate: float, years_total: int, years_paid: int) -> float:
    if principal <= 0:
        return 0.0
    if years_paid <= 0:
        return principal
    if years_paid >= years_total:
        return 0.0
    r = float(annual_rate)
    if abs(r) < 1e-12:
        return max(0.0, principal * (1 - years_paid / years_total))
    pmt = annuity_payment(principal, r, years_total)
    bal = principal * (1 + r) ** years_paid - pmt * ((1 + r) ** years_paid - 1) / r
    return max(0.0, bal)


MONTHS_TABLE = {
    40: 233, 41: 230, 42: 226, 43: 223, 44: 220, 45: 216, 46: 212, 47: 208,
    48: 204, 49: 199, 50: 195, 51: 190, 52: 185, 53: 180, 54: 175, 55: 170,
    56: 164, 57: 158, 58: 152, 59: 145, 60: 139, 61: 132, 62: 125, 63: 117,
    64: 109, 65: 101, 66: 93, 67: 84, 68: 75, 69: 65, 70: 56,
}


def months_for_age(age: int) -> int:
    a = int(max(40, min(70, age)))
    return MONTHS_TABLE[a]


def pension_today(params: dict, person: str = "self") -> float:
    """返回“今天购买力”口径的月养老金（已考虑账户记账利率与社平工资实际增长）。"""
    inc = params["income"]
    soc = params["social"]
    h = params["household"]
    if inc.get("pensionMode") == "none":
        return 0.0
    if person == "self":
        if inc.get("pensionMode") == "direct":
            return max(0.0, float(inc.get("pensionMonthly", 0)))
        years = float(soc.get("contribYears", 0))
        index = float(soc.get("contributionIndex", 1.0))
        wage = float(soc.get("localAverageWage", 0))
        account = float(soc.get("personalAccount", 0))
        start_age = int(inc.get("pensionStartAge", 60))
        current_age = int(h.get("age", 40))
    else:
        if inc.get("pensionMode") == "direct":
            return max(0.0, float(inc.get("spousePensionMonthly", 0)))
        years = float(soc.get("spouseContribYears", 0))
        index = float(soc.get("spouseContributionIndex", 1.0))
        wage = float(soc.get("spouseLocalAverageWage", 0))
        account = float(soc.get("spousePersonalAccount", 0))
        start_age = int(inc.get("spousePensionStartAge", 55))
        current_age = int(h.get("spouseAge", h.get("age", 40)))
    if years < float(soc.get("minContribYears", 20)):
        return 0.0

    n = max(0, start_age - current_age)
    infl = max(0.0, float(params["risk"].get("inflationMean", 0.02)))
    wage_g = float(soc.get("socialWageGrowth", 0.03))
    acct_g = float(soc.get("accountRate", 0.03))
    # 折算成今天购买力
    real_wage_growth = (1 + wage_g) / (1 + infl) - 1
    real_acct_growth = (1 + acct_g) / (1 + infl) - 1
    wage_today = wage * (1 + real_wage_growth) ** n
    account_today = account * (1 + real_acct_growth) ** n
    base = wage_today * (1 + index) / 2 * years * 0.01
    personal = account_today / months_for_age(start_age) if account_today > 0 else 0.0
    return max(0.0, base + personal)


def portfolio_stats(params: dict) -> dict:
    """返回费后几何/算术收益与波动。资产预期收益按几何年化输入。"""
    inv = params["investment"]
    keys = list(inv["allocation"].keys())
    w = np.array([inv["allocation"][k] for k in keys], dtype=float)
    mu_vec = np.array([inv["expected"][k] for k in keys], dtype=float)
    vol_vec = np.array([inv["vol"][k] for k in keys], dtype=float)
    corr = np.eye(len(keys))
    for i, a in enumerate(keys):
        for j, b in enumerate(keys):
            if i == j:
                continue
            key1, key2 = f"{a}-{b}", f"{b}-{a}"
            corr[i, j] = float(inv["corr"].get(key1, inv["corr"].get(key2, 0.0)))
    cov = np.outer(vol_vec, vol_vec) * corr
    mu_arith_gross = float(w @ mu_vec)
    var = float(w @ cov @ w)
    sigma = math.sqrt(max(var, 0.0))
    mu_geom_gross = mu_arith_gross - 0.5 * var
    fee = float(inv.get("fee", 0))
    tax = float(inv.get("taxDrag", 0))
    mu_geom = mu_geom_gross - fee - tax
    mu_arith = mu_geom + 0.5 * var
    if inv.get("overrideReturn") is not None:
        mu_geom = float(inv["overrideReturn"])
        mu_arith = mu_geom + 0.5 * var
    if inv.get("overrideVol") is not None:
        sigma = float(inv["overrideVol"])
        var = sigma ** 2
        mu_arith = mu_geom + 0.5 * var
    mu_geom = min(0.15, max(-0.05, mu_geom))
    sigma = min(0.40, max(0.005, sigma))
    return {
        "arith": mu_arith,
        "geom": mu_geom,
        "vol": sigma,
        "grossArith": mu_arith_gross,
        "grossGeom": mu_geom_gross,
    }


def spend_curve_factor(age: float, fi_age: float, curve: list) -> float:
    if age <= fi_age:
        return 1.0
    pts = sorted((float(a), float(f)) for a, f in curve)
    if age <= pts[0][0]:
        return pts[0][1]
    for (a1, f1), (a2, f2) in zip(pts, pts[1:]):
        if age <= a2:
            if a2 == a1:
                return f2
            return f1 + (f2 - f1) * (age - a1) / (a2 - a1)
    return pts[-1][1]


def child_stage(age: float) -> str | None:
    if age < 0:
        return None
    if age < 3:
        return "0-2"
    if age < 6:
        return "3-5"
    if age < 12:
        return "6-11"
    if age < 15:
        return "12-14"
    if age < 18:
        return "15-17"
    if age < 22:
        return "18-21"
    if age < 25:
        return "22-24"
    return None


def child_annual_cost(params: dict, child: dict, age: float) -> float:
    if age < 0 or age > float(child.get("supportUntil", 22)):
        return 0.0
    if age >= 22 and not child.get("postgrad", False):
        return 0.0
    stage = child_stage(age)
    if stage is None:
        return 0.0
    table = params["childCostTable"][child.get("path", "public")]
    return float(table.get(stage, 0.0)) * float(child.get("multiplier", 1.0))


# ---------------------------------------------------------------------------
# 随机冲击
# ---------------------------------------------------------------------------

def sample_death_age(rng: np.random.Generator, current_age: float, sex: str, scale_mult: float = 1.0) -> float:
    k = 3.6
    scale = (28.5 if sex == "female" else 26.5) * max(0.7, float(scale_mult))
    if current_age <= 60:
        u = max(1e-12, float(rng.random()))
        t = scale * (-math.log(u)) ** (1.0 / k)
        return 60.0 + t
    s0 = math.exp(-((current_age - 60.0) / scale) ** k)
    u = max(1e-12, float(rng.random()))
    s = max(1e-12, s0 * u)
    t = scale * (-math.log(s)) ** (1.0 / k)
    return 60.0 + t


def build_shocks(params: dict, n_paths: int, seed: int | None = None, mode: str = "stochastic") -> dict:
    rng = np.random.default_rng(int(params["risk"].get("seed", 20261025) if seed is None else seed))
    h = params["household"]
    risk = params["risk"]
    stats = portfolio_stats(params)
    mu = float(stats["arith"] if mode == "stochastic" else stats["geom"])
    sigma = float(stats["vol"])

    max_age = int(h.get("planUntil", 100))
    max_age_self = max_age
    max_age_spouse = max_age
    age0 = int(h.get("age", 40))
    adults = int(h.get("adults", 2))
    spouse_age0 = int(h.get("spouseAge", age0))
    T = max(1, max_age_self - age0 + 1, max_age_spouse - spouse_age0 + 1 if adults == 2 else 1)

    df = max(3.1, float(risk.get("tdf", 5)))
    rho = float(risk.get("returnInflationCorr", -0.2))
    cov = np.array([[1.0, rho], [rho, 1.0]])
    z = rng.multivariate_normal([0.0, 0.0], cov, size=(n_paths, T))
    chi = rng.chisquare(df, size=(n_paths, T)) / df
    t = z / np.sqrt(chi)[:, :, None]
    t *= math.sqrt((df - 2.0) / df)

    if mode == "deterministic":
        ret = np.full((n_paths, T), mu)
        pi = np.full((n_paths, T), float(risk.get("inflationMean", 0.02)))
    else:
        ret = mu + sigma * t[:, :, 0]
        phi = float(risk.get("inflationPersistence", 0.55))
        mu_pi = float(risk.get("inflationMean", 0.02))
        sd_pi = float(risk.get("inflationVol", 0.012))
        innov_sd = sd_pi * math.sqrt(max(0.0, 1 - phi * phi))
        pi = np.zeros((n_paths, T))
        pi[:, 0] = mu_pi + sd_pi * t[:, 0, 1]
        for k in range(1, T):
            pi[:, k] = mu_pi + phi * (pi[:, k - 1] - mu_pi) + innov_sd * t[:, k, 1]
        pi = np.clip(pi, -0.02, 0.15)
        if risk.get("returnModel", "student-t") == "student-t":
            ret = np.clip(ret, -0.85, 1.5)
        crash_prob = float(risk.get("crashProb", 0.03))
        if crash_prob > 0:
            crashes = rng.random((n_paths, T)) < crash_prob
            ret = ret + crashes * float(risk.get("crashSize", -0.2))
        ret = np.clip(ret, -0.9, 1.5)

    def make_index(series: np.ndarray, spread: float = 0.0) -> np.ndarray:
        idx = np.ones_like(series)
        for k in range(1, T):
            idx[:, k] = idx[:, k - 1] * (1 + np.maximum(-0.05, series[:, k - 1] + spread))
        return idx

    cpi_idx = make_index(pi, 0.0)
    med_idx = make_index(pi, float(risk.get("medicalInflationSpread", 0.03)))
    edu_idx = make_index(pi, float(risk.get("educationInflationSpread", 0.03)))
    house_idx = make_index(pi, float(risk.get("housingInflationSpread", 0.0)))

    def death_ages(sex: str, start_age: int) -> np.ndarray:
        if mode == "deterministic" or h.get("longevityMode") == "fixed":
            return np.full(n_paths, float(max_age))
        scale_mult = float(risk.get("longevityScale", 1.0))
        return np.array([min(float(max_age), sample_death_age(rng, start_age, sex, scale_mult)) for _ in range(n_paths)])

    death_self = death_ages(str(h.get("selfSex", "male")), age0)
    death_spouse = death_ages(str(h.get("spouseSex", "female")), spouse_age0) if adults == 2 else np.zeros(n_paths)

    med_base = float(risk.get("medicalShockBaseProb", 0.006))
    med_slope = float(risk.get("medicalShockAgeSlope", 0.0002))
    med_median = float(risk.get("medicalShockMedian", 150000))
    med_sigma = float(risk.get("medicalShockSigma", 0.85))
    med_cost_self = np.zeros((n_paths, T))
    med_cost_spouse = np.zeros((n_paths, T))
    if mode == "stochastic":
        for k in range(T):
            age_s = age0 + k
            p_s = min(0.10, med_base + med_slope * max(0, age_s - 40))
            hit_s = rng.random(n_paths) < p_s
            med_cost_self[:, k] = np.where(
                hit_s, np.minimum(2_000_000, med_median * np.exp(med_sigma * rng.standard_normal(n_paths))), 0.0
            )
            if adults == 2:
                age_p = spouse_age0 + k
                p_p = min(0.10, med_base + med_slope * max(0, age_p - 40))
                hit_p = rng.random(n_paths) < p_p
                med_cost_spouse[:, k] = np.where(
                    hit_p, np.minimum(2_000_000, med_median * np.exp(med_sigma * rng.standard_normal(n_paths))), 0.0
                )

    ltc_start_self = np.full(n_paths, -1)
    ltc_dur_self = np.zeros(n_paths, dtype=int)
    ltc_start_spouse = np.full(n_paths, -1)
    ltc_dur_spouse = np.zeros(n_paths, dtype=int)
    if mode == "stochastic":
        ltc_base = float(risk.get("ltcBaseProb", 0.005))
        ltc_slope = float(risk.get("ltcAgeSlope", 0.0015))
        dur_mean = float(risk.get("ltcDurationYears", 4))
        for i in range(n_paths):
            for person in ("self", "spouse"):
                if person == "spouse" and adults != 2:
                    continue
                start_age = age0 if person == "self" else spouse_age0
                death = death_self[i] if person == "self" else death_spouse[i]
                onset = -1
                for k in range(T):
                    a = start_age + k
                    if a < 65 or a >= death:
                        continue
                    p = min(0.15, ltc_base + ltc_slope * (a - 65))
                    if rng.random() < p:
                        onset = k
                        break
                if onset >= 0:
                    dur = int(max(1, round(dur_mean * (0.5 + rng.random()))))
                    if person == "self":
                        ltc_start_self[i] = onset
                        ltc_dur_self[i] = dur
                    else:
                        ltc_start_spouse[i] = onset
                        ltc_dur_spouse[i] = dur

    return {
        "T": T,
        "ret": ret,
        "pi": pi,
        "cpi_idx": cpi_idx,
        "med_idx": med_idx,
        "edu_idx": edu_idx,
        "house_idx": house_idx,
        "death_self": death_self,
        "death_spouse": death_spouse,
        "med_cost_self": med_cost_self,
        "med_cost_spouse": med_cost_spouse,
        "ltc_start_self": ltc_start_self,
        "ltc_dur_self": ltc_dur_self,
        "ltc_start_spouse": ltc_start_spouse,
        "ltc_dur_spouse": ltc_dur_spouse,
    }


# ---------------------------------------------------------------------------
# 单路径
# ---------------------------------------------------------------------------

def simulate_one(params: dict, W0: float, shocks: dict, i: int, collect: bool = False) -> dict:
    h = params["household"]
    inc = params["income"]
    sp = params["spending"]
    hou = params["housing"]
    risk = params["risk"]
    ins = params["insurance"]
    adults = int(h.get("adults", 2))
    age0 = int(h.get("age", 40))
    fi_age = int(h.get("fiAge", age0))
    years_to_fi = max(0, fi_age - age0)
    T = int(shocks["T"])

    self_death = float(shocks["death_self"][i])
    spouse_death = float(shocks["death_spouse"][i]) if adults == 2 else 0.0
    spouse_age0 = int(h.get("spouseAge", age0))
    death_household = max(self_death, spouse_death) if adults == 2 else self_death

    monthly = sp["monthly"]
    # 核心生活：不含医疗、保险
    core_monthly = sum(float(v) for k, v in monthly.items() if k not in ("medical", "insurance"))
    medical_monthly = float(monthly.get("medical", 0))
    monthly_insurance = float(monthly.get("insurance", 0))
    insurance_annual = float(ins.get("annualPremium", monthly_insurance * 12))
    core_annual = core_monthly * 12

    pension_self_today = pension_today(params, "self")
    pension_spouse_today = pension_today(params, "spouse") if adults == 2 else 0.0
    pension_start_self = int(inc.get("pensionStartAge", 60))
    pension_start_spouse = int(inc.get("spousePensionStartAge", 55))
    cola = float(inc.get("pensionCOLA", 0.02))

    mortgage_pmt = annuity_payment(float(hou.get("mortgageBalance", 0)), float(hou.get("mortgageRate", 0)), int(hou.get("mortgageYearsLeft", 0)))
    annual_expense_now = core_annual + medical_monthly * 12 + insurance_annual + mortgage_pmt
    annual_expense_now += float(params.get("parents", {}).get("annualSupport", 0))
    annual_expense_now += sum(child_annual_cost(params, c, c.get("age", 0)) for c in params.get("children", []))
    if inc.get("savingsMode") == "auto":
        salary = float(inc.get("salary", 0)) + (float(inc.get("spouseSalary", 0)) if adults == 2 else 0.0)
        savings0 = max(0.0, salary - annual_expense_now)
    else:
        savings0 = max(0.0, float(inc.get("savingsAnnual", 0)))
    sell_age = int(hou.get("sellAge", 0) or 0)
    sell_t = max(0, sell_age - age0) if sell_age > 0 else None
    home_value = float(hou.get("homeValue", 0))
    house_growth = float(hou.get("houseGrowth", 0))
    property_tax_rate = float(hou.get("propertyTaxRate", 0))
    rent_after = float(hou.get("rentAfterSell", 0))
    sell_cost = float(hou.get("sellCostRate", 0.03))

    pen_self_nom = None
    pen_spouse_nom = None

    ltc_start_self = int(shocks["ltc_start_self"][i])
    ltc_dur_self = int(shocks["ltc_dur_self"][i])
    ltc_start_spouse = int(shocks["ltc_start_spouse"][i]) if adults == 2 else -1
    ltc_dur_spouse = int(shocks["ltc_dur_spouse"][i]) if adults == 2 else 0

    W = float(W0) - float(params.get("parents", {}).get("medicalReserve", 0))
    if W < 0:
        return {"success": False, "ruin_age": age0, "final": W, "path": None, "death_household": death_household}

    records = [] if collect else None
    ruin_age = None

    for t in range(T):
        age_s = age0 + t
        age_p = spouse_age0 + t
        self_alive = age_s < self_death
        spouse_alive = adults == 2 and age_p < spouse_death
        if not self_alive and not spouse_alive:
            break

        cpi = float(shocks["cpi_idx"][i, t])
        med = float(shocks["med_idx"][i, t])
        edu = float(shocks["edu_idx"][i, t])
        house = float(shocks["house_idx"][i, t])

        # 收入
        income = 0.0
        if t < years_to_fi:
            income += savings0 * cpi
        if self_alive and age_s >= pension_start_self and pension_self_today > 0:
            if pen_self_nom is None:
                pen_self_nom = pension_self_today * cpi
            else:
                pen_self_nom *= (1 + cola)
            income += pen_self_nom
        if spouse_alive and age_p >= pension_start_spouse and pension_spouse_today > 0:
            if pen_spouse_nom is None:
                pen_spouse_nom = pension_spouse_today * cpi
            else:
                pen_spouse_nom *= (1 + cola)
            income += pen_spouse_nom
        if self_alive or spouse_alive:
            income += float(inc.get("rentalAnnual", 0)) * cpi
        if t < int(inc.get("partTimeYears", 0)) and (self_alive or spouse_alive):
            income += float(inc.get("partTimeAnnual", 0)) * cpi
        for inflow in inc.get("oneTimeInflows", []):
            if int(inflow.get("age", -1)) == age_s:
                income += float(inflow.get("amount", 0)) * cpi

        # 核心生活支出
        alive_factor = 1.0
        if adults == 2 and not (self_alive and spouse_alive):
            alive_factor = float(h.get("singleSpendingFactor", 0.72))
        retire_factor = 1.0 if t < years_to_fi else float(sp.get("retirementFactor", 0.9))
        curve_factor = spend_curve_factor(age_s, fi_age, sp.get("curve", [[0, 1.0]]))
        core = core_annual * cpi * alive_factor * retire_factor * curve_factor

        # 医疗/保险不随年龄曲线下降；分别按医疗通胀/保费实际增长膨胀
        medical_routine = medical_monthly * 12 * med * alive_factor
        premium_idx = cpi * (1 + float(ins.get("premiumRealGrowth", 0.03))) ** t
        insurance_premium = insurance_annual * premium_idx * alive_factor

        ltc_active_count = 0
        if ltc_start_self >= 0 and ltc_start_self <= t < ltc_start_self + ltc_dur_self and self_alive:
            ltc_active_count += 1
        if ltc_start_spouse >= 0 and ltc_start_spouse <= t < ltc_start_spouse + ltc_dur_spouse and spouse_alive:
            ltc_active_count += 1
        if ltc_active_count:
            core *= max(0.4, 1 - float(risk.get("ltcLivingOffset", 0.2)) * ltc_active_count / adults)

        child_cost = 0.0
        for c in params.get("children", []):
            ca = float(c.get("age", 0)) + t
            child_cost += child_annual_cost(params, c, ca) * edu
            if int(c.get("marriageAge", 28)) == ca and float(c.get("marriageSupport", 0)) > 0:
                child_cost += float(c["marriageSupport"]) * cpi

        parent_cost = 0.0
        if t < int(params.get("parents", {}).get("years", 0)):
            parent_cost = float(params.get("parents", {}).get("annualSupport", 0)) * cpi

        mortgage = mortgage_pmt if t < int(hou.get("mortgageYearsLeft", 0)) else 0.0

        oneoff = 0.0
        for o in sp.get("oneOffs", []):
            start = int(o.get("startAge", 999))
            every = max(1, int(o.get("every", 1)))
            end = int(o.get("endAge", start))
            if start <= age_s <= end and (age_s - start) % every == 0:
                oneoff += float(o.get("amount", 0)) * cpi

        # 医疗大额：只有一部分费用属于可报销范围
        med_oop = 0.0
        eligible_share = float(ins.get("eligibleShare", 0.8))
        social = float(ins.get("medicalReimbursement", 0.7))
        commercial = float(ins.get("commercialCoverage", 0.6))
        deductible = float(ins.get("deductible", 10000))
        for person_alive, costs in ((self_alive, shocks["med_cost_self"]), (spouse_alive, shocks["med_cost_spouse"])):
            if person_alive:
                cost = float(costs[i, t])
                if cost > 0:
                    eligible = cost * eligible_share
                    covered = max(0.0, eligible - deductible)
                    reimb = covered * social + covered * (1 - social) * commercial
                    med_oop += max(0.0, cost - reimb)

        ltc_cost = 0.0
        if ltc_start_self >= 0 and ltc_start_self <= t < ltc_start_self + ltc_dur_self and self_alive:
            ltc_cost += float(risk.get("ltcCostMonthly", 8000)) * 12 * med * (1 - float(risk.get("ltcCoverage", 0)))
        if ltc_start_spouse >= 0 and ltc_start_spouse <= t < ltc_start_spouse + ltc_dur_spouse and spouse_alive:
            ltc_cost += float(risk.get("ltcCostMonthly", 8000)) * 12 * med * (1 - float(risk.get("ltcCoverage", 0)))

        property_tax = 0.0
        if home_value > 0 and (sell_t is None or t < sell_t):
            property_tax = home_value * (1 + house_growth) ** t * property_tax_rate
        sale_inflow = 0.0
        if sell_t is not None and t == sell_t:
            hv = home_value * (1 + house_growth) ** t
            bal = mortgage_balance(float(hou.get("mortgageBalance", 0)), float(hou.get("mortgageRate", 0)),
                                   int(hou.get("mortgageYearsLeft", 0)), t)
            sale_inflow = hv - bal - hv * sell_cost
            property_tax = 0.0
        rent = 0.0
        if sell_t is not None and t >= sell_t:
            rent = rent_after * 12 * house

        expenses = (core + medical_routine + insurance_premium + child_cost + parent_cost
                    + mortgage + oneoff + med_oop + ltc_cost + property_tax + rent)

        W = W + income - expenses + sale_inflow
        if W < 0:
            ruin_age = age_s
            break

        if collect:
            records.append({
                "age": age_s,
                "wealth_real": W / cpi,
                "spend_core": core / cpi,
                "spend_child": child_cost / cpi,
                "spend_medical": (medical_routine + med_oop) / cpi,
                "spend_ltc": ltc_cost / cpi,
                "spend_insurance": insurance_premium / cpi,
                "spend_housing": (mortgage + property_tax + rent) / cpi,
                "spend_oneoff": oneoff / cpi,
                "spend_parents": parent_cost / cpi,
                "income": income / cpi,
                "total_spend": expenses / cpi,
            })

        W *= (1 + float(shocks["ret"][i, t]))

    if ruin_age is None:
        cpi_end = float(shocks["cpi_idx"][i, min(T - 1, max(0, int(math.ceil(death_household)) - age0))])
        bequest = float(risk.get("bequest", 0)) * cpi_end
        if W < bequest:
            ruin_age = int(math.ceil(death_household))
    success = ruin_age is None
    return {
        "success": success,
        "ruin_age": ruin_age,
        "final": W,
        "path": records,
        "death_household": death_household,
    }


def success_rate(params: dict, W0: float, shocks: dict, collect: bool = False, long_age: int = 90) -> dict:
    n = int(shocks["ret"].shape[0])
    ok = 0
    long_ok = 0
    long_n = 0
    ruins = []
    paths = []
    finals = []
    for i in range(n):
        r = simulate_one(params, W0, shocks, i, collect=collect)
        if r["success"]:
            ok += 1
        elif r["ruin_age"] is not None:
            ruins.append(r["ruin_age"])
        if r["death_household"] >= long_age:
            long_n += 1
            if r["success"]:
                long_ok += 1
        finals.append(r["final"])
        if collect and r["path"] is not None:
            paths.append(r["path"])
    return {
        "success": ok / n if n else 0.0,
        "success_long": (long_ok / long_n) if long_n else 0.0,
        "long_n": long_n,
        "ruin_ages": ruins,
        "finals": finals,
        "paths": paths,
    }


def required_capital(params: dict, confidence: float = 0.9, n_paths: int = 4000,
                     seed: int | None = None, mode: str = "stochastic",
                     max_iter: int = 16) -> tuple[float, dict]:
    shocks = build_shocks(params, n_paths, seed=seed, mode=mode)
    reserve = float(params.get("parents", {}).get("medicalReserve", 0))

    def succ(w: float) -> float:
        return success_rate(params, w, shocks)["success"]

    monthly = sum(float(v) for v in params["spending"]["monthly"].values())
    annual = monthly * 12 + annuity_payment(float(params["housing"].get("mortgageBalance", 0)),
                                            float(params["housing"].get("mortgageRate", 0)),
                                            int(params["housing"].get("mortgageYearsLeft", 0)))
    upper = max(2_000_000.0, annual * 60, reserve * 2)
    while succ(upper) < confidence and upper < 300_000_000:
        upper *= 1.7
    if succ(upper) < confidence:
        return float("inf"), {"shocks": shocks, "converged": False}
    if succ(0) >= confidence:
        return 0.0, {"shocks": shocks, "converged": True}

    lo, hi = 0.0, upper
    for _ in range(max_iter):
        mid = (lo + hi) / 2
        if succ(mid) >= confidence:
            hi = mid
        else:
            lo = mid
    return hi, {"shocks": shocks, "converged": True}


# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.array(values, dtype=float), q))


def interpolate_required(curve: list[tuple[float, float]], confidence: float) -> float:
    if not curve:
        return float("nan")
    curve = sorted(curve)
    if confidence <= curve[0][1]:
        return 0.0
    if confidence >= curve[-1][1]:
        return curve[-1][0] * 1.5
    for (w1, s1), (w2, s2) in zip(curve, curve[1:]):
        if s1 <= confidence <= s2:
            if s2 == s1:
                return w2
            return w1 + (w2 - w1) * (confidence - s1) / (s2 - s1)
    return curve[-1][0]


def safe_core_spending(params: dict, req: float, shocks: dict, confidence: float) -> tuple[float, float]:
    """在给定本金下，求可支撑的核心月生活费（只缩放核心生活，不缩放子女/医疗等）。"""
    base_core_monthly = sum(float(v) for k, v in params["spending"]["monthly"].items()
                            if k not in ("medical", "insurance"))
    if req <= 0 or not math.isfinite(req):
        return 0.0, 0.0

    def succ(mult: float) -> float:
        pp = deepcopy(params)
        for k in pp["spending"]["monthly"]:
            if k not in ("medical", "insurance"):
                pp["spending"]["monthly"][k] = float(pp["spending"]["monthly"][k]) * mult
        return success_rate(pp, req, shocks)["success"]

    lo, hi = 0.0, 3.0
    if succ(hi) >= confidence:
        return base_core_monthly * hi, base_core_monthly * hi * 12
    if succ(1e-6) < confidence:
        return 0.0, 0.0
    for _ in range(12):
        mid = (lo + hi) / 2
        if succ(mid) >= confidence:
            lo = mid
        else:
            hi = mid
    return base_core_monthly * lo, base_core_monthly * lo * 12


def run_model(params: dict | None = None, n_paths: int | None = None) -> dict:
    p = normalize(params)
    risk = p["risk"]
    confidence = float(risk.get("confidence", 0.9))
    n = int(n_paths or risk.get("simulations", 6000))
    seed = int(risk.get("seed", 20261025))

    req, diag = required_capital(p, confidence=confidence, n_paths=n, seed=seed)
    shocks = diag["shocks"]

    factors = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
    curve = []
    for f in factors:
        w = max(0.0, req * f) if math.isfinite(req) else 0.0
        s = success_rate(p, w, shocks)["success"]
        curve.append((w, s))
    current = float(p.get("assets", 3_000_000))
    current_stats = success_rate(p, current, shocks)
    reqs = {f"{int(c*100)}": interpolate_required(curve, c) for c in (0.8, 0.9, 0.95, 0.99)}

    det_req, _ = required_capital(p, confidence=confidence, n_paths=1, seed=seed, mode="deterministic", max_iter=20)
    det_shocks = build_shocks(p, 1, seed=seed, mode="deterministic")
    det_path = simulate_one(p, det_req, det_shocks, 0, collect=True)["path"] or []

    lifetime = {k: 0.0 for k in ("spend_core", "spend_child", "spend_medical", "spend_ltc",
                                 "spend_insurance", "spend_housing", "spend_oneoff", "spend_parents")}
    for row in det_path:
        for k in lifetime:
            lifetime[k] += row.get(k, 0.0)
    first_year = det_path[0] if det_path else {}
    first_year_total = float(first_year.get("total_spend", 0.0))

    mc = success_rate(p, req, shocks, collect=True)
    paths = mc["paths"]
    ages = [int(p["household"]["age"]) + t for t in range(shocks["T"])]
    fan = {"ages": ages}
    for q in (5, 25, 50, 75, 95):
        vals = []
        for t in range(shocks["T"]):
            col = [path[t]["wealth_real"] for path in paths if len(path) > t]
            vals.append(percentile(col, q) if col else 0.0)
        fan[f"p{q}"] = vals

    # 当前资产能支撑的核心生活费（不是目标本金下的，否则是循环）
    safe_month_current, safe_annual_current = safe_core_spending(p, current, shocks, confidence)
    core_month0 = sum(float(v) for k, v in p["spending"]["monthly"].items()
                      if k not in ("medical", "insurance"))
    four_pct_capital = first_year_total / 0.04
    four_pct_success = success_rate(p, four_pct_capital, shocks)["success"] if four_pct_capital > 0 else 0.0

    # 敏感性：low = 更乐观（所需本金更低），high = 更悲观
    sensitivity = []
    base_stats = portfolio_stats(p)
    scenarios = [
        ("日常支出", {"spending": {"monthly": {k: v * 0.8 for k, v in p["spending"]["monthly"].items()}}},
         {"spending": {"monthly": {k: v * 1.2 for k, v in p["spending"]["monthly"].items()}}}, "-20%", "+20%"),
        ("投资净收益", {"investment": {"overrideReturn": base_stats["geom"] + 0.015}},
         {"investment": {"overrideReturn": base_stats["geom"] - 0.015}}, "+1.5%", "-1.5%"),
        ("通胀中枢", {"risk": {"inflationMean": max(0.0, p["risk"]["inflationMean"] - 0.01)}},
         {"risk": {"inflationMean": p["risk"]["inflationMean"] + 0.01}}, "-1%", "+1%"),
        ("医疗通胀", {"risk": {"medicalInflationSpread": max(0.0, p["risk"]["medicalInflationSpread"] - 0.02)}},
         {"risk": {"medicalInflationSpread": p["risk"]["medicalInflationSpread"] + 0.02}}, "-2%", "+2%"),
        ("子女成本", {"children": [{**c, "multiplier": float(c.get("multiplier", 1)) * 0.7} for c in p.get("children", [])]},
         {"children": [{**c, "multiplier": float(c.get("multiplier", 1)) * 1.3} for c in p.get("children", [])]}, "-30%", "+30%"),
        ("养老金", {"income": {"pensionMode": "direct", "pensionMonthly": pension_today(p, "self") * 1.2,
                                "spousePensionMonthly": pension_today(p, "spouse") * 1.2}},
         {"income": {"pensionMode": "direct", "pensionMonthly": pension_today(p, "self") * 0.7,
                     "spousePensionMonthly": pension_today(p, "spouse") * 0.7}}, "+20%", "-30%"),
        ("护理成本", {"risk": {"ltcCostMonthly": p["risk"]["ltcCostMonthly"] * 0.5}},
         {"risk": {"ltcCostMonthly": p["risk"]["ltcCostMonthly"] * 1.5}}, "-50%", "+50%"),
        ("寿命", {"risk": {"longevityScale": 0.9}},
         {"risk": {"longevityScale": 1.1}}, "-10%", "+10%"),
    ]
    sens_paths = max(1500, n // 4)
    base_sens_req, _ = required_capital(p, confidence=confidence, n_paths=sens_paths, seed=seed, max_iter=12)
    for name, low_override, high_override, low_label, high_label in scenarios:
        try:
            low_req, _ = required_capital(deep_merge(p, low_override), confidence=confidence,
                                          n_paths=sens_paths, seed=seed, max_iter=12)
            high_req, _ = required_capital(deep_merge(p, high_override), confidence=confidence,
                                           n_paths=sens_paths, seed=seed, max_iter=12)
            sensitivity.append({"name": name, "low": low_req, "high": high_req, "base": base_sens_req,
                                "lowLabel": low_label, "highLabel": high_label})
        except Exception:
            continue

    stress = []
    stress_scenarios = [
        ("基准", {}),
        ("退休后前3年连续大跌", {"sequence_crash": True}),
        ("滞胀10年（通胀5%）", {"stagflation": True}),
        ("日本化20年（收益1%）", {"japan": True}),
        ("养老金下调30%", {"pension_cut": 0.3}),
        ("活到105岁", {"long_life": True}),
    ]
    for name, opt in stress_scenarios:
        pp = deepcopy(p)
        if opt.get("pension_cut"):
            pp["income"]["pensionMode"] = "direct"
            pp["income"]["pensionMonthly"] = pension_today(p, "self") * (1 - opt["pension_cut"])
            pp["income"]["spousePensionMonthly"] = pension_today(p, "spouse") * (1 - opt["pension_cut"])
        if opt.get("long_life"):
            pp["household"]["longevityMode"] = "fixed"
            pp["household"]["planUntil"] = 105
        sh = build_shocks(pp, max(1200, n // 2), seed=seed)
        if opt.get("sequence_crash"):
            for k in range(min(3, sh["T"])):
                sh["ret"][:, k] -= [0.35, 0.25, 0.15][k]
        if opt.get("stagflation"):
            for k in range(min(10, sh["T"])):
                sh["pi"][:, k] = 0.05
                sh["ret"][:, k] = -0.02
            for key, spread in (("cpi_idx", 0.0), ("med_idx", p["risk"]["medicalInflationSpread"]),
                                ("edu_idx", p["risk"]["educationInflationSpread"]),
                                ("house_idx", p["risk"]["housingInflationSpread"])):
                idx = np.ones_like(sh["pi"])
                for k in range(1, sh["T"]):
                    idx[:, k] = idx[:, k - 1] * (1 + np.maximum(-0.05, sh["pi"][:, k - 1] + spread))
                sh[key] = idx
        if opt.get("japan"):
            sh["ret"][:, :min(20, sh["T"])] = 0.01
            sh["pi"][:, :min(20, sh["T"])] = 0.0
        s = success_rate(pp, req, sh)["success"]
        stress.append({"name": name, "success": s})

    coverage = current / req if req > 0 and math.isfinite(req) else float("inf")
    return {
        "meta": {"asOf": p["meta"]["asOf"], "version": p["meta"]["version"], "confidence": confidence,
                 "simulations": n, "seed": seed},
        "required": req,
        "requiredByConfidence": reqs,
        "deterministicRequired": det_req,
        "currentAssets": current,
        "currentSuccess": current_stats["success"],
        "currentSuccessLong": current_stats["success_long"],
        "coverage": coverage,
        "successCurve": [{"wealth": w, "success": s} for w, s in curve],
        "fan": fan,
        "lifetimeSpending": lifetime,
        "firstYearSpending": {
            "total": first_year_total,
            "core": float(first_year.get("spend_core", 0)),
            "medical": float(first_year.get("spend_medical", 0)),
            "insurance": float(first_year.get("spend_insurance", 0)),
            "housing": float(first_year.get("spend_housing", 0)),
            "child": float(first_year.get("spend_child", 0)),
            "oneoff": float(first_year.get("spend_oneoff", 0)),
            "parents": float(first_year.get("spend_parents", 0)),
            "ltc": float(first_year.get("spend_ltc", 0)),
        },
        "annualSpend0": first_year_total,
        "coreMonthly0": core_month0,
        "safeCoreMonthlyCurrent": safe_month_current,
        "safeAnnualCurrent": safe_annual_current,
        "currentWithdrawalRate": (safe_annual_current / current) if current > 0 else 0.0,
        "firstYearWithdrawalRate": (first_year_total / req) if req > 0 else 0.0,
        "fourPercent": four_pct_capital,
        "fourPercentSuccess": four_pct_success,
        "sensitivity": sensitivity,
        "stress": stress,
        "ruinAge": mc["ruin_ages"],
        "pension": {"self": pension_today(p, "self"), "spouse": pension_today(p, "spouse")},
        "portfolio": {"expected": base_stats["geom"], "arith": base_stats["arith"],
                      "vol": base_stats["vol"], "gross": base_stats["grossGeom"]},
        "warnings": build_warnings(p, req, current_stats["success"], confidence),
    }


def build_warnings(p: dict, req: float, current_success: float, confidence: float) -> list[str]:
    w = []
    if not math.isfinite(req):
        w.append("在当前假设下，即使本金极高也很难达到目标置信度；请检查支出、寿命或收益假设。")
    if current_success < confidence:
        w.append(f"当前资产的成功率为 {current_success:.1%}，低于目标 {confidence:.0%}。")
    if p["income"].get("pensionMode") == "formula" and p["social"].get("contribYears", 0) < 20:
        w.append("缴费年限少于 20 年：2030 年后退休的最低缴费年限将逐步提高到 20 年，养老金可能低于模型值。")
    if p["household"].get("longevityMode") == "fixed":
        w.append("当前使用固定寿命假设；真实长寿风险可能高于此。")
    if p["risk"].get("ltcCoverage", 0) == 0:
        w.append("长期护理保险覆盖为 0：失能护理费用全部由本金承担。")
    if p["spending"].get("monthly", {}).get("insurance", 0) > 0 and p["insurance"].get("annualPremium", 0) > 0:
        w.append("月度保险预算与年保费同时大于 0，可能重复计算；模型优先使用年保费。")
    return w


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", type=int, default=2000)
    ap.add_argument("--out", type=str, default="")
    args = ap.parse_args()
    result = run_model(n_paths=args.paths)
    text = json.dumps(result, ensure_ascii=False, indent=2, default=float)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"written {args.out}")
    else:
        print(text)
