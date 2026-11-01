# claude-usage-band

A one-line usage band above the Claude Code prompt: context fill, rate-limit windows with reset countdowns, and estimated cost for today, the billing week and this month.

在 Claude Code 输入框上方显示一行用量信息：上下文占用、限额窗口及重置倒计时，以及今日、本计费周、本月的估算费用。

![usage-band in the desktop app](docs/screenshot.png)

```
◑ 50% ctx · ○ 3% 5h · 4h22m · ◔ 25% 7d · 4d17h · $12.50/D · $85/W · $300/M
```

In the desktop app each percentage gets a small ring; in the terminal, a pie glyph.

桌面 app 中每个百分比带一个小圆环，终端中显示为饼图字符。

## What it shows / 显示内容

| Item | Meaning | 含义 |
| --- | --- | --- |
| `ctx` | Context used, against the auto-compact window (same as `/context`) | 上下文占用，按自动压缩窗口计算（与 `/context` 一致） |
| `5h` / `7d` | Five-hour and seven-day limit usage, with time until reset | 5 小时、7 天限额已用比例，及距重置的时间 |
| `/D` `/W` `/M` | Estimated cost today, this billing week, this month | 今日、本计费周、本月的估算费用 |

![ring colors: normal, warning, critical](docs/states.svg)

- Colors follow the app's own usage popover: normal below 75%, amber from 75%, red from 90%.
- The billing week is the seven-day limit's window, not a calendar week; `/W` is hidden without it (e.g. on an API key).
- A `*` after `/M` means some models had no known price and were left out.

- 颜色与 app 自带的用量弹窗一致：75% 以下正常，75% 起橙色，90% 起红色。
- 计费周指 7 天限额的窗口，不是自然周；没有该窗口时（如使用 API key）不显示 `/W`。
- `/M` 后出现 `*` 表示有模型价格未知，未计入。

## Install / 安装

In a terminal Claude Code session / 在终端 Claude Code 会话中：

```
/plugin install usage-band --marketplace guoggg/claude-usage-band
```

From a shell / 在 shell 中：

```bash
claude plugin install usage-band --marketplace guoggg/claude-usage-band
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `guoggg/claude-usage-band`, then **Add plugin**.

桌面 app：点击输入框旁的 **+** → **Plugins** → **Add marketplace**，填入 `guoggg/claude-usage-band`，再点 **Add plugin**。

Answer `y` to add the marketplace and pick the user scope; the band appears once the next prompt is drawn.

添加 marketplace 时输入 `y`，范围选 user；下次刷新输入框时即可看到。

## Requirements / 环境要求

- A Claude Code version that supports mods (hooks modules); built and tested on 2.1.309.
- Python 3 at `/usr/bin/python3` (macOS / Linux), used for the cost scan. Windows is not supported yet.

- 支持 mod（hooks 模块）的 Claude Code 版本；在 2.1.309 上开发和测试。
- `/usr/bin/python3`（macOS / Linux），用于计算费用。暂不支持 Windows。

## Privacy / 隐私

Everything stays on your machine. Cost is computed by `scripts/scan.py`, which reads the transcripts under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and keeps a cache in `~/.cache/claude-usage-band/`. Nothing is sent over the network.

所有数据只在本地处理。费用由 `scripts/scan.py` 计算：读取 `~/.claude/projects`（或 `$CLAUDE_CONFIG_DIR/projects`）下的会话记录，缓存写入 `~/.cache/claude-usage-band/`，不做任何网络请求。

## About the cost / 关于费用

Cost is an **API-equivalent estimate** from each response's token usage and a built-in price table (`PRICES` in `scripts/scan.py`). On a subscription it is not what you are billed; prices may change, so treat it as a rough gauge. Pull requests to update prices are welcome.

费用是根据每次响应的 token 用量和内置价格表（`scripts/scan.py` 中的 `PRICES`）算出的 **API 等价估算值**。订阅用户的实际扣费与此无关；价格可能变化，仅供参考。欢迎提 PR 更新价格。

## License / 许可

MIT
