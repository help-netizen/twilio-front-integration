'use strict';

const reconcileService = require('./vapiUsageReconcileService');
const auditService = require('./vapiUsageAuditService');
const fallbackRatingService = require('./vapiFallbackRatingService');
const alertDeliveryService = require('./vapiUsageAlertDeliveryService');
const inboundVoiceRecoveryService = require('./inboundVoiceRecoveryService');

const TICK_INTERVAL_MS = 60 * 1000;

function createVapiUsageReconcileScheduler(dependencies = {}) {
    const reconcile = dependencies.reconcileService || reconcileService;
    const audit = dependencies.auditService || auditService;
    const fallbackRating = dependencies.fallbackRatingService || fallbackRatingService;
    const alertDelivery = dependencies.alertDeliveryService || alertDeliveryService;
    const inboundRecovery = dependencies.inboundVoiceRecoveryService
        || inboundVoiceRecoveryService;
    let nextRunAt = 0;
    let running = false;
    let lastAuditDate = null;

    async function tick(now = new Date()) {
        const nowMs = now.getTime();
        if (running || nowMs < nextRunAt) return { skipped: true };
        running = true;
        nextRunAt = nowMs + TICK_INTERVAL_MS;
        try {
            const companyIds = await reconcile.listDueCompanies(now);
            const companies = [];
            for (const companyId of companyIds) {
                try {
                    companies.push(await reconcile.processDueCompany(companyId, { now }));
                } catch (_error) {
                    companies.push({ companyId, failed: true });
                }
            }

            const auditDate = audit.utcDayWindow(now).auditDate;
            const operational = typeof reconcile.getOperationalMetrics === 'function'
                ? await reconcile.getOperationalMetrics(now)
                : {};
            let auditResult = { skipped: true };
            if (lastAuditDate !== auditDate) {
                auditResult = await audit.runNightlyAudit({ now });
                // Catch-up runs oldest-first. Only mark this UTC day complete
                // after yesterday itself succeeds, or the claimer proves there
                // is no missing/failed day inside the bounded lookback window.
                if (auditResult.skipped
                    || (
                        auditResult.status === 'succeeded'
                        && auditResult.auditDate === auditDate
                    )) {
                    lastAuditDate = auditDate;
                }
            }
            let fallbackResult;
            try {
                const fallbackPolicy = await fallbackRating.syncConfiguredRate({ now });
                const fallbackCompanyIds = await fallbackRating.listDueCompanies(now);
                const fallbackCompanies = [];
                for (const companyId of fallbackCompanyIds) {
                    try {
                        fallbackCompanies.push(await fallbackRating.processCompany(
                            companyId,
                            { now },
                        ));
                    } catch (_error) {
                        fallbackCompanies.push({ companyId, failed: true });
                    }
                }
                fallbackResult = {
                    policyVersion: String(fallbackPolicy.version),
                    dueCompanies: fallbackCompanyIds.length,
                    estimatesCreated: fallbackCompanies.reduce(
                        (sum, row) => sum + (row.estimatesCreated || 0),
                        0,
                    ),
                    correctionsCreated: fallbackCompanies.reduce(
                        (sum, row) => sum + (row.correctionsCreated || 0),
                        0,
                    ),
                    failedCompanies: fallbackCompanies.filter((row) => row.failed).length,
                };
            } catch (error) {
                fallbackResult = {
                    failed: true,
                    error: String(error?.code || error?.message || 'fallback_rating_failed'),
                };
            }
            let alertResult;
            try {
                alertResult = await alertDelivery.dispatchAlerts({ now });
            } catch (error) {
                alertResult = {
                    failed: true,
                    error: String(error?.code || error?.message || 'alert_delivery_failed'),
                };
            }
            let inboundRecoveryResult;
            try {
                inboundRecoveryResult = await inboundRecovery.sweepRetryPending({ now });
            } catch (error) {
                // Human callback recovery is independent from cost reconciliation
                // and alert delivery. A sweep fault is visible but never poisons
                // the shared scheduler tick or another subsystem's state.
                inboundRecoveryResult = {
                    failed: true,
                    error: String(error?.code || error?.message || 'inbound_recovery_failed'),
                };
            }
            return {
                skipped: false,
                companies,
                metrics: {
                    dueCompanies: companyIds.length,
                    finalized: companies.reduce((sum, row) => sum + (row.finalized || 0), 0),
                    corrected: companies.reduce((sum, row) => sum + (row.corrected || 0), 0),
                    stale: companies.reduce((sum, row) => sum + (row.stale || 0), 0),
                    providerErrors: companies.reduce(
                        (sum, row) => sum + (row.providerErrors || 0),
                        0,
                    ),
                    failedCompanies: companies.filter((row) => row.failed).length,
                    ...operational,
                },
                audit: auditResult,
                fallbackRating: fallbackResult,
                alertDelivery: alertResult,
                inboundRecovery: inboundRecoveryResult,
            };
        } finally {
            running = false;
        }
    }

    return { tick };
}

let singleton = createVapiUsageReconcileScheduler();

function registerScheduler(registry) {
    registry.register('vapi-usage-reconcile', (now) => singleton.tick(now));
}

function resetForTests() {
    singleton = createVapiUsageReconcileScheduler();
}

module.exports = {
    TICK_INTERVAL_MS,
    createVapiUsageReconcileScheduler,
    registerScheduler,
    tick: (now) => singleton.tick(now),
    _resetForTests: resetForTests,
};
