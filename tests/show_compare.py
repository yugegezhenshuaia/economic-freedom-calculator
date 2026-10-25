import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
j = json.loads((ROOT / "data" / "js_cases.json").read_text(encoding="utf-8"))
p = json.loads((ROOT / "data" / "py_cases.json").read_text(encoding="utf-8"))
print(f"{'case':14} {'JS det':>10} {'PY det':>10} {'diff%':>7} {'JS MC':>10} {'PY MC':>10} {'diff%':>7}")
for k in j:
    dj, dp = j[k]["deterministic"], p[k]["deterministic"]
    mj, mp = j[k]["required"], p[k]["required"]
    ddiff = 0.0 if dp == 0 else abs(dj / dp - 1) * 100
    mdiff = 0.0 if mp == 0 else abs(mj / mp - 1) * 100
    print(f"{k:14} {dj/1e4:10.1f} {dp/1e4:10.1f} {ddiff:7.3f} {mj/1e4:10.1f} {mp/1e4:10.1f} {mdiff:7.2f}")
