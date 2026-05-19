"""Preview script — renders the dashboard template with a fully mocked
context (no DB, no Alpaca). Used to iterate on visual design without
touching real infrastructure.

    python3 dashboard/_preview.py

Writes to /tmp/alpaca-preview.html and prints the path. On macOS you
can `open` that path to view.
"""
from __future__ import annotations

from pathlib import Path
from jinja2 import Environment, FileSystemLoader

HERE = Path(__file__).parent
OUT = Path("/tmp/alpaca-preview.html")


def _nav_polyline(seed: int, drift: float, amp: float) -> str:
    pts = []
    for i in range(60):
        x = round(40 + i * (680 / 59), 1)
        y = 220 - i * drift - ((i + seed) % 7) * amp + ((i + seed) % 13)
        pts.append(f"{x},{round(max(20, min(240, y)), 1)}")
    return " ".join(pts)


fund_line = _nav_polyline(seed=2, drift=1.6, amp=2.5)
spy_line = _nav_polyline(seed=5, drift=0.9, amp=1.8)


def _area(line: str) -> str:
    return f"40,260 {line} 720,260"


CTX = {
    "meta": {
        "agent_id": "alpaca-us-stock-trader",
        "account_number": "PA3X4F2K9Q",
        "authorization_label": "Semi-Auto",
        "build_date": "2026.05.19",
        "generated_at": "2026-05-19 09:32",
        "is_paper": True,
        "latency_ms": 142,
        "market_label": "NYSE 09:32 ET · 常规交易",
        "mode": "L2",
        "skill_version": "alpaca-us-stock-agent v0.3.3",
    },
    "account": {
        "equity_fmt": "$128,420",
        "cash_fmt": "$36,180",
        "buying_power_fmt": "$256,840",
        "buying_power_mult": "2x",
        "day_pl_fmt": "+$1,847",
        "day_pl_class": "good",
        "day_pl_pct_fmt": "+1.46%",
    },
    "metrics": {
        "ytd_fmt": "+18.4%",
        "spy_ytd_fmt": "+9.7%",
        "alpha_fmt": "+8.7%",
        "sharpe": "1.84",
        "sortino": "2.31",
        "max_dd_fmt": "-6.2%",
        "var_fmt": "-$2,140",
    },
    "nav": {
        "nav_value": "$1.184",
        "alpha_fmt": "+8.7%",
        "fund_line": fund_line,
        "fund_area": _area(fund_line),
        "spy_line": spy_line,
        "spy_area": _area(spy_line),
        "x_labels": [
            {"x": 80, "text": "Jan"}, {"x": 200, "text": "Mar"},
            {"x": 320, "text": "May"}, {"x": 440, "text": "Jul"},
            {"x": 560, "text": "Sep"}, {"x": 680, "text": "Nov"},
        ],
        "y_labels": [
            {"y": 60, "text": "1.20"}, {"y": 120, "text": "1.10"},
            {"y": 180, "text": "1.00"}, {"y": 240, "text": "0.95"},
        ],
        "last_x": 680, "last_y": 110, "last_label": "$1.184",
    },
    "strategies": [
        {"name": "Momentum Rotation", "status": "running", "status_class": "run",
         "pnl_fmt": "+$4,820", "pnl_class": "good",
         "meta": "k=5 holdings · 3d hold · 50/200 DMA cross",
         "last_label": "last: ", "last_text": "NVDA buy 5 @ 892.40 · 8s ago"},
        {"name": "Mean Reversion (SPY)", "status": "running", "status_class": "run",
         "pnl_fmt": "+$1,260", "pnl_class": "good",
         "meta": "RSI<30 entry · 2σ band · 1d hold",
         "last_label": "last: ", "last_text": "SPY exit @ 538.20 · 14m ago"},
        {"name": "Pairs (XOM-CVX)", "status": "paused", "status_class": "pause",
         "pnl_fmt": "-$310", "pnl_class": "bad",
         "meta": "correlation breakdown detected",
         "last_label": "paused: ", "last_text": "awaiting reapproval"},
    ],
    "holdings": {
        "count": 7,
        "total_mv_fmt": "$92,240", "total_upl_fmt": "+$5,140",
        "total_upl_class": "good", "total_weight_fmt": "71.8%",
        "rows": [
            {"symbol": "NVDA", "strategy": "Momentum Rotation", "qty": "5",
             "avg_fmt": "$892.40", "cur_fmt": "$896.10", "mv_fmt": "$4,480",
             "upl_fmt": "+$18.50", "upl_class": "good", "weight_fmt": "3.5%"},
            {"symbol": "AAPL", "strategy": "Momentum Rotation", "qty": "22",
             "avg_fmt": "$184.20", "cur_fmt": "$191.05", "mv_fmt": "$4,203",
             "upl_fmt": "+$150.70", "upl_class": "good", "weight_fmt": "3.3%"},
            {"symbol": "MSFT", "strategy": "Momentum Rotation", "qty": "14",
             "avg_fmt": "$402.30", "cur_fmt": "$418.90", "mv_fmt": "$5,864",
             "upl_fmt": "+$232.40", "upl_class": "good", "weight_fmt": "4.6%"},
            {"symbol": "GOOGL", "strategy": "Momentum Rotation", "qty": "18",
             "avg_fmt": "$162.50", "cur_fmt": "$174.20", "mv_fmt": "$3,135",
             "upl_fmt": "+$210.60", "upl_class": "good", "weight_fmt": "2.4%"},
            {"symbol": "SPY", "strategy": "Mean Reversion", "qty": "60",
             "avg_fmt": "$528.10", "cur_fmt": "$542.15", "mv_fmt": "$32,529",
             "upl_fmt": "+$843.00", "upl_class": "good", "weight_fmt": "25.3%"},
            {"symbol": "META", "strategy": "Momentum Rotation", "qty": "7",
             "avg_fmt": "$498.20", "cur_fmt": "$614.90", "mv_fmt": "$4,304",
             "upl_fmt": "+$816.90", "upl_class": "good", "weight_fmt": "3.4%"},
            {"symbol": "TSLA", "strategy": "Momentum Rotation", "qty": "15",
             "avg_fmt": "$232.80", "cur_fmt": "$228.40", "mv_fmt": "$3,426",
             "upl_fmt": "-$66.00", "upl_class": "bad", "weight_fmt": "2.7%"},
        ],
    },
    "broadcast": [
        {"ts": "09:31:02", "tag": "SYSTEM", "actor": "",                "msg": "connecting to Alpaca paper · OK",                                       "level": "info"},
        {"ts": "09:31:04", "tag": "SYSTEM", "actor": "",                "msg": "loaded strategy momentum-rotation (k=5, hold=3d)",                       "level": "info"},
        {"ts": "09:31:08", "tag": "SYSTEM", "actor": "",                "msg": "market open · NYSE regular hours · latency 142ms",                       "level": "info"},
        {"ts": "09:31:12", "tag": "AGENT",  "actor": "[Screener]",      "msg": "扫描 SP500 候选 (487 支) · 应用价/量/动量过滤",                          "level": "info"},
        {"ts": "09:31:18", "tag": "AGENT",  "actor": "[Screener]",      "msg": "选出 12 支符合条件 → NVDA, AMD, MSFT, GOOGL …",                          "level": "done"},
        {"ts": "09:31:21", "tag": "AGENT",  "actor": "[Risk]",          "msg": "检查单仓上限 ≤10% · 当日 DD ≤3% · 通过",                                 "level": "done"},
        {"ts": "09:31:24", "tag": "DECIDE", "actor": "[Trader]",        "msg": "买入 NVDA × 5 @ market · 理由:50DMA 上穿 200DMA + 量能放大 1.8x",        "level": "info"},
        {"ts": "09:31:25", "tag": "ORDER",  "actor": "[Trader]",        "msg": "submitted client_order_id=mom-20260519-001 · NVDA buy 5 @ market",       "level": "info"},
        {"ts": "09:31:27", "tag": "FILL",   "actor": "[Broker]",        "msg": "NVDA × 5 @ $892.40 · slippage +$0.12 · fee $0.00",                       "level": "done"},
        {"ts": "09:31:30", "tag": "AGENT",  "actor": "[Screener]",      "msg": "AMD 信号弱化(量能回落 < 0.6x),撤回买入意向",                            "level": "info"},
        {"ts": "09:31:34", "tag": "HOLD",   "actor": "[Trader]",        "msg": "AAPL · 已持有 22 股 · 信号未变,继续持有",                                "level": "info"},
        {"ts": "09:31:41", "tag": "AGENT",  "actor": "[Risk]",          "msg": "组合 β 漂移到 1.18(目标 1.0±0.2),仍在阈值内",                          "level": "info"},
        {"ts": "09:31:48", "tag": "WARN",   "actor": "[Risk]",          "msg": "TSLA 波动率突增 2.4σ · 自动收紧止损 -3% → -1.8%",                        "level": "warn"},
        {"ts": "09:31:53", "tag": "DECIDE", "actor": "[Trader]",        "msg": "卖出 META × 3 @ limit $612.50 · 理由:触发利润止盈线 +18.2%",             "level": "info"},
        {"ts": "09:31:54", "tag": "ORDER",  "actor": "[Trader]",        "msg": "submitted client_order_id=mom-20260519-002 · META sell 3 @ 612.50",      "level": "info"},
        {"ts": "09:31:58", "tag": "FILL",   "actor": "[Broker]",        "msg": "META × 3 @ $612.58 · realized P&L +$324.18",                             "level": "done"},
        {"ts": "09:32:02", "tag": "AGENT",  "actor": "[ReportAgent]",   "msg": "生成小时汇报 · 推送到 WebChat (channel=webchat)",                         "level": "info"},
        {"ts": "09:32:05", "tag": "SYSTEM", "actor": "",                "msg": "next cron tick at 10:32:00 · idle",                                      "level": "info"},
    ],
    "feed": [
        {"time": "09:31:58", "side": "sell", "side_label": "SELL", "symbol": "META",
         "detail": "3 股 @ $612.58", "reasoning": "触发利润止盈线 +18.2%,主动锁定收益",
         "pnl_fmt": "+$324", "pnl_class": "good"},
        {"time": "09:31:27", "side": "buy", "side_label": "BUY", "symbol": "NVDA",
         "detail": "5 股 @ $892.40", "reasoning": "50DMA 上穿 200DMA · 量能放大 1.8x · 动量入场",
         "pnl_fmt": "+$18", "pnl_class": "good"},
        {"time": "09:18:12", "side": "hold", "side_label": "HOLD", "symbol": "AAPL",
         "detail": "22 股 @ $184.20 avg",
         "reasoning": "信号未变(动量得分 0.72,阈值 0.6),继续持有",
         "pnl_fmt": "+$150", "pnl_class": "good"},
        {"time": "09:02:41", "side": "buy", "side_label": "ADD", "symbol": "MSFT",
         "detail": "+4 股 @ $416.10", "reasoning": "短线回踩 20DMA 不破 · 加仓",
         "pnl_fmt": "+$11", "pnl_class": "good"},
        {"time": "08:48:03", "side": "sell", "side_label": "REDUCE", "symbol": "SPY",
         "detail": "-10 股 @ $541.80", "reasoning": "RSI 回到 55,均值回归仓位 5/6 完成出场",
         "pnl_fmt": "+$420", "pnl_class": "good"},
    ],
    "risk": [
        {"k": "组合 β", "v": "1.18", "w_pct": 59},
        {"k": "集中度 (Top1)", "v": "25.3%", "w_pct": 50},
        {"k": "波动率 σ (30d)", "v": "14.2%", "w_pct": 47},
        {"k": "换手率 (5d)", "v": "38%", "w_pct": 38},
        {"k": "杠杆使用", "v": "0.0x", "w_pct": 0},
        {"k": "VaR (95%, 1d)", "v": "-$2,140", "w_pct": 42},
    ],
    "guardrails": [
        {"k": "单仓上限", "v": "25.3% / 30%", "meta": "SPY 占比 25.3%", "ok": True},
        {"k": "日内最大亏损", "v": "+1.46% / -3%", "meta": "今日盈,余量充足", "ok": True},
        {"k": "日内最大交易数", "v": "5 / 10", "meta": "今日 5 笔", "ok": True},
        {"k": "单笔最大金额", "v": "$4,463 / $5,000", "meta": "SPY 60 股", "ok": True},
        {"k": "止损必备", "v": "7 / 7", "meta": "所有持仓已设止损", "ok": True},
        {"k": "新策略 paper 5 天", "v": "PAPER 模式", "meta": "目前全策略均为 paper", "ok": True},
        {"k": "熔断条件 -3% 日亏", "v": "未触发", "meta": "safety net", "ok": True},
        {"k": "波动率告警", "v": "TSLA σ +2.4σ", "meta": "自动收紧止损 -1.8%", "ok": False},
    ],
}


def main() -> int:
    env = Environment(loader=FileSystemLoader(str(HERE / "templates")))
    tpl = env.get_template("us-equity-desk.html")
    html = tpl.render(ctx=CTX)
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
