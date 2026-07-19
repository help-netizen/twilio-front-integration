/**
 * Regression guard: STRIPE-ACTOR-FK-001.
 *
 * Prod incident (2026-07-18): "Enter card manually" on a Job returned 500 with
 * stripe_payment_sessions_created_by_fkey — the route passed req.user.sub into
 * created_by, a UUID FK → crm_users(id). The Keycloak sub IS a UUID, so any
 * UUID-shape check lets it through; the only safe actor for FK-bound Stripe
 * writes is req.user.crmUser.id or null.
 *
 * invoice_events.actor_id is VARCHAR(255) — the sub is legitimate THERE, which
 * is why invoices.js getUserId keeps its sub fallback for event logging. This
 * suite pins the split so neither side regresses into the other.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const STRIPE_ROUTE_FILES = [
    'backend/src/routes/invoices.js',
    'backend/src/routes/jobs.js',
];

describe('STRIPE-ACTOR-FK-001 · FK-bound Stripe writes never receive the Keycloak sub', () => {
    test.each(STRIPE_ROUTE_FILES)('%s: no Stripe call site builds its actor from getUserId or the sub', file => {
        const offenders = [];
        read(file).split('\n').forEach((line, index) => {
            if (!line.includes('stripePaymentsService.')) return;
            if (/getUserId\(|req\.user\?\.sub/.test(line)) {
                offenders.push(`${file}:${index + 1} ${line.trim()}`);
            }
        });
        expect(offenders).toEqual([]);
    });

    test('invoices.js: the two-line actor pattern cannot silently revert to getUserId', () => {
        const source = read('backend/src/routes/invoices.js');
        // The helper is FK-strict — crmUser.id or null, never a sub fallback.
        expect(source).toMatch(/function getStripeActor\(req\) \{\s*return \{ id: req\.user\?\.crmUser\?\.id \|\| null \};/);
        // The pre-fix bug literal must never come back.
        expect(source).not.toContain('const actor = { id: getUserId(req) }');
        // Both link routes go through the helper.
        expect(source.match(/const actor = getStripeActor\(req\);/g)).toHaveLength(2);
    });

    test('jobs.js: all four Stripe sites keep the deployed crmUser-or-null literal', () => {
        const source = read('backend/src/routes/jobs.js');
        expect(source).not.toContain('{ id: req.user?.sub }');
        expect(
            (source.match(/\{ id: req\.user\?\.crmUser\?\.id \|\| null \}/g) || []).length,
        ).toBeGreaterThanOrEqual(4);
    });
});
