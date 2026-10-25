"""模型的基础性质测试（Python 参考实现）。"""
import json
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import model  # noqa: E402


def base(overrides=None):
    p = model.normalize(overrides or {})
    return p


class TestModel(unittest.TestCase):
    def test_mortgage_zero_rate(self):
        self.assertAlmostEqual(model.annuity_payment(1_200_000, 0.0, 10), 120_000)

    def test_mortgage_balance(self):
        self.assertAlmostEqual(model.mortgage_balance(1_000_000, 0.032, 15, 15), 0)
        self.assertGreater(model.mortgage_balance(1_000_000, 0.032, 15, 5), 0)

    def test_pension_formula(self):
        p = base({"income": {"pensionMode": "formula"}, "social": {
            "contribYears": 20, "contributionIndex": 1.0, "personalAccount": 0,
            "localAverageWage": 10_000, "minContribYears": 20, "socialWageGrowth": 0.02,
        }})
        # 基础养老金 = 10000*(1+1)/2*20*1% = 2000
        self.assertAlmostEqual(model.pension_today(p, "self"), 2000, places=0)

    def test_pension_below_min_years(self):
        p = base({"income": {"pensionMode": "formula"}, "social": {"contribYears": 10, "minContribYears": 20}})
        self.assertEqual(model.pension_today(p, "self"), 0)

    def test_zero_spend_zero_required(self):
        p = base({
            "spending": {"monthly": {"food": 0, "housing": 0, "transport": 0, "clothing": 0,
                                     "leisure": 0, "social": 0, "medical": 0, "insurance": 0, "other": 0},
                         "oneOffs": []},
            "children": [], "parents": {"annualSupport": 0, "years": 0, "medicalReserve": 0},
            "housing": {"homeValue": 0, "mortgageBalance": 0, "mortgageYearsLeft": 0},
            "insurance": {"annualPremium": 0},
            "risk": {"medicalShockBaseProb": 0, "medicalShockAgeSlope": 0,
                     "ltcBaseProb": 0, "ltcAgeSlope": 0, "ltcCostMonthly": 0},
        })
        req, _ = model.required_capital(p, 0.9, 200, 20261025)
        self.assertEqual(req, 0)

    def test_required_increases_with_spending(self):
        reqs = []
        for m in (0.8, 1.0, 1.2):
            p = base()
            for k in p["spending"]["monthly"]:
                if k not in ("medical", "insurance"):
                    p["spending"]["monthly"][k] *= m
            r, _ = model.required_capital(p, 0.9, 300, 20261025, max_iter=10)
            reqs.append(r)
        self.assertLess(reqs[0], reqs[1])
        self.assertLess(reqs[1], reqs[2])

    def test_required_increases_with_confidence(self):
        p = base()
        a, _ = model.required_capital(p, 0.8, 300, 20261025, max_iter=10)
        b, _ = model.required_capital(p, 0.9, 300, 20261025, max_iter=10)
        self.assertLess(a, b)

    def test_required_increases_with_inflation(self):
        p = base({"risk": {"inflationMean": 0.02}})
        q = base({"risk": {"inflationMean": 0.04}})
        a, _ = model.required_capital(p, 0.9, 300, 20261025, max_iter=10)
        b, _ = model.required_capital(q, 0.9, 300, 20261025, max_iter=10)
        self.assertLess(a, b)

    def test_bequest_increases_required(self):
        p = base({"risk": {"bequest": 0}})
        q = base({"risk": {"bequest": 2_000_000}})
        a, _ = model.required_capital(p, 0.9, 300, 20261025, max_iter=10)
        b, _ = model.required_capital(q, 0.9, 300, 20261025, max_iter=10)
        self.assertLess(a, b)

    def test_deterministic_less_than_mc(self):
        p = base()
        d, _ = model.required_capital(p, 0.9, 1, 20261025, "deterministic", 20)
        m, _ = model.required_capital(p, 0.9, 500, 20261025, "stochastic", 12)
        self.assertLess(d, m)

    def test_reproducible_same_seed(self):
        p = base()
        a, _ = model.required_capital(p, 0.9, 300, 12345, "stochastic", 10)
        b, _ = model.required_capital(p, 0.9, 300, 12345, "stochastic", 10)
        self.assertAlmostEqual(a, b, places=6)

    def test_child_cost_stops(self):
        p = base()
        child = p["children"][0]
        self.assertGreater(model.child_annual_cost(p, child, 10), 0)
        self.assertEqual(model.child_annual_cost(p, child, 30), 0)

    def test_portfolio_geometric_less_than_arithmetic(self):
        p = base()
        st = model.portfolio_stats(p)
        self.assertLess(st["geom"], st["arith"])
        self.assertGreater(st["vol"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
