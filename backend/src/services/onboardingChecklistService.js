/**
 * Onboarding Checklist — ONBTEL-001 Part A + ONBOARDING-UX-001.
 *
 * Data-driven catalog of onboarding items for tenant_admin setup surfaces
 * (precedent for the registry style: permissionCatalog.js). Adding a future
 * item = one more entry in CHECKLIST_ITEMS — the API shape stays the same and
 * the frontend renders items[] without knowing the composition.
 *
 * Item completion is DERIVED (never stored): connect_telephony is done iff the
 * company has at least one phone_number_settings row (released numbers are
 * deleted by releaseNumber, so "has a row" ≡ "has an active number").
 *
 * The ONLY persistent field is companies.settings.onboarding_checklist.completed_at
 * (JSONB, column exists since mig 010 — NO new migration). Write-once semantics:
 * fixed in the same GET where all items first derive as done, guarded by
 * "only if currently NULL", never reset. This keeps the card gone forever even
 * if a number is later released or new catalog items are added (spec §1.2).
 *
 * No mutation endpoints exist for the checklist; collapse state is client-only.
 */

'use strict';

const db = require('../db/connection');
const emailMailboxService = require('./emailMailboxService');
const stripePaymentsService = require('./stripePaymentsService');
const billingService = require('./billingService');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Registry of checklist items. Strings are the normative copies from
 * Docs/specs/ONBOARDING-UX-001.md §1.1-1.2 (product name is Albusto — never "Blanc").
 * `isComplete(companyId)` derives the item state; every query MUST filter
 * by company_id (tenant isolation).
 */
const CHECKLIST_ITEMS = [
    {
        key: 'service_territory',
        title: 'Set up your service territory',
        description: 'Tell Albusto where you work — service-area checks and booking slots follow your coverage.',
        cta: { label: 'Set up', path: '/settings/service-territories' },
        est_minutes: 2,
        done_note: 'Mapped out — Albusto knows where you work.',
        async isComplete(companyId) {
            const { rows } = await db.query(
                `SELECT CASE
                   WHEN COALESCE(
                       (SELECT active_mode
                        FROM company_territory_settings
                        WHERE company_id = $1),
                       'list'
                   ) = 'radius'
                   THEN EXISTS (
                       SELECT 1
                       FROM territory_radii
                       WHERE company_id = $1
                   )
                   ELSE EXISTS (
                       SELECT 1
                       FROM service_territories
                       WHERE company_id = $1
                   )
                 END AS done`,
                [companyId]
            );
            return rows[0]?.done === true;
        },
    },
    {
        key: 'connect_telephony',
        title: 'Connect telephony',
        description: 'Get a business phone number to make and receive calls and texts in Albusto.',
        cta: { label: 'Set up', path: '/settings/integrations/telephony-twilio' },
        est_minutes: 2,
        done_note: 'Nice — your phone line is live!',
        async isComplete(companyId) {
            const { rows } = await db.query(
                'SELECT EXISTS(SELECT 1 FROM phone_number_settings WHERE company_id = $1) AS done',
                [companyId]
            );
            return rows[0]?.done === true;
        },
    },
    {
        key: 'connect_email',
        title: 'Connect your email',
        description: 'Bring your Gmail into Albusto so every customer email lands in one timeline.',
        cta: { label: 'Set up', path: '/settings/integrations/google-email' },
        est_minutes: 1,
        done_note: 'Great — your email flows into Albusto now.',
        async isComplete(companyId) {
            const mailbox = await emailMailboxService.getMailboxStatus(companyId);
            return mailbox !== null
                && mailbox.provider === 'gmail'
                && mailbox.status === 'connected';
        },
    },
    {
        key: 'stripe_payments',
        title: 'Get paid with Stripe',
        description: 'Take card payments on the job, by link, or over the phone.',
        cta: { label: 'Set up', path: '/settings/integrations/stripe-payments' },
        est_minutes: 5,
        done_note: "You're ready to get paid on the spot.",
        async isComplete(companyId) {
            const status = await stripePaymentsService.getStatus(companyId);
            return status.readiness === 'connected_ready';
        },
    },
];

