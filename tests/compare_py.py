import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import model  # noqa: E402

cases = json.loads((ROOT / "tests" / "cases.json").read_text(encoding="utf-8"))
out = {}
for c in cases:
    p = model.normalize(c.get("override", {}))
    det, _ = model.required_capital(p, confidence=0.9, n_paths=1, seed=20261025, mode="deterministic", max_iter=20)
    mc, _ = model.required_capital(p, confidence=0.9, n_paths=800, seed=20261025, mode="stochastic", max_iter=14)
    out[c["name"]] = {
        "deterministic": det,
        "required": mc,
        "pension": [model.pension_today(p, "self"), model.pension_today(p, "spouse")],
    }
(ROOT / "data" / "py_cases.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=2, default=float), encoding="utf-8"
)
print("wrote data/py_cases.json")
