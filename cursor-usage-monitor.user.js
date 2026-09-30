// ==UserScript==
// @name         Cursor Usage Limits
// @namespace    https://github.com/AryaPaw/cursor-usage-monitor
// @version      1.1.2
// @description  Shows actual Cursor Models and API usage limits on the spending dashboard
// @author       AryaPaw
// @license      MIT
// @homepageURL  https://github.com/AryaPaw/cursor-usage-monitor
// @supportURL   https://github.com/AryaPaw/cursor-usage-monitor/issues
// @updateURL    https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js
// @downloadURL  https://github.com/AryaPaw/cursor-usage-monitor/raw/main/cursor-usage-monitor.user.js
// @match        https://cursor.com/dashboard/spending*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=cursor.com
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const REFRESH_INTERVAL = 60_000;
    const RELATIVE_TIME_INTERVAL = 1_000;
    const COLLAPSED_KEY = 'cursor-usage-collapsed';
    const USAGE_SUMMARY_PATH = '/api/usage-summary';

    /**
     * @typedef {object} CursorPlanUsage
     * @property {boolean} [enabled]
     * @property {number|string} [used]
     * @property {number|string} [limit]
     * @property {number|string} [autoPercentUsed]
     * @property {number|string} [apiPercentUsed]
     * @property {number|string} [totalPercentUsed]
     */

    /**
     * @typedef {object} CursorIndividualUsage
     * @property {CursorPlanUsage} [plan]
     */

    /**
     * @typedef {object} CursorUsageSummary
     * @property {CursorIndividualUsage} [individualUsage]
     * @property {string} [membershipType]
     * @property {string} [billingCycleEnd]
     */

    let refreshing = false;
    /** @type {number|null} */
    let lastUpdatedAt = null;
    /** @type {string|null} */
    let lastResetAt = null;
    let connectionOk = false;

    /**
     * @param {unknown} value
     * @returns {string}
     */
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * @param {number} value
     * @returns {string}
     */
    function money(value) {
        if (!Number.isFinite(value)) return '—';

        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: value >= 100 ? 0 : 2,
            maximumFractionDigits: 2,
        }).format(value);
    }

    /**
     * @param {number} value
     * @returns {string}
     */
    function percent(value) {
        if (!Number.isFinite(value)) return '—';

        if (value >= 10) return `${value.toFixed(1)}%`;
        if (value >= 1) return `${value.toFixed(2)}%`;

        return `${value.toFixed(3)}%`;
    }

    /**
     * @param {string|null|undefined} value
     * @returns {string}
     */
    function formatResetDate(value) {
        if (!value) return '—';

        return new Date(value).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    }

    /**
     * @param {number|null} timestamp
     * @returns {string}
     */
    function formatRelativeTime(timestamp) {
        if (!timestamp) return 'Not updated';

        const seconds = Math.max(
            0,
            Math.floor((Date.now() - timestamp) / 1000)
        );

        if (seconds < 60) {
            return `Updated ${seconds}s ago`;
        }

        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) {
            return `Updated ${minutes}m ago`;
        }

        const hours = Math.floor(minutes / 60);

        return `Updated ${hours}h ago`;
    }

    /**
     * @param {string|null|undefined} resetDate
     * @returns {string}
     */
    function formatCountdown(resetDate) {
        if (!resetDate) return '—';

        const end = new Date(resetDate).getTime();

        if (!Number.isFinite(end)) return '—';

        const ms = end - Date.now();

        if (ms <= 0) return 'now';

        const totalSec = Math.floor(ms / 1000);
        const totalMin = Math.floor(totalSec / 60);
        const totalHours = Math.floor(totalMin / 60);
        const totalDays = Math.floor(totalHours / 24);
        const months = Math.floor(totalDays / 30);
        const hours = totalHours % 24;
        const minutes = totalMin % 60;

        /** @type {string[]} */
        const parts = [];

        if (totalDays >= 60) {
            parts.push(`${months}mo`);
            const days = totalDays % 30;
            if (days > 0) parts.push(`${days}d`);
        } else if (totalDays > 0) {
            parts.push(`${totalDays}d`);
            if (hours > 0) parts.push(`${hours}h`);
        } else if (totalHours > 0) {
            parts.push(`${totalHours}h`);
            if (minutes > 0) parts.push(`${minutes}m`);
        } else if (totalMin > 0) {
            parts.push(`${totalMin}m`);
        } else {
            parts.push(`${totalSec}s`);
        }

        return `in ${parts.join(' ')}`;
    }

    /**
     * Cursor Models dollar cap is not published. Prefer plan.used (cents)
     * over autoPercent while that counter is not clamped to plan.limit.
     * Percent inversion is only a fallback and is skipped near 100% Auto.
     *
     * @param {CursorUsageSummary} data
     * @returns {number|null}
     */
    function calculateFirstPartyLimit(data) {
        const plan = data.individualUsage?.plan;

        if (!plan) return null;

        const used = Number(plan.used);
        const includedLimit = Number(plan.limit);
        const autoPct = Number(plan.autoPercentUsed);
        const auto = autoPct / 100;
        const api = Number(plan.apiPercentUsed) / 100;
        const total = Number(plan.totalPercentUsed) / 100;
        const apiLimit = includedLimit / 100;

        if (
            autoPct > 1e-9 &&
            used > 0 &&
            Number.isFinite(used) &&
            Number.isFinite(includedLimit) &&
            used < includedLimit
        ) {
            const fromUsed = used / autoPct;

            if (Number.isFinite(fromUsed) && fromUsed > 0) {
                return fromUsed;
            }
        }

        if (auto >= 0.97) {
            return null;
        }

        const denominator = total - auto;

        if (Math.abs(denominator) < 1e-12) {
            return null;
        }

        const result =
            apiLimit * (api - total) / denominator;

        if (!Number.isFinite(result) || result <= 0) {
            return null;
        }

        return result;
    }

    /**
     * @param {number} value
     * @param {boolean} estimated
     * @returns {string}
     */
    function moneyLabel(value, estimated) {
        const formatted = money(value);

        return estimated && Number.isFinite(value)
            ? `~${formatted}`
            : formatted;
    }

    /**
     * @param {string} label
     * @param {number} used
     * @param {number} limit
     * @param {number} pct
     * @param {boolean} [estimated]
     * @param {number} [remaining]
     * @returns {string}
     */
    function usageRow(
        label,
        used,
        limit,
        pct,
        estimated = false,
        remaining
    ) {
        const left = remaining !== undefined
            ? remaining
            : Number.isFinite(used) && Number.isFinite(limit)
                ? Math.max(0, limit - used)
                : NaN;

        const barWidth = Math.min(
            100,
            Math.max(0, pct)
        );

        return `
            <div class="cu-row">
                <div class="cu-row-header">
                    <span>${escapeHtml(label)}</span>
                    <strong>${escapeHtml(percent(pct))}</strong>
                </div>

                <div class="cu-row-values">
                    <span>
                        ${escapeHtml(moneyLabel(used, estimated))} / ${escapeHtml(moneyLabel(limit, estimated))}
                    </span>

                    <span class="cu-remaining">
                        ${escapeHtml(moneyLabel(left, estimated))} left
                    </span>
                </div>

                <div class="cu-bar">
                    <div
                        class="cu-bar-fill"
                        style="width: ${barWidth}%"
                    ></div>
                </div>
            </div>
        `;
    }

    function createStyles() {
        if (document.getElementById('cursor-usage-styles')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'cursor-usage-styles';

        style.textContent = `
            #cursor-usage-panel {
                position: fixed;
                top: 18px;
                right: 18px;
                z-index: 999999;

                width: 285px;
                padding: 13px 14px;

                background: rgba(18, 18, 18, 0.94);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);

                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;

                color: rgba(255, 255, 255, 0.92);

                font-family:
                    Inter,
                    -apple-system,
                    BlinkMacSystemFont,
                    "Segoe UI",
                    sans-serif;

                font-size: 12px;
                line-height: 1.4;

                box-shadow:
                    0 8px 28px rgba(0, 0, 0, 0.28);
            }

            #cursor-usage-panel * {
                box-sizing: border-box;
            }

            #cursor-usage-panel .cu-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;

                margin-bottom: 12px;
            }

            #cursor-usage-panel.collapsed {
                width: auto;
            }

            #cursor-usage-panel.collapsed .cu-title {
                margin-bottom: 0;
            }

            #cursor-usage-panel.collapsed .cu-plan,
            #cursor-usage-panel.collapsed #cursor-usage-body {
                display: none;
            }

            #cursor-usage-panel .cu-title-left {
                display: flex;
                align-items: center;
                gap: 7px;
            }

            #cursor-usage-panel .cu-title strong {
                font-size: 13px;
                font-weight: 600;
            }

            #cursor-usage-panel .cu-plan {
                opacity: 0.5;
                text-transform: capitalize;
                font-size: 11px;
            }

            #cursor-usage-panel .cu-actions {
                display: flex;
                align-items: center;
                gap: 4px;
                flex-shrink: 0;
            }

            #cursor-usage-panel .cu-btn {
                display: flex;
                align-items: center;
                justify-content: center;

                width: 23px;
                height: 23px;
                padding: 0;

                border: 0;
                border-radius: 6px;

                background: rgba(255, 255, 255, 0.07);
                color: rgba(255, 255, 255, 0.72);

                cursor: pointer;

                transition:
                    background 120ms ease,
                    color 120ms ease;
            }

            #cursor-usage-panel .cu-btn:hover {
                background: rgba(255, 255, 255, 0.13);
                color: rgba(255, 255, 255, 0.95);
            }

            #cursor-usage-panel .cu-icon {
                display: block;
                width: 13px;
                height: 13px;
                transform-origin: 50% 50%;
            }

            #cursor-usage-panel .cu-icon-expand {
                display: none;
            }

            #cursor-usage-panel.collapsed .cu-icon-collapse {
                display: none;
            }

            #cursor-usage-panel.collapsed .cu-icon-expand {
                display: block;
            }

            #cursor-usage-panel .cu-refresh.loading .cu-icon {
                animation: cu-spin 0.8s linear infinite;
            }

            @keyframes cu-spin {
                from {
                    transform: rotate(0deg);
                }

                to {
                    transform: rotate(360deg);
                }
            }

            #cursor-usage-panel .cu-row + .cu-row {
                margin-top: 12px;
            }

            #cursor-usage-panel .cu-row-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;

                margin-bottom: 3px;
            }

            #cursor-usage-panel .cu-row-header strong {
                font-weight: 600;
            }

            #cursor-usage-panel .cu-row-values {
                display: flex;
                justify-content: space-between;
                gap: 8px;

                margin-bottom: 5px;

                opacity: 0.62;
                font-size: 11px;
            }

            #cursor-usage-panel .cu-remaining {
                white-space: nowrap;
            }

            #cursor-usage-panel .cu-bar {
                overflow: hidden;

                width: 100%;
                height: 3px;

                border-radius: 3px;
                background: rgba(255, 255, 255, 0.12);
            }

            #cursor-usage-panel .cu-bar-fill {
                height: 100%;

                border-radius: inherit;
                background: rgba(255, 255, 255, 0.78);

                transition: width 250ms ease;
            }

            #cursor-usage-panel .cu-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;

                margin-top: 12px;
                padding-top: 9px;

                border-top:
                    1px solid rgba(255, 255, 255, 0.08);

                color: rgba(255, 255, 255, 0.52);
                font-size: 11px;
            }

            #cursor-usage-panel .cu-footer-left {
                display: flex;
                align-items: center;
                gap: 4px;

                min-width: 0;
                overflow: visible;
            }

            #cursor-usage-panel .cu-status {
                display: block;
                flex: 0 0 24px;

                width: 24px;
                height: 24px;
                margin-right: -2px;

                color: #22c55e;
                overflow: visible;
            }

            #cursor-usage-panel .cu-status.error {
                color: #ef4444;
            }

            #cursor-usage-panel .cu-status svg {
                display: block;
                width: 24px;
                height: 24px;
                overflow: visible;
            }

            #cursor-usage-panel .cu-status-wave {
                fill: none;
                stroke: currentColor;
                stroke-width: 1;
                transform-box: fill-box;
                transform-origin: center;
                animation: cu-status-wave 4s cubic-bezier(0, 0, 0.2, 1) infinite;
            }

            #cursor-usage-panel .cu-status-wave:nth-of-type(1) {
                animation-delay: 0s;
            }

            #cursor-usage-panel .cu-status-wave:nth-of-type(2) {
                animation-delay: -1.33s;
            }

            #cursor-usage-panel .cu-status-wave:nth-of-type(3) {
                animation-delay: -2.66s;
            }

            @keyframes cu-status-wave {
                0% {
                    transform: scale(1);
                    opacity: 0.75;
                }

                100% {
                    transform: scale(3);
                    opacity: 0;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                #cursor-usage-panel .cu-status-wave {
                    animation: none;
                    display: none;
                }
            }

            #cursor-usage-panel .cu-updated {
                white-space: nowrap;
            }

            #cursor-usage-panel .cu-reset {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 1px;

                white-space: nowrap;
                text-align: right;
            }

            #cursor-usage-panel .cu-error {
                opacity: 0.65;
                font-size: 11px;
            }
        `;

        document.head.appendChild(style);
    }

    /**
     * @returns {HTMLElement}
     */
    function createPanel() {
        let panel =
            document.getElementById('cursor-usage-panel');

        if (panel) return panel;

        createStyles();

        panel = document.createElement('div');
        panel.id = 'cursor-usage-panel';
        panel.innerHTML = `
            <div class="cu-title">
                <div class="cu-title-left">
                    <strong>Cursor Usage</strong>
                    <span class="cu-plan" hidden></span>
                </div>
                <div class="cu-actions">
                    <button class="cu-btn cu-refresh" type="button" title="Refresh usage">
                        <svg class="cu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
                            <path d="M21 3v5h-5"/>
                        </svg>
                    </button>
                    <button class="cu-btn cu-collapse" type="button" title="Collapse">
                        <svg class="cu-icon cu-icon-collapse" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="m6 9 6 6 6-6"/>
                        </svg>
                        <svg class="cu-icon cu-icon-expand" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="m18 15-6-6-6 6"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div id="cursor-usage-body"></div>
        `;

        document.body.appendChild(panel);

        const collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
        panel.classList.toggle('collapsed', collapsed);

        const refresh =
            /** @type {HTMLButtonElement|null} */
            (panel.querySelector('.cu-refresh'));
        const collapse =
            /** @type {HTMLButtonElement|null} */
            (panel.querySelector('.cu-collapse'));
        const icon = refresh?.querySelector('.cu-icon');

        if (collapse) {
            collapse.title = collapsed ? 'Expand' : 'Collapse';
            collapse.addEventListener('click', () => {
                const next = panel.classList.toggle('collapsed');
                localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
                collapse.title = next ? 'Expand' : 'Collapse';
            });
        }

        refresh?.addEventListener('click', update);
        icon?.addEventListener('animationiteration', () => {
            if (!refreshing) refresh?.classList.remove('loading');
        });

        return panel;
    }

    /**
     * @param {HTMLElement} panel
     * @param {string|null|undefined} membership
     * @param {string} html
     */
    function fillPanel(panel, membership, html) {
        const plan =
            /** @type {HTMLElement|null} */
            (panel.querySelector('.cu-plan'));
        const body = panel.querySelector('#cursor-usage-body');

        if (!plan || !body) return;

        plan.textContent = membership ?? '';
        plan.hidden = !plan.textContent;
        body.innerHTML = html;
    }

    function updateClocks() {
        const updated =
            document.getElementById(
                'cursor-usage-updated'
            );

        if (updated) {
            const text = formatRelativeTime(lastUpdatedAt);

            if (updated.textContent !== text) {
                updated.textContent = text;
            }
        }

        const countdown =
            document.getElementById(
                'cursor-usage-countdown'
            );

        if (countdown) {
            const text = formatCountdown(lastResetAt);

            if (countdown.textContent !== text) {
                countdown.textContent = text;
            }
        }
    }

    function updateStatusIndicator() {
        const indicator =
            document.getElementById(
                'cursor-usage-status'
            );

        if (!indicator) {
            return;
        }

        indicator.classList.toggle(
            'ok',
            connectionOk
        );

        indicator.classList.toggle(
            'error',
            !connectionOk
        );

        indicator.title = connectionOk
            ? 'Cursor Usage API is working'
            : 'Cursor Usage API request failed';
    }

    /**
     * @param {string|null|undefined} resetDate
     * @returns {string}
     */
    function renderFooter(resetDate) {
        lastResetAt = resetDate ?? null;
        const resetLabel = `Reset ${formatResetDate(resetDate)}`;

        return `
            <div class="cu-footer">
                <div class="cu-footer-left">
                    <span
                        id="cursor-usage-status"
                        class="cu-status ${
                            connectionOk
                                ? 'ok'
                                : 'error'
                        }"
                        title="${
                            connectionOk
                                ? 'Cursor Usage API is working'
                                : 'Cursor Usage API request failed'
                        }"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <circle class="cu-status-wave" cx="12" cy="12" r="3" />
                            <circle class="cu-status-wave" cx="12" cy="12" r="3" />
                            <circle class="cu-status-wave" cx="12" cy="12" r="3" />
                            <circle cx="12" cy="12" r="3" fill="currentColor" />
                        </svg>
                    </span>

                    <span
                        id="cursor-usage-updated"
                        class="cu-updated"
                    >
                        ${escapeHtml(formatRelativeTime(
                            lastUpdatedAt
                        ))}
                    </span>
                </div>

                <span class="cu-reset">
                    ${escapeHtml(resetLabel)}
                    <span id="cursor-usage-countdown" class="cu-countdown">
                        ${escapeHtml(formatCountdown(resetDate))}
                    </span>
                </span>
            </div>
        `;
    }

    async function update() {
        if (refreshing) {
            return;
        }

        refreshing = true;

        const panel = createPanel();
        panel.querySelector('.cu-refresh')?.classList.add('loading');

        try {
            const response = await fetch(
                USAGE_SUMMARY_PATH,
                {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store',
                    headers: {
                        Accept: 'application/json',
                    },
                }
            );

            if (!response.ok) {
                throw new Error(
                    `Usage API returned HTTP ${response.status}`
                );
            }

            /** @type {CursorUsageSummary} */
            const data =
                await response.json();
            const plan = data.individualUsage?.plan;

            if (!plan || plan.enabled === false) {
                lastUpdatedAt = Date.now();
                connectionOk = true;
                fillPanel(
                    panel,
                    data.membershipType,
                    `
                    <div class="cu-error">No active subscription</div>
                    ${renderFooter(data.billingCycleEnd)}
                    `
                );
                return;
            }

            const apiLimit =
                Number(plan.limit) / 100;
            const firstPartyPct =
                Number(plan.autoPercentUsed) || 0;
            const apiPct =
                Number(plan.apiPercentUsed) || 0;
            const apiUsed = apiLimit * apiPct / 100;
            const firstPartyLimit =
                calculateFirstPartyLimit(data);

            let firstPartyUsed = NaN;
            /** @type {number|undefined} */
            let firstPartyLeft;

            if (firstPartyLimit) {
                firstPartyUsed =
                    firstPartyLimit * firstPartyPct / 100;
            } else {
                firstPartyLeft = firstPartyPct >= 100 ? 0 : NaN;
            }

            lastUpdatedAt = Date.now();
            connectionOk = true;
            fillPanel(
                panel,
                data.membershipType,
                `
                ${usageRow('Cursor Models', firstPartyUsed, firstPartyLimit ?? NaN, firstPartyPct, true, firstPartyLeft)}
                ${usageRow('API / Other Models', apiUsed, apiLimit, apiPct)}
                ${renderFooter(data.billingCycleEnd)}
                `
            );

        } catch (error) {
            console.error(
                '[Cursor Usage Limits]',
                error
            );

            connectionOk = false;

            if (!(document.getElementById('cursor-usage-status') && lastUpdatedAt)) {
                fillPanel(
                    panel,
                    '',
                    `
                    <div class="cu-error">Failed to load usage</div>
                    ${renderFooter(null)}
                    `
                );
            }

        } finally {
            refreshing = false;
            updateStatusIndicator();
        }
    }

    /**
     * @param {() => void} fn
     */
    function whenBodyReady(fn) {
        if (document.body) {
            fn();
            return;
        }

        document.addEventListener(
            'DOMContentLoaded',
            fn,
            { once: true }
        );
    }

    whenBodyReady(() => {
        update();

        setInterval(
            update,
            REFRESH_INTERVAL
        );

        setInterval(
            updateClocks,
            RELATIVE_TIME_INTERVAL
        );

        document.addEventListener(
            'visibilitychange',
            () => {
                if (!document.hidden) {
                    update();
                    updateClocks();
                }
            }
        );

        window.addEventListener(
            'online',
            update
        );

        window.addEventListener(
            'offline',
            () => {
                connectionOk = false;
                updateStatusIndicator();
            }
        );
    });
})();
