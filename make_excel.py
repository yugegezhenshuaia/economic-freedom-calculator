"""生成《经济自由测算表.xlsx》——参数、确定性测算、结果、敏感性、来源。"""
from __future__ import annotations

import json
from pathlib import Path

import xlsxwriter

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / "data" / "base_result.json").read_text(encoding="utf-8"))
TARGET = int(round(DATA["required"]))
DEFAULTS = json.loads((ROOT / "src" / "defaults.json").read_text(encoding="utf-8"))
OUT = ROOT / "经济自由测算表.xlsx"


def pmt(principal: float, rate: float, years: int) -> float:
    if principal <= 0 or years <= 0:
        return 0.0
    if abs(rate) < 1e-12:
        return principal / years
    return principal * rate / (1 - (1 + rate) ** (-years))


def projection(target: float) -> list[dict]:
    p = DEFAULTS
    age0, fi, plan = int(p["household"]["age"]), int(p["household"]["fiAge"]), int(p["household"]["planUntil"])
    core = sum(float(v) for k, v in p["spending"]["monthly"].items() if k not in ("medical", "insurance"))
    med = float(p["spending"]["monthly"]["medical"])
    ins = float(p["insurance"]["annualPremium"])
    cpi = float(p["risk"]["inflationMean"])
    med_inf = cpi + float(p["risk"]["medicalInflationSpread"])
    edu_inf = cpi + float(p["risk"]["educationInflationSpread"])
    ret = 0.0384023
    mort_p = pmt(float(p["housing"]["mortgageBalance"]), float(p["housing"]["mortgageRate"]), int(p["housing"]["mortgageYearsLeft"]))
    child_age = int(p["children"][0]["age"])
    child_until = int(p["children"][0]["supportUntil"])
    pension = 9617.866482765313
    rows = []
    assets = target
    for t in range(0, plan - age0 + 1):
        age = age0 + t
        cpi_idx = (1 + cpi) ** t
        core_n = core * 12 * cpi_idx * (1 if age < fi else float(p["spending"]["retirementFactor"]))
        med_n = med * 12 * (1 + med_inf) ** t
        ins_n = ins * (1 + cpi) ** t * (1.03) ** t
        mort = mort_p if t < int(p["housing"]["mortgageYearsLeft"]) else 0.0
        child = 20000.0 * (1 + edu_inf) ** t if child_age + t <= child_until else 0.0
        oneoff = 0.0
        for o in p["spending"]["oneOffs"]:
            start, every, end = int(o["startAge"]), max(1, int(o["every"])), int(o["endAge"])
            if start <= age <= end and (age - start) % every == 0:
                oneoff += float(o["amount"]) * cpi_idx
        total = core_n + med_n + ins_n + mort + child + oneoff
        pen = pension * 12 * cpi_idx if age >= 63 else 0.0
        net = total - pen
        end = (assets - net) * (1 + ret)
        rows.append({"t": t, "age": age, "cpi": cpi_idx, "core": core_n, "med": med_n, "ins": ins_n,
                     "mort": mort, "child": child, "oneoff": oneoff, "total": total, "pension": pen,
                     "net": net, "begin": assets, "end": end})
        assets = end
    return rows


