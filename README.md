# Cursor Usage Monitor

Tampermonkey userscript that overlays real Cursor Models and API spending limits on [cursor.com/dashboard/spending](https://cursor.com/dashboard/spending).

The dashboard only shows percentages. This script reads the signed-in session's `/api/usage-summary` response, reconstructs the missing first-party dollar cap, and shows used / limit / remaining for:

- Cursor Models
- API / Other Models
- Total

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or [Violentmonkey](https://violentmonkey.github.io/)).
2. Open this raw file so the manager can install it:

   [Install cursor-usage-monitor.user.js](https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js)

3. Confirm the install prompt.
4. Open [https://cursor.com/dashboard/spending](https://cursor.com/dashboard/spending) while signed in.

If the browser only shows source instead of an install prompt, copy the raw URL into Tampermonkey: **Utilities → Install from URL**.

Direct install helper (Tampermonkey):

https://www.tampermonkey.net/script_installation.php#url=https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js

## Auto-update

The script header points Tampermonkey at this repository:

```
@updateURL    https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js
@downloadURL  https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js
```

Updates happen when `@version` in that file increases. Keep Tampermonkey's **Check for updates** enabled (default). After a release, Tampermonkey usually picks it up within a day, or immediately via the script's **Check for updates** action.

## How the first-party limit is calculated

Cursor's usage summary exposes an API dollar limit and three percents (`auto`, `api`, `total`). It does not expose the Cursor Models dollar cap.

That cap is recovered as:

```
firstPartyLimit = apiLimit * (apiPercent - totalPercent) / (totalPercent - autoPercent)
```

All percents are converted from `0–100` to `0–1` before this formula. Values are in dollars after dividing `plan.limit` by `100` (the API stores cents).

If the formula cannot be evaluated yet (for example both auto and total percents are still zero), the last successful cap is reused from `localStorage` and the footer shows `cached limit`.

## Privacy

- Runs only on `https://cursor.com/dashboard/spending*`.
- Uses a same-origin `fetch` with `credentials: 'include'`, so it sees the same session cookie the dashboard already has.
- Does not send data to any third-party server.
- Caches only the derived first-party dollar cap in `localStorage` under `cursor-usage-first-party-limit`.

## Development

The published artifact is `cursor-usage-monitor.user.js`. There is no build step.

1. Edit the userscript.
2. Bump `@version` (semver, for example `1.0.0` → `1.0.1`). Tampermonkey will not update if the version does not increase.
3. Keep `@updateURL` and `@downloadURL` pointed at `main`.
4. Commit and push to `main`.

Optional editor checking: `jsconfig.json` enables `checkJs` for the userscript. In a checkout with TypeScript installed you can run:

```bash
npx --yes typescript --pretty false --noEmit -p jsconfig.json
```

## License

[MIT](LICENSE)
