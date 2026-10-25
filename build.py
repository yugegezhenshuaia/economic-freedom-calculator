"""把 src 下的模板、样式、引擎、应用打包成单文件 HTML。"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"


def main() -> None:
    defaults = json.loads((SRC / "defaults.json").read_text(encoding="utf-8"))
    engine = (SRC / "engine.js").read_text(encoding="utf-8")
    engine = engine.replace("__DEFAULTS__", json.dumps(defaults, ensure_ascii=False, separators=(",", ":")))
    app = (SRC / "app.js").read_text(encoding="utf-8")
    styles = (SRC / "styles.css").read_text(encoding="utf-8")
    template = (SRC / "template.html").read_text(encoding="utf-8")

    html = template.replace("__STYLES__", styles)
    html = html.replace("__ENGINE__", engine)
    html = html.replace("__APP__", app)

    out = ROOT / "经济自由计算器.html"
    out.write_text(html, encoding="utf-8")
    print(f"built {out} ({out.stat().st_size / 1024:.0f} KB)")
    if "__" in html:
        leftovers = sorted(set(part[:40] for part in html.split("__")[1::2]))
        print("WARNING unresolved tokens:", leftovers[:20])


if __name__ == "__main__":
    main()