async function getTrial(companyId) {
    try {
        const subscription = await billingService.getSubscription(companyId);
        if (!subscription || subscription.status !== 'trialing' || !subscription.trial_ends_at) {
            return null;
        }

        const trialEnd = new Date(subscription.trial_ends_at);
        const remainingMs = trialEnd.getTime() - Date.now();
        if (remainingMs <= 0) return null;

        return {
            active: true,
            days_left: Math.max(0, Math.ceil(remainingMs / DAY_MS)),
            trial_ends_at: trialEnd.toISOString(),
        };
    } catch (err) {
        console.warn(`[OnboardingChecklist] failed to read trial for company ${companyId}:`, err.message);
        return null;
    }
}

/** Read companies.settings#>>'{onboarding_checklist,completed_at}' (null if unset / no row). */
async function readCompletedAt(companyId) {
    const { rows } = await db.query(
        `SELECT settings#>>'{onboarding_checklist,completed_at}' AS completed_at
         FROM companies
         WHERE id = $1`,
        [companyId]
    );
    return rows[0]?.completed_at || null;
}

/**
 * Write-once fixation of completed_at. Idempotent guarded UPDATE: only writes
 * while the value is still NULL, so concurrent GETs are safe — one writes,
 * the others no-op (rowCount 0 is fine). Returns the persisted value, or null
 * if this call did not write (caller re-reads for the concurrent-winner value).
 */
async function markCompleted(companyId) {
    // Deep-merge via || (NOT jsonb_set): jsonb_set writes the leaf only when its
    // parent object already exists — for a fresh company settings is '{}' with no
    // 'onboarding_checklist' key, so jsonb_set would silently no-op and completed_at
    // would never persist (breaking the write-once guarantee; caught in live-DB QA).
    // Concatenation materializes the parent while preserving other settings/checklist keys.
    const result = await db.query(
        `UPDATE companies
         SET settings = COALESCE(settings, '{}'::jsonb)
             || jsonb_build_object(
                  'onboarding_checklist',
                  COALESCE(settings -> 'onboarding_checklist', '{}'::jsonb)
                    || jsonb_build_object('completed_at', now()::text))
         WHERE id = $1
           AND (settings#>>'{onboarding_checklist,completed_at}') IS NULL
         RETURNING settings#>>'{onboarding_checklist,completed_at}' AS completed_at`,
        [companyId]
    );
    return result.rows[0]?.completed_at || null;
}

/**
 * Visibility state machine (spec §1.2 — the server is the single source of truth):
 *
 *   items[].done := derived catalog conditions
 *   allDone      := every item done
 *   completed_at := companies.settings#>>'{onboarding_checklist,completed_at}'
 *   if completed_at IS NULL and allDone → fix completed_at = now() (write-once)
 *   visible      := NOT (completed_at set OR allDone)
 *
 * A failed completed_at write is NOT an error: the response still says
 * visible:false (derived from allDone) and the write retries on the next GET.
 */
async function getChecklist(companyId) {
    let completedAt = await readCompletedAt(companyId);

    const items = [];
    for (const item of CHECKLIST_ITEMS) {
        const done = await item.isComplete(companyId);
        items.push({
            key: item.key,
            title: item.title,
            description: item.description,
            done,
            cta: item.cta,
            est_minutes: item.est_minutes,
            done_note: item.done_note,
        });
    }
    const allDone = items.length > 0 && items.every(item => item.done);
    const progress = {
        done: items.filter(item => item.done).length,
        total: items.length,
    };

    if (allDone && !completedAt) {
        try {
            completedAt = await markCompleted(companyId);
            if (!completedAt) {
                // rowCount 0 — a concurrent GET won the write; read its value.
                completedAt = await readCompletedAt(companyId);
            }
        } catch (err) {
            // Write failure must not break the response: visible is already
            // false via allDone; the guarded UPDATE will retry on the next GET.
            console.warn(`[OnboardingChecklist] failed to persist completed_at for company ${companyId}:`, err.message);
        }
    }

    const trial = await getTrial(companyId);

    return {
        visible: !(completedAt || allDone),
        completed_at: completedAt,
        progress,
        trial,
        items,
    };
}

module.exports = {
    CHECKLIST_ITEMS,
    getChecklist,
};
