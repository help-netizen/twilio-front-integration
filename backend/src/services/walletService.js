/**
 * walletService.js — BILLING. Prepaid wallet: plan fees and usage overage are
 * debited from the balance; Stripe is used only to top up (manual + off-session
 * auto-recharge).
 *
 * Policy:
 *   - Minimum top-up: $10.
 *   - Auto-recharge: when balance < threshold ($5) → charge $10; before a large
 *     charge (e.g. a plan fee) that the balance can't cover → charge the shortfall.
 *   - Grace overdraft to −$5. At/below −$5 paid telephony (calls/SMS) is blocked
 *     (assertServiceActive) until the wallet is topped up.
 */
const db = require('../db/connection');
const { getProvider } = require('./billing/billingProvider');

const MIN_TOPUP_USD = 10;
const GRACE_FLOOR_USD = -5; // service blocked at/below this balance

async function getWallet(companyId) {
    await db.query('INSERT INTO billing_wallets (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
    const { rows } = await db.query('SELECT * FROM billing_wallets WHERE company_id = $1', [companyId]);
    return rows[0];
}

async function getLedger(companyId, limit = 50) {
    const { rows } = await db.query(
        `SELECT amount_usd, type, description, balance_after, ref, created_at
         FROM billing_wallet_ledger WHERE company_id = $1 ORDER BY id DESC LIMIT $2`,
        [companyId, limit]
    );
    return rows;
}

/**
 * Atomic balance change + ledger row, serialized per wallet. Idempotent when a
 * `ref` is provided (a duplicate ref is a no-op returning applied:false).
 */
async function applyDelta(companyId, amount, { type, description = null, ref = null }) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('INSERT INTO billing_wallets (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
        const cur = await client.query('SELECT balance_usd FROM billing_wallets WHERE company_id = $1 FOR UPDATE', [companyId]);
        if (ref) {
            const dup = await client.query('SELECT 1 FROM billing_wallet_ledger WHERE company_id = $1 AND ref = $2', [companyId, ref]);
            if (dup.rowCount) { await client.query('ROLLBACK'); return { balance: Number(cur.rows[0].balance_usd), applied: false }; }
        }
        const upd = await client.query(
            'UPDATE billing_wallets SET balance_usd = balance_usd + $2, updated_at = now() WHERE company_id = $1 RETURNING balance_usd',
            [companyId, amount]
        );
        const balanceAfter = Number(upd.rows[0].balance_usd);
        await client.query(
            `INSERT INTO billing_wallet_ledger (company_id, amount_usd, type, description, ref, balance_after)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [companyId, amount, type, description, ref, balanceAfter]
        );
        await client.query('COMMIT');
        return { balance: balanceAfter, applied: true };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
}

function credit(companyId, amount, meta) { return applyDelta(companyId, Math.abs(amount), meta); }

async function customerId(companyId) {
    const { rows } = await db.query('SELECT provider_customer_id FROM billing_subscriptions WHERE company_id = $1', [companyId]);
    return rows[0]?.provider_customer_id || null;
}

/** Charge the saved card off-session and credit the wallet on success. */
async function autoRecharge(companyId, amount) {
    const w = await getWallet(companyId);
    if (!w.auto_recharge_enabled || !w.default_payment_method_id) return { ok: false, reason: 'no_card' };
    const cust = await customerId(companyId);
    if (!cust) return { ok: false, reason: 'no_customer' };
    try {
        const r = await getProvider().chargeOffSession(cust, w.default_payment_method_id, amount, 'Wallet auto top-up');
        await credit(companyId, amount, { type: 'auto_topup', description: `Auto top-up $${Number(amount).toFixed(2)}`, ref: r.paymentIntentId });
        return { ok: true, amount };
    } catch (e) {
        console.error(`[wallet] auto-recharge failed (${companyId}):`, e.message);
        return { ok: false, reason: e.message };
    }
}

/** Ensure the wallet can cover `needed`; top up the shortfall (min $10) off-session. */
async function ensureBalance(companyId, needed) {
    const w = await getWallet(companyId);
    if (Number(w.balance_usd) >= needed) return true;
    if (!w.auto_recharge_enabled) return false;
    const shortfall = needed - Number(w.balance_usd);
    const r = await autoRecharge(companyId, Math.max(MIN_TOPUP_USD, Math.ceil(shortfall)));
    return r.ok;
}

/** After a debit, refill if the balance dropped below the threshold. */
async function maybeAutoTopup(companyId) {
    const w = await getWallet(companyId);
    if (w.auto_recharge_enabled && w.default_payment_method_id
        && Number(w.balance_usd) < Number(w.auto_recharge_threshold_usd)) {
        await autoRecharge(companyId, Number(w.auto_recharge_amount_usd));
    }
}

/** Debit `amount`; auto-recharge to cover if possible; the grace overdraft is allowed. */
async function debit(companyId, amount, meta) {
    amount = Math.abs(amount);
    await ensureBalance(companyId, amount);
    const res = await applyDelta(companyId, -amount, meta);
    if (res.applied) await maybeAutoTopup(companyId);
    return res;
}

async function isServiceBlocked(companyId) {
    const w = await getWallet(companyId);
    return Number(w.balance_usd) <= GRACE_FLOOR_USD;
}

/** Throw 402 WALLET_BLOCKED when the balance is at/below the grace floor. */
async function assertServiceActive(companyId) {
    if (await isServiceBlocked(companyId)) {
        const e = new Error('Wallet balance too low — top up to keep making calls and sending texts.');
        e.httpStatus = 402; e.code = 'WALLET_BLOCKED';
        throw e;
    }
}

async function setDefaultPaymentMethod(companyId, pmId) {
    await getWallet(companyId);
    await db.query('UPDATE billing_wallets SET default_payment_method_id = $2, updated_at = now() WHERE company_id = $1', [companyId, pmId]);
}

async function updateSettings(companyId, { enabled, threshold, amount }) {
    await getWallet(companyId);
    await db.query(
        `UPDATE billing_wallets SET
            auto_recharge_enabled = COALESCE($2, auto_recharge_enabled),
            auto_recharge_threshold_usd = COALESCE($3, auto_recharge_threshold_usd),
            auto_recharge_amount_usd = GREATEST(COALESCE($4, auto_recharge_amount_usd), ${MIN_TOPUP_USD}),
            updated_at = now()
         WHERE company_id = $1`,
        [companyId, enabled ?? null, threshold ?? null, amount ?? null]
    );
}

module.exports = {
    MIN_TOPUP_USD, GRACE_FLOOR_USD,
    getWallet, getLedger, credit, debit, autoRecharge, ensureBalance, maybeAutoTopup,
    isServiceBlocked, assertServiceActive, setDefaultPaymentMethod, updateSettings,
};
