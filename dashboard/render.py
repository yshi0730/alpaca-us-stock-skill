"""Render the US Equity desk page as a static file in the shared hub.

This skill does NOT run a server or own a tunnel. claw-dashboard-skill
(Layer 0) provides the device's one hub + one tunnel and already serves
`~/.claw/hub/public/` at `device-xxx.clawln.app/static/`. This script is
the renderer + data layer: it reads live Alpaca data + the shared.db
annotation layer, fills the template, and writes the page into that
public dir. The agent runs it on each session and on a cron.

    python3 dashboard/render.py
      → writes  ~/.claw/hub/public/us-equity.html
      URL:      https://device-<serial>.clawln.app/static/us-equity.html

Env overrides (for testing / non-default layouts):
    CLAW_SHARED_DB    path to shared.db   (default ~/.claw/shared/shared.db)
    CLAW_HUB_PUBLIC   hub public dir      (default ~/.claw/hub/public)

Never raises: missing creds / db / Alpaca failure all write a calm
status page and exit 0, so an agent session is never broken by the
dashboard.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jinja2 import Environment, FileSystemLoader, select_autoescape  # noqa: E402
from alpaca_client import AlpacaClient  # noqa: E402
from us_equity_context import build_context, read_alpaca_creds, AGENT_ID  # noqa: E402

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
DB_PATH = Path(
    os.environ.get("CLAW_SHARED_DB", str(Path.home() / ".claw" / "shared" / "shared.db"))
)
PUBLIC_DIR = Path(
    os.environ.get("CLAW_HUB_PUBLIC", str(Path.home() / ".claw" / "hub" / "public"))
)
OUT_FILE = "us-equity.html"

_env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)


def _shell(title: str, body: str) -> str:
    """Calm dark status page matching the dashboard aesthetic, for the
    not-configured / error states."""
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:flex;
align-items:center;justify-content:center;font-family:Inter,'PingFang SC',
system-ui,sans-serif;background:radial-gradient(1000px 400px at 50% -10%,
rgba(75,226,173,.14),transparent),#0a1220;color:#edf3ff}}
.box{{max-width:520px;text-align:center;padding:40px;border:1px solid #294161;
border-radius:16px;background:#0f1b31}}
.mark{{width:48px;height:48px;border-radius:12px;margin:0 auto 18px;
background:linear-gradient(135deg,#4be2ad,#43b6ff);display:flex;
align-items:center;justify-content:center;font-size:22px;color:#0a1220;
font-weight:800}}
h1{{font-size:20px;margin:0 0 10px}}
p{{color:#94a9c7;font-size:13.5px;line-height:1.65;margin:8px 0 0}}
code{{background:#162843;padding:2px 7px;border-radius:5px;font-size:12px;
color:#4be2ad}}
</style></head><body><div class="box"><div class="mark">📈</div>
{body}</div></body></html>"""


def _write(html: str) -> Path:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    out = PUBLIC_DIR / OUT_FILE
    out.write_text(html, encoding="utf-8")
    return out


def main() -> int:
    # Layer 0 must be set up first; if its public dir's parent (the hub)
    # doesn't exist we still write the file (mkdir -p) but warn.
    if not DB_PATH.exists():
        out = _write(_shell(
            "未配置 · US Equity",
            "<h1>仪表盘尚未初始化</h1><p>共享数据库还不存在。请先运行 "
            "<code>bash skills/alpaca-us-stock/dashboard/setup.sh</code> 完成初始化"
            "（它会自动搭好 Layer 0 hub + tunnel）。</p>",
        ))
        print(f"[render] no shared.db → wrote not-initialized page {out}")
        return 0

    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    try:
        creds = read_alpaca_creds(db, AGENT_ID)
        if not creds:
            out = _write(_shell(
                "未连接 Alpaca · US Equity",
                "<h1>还没连接 Alpaca 账户</h1><p>请在 "
                "<code>US Stock Trader</code> agent 里提供 Alpaca API "
                "key。配置后这个页面会自动显示你的实时组合、策略和风控。</p>",
            ))
            print(f"[render] no creds in agent_config → wrote connect page {out}")
            return 0

        try:
            with AlpacaClient(
                creds["key"], creds["secret"], paper=creds["paper"]
            ) as ac:
                ctx = build_context(ac, db)
        except Exception as e:  # noqa: BLE001
            out = _write(_shell(
                "数据加载失败 · US Equity",
                f"<h1>暂时拿不到数据</h1><p>连接 Alpaca 或读取时出错："
                f"<br><code>{type(e).__name__}: {str(e)[:160]}</code><br><br>"
                f"通常是 API key 失效或 Alpaca 临时不可用，下次刷新重试。</p>",
            ))
            print(f"[render] data error ({type(e).__name__}) → wrote error page {out}")
            return 0

        html = _env.get_template("us-equity-desk.html").render(ctx=ctx)
        out = _write(html)
        print(
            f"[render] ok → {out} "
            f"({len(html):,} chars · equity {ctx['account']['equity_fmt']} · "
            f"{ctx['holdings']['count']} positions · "
            f"{len(ctx['strategies'])} strategies · "
            f"{len(ctx['feed'])} feed)"
        )
        return 0
    except Exception:  # noqa: BLE001 — last-resort guard
        out = _write(_shell(
            "渲染错误 · US Equity",
            f"<h1>页面渲染出错</h1><p><code>"
            f"{traceback.format_exc().splitlines()[-1][:200]}</code></p>",
        ))
        print(f"[render] render error → wrote error page {out}", file=sys.stderr)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
