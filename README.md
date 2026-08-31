# Cursor Usage Monitor

[![Install](https://img.shields.io/badge/install-userscript-2ea44f)](https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-black?logo=tampermonkey&logoColor=white)](https://www.tampermonkey.net/)
[![Violentmonkey](https://img.shields.io/badge/Violentmonkey-compatible-3b3b3b)](https://violentmonkey.github.io/)
[![License: MIT](https://img.shields.io/github/license/AryaPaw/cursor-usage-monitor)](LICENSE)

Overlay on [cursor.com/dashboard/spending](https://cursor.com/dashboard/spending): real dollar limits for Cursor Models, API / Other Models, and Total. The dashboard only shows percents; the script reads `/api/usage-summary` in your session and fills in used / limit / remaining.

[Install cursor-usage-monitor.user.js](https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js)

<p align="center">
  <img src="docs/screenshot.png" alt="Cursor Usage overlay on the spending dashboard" width="320">
</p>

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the [raw userscript](https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js) and confirm.
3. Open [the spending dashboard](https://cursor.com/dashboard/spending) while signed in.

If the browser shows source instead of an install prompt, paste the raw URL into Tampermonkey: **Utilities → Install from URL**. Tampermonkey helper: [script installation](https://www.tampermonkey.net/script_installation.php#url=https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js).

## Auto-update

`@updateURL` and `@downloadURL` point at `main`:

https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js

Bump `@version` and push. Tampermonkey checks periodically, or use **Check for updates** on the script.

## First-party limit

Cursor exposes an API dollar cap and `auto` / `api` / `total` percents, not the Cursor Models dollar cap. It is recovered as:

```
firstPartyLimit = apiLimit * (apiPercent - totalPercent) / (totalPercent - autoPercent)
```

Percents are converted from `0-100` to `0-1`. `plan.limit` is in cents, so it is divided by `100`. If the formula cannot run yet (percents still zero), the last cap is reused from `localStorage` and the footer shows `cached limit`.

## Privacy

Same-origin `fetch` with your dashboard session. No third-party requests. Only the derived first-party cap is stored locally (`cursor-usage-first-party-limit`). Runs only on `https://cursor.com/dashboard/spending*`.

## Development

Edit `cursor-usage-monitor.user.js`, bump `@version`, push to `main`. No build step.

```bash
npx --yes typescript --pretty false --noEmit -p jsconfig.json
```

## License

[MIT](LICENSE)
