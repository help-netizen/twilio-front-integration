/**
 * billingScheduler — debits monthly plan fees (current period) and usage overage
 * (previous period) from each paid company's wallet. Runs every 6h; both are
 * idempotent (wallet ledger `ref`), so repeated runs in a period are no-ops and
 * only the first run after a boundary actually charges. The wallet auto-recharges
 * off-session when a charge can't be covered.
 */
const billingService = require('./billingService');

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let handle = null;

async function tick() {
    try {
        const plan = await billingService.billCurrentPeriodPlanFees();
        if (plan.companies > 0) console.log(`[BillingScheduler] Billed plan fee for ${plan.companies} company(ies) — period ${plan.period}`);
    } catch (e) { console.error('[BillingScheduler] plan-fee tick error:', e.message); }
    try {
        const over = await billingService.billPreviousPeriodOverages();
        if (over.companies > 0) console.log(`[BillingScheduler] Billed overage for ${over.companies} company(ies) — period ${over.period}`);
    } catch (e) { console.error('[BillingScheduler] overage tick error:', e.message); }
}

function start() {
    if (handle) return;
    handle = setInterval(tick, INTERVAL_MS);
    console.log('[BillingScheduler] Started (6h tick)');
    tick();
}

function stop() {
    if (handle) { clearInterval(handle); handle = null; }
}

module.exports = { start, stop, tick };
