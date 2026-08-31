// ==UserScript==
// @name         Cursor Usage Limits
// @namespace    https://github.com/AryaPaw/cursor-usage-monitor
// @version      1.0.0
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
    const STORAGE_KEY = 'cursor-usage-first-party-limit';
    const USAGE_SUMMARY_PATH = '/api/usage-summary';

    /**
     * @typedef {object} CursorPlanUsage
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

        if (seconds < 5) {
            return 'Updated just now';
        }

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
     * Cursor does not expose the first-party (Cursor Models) dollar cap
     * directly. It can be recovered from the published percents:
     *
     *   apiLimit * (apiPercent - totalPercent) / (totalPercent - autoPercent)
     *
     * @param {CursorUsageSummary} data
     * @returns {number|null}
     */
    function calculateFirstPartyLimit(data) {
        const plan = data.individualUsage?.plan;

        if (!plan) return null;

        const apiLimit = Number(plan.limit) / 100;

        const auto = Number(plan.autoPercentUsed) / 100;
        const api = Number(plan.apiPercentUsed) / 100;
        const total = Number(plan.totalPercentUsed) / 100;

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
     * @returns {number|null}
     */
    function getCachedFirstPartyLimit() {
        const value = Number(
            localStorage.getItem(STORAGE_KEY)
        );

        return Number.isFinite(value) && value > 0
            ? value
            : null;
    }

    /**
     * @param {number} value
     */
    function cacheFirstPartyLimit(value) {
        if (Number.isFinite(value) && value > 0) {
            localStorage.setItem(
                STORAGE_KEY,
                String(value)
            );
        }
    }

    /**
     * @param {string} label
     * @param {number} used
     * @param {number} limit
     * @param {number} pct
     * @returns {string}
     */
    function usageRow(label, used, limit, pct) {
        const remaining = Math.max(0, limit - used);

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
                        ${escapeHtml(money(used))} / ${escapeHtml(money(limit))}
                    </span>

                    <span class="cu-remaining">
                        ${escapeHtml(money(remaining))} left
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

            #cursor-usage-panel .cu-refresh {
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
                font-size: 14px;
                line-height: 1;

                transition:
                    background 120ms ease,
                    color 120ms ease,
                    transform 120ms ease;
            }

            #cursor-usage-panel .cu-refresh:hover {
                background: rgba(255, 255, 255, 0.13);
                color: rgba(255, 255, 255, 0.95);
            }

            #cursor-usage-panel .cu-refresh.loading {
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
                opacity: 0.8;
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

                opacity: 0.52;
                font-size: 10px;
            }

            #cursor-usage-panel .cu-footer-left {
                display: flex;
                align-items: center;
                gap: 6px;

                min-width: 0;
            }

            #cursor-usage-panel .cu-status {
                flex: 0 0 auto;

                width: 7px;
                height: 7px;

                border-radius: 50%;
            }

            #cursor-usage-panel .cu-status.ok {
                background: #22c55e;

                box-shadow:
                    0 0 5px rgba(34, 197, 94, 0.8),
                    0 0 10px rgba(34, 197, 94, 0.35);

                animation:
                    cu-status-pulse 2s ease-in-out infinite;
            }

            #cursor-usage-panel .cu-status.error {
                background: #ef4444;

                box-shadow:
                    0 0 5px rgba(239, 68, 68, 0.8),
                    0 0 9px rgba(239, 68, 68, 0.3);

                animation: none;
            }

            @keyframes cu-status-pulse {
                0%,
                100% {
                    opacity: 0.55;
                    transform: scale(0.9);
                    box-shadow:
                        0 0 4px rgba(34, 197, 94, 0.65),
                        0 0 7px rgba(34, 197, 94, 0.25);
                }

                50% {
                    opacity: 1;
                    transform: scale(1.15);
                    box-shadow:
                        0 0 6px rgba(34, 197, 94, 0.95),
                        0 0 13px rgba(34, 197, 94, 0.5);
                }
            }

            #cursor-usage-panel .cu-updated {
                white-space: nowrap;
            }

            #cursor-usage-panel .cu-reset {
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

        if (panel) {
            return panel;
        }

        createStyles();

        panel = document.createElement('div');
        panel.id = 'cursor-usage-panel';

        document.body.appendChild(panel);

        return panel;
    }

    function bindRefreshButton() {
        const button =
            /** @type {HTMLButtonElement|null} */
            (document.querySelector(
                '#cursor-usage-panel .cu-refresh'
            ));

        if (
            !button ||
            button.dataset.bound === 'true'
        ) {
            return;
        }

        button.dataset.bound = 'true';

        button.addEventListener(
            'click',
            update
        );
    }

    function updateRelativeTime() {
        const element =
            document.getElementById(
                'cursor-usage-updated'
            );

        if (!element) {
            return;
        }

        const text =
            formatRelativeTime(lastUpdatedAt);

        if (element.textContent !== text) {
            element.textContent = text;
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
     * @param {boolean} [cachedLimit]
     * @returns {string}
     */
    function renderFooter(resetDate, cachedLimit = false) {
        const resetLabel = cachedLimit
            ? `Reset ${formatResetDate(resetDate)} | cached limit`
            : `Reset ${formatResetDate(resetDate)}`;

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
                    ></span>

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

        const existingButton =
            panel.querySelector('.cu-refresh');

        if (existingButton) {
            existingButton.classList.add(
                'loading'
            );
        }

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

            const plan =
                data.individualUsage?.plan;

            if (!plan) {
                throw new Error(
                    'individualUsage.plan is missing'
                );
            }

            const apiLimit =
                Number(plan.limit) / 100;

            let firstPartyLimit =
                calculateFirstPartyLimit(data);

            let cachedLimit = false;

            if (firstPartyLimit) {
                cacheFirstPartyLimit(
                    firstPartyLimit
                );
            } else {
                firstPartyLimit =
                    getCachedFirstPartyLimit();

                cachedLimit = true;
            }

            if (!firstPartyLimit) {
                throw new Error(
                    'First-party limit cannot be determined yet'
                );
            }

            const firstPartyPct =
                Number(
                    plan.autoPercentUsed
                ) || 0;

            const apiPct =
                Number(
                    plan.apiPercentUsed
                ) || 0;

            const totalPct =
                Number(
                    plan.totalPercentUsed
                ) || 0;

            const firstPartyUsed =
                firstPartyLimit *
                firstPartyPct /
                100;

            const apiUsed =
                apiLimit *
                apiPct /
                100;

            const totalLimit =
                firstPartyLimit +
                apiLimit;

            const totalUsed =
                firstPartyUsed +
                apiUsed;

            lastUpdatedAt = Date.now();
            connectionOk = true;

            panel.innerHTML = `
                <div class="cu-title">
                    <div class="cu-title-left">
                        <strong>Cursor Usage</strong>

                        <span class="cu-plan">
                            ${escapeHtml(data.membershipType ?? '')}
                        </span>
                    </div>

                    <button
                        class="cu-refresh"
                        type="button"
                        title="Refresh usage"
                    >
                        ↻
                    </button>
                </div>

                ${usageRow(
                    'Cursor Models',
                    firstPartyUsed,
                    firstPartyLimit,
                    firstPartyPct
                )}

                ${usageRow(
                    'API / Other Models',
                    apiUsed,
                    apiLimit,
                    apiPct
                )}

                ${usageRow(
                    'Total',
                    totalUsed,
                    totalLimit,
                    totalPct
                )}

                ${renderFooter(
                    data.billingCycleEnd,
                    cachedLimit
                )}
            `;

            bindRefreshButton();

        } catch (error) {
            console.error(
                '[Cursor Usage Limits]',
                error
            );

            connectionOk = false;

            const status =
                document.getElementById(
                    'cursor-usage-status'
                );

            /*
             * If the panel already contains valid usage data,
             * keep it visible and only switch the LED to red
             */
            if (status && lastUpdatedAt) {
                updateStatusIndicator();
            } else {
                panel.innerHTML = `
                    <div class="cu-title">
                        <div class="cu-title-left">
                            <strong>Cursor Usage</strong>
                        </div>

                        <button
                            class="cu-refresh"
                            type="button"
                            title="Retry"
                        >
                            ↻
                        </button>
                    </div>

                    <div class="cu-error">
                        Failed to load usage
                    </div>

                    ${renderFooter(null)}
                `;

                bindRefreshButton();
            }

        } finally {
            refreshing = false;

            const button =
                panel.querySelector(
                    '.cu-refresh'
                );

            if (button) {
                button.classList.remove(
                    'loading'
                );
            }

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
            updateRelativeTime,
            RELATIVE_TIME_INTERVAL
        );

        document.addEventListener(
            'visibilitychange',
            () => {
                if (!document.hidden) {
                    update();
                    updateRelativeTime();
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