def main() -> None:
    wb = xlsxwriter.Workbook(str(OUT), {"nan_inf_to_errors": True})
    ink, green, red, muted = "#17211b", "#0d5744", "#a63d35", "#65706a"
    f_title = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 20, "bold": True, "font_color": ink})
    f_sub = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": muted, "text_wrap": True, "valign": "top"})
    f_section = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 12, "bold": True, "font_color": green, "bottom": 1, "bottom_color": "#dcd3c3"})
    f_head = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 9, "bold": True, "font_color": "#ffffff", "bg_color": green, "align": "center", "valign": "vcenter", "border": 1, "border_color": green})
    f_label = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": ink, "border": 1, "border_color": "#dcd3c3", "valign": "vcenter", "text_wrap": True})
    f_input = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": "#3a2a00", "bg_color": "#fff3cf", "border": 1, "border_color": "#e0c98e", "num_format": "#,##0"})
    f_input_pct = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": "#3a2a00", "bg_color": "#fff3cf", "border": 1, "border_color": "#e0c98e", "num_format": "0.00%"})
    f_note = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 9, "font_color": muted, "text_wrap": True, "valign": "top"})
    f_money = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "num_format": "¥#,##0", "border": 1, "border_color": "#eee7da"})
    f_money_b = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 12, "bold": True, "num_format": "¥#,##0", "font_color": green, "border": 1, "border_color": "#eee7da"})
    f_pct = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "num_format": "0.0%", "border": 1, "border_color": "#eee7da"})
    f_pct2 = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "num_format": "0.00%", "border": 1, "border_color": "#eee7da"})
    f_num = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "num_format": "#,##0", "border": 1, "border_color": "#eee7da"})
    f_good = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": green, "bold": True, "num_format": "0.0%", "border": 1, "border_color": "#eee7da"})
    f_bad = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": red, "bold": True, "num_format": "0.0%", "border": 1, "border_color": "#eee7da"})
    f_warn = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "font_color": "#a66a1f", "bold": True, "num_format": "0.0%", "border": 1, "border_color": "#eee7da"})
    f_link = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 9, "font_color": green, "underline": 1})
    f_callout = wb.add_format({"font_name": "Microsoft YaHei", "font_size": 10, "bg_color": "#fbf5e8", "border": 1, "border_color": "#e7d3ad", "text_wrap": True, "valign": "top"})
    f_red_money = wb.add_format({"bg_color": "#f3e0dc", "font_color": red, "num_format": "¥#,##0"})

    # ================= 说明 =================
    ws = wb.add_worksheet("说明")
    ws.hide_gridlines(2)
    ws.set_column("A:A", 3); ws.set_column("B:B", 20); ws.set_column("C:C", 86)
    ws.write("B2", "经济自由本金测算表", f_title)
    ws.write("B3", "2026-10 · 参数为今天购买力；确定性测算为名义金额 · 与 HTML 计算器同一套默认参数", f_sub)
    ws.merge_range("B5:C5", "这不是“保证一辈子不破产”的承诺。它把支出、通胀、社保、医疗、护理、长寿、收益序列和黑天鹅放在一起；输出是概率意义上的“够”。", f_callout)
    ws.set_row(4, 46)
    ws.write("B7", "三个概念", f_section)
    for i, (k, v) in enumerate([
        ("成功", "死亡前可投资资产从未为负，且死亡时资产不低于遗产目标（按 CPI 指数化）。"),
        ("置信度", "例如 90%，表示 4,000 条模拟人生里约 90% 不破产；不是 100%。"),
        ("所需本金", "在给定置信度下，今天至少需要的可投资净资产（不含自住房）。"),
    ]):
        ws.write(f"B{8+i}", k, f_label); ws.write(f"C{8+i}", v, f_note)
    ws.write("B12", "怎么用", f_section)
    for i, v in enumerate([
        "只改“参数”表黄色单元格；“确定性测算”会自动更新。",
        "“结果”表的蒙特卡洛区间来自 HTML 模型；改参数后请在 HTML 里重算，Excel 不会自动重跑 4,000 条路径。",
        "“确定性测算”是简化版：不含医疗大额冲击、长期护理、收益率波动；用来理解现金流，不替代蒙特卡洛。",
    ]):
        ws.write(f"B{13+i}", str(i+1), f_label); ws.write(f"C{13+i}", v, f_note)
    ws.write("B18", "模型边界", f_section)
    ws.merge_range("B19:C19", "未单独建模：个人养老金账户税优、海外资产汇率、房产税全国推开、遗产税、离婚/丧偶状态机、子女啃老、诈骗/诉讼、保险拒赔、医保目录变化、地方养老金差异。它们会改变结果，方向不一定。", f_note)
    ws.set_row(18, 44)
    ws.merge_range("B20:C20", "所有“预期收益”都是假设，不是事实。请用区间思维，而不是单点数字。", f_note)

    # ================= 参数 =================
    ws = wb.add_worksheet("参数")
    ws.hide_gridlines(2)
    ws.set_column("A:A", 3); ws.set_column("B:B", 32); ws.set_column("C:C", 18); ws.set_column("D:D", 14); ws.set_column("E:E", 64); ws.set_column("F:F", 10)
    ws.write("B2", "参数（只改黄色单元格）", f_title)
    ws.write("B3", "所有金额为今天（2026）购买力；百分比单元格已设为百分比格式。", f_sub)
    ws.write_row("B5", ["参数", "值", "单位", "说明 / 来源", ""], f_head)
    C = {
        "age": "C6", "spouse": "C7", "fi": "C8", "plan": "C9", "assets": "C10",
        "core": "C20", "med": "C21", "ins": "C22", "retire": "C23",
        "mort_bal": "C24", "mort_rate": "C25", "mort_years": "C26", "mort_pmt": "C27",
        "child_age": "C28", "child_cost": "C29", "child_until": "C30",
        "pension": "C31", "pension_start": "C32", "cola": "C33",
        "cpi": "C34", "med_inf": "C35", "edu_inf": "C36", "ret": "C37", "prem_g": "C38",
        "target": "C39", "conf": "C40", "bequest": "C41", "home": "C42",
    }
    set_row = 6
    for key, label, val, fmt, unit, note in [
        ("age", "当前年龄", 40, f_input, "周岁", "你自己"),
        ("spouse", "配偶年龄", 38, f_input, "周岁", "1 人家庭忽略"),
        ("fi", "停止工作年龄", 40, f_input, "周岁", "现在不工作 = 当前年龄"),
        ("plan", "规划到年龄", 100, f_input, "周岁", "保守 100；压力测试 105"),
        ("assets", "当前可投资净资产", 3000000, f_input, "元", "不含自住房"),
    ]:
        ws.write(f"B{set_row}", label, f_label); ws.write_number(f"C{set_row}", val, fmt); ws.write(f"D{set_row}", unit, f_label); ws.write(f"E{set_row}", note, f_note)
        set_row += 1

    ws.write("B12", "核心生活（元/月）", f_section)
    core_vals = [("餐饮食品", 5000), ("居住/物业/水电", 3000), ("交通通讯", 1800), ("衣着日用", 800), ("娱乐旅游", 1200), ("人情社交", 1000), ("其他/不可预见", 1200)]
    for i, (label, val) in enumerate(core_vals):
        row = 13 + i
        ws.write(f"B{row}", label, f_label); ws.write_number(f"C{row}", val, f_input); ws.write(f"D{row}", "元/月", f_label); ws.write(f"E{row}", "不含医疗、保险、房贷", f_note)
    ws.write("B20", "核心月支出合计", f_label)
    ws.write_formula("C20", "=SUM(C13:C19)", f_input, sum(v for _, v in core_vals))
    ws.write("D20", "元/月", f_label); ws.write("E20", "公式自动合计（7 项）", f_note)

    rows_params = [
        (21, "日常医疗 / 体检", 1000, f_input, "元/月", "随医疗通胀膨胀", C["med"]),
        (22, "商业保险年保费", 12000, f_input, "元/年", "全家合计；随年龄上升", C["ins"]),
        (23, "退休后基础支出比例", 0.9, f_input_pct, "%", "相对当前核心生活", C["retire"]),
        (24, "房贷余额", 1000000, f_input, "元", "自住房不计入可投资资产", C["mort_bal"]),
        (25, "房贷利率", 0.032, f_input_pct, "%", "名义固定利率", C["mort_rate"]),
        (26, "房贷剩余年限", 15, f_input, "年", "等额本息", C["mort_years"]),
    ]
    for row, label, val, fmt, unit, note, _ in rows_params:
        ws.write(f"B{row}", label, f_label); ws.write_number(f"C{row}", val, fmt); ws.write(f"D{row}", unit, f_label); ws.write(f"E{row}", note, f_note)
    ws.write("B27", "房贷年供", f_label)
    ws.write_formula("C27", f"=PMT({C['mort_rate']},{C['mort_years']},-{C['mort_bal']})", f_money, pmt(1000000, 0.032, 15))
    ws.write("D27", "元/年", f_label); ws.write("E27", "公式自动计算", f_note)

    for row, label, val, fmt, unit, note in [
        (28, "子女当前年龄", 6, f_input, "周岁", "0 个子女填 0 并把年成本设 0"),
        (29, "子女年成本", 20000, f_input, "元/年", "增量成本；不含家庭共同住房"),
        (30, "子女支持到年龄", 22, f_input, "周岁", "默认本科毕业"),
        (31, "社保月养老金（合计）", 9618, f_input, "元/月", "今天币值；可由 HTML 公式估算"),
        (32, "养老金开始年龄", 63, f_input, "周岁", "渐进式延迟退休后约为 63"),
        (33, "养老金调整率", 0.02, f_input_pct, "%", "名义；本表简化未用"),
        (34, "CPI 中枢", 0.02, f_input_pct, "%/年", "长期假设；2024/2025 实际为 0.2%/0.0%"),
        (35, "医疗通胀", 0.05, f_input_pct, "%/年", "CPI + 3% 的假设"),
        (36, "教育通胀", 0.05, f_input_pct, "%/年", "CPI + 3% 的假设"),
        (37, "组合费后几何收益", 0.0384023, f_input_pct, "%/年", "HTML 默认组合：30/30/30/10，费后"),
        (38, "保费实际增长", 0.03, f_input_pct, "%/年", "随年龄上升"),
        (39, "目标本金（测算用）", TARGET, f_input, "元", "来自蒙特卡洛 90% 目标；可改"),
        (40, "目标置信度", 0.9, f_input_pct, "%", "90% 推荐；95/99 更稳"),
        (41, "遗产目标", 0, f_input, "元", "按 CPI 指数化"),
        (42, "自住房价值", 3000000, f_input, "元", "不计入可投资资产"),
    ]:
        ws.write(f"B{row}", label, f_label); ws.write_number(f"C{row}", val, fmt); ws.write(f"D{row}", unit, f_label); ws.write(f"E{row}", note, f_note)

    ws.write("B44", "大件 / 一次性支出", f_section)
    ws.write_row("B45", ["项目", "金额（元）", "开始年龄", "每隔（年）", "结束年龄", ""], f_head)
    oneoffs = [("换车", 180000, 48, 8, 80), ("房屋装修/维修", 200000, 50, 15, 80), ("长途旅行", 60000, 45, 5, 80)]
    for i, (name, amount, start, every, end) in enumerate(oneoffs):
        row = 46 + i
        ws.write(f"B{row}", name, f_label); ws.write_number(f"C{row}", amount, f_input); ws.write_number(f"D{row}", start, f_input); ws.write_number(f"E{row}", every, f_input); ws.write_number(f"F{row}", end, f_input)

    def P(cell: str) -> str:
        return f"参数!${cell[0]}${cell[1:]}"

    # ================= 确定性测算 =================
    ws = wb.add_worksheet("确定性测算")
    ws.hide_gridlines(2)
    ws.freeze_panes(3, 2)
    for i, w in enumerate([6, 7, 9, 12, 11, 10, 10, 10, 10, 12, 11, 12, 14, 14]):
        ws.set_column(i, i, w)
    ws.set_landscape(); ws.fit_to_pages(1, 0)
    ws.write("A1", "确定性测算（简化版）", f_title)
    ws.write("A2", "名义金额；假设双方都活到 100 岁，不建模死亡、卖房、遗产；不含收益波动、医疗大额冲击、长期护理。用于理解现金流，不替代蒙特卡洛。", f_sub)
    ws.write_row(3, 0, ["年序", "年龄", "CPI 指数", "核心支出", "医疗", "保险", "房贷", "子女", "大件", "总支出", "养老金", "净支出", "期初资产", "期末资产"], f_head)
    rows = projection(TARGET)

    def oneoff_formula(row: int) -> str:
        parts = []
        for r in (46, 47, 48):
            parts.append(f"IF(AND(B{row}>=参数!$D${r},B{row}<=参数!$F${r},MOD(B{row}-参数!$D${r},参数!$E${r})=0),参数!$C${r}*C{row},0)")
        return "=" + "+".join(parts)

    for i, row in enumerate(rows):
        rr = 4 + i  # 1-based Excel row
        ws.write_number(rr - 1, 0, row["t"], f_num)
        ws.write_number(rr - 1, 1, row["age"], f_num)
        if i == 0:
            ws.write_formula(rr - 1, 2, "=1", f_num, 1.0)
        else:
            ws.write_formula(rr - 1, 2, f"=C{rr-1}*(1+{P(C['cpi'])})", f_num, row["cpi"])
        ws.write_formula(rr - 1, 3, f"={P(C['core'])}*12*C{rr}*IF(B{rr}>={P(C['fi'])},{P(C['retire'])},1)", f_money, row["core"])
        ws.write_formula(rr - 1, 4, f"={P(C['med'])}*12*(1+{P(C['med_inf'])})^A{rr}", f_money, row["med"])
        ws.write_formula(rr - 1, 5, f"={P(C['ins'])}*(1+{P(C['cpi'])})^A{rr}*(1+{P(C['prem_g'])})^A{rr}", f_money, row["ins"])
        ws.write_formula(rr - 1, 6, f"=IF(A{rr}<{P(C['mort_years'])},{P(C['mort_pmt'])},0)", f_money, row["mort"])
        ws.write_formula(rr - 1, 7, f"=IF({P(C['child_age'])}+A{rr}<={P(C['child_until'])},{P(C['child_cost'])}*(1+{P(C['edu_inf'])})^A{rr},0)", f_money, row["child"])
        ws.write_formula(rr - 1, 8, oneoff_formula(rr), f_money, row["oneoff"])
        ws.write_formula(rr - 1, 9, f"=SUM(D{rr}:I{rr})", f_money, row["total"])
        ws.write_formula(rr - 1, 10, f"=IF(B{rr}>={P(C['pension_start'])},{P(C['pension'])}*12*C{rr},0)", f_money, row["pension"])
        ws.write_formula(rr - 1, 11, f"=J{rr}-K{rr}", f_money, row["net"])
        if i == 0:
            ws.write_formula(rr - 1, 12, f"={P(C['target'])}", f_money_b, row["begin"])
        else:
            ws.write_formula(rr - 1, 12, f"=N{rr-1}", f_money_b, row["begin"])
        ws.write_formula(rr - 1, 13, f"=(M{rr}-L{rr})*(1+{P(C['ret'])})", f_money, row["end"])
    last = 4 + len(rows) - 1
    ws.conditional_format(3, 13, last - 1, 13, {"type": "cell", "criteria": "<", "value": 0, "format": f_red_money})
    summary = last + 2
    ws.write(summary - 1, 1, "期末资产", f_label)
    ws.write_formula(summary - 1, 2, f"=N{last}", f_money_b, rows[-1]["end"])
    ws.write(summary, 1, "资产首次为负", f_label)
    first_neg = next((x["age"] for x in rows if x["end"] < 0), "未耗尽")
    ws.write_formula(summary, 2, f'=IFERROR(INDEX(B4:B{last},MATCH(TRUE,INDEX(N4:N{last}<0,0),0)),"未耗尽")', f_label, first_neg)
    ws.write(summary + 1, 1, "最低期末资产", f_label)
    ws.write_formula(summary + 1, 2, f"=MIN(N4:N{last})", f_money, min(x["end"] for x in rows))

    # ================= 结果 =================
    ws = wb.add_worksheet("结果")
    ws.hide_gridlines(2)
    ws.set_column("A:A", 3); ws.set_column("B:B", 30); ws.set_column("C:C", 18); ws.set_column("D:D", 14); ws.set_column("E:E", 54)
    ws.write("B2", "结果：概率意义上的“够”", f_title)
    ws.write("B3", "以下蒙特卡洛数值来自 4,000 条路径、90% 置信度；改参数后请在 HTML 计算器重算。", f_sub)
    ws.write("B5", "目标本金（90%）", f_label); ws.write_number("C5", DATA["required"], f_money_b); ws.write("D5", "今天币值", f_label)
    ws.write("B6", "当前资产", f_label); ws.write_number("C6", DATA["currentAssets"], f_money)
    ws.write("B7", "覆盖率", f_label); ws.write_number("C7", DATA["coverage"], f_pct)
    ws.write("B8", "当前资产成功率（不再工作）", f_label); ws.write_number("C8", DATA["currentSuccess"], f_pct)
    ws.write("B9", "活到 90 岁条件下成功率", f_label); ws.write_number("C9", DATA["currentSuccessLong"], f_pct)
    ws.write("B10", "首年总支出", f_label); ws.write_number("C10", DATA["firstYearSpending"]["total"], f_money)
    ws.write("B11", "首年总支出 / 目标本金", f_label); ws.write_number("C11", DATA["firstYearWithdrawalRate"], f_pct)
    ws.write("B12", "当前资产可支撑核心生活费", f_label); ws.write_number("C12", DATA["safeCoreMonthlyCurrent"] * 12, f_money); ws.write("D12", "元/年", f_label)
    ws.write("B13", "4% 法则本金", f_label); ws.write_number("C13", DATA["fourPercent"], f_money)
    ws.write("B14", "4% 法则在本模型下的成功率", f_label); ws.write_number("C14", DATA["fourPercentSuccess"], f_bad)

    ws.write("B16", "置信度区间", f_section)
    ws.write_row("B17", ["目标置信度", "所需本金", "相当于首年支出", "说明"], f_head)
    for i, k in enumerate(["80", "90", "95", "99"]):
        rr = 18 + i
        v = DATA["requiredByConfidence"][k]
        ws.write(f"B{rr}", f"{k}%", f_label); ws.write_number(f"C{rr}", v, f_money_b if k == "90" else f_money)
        ws.write(f"D{rr}", f"{v / DATA['firstYearSpending']['total']:.1f}×", f_label)
        ws.write(f"E{rr}", "推荐" if k == "90" else ("更稳" if k in ("95", "99") else "进取"), f_note)

    ws.write("B23", "首年现金流", f_section)
    ws.write_row("B24", ["项目", "金额（元）", "", "备注"], f_head)
    f = DATA["firstYearSpending"]
    for i, (name, val) in enumerate([("核心生活", f["core"]), ("医疗（日常）", f["medical"]), ("商业保险", f["insurance"]), ("房贷 / 居住", f["housing"]), ("子女", f["child"]), ("父母赡养", f.get("parents", 0)), ("长期护理", f.get("ltc", 0)), ("大件", f.get("oneoff", 0)), ("合计", f["total"])]):
        rr = 25 + i
        ws.write(f"B{rr}", name, f_label); ws.write_number(f"C{rr}", val, f_money); ws.write(f"D{rr}", "", f_label); ws.write(f"E{rr}", "首年" if name == "合计" else "", f_note)

    ws.write("B33", "压力测试（目标本金下）", f_section)
    ws.write_row("B34", ["情景", "成功率", "", "说明"], f_head)
    for i, s in enumerate(DATA["stress"]):
        rr = 35 + i
        fmt = f_bad if s["success"] < 0.5 else (f_warn if s["success"] < 0.8 else f_good)
        ws.write(f"B{rr}", s["name"], f_label); ws.write_number(f"C{rr}", s["success"], fmt); ws.write(f"D{rr}", "", f_label); ws.write(f"E{rr}", "", f_note)

    ws.write("B43", "结论", f_section)
    ws.merge_range("B44:E46", f"按当前参数，90% 置信度目标约 {DATA['required']/1e4:,.0f} 万元；当前资产 {DATA['currentAssets']/1e4:,.0f} 万元，覆盖率 {DATA['coverage']:.0%}。4% 法则给出 {DATA['fourPercent']/1e4:,.0f} 万元，但在本模型下只有 {DATA['fourPercentSuccess']:.0%} 成功率。", f_callout)
    for r in (43, 44, 45):
        ws.set_row(r, 24)

    # ================= 敏感性 =================
    ws = wb.add_worksheet("敏感性")
    ws.hide_gridlines(2)
    ws.set_column("A:A", 3); ws.set_column("B:B", 16); ws.set_column("C:C", 15); ws.set_column("D:D", 15); ws.set_column("E:E", 15); ws.set_column("F:F", 12); ws.set_column("G:G", 12); ws.set_column("H:H", 12)
    ws.write("B2", "敏感性：参数变化时，90% 目标本金怎么变", f_title)
    ws.write("B3", "敏感性内部同一样本（800 路径）；与结果表主目标（4,000 路径）有抽样差异。low = 更乐观（本金更低），high = 更悲观。", f_sub)
    ws.write_row("B5", ["参数", "基准", "更乐观", "更悲观", "乐观标签", "悲观标签", "影响幅度"], f_head)
    for i, s in enumerate(DATA["sensitivity"]):
        rr = 6 + i
        ws.write(f"B{rr}", s["name"], f_label); ws.write_number(f"C{rr}", s["base"], f_money)
        ws.write_number(f"D{rr}", s["low"], f_money); ws.write_number(f"E{rr}", s["high"], f_money)
        ws.write(f"F{rr}", s["lowLabel"], f_label); ws.write(f"G{rr}", s["highLabel"], f_label)
        ws.write_number(f"H{rr}", abs(s["high"] - s["low"]) / max(1, s["base"]), f_pct)

    # ================= 来源 =================
    ws = wb.add_worksheet("数据与来源")
    ws.hide_gridlines(2)
    ws.set_column("A:A", 3); ws.set_column("B:B", 30); ws.set_column("C:C", 30); ws.set_column("D:D", 14); ws.set_column("E:E", 56); ws.set_column("F:F", 10)
    ws.write("B2", "关键数据与来源", f_title)
    ws.write("B3", "截至 2026-10-25；政策类尽量用政府原文，数值类标注年份与口径。", f_sub)
    ws.write_row("B5", ["数据", "数值", "年份/口径", "来源", "链接"], f_head)
    sources = [
        ("全国居民人均消费支出", "29,476 元/年", "2025", "国家统计局", "https://www.stats.gov.cn/xxgk/sjfb/zxfb2020/202601/t20260119_1962321.html"),
        ("城镇居民人均消费支出", "35,869 元/年", "2025", "国家统计局", "https://www.stats.gov.cn/xxgk/sjfb/zxfb2020/202601/t20260119_1962321.html"),
        ("北京城镇居民人均消费", "54,122 元/年", "2025", "北京市统计局", "https://www.beijing.gov.cn/gongkai/shuju/sjjd/202601/t20260121_4452945.html"),
        ("上海城镇居民人均消费", "57,076 元/年", "2025", "上海市统计局", "https://www.shanghai.gov.cn/nw48810/20260203/2bed33e23b324e27ae846d3a88bade53.html"),
        ("CPI", "2024 +0.2% / 2025 0.0% / 2026-09 +0.9%", "2024–2026", "国家统计局", "https://www.stats.gov.cn/"),
        ("人均预期寿命", "79.25 岁", "2025", "国家卫健委", "https://wsjkw.hebei.gov.cn/zwyw/417773.jhtml"),
        ("卫生总费用 / 人均", "93,367.2 亿元 / 6,637.9 元", "2025", "国家卫健委卫生发展研究中心", "http://www.cn-he.cn/zgwsjj/article/abstract/1202604160"),
        ("个人卫生支出占比", "27.1%", "2025", "同上", "http://www.cn-he.cn/zgwsjj/article/abstract/1202604160"),
        ("企业退休月人均养老金", "3,162 元", "2023", "全国人大常委会社保法执法检查报告", "https://news.dayoo.com/gzrbrmt/202411/07/170628_54742831.htm"),
        ("2024 / 2025 养老金调整", "+3% / +2%", "2024 / 2025", "人社部、财政部", "https://www.gov.cn/zhengce/zhengceku/202507/content_7031449.htm"),
        ("城乡居民基础养老金最低标准", "163 元/月", "2026", "政府工作报告", "http://www.yuping.gov.cn/xzjdbsc/yyx_5999721/gzdt/202603/t20260316_89875891.html"),
        ("渐进式延迟退休", "男 63 / 女 58 或 55；最低缴费 20 年", "2025 起", "全国人大常委会决定", "https://www.gov.cn/zhengce/202409/content_6974294.htm"),
        ("个人养老金", "12,000 元/年限额；领取 3% 税", "2024 起全国", "财政部、税务总局公告 2024 年第 21 号", "https://zhejiang.chinatax.gov.cn/art/2026/3/9/art_24107_650245.html"),
        ("中国 10 年期国债", "1.64%", "2026-10-23", "中债", "https://www.chinabond.com.cn/zzsj/zzsj_zzjgcp/zzjgcp_cpdt/cpdt_cpbg/cpbg_qxhzsrp/202610/t20261023_855472794.html"),
        ("1 年期定存", "0.95%–0.98%", "2026-10", "国有大行挂牌", "https://bank.stockstar.com/IG2026032900008267.shtml"),
        ("生育成本（全国 0–17 岁）", "53.8 万元", "2022 年价格", "育娲人口《中国生育成本报告 2024 版》", "https://news.cnr.cn/native/gd/20240221/t20240221_526602847.shtml"),
        ("30 岁男 50 万重疾（保至 70）", "约 5,600 元/年", "2026 报价", "谱蓝保/慧择等公开报价", "https://www.pulanbx.com/bxzs/233812.html"),
        ("30 岁男 100 万定寿（保至 60）", "约 1,100–1,250 元/年", "2025–2026 报价", "慧择公开报价", "https://m.huize.com/study/detail-482956.html"),
        ("芜湖全护理养老机构", "2,200–4,600 元/月", "2025-12 政府公示", "芜湖市镜湖区民政局", "https://www.whjhq.gov.cn/openness/public/6605561/40821393.html"),
        ("4% 法则", "美国 1926–1992，30 年，50/50 股债", "1994", "Bengen, JFP 7(4)", "https://www.nasdaq.com/articles/creator-4-rule-shares-his-new-strategy-retire-richer"),
    ]
    for i, (data, val, year, src, url) in enumerate(sources):
        rr = 6 + i
        ws.write(f"B{rr}", data, f_label); ws.write(f"C{rr}", val, f_label); ws.write(f"D{rr}", year, f_label); ws.write(f"E{rr}", src, f_label)
        ws.write_url(f"F{rr}", url, f_link, string="链接")
        ws.set_row(rr - 1, 28)

    wb.close()
    print("wrote", OUT)


if __name__ == "__main__":
    main()
