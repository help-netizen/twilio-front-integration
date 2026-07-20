'use strict';

const inspectorQueries = require('../db/inspectorQueries');
const inspectorRunner = require('./inspectorRunner');

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;

function boundedCooldown(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COOLDOWN_MS;
    return Math.min(MAX_COOLDOWN_MS, Math.max(60_000, parsed));
}

// node-pg parses a PG `date` column into a JS Date (at local midnight), and
// `String(dateObject)` yields "Mon Jul 20 2026 …" which Postgres rejects as a
// DATE (SQLSTATE 22007) the moment it flows back into `$::DATE`. Always hand the
// runner a canonical YYYY-MM-DD string. Extract LOCAL components (they ARE the
// intended calendar day regardless of the container timezone); pass a string
// through untouched.
function toCompanyLocalDate(value) {
    if (value instanceof Date) {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    return String(value).slice(0, 10);
}

function createInspectorScheduler(dependencies = {}) {
    const queries = dependencies.queries || inspectorQueries;
    const runner = dependencies.runner || inspectorRunner;
    const now = dependencies.now || (() => new Date());
    const activeRuns = new Set();
    let circuitOpenUntil = 0;

    async function executeClaim(claim) {
        try {
            const result = await runner.runCompany({
                companyId: claim.company_id,
                runId: claim.id,
                timezone: claim.timezone,
                companyLocalDate: toCompanyLocalDate(claim.company_local_date),
                startedAt: new Date(claim.started_at || now()),
            });
            if (result?.spend_cap) {
                circuitOpenUntil = Math.max(
                    circuitOpenUntil,
                    now().getTime() + boundedCooldown(result.retry_after_ms)
                );
            }
        } catch (error) {
            const code = inspectorRunner.safeCode(error, 'company_run_failed');
            console.warn(`[Inspector] company_id=${claim.company_id} run_id=${claim.id} warning=${code}`);
            try {
                await queries.finishRun(claim.company_id, claim.id, {
                    status: 'failed',
                    warning_count: 1,
                    warning_code: code,
                    warning_summary: 'Inspector company run failed safely.',
                });
            } catch {
                console.warn(`[Inspector] company_id=${claim.company_id} run_id=${claim.id} warning=run_finalize_failed`);
            }
        }
    }

    function launch(claim) {
        const promise = Promise.resolve()
            .then(() => executeClaim(claim))
            .finally(() => activeRuns.delete(promise));
        activeRuns.add(promise);
    }

    async function tick(tickNow = now()) {
        if (tickNow.getTime() < circuitOpenUntil) {
            return { claimed: 0, active: activeRuns.size, circuit_open: true };
        }
        if (activeRuns.size > 0) {
            return { claimed: 0, active: activeRuns.size, circuit_open: false };
        }
        const due = await queries.listDueCompanies(tickNow, 1);
        let claimedCount = 0;
        for (const company of due) {
            const claim = await queries.claimDailyRun(
                company.company_id,
                company.company_local_date,
                company.timezone,
                tickNow,
                new Date(tickNow.getTime() + LEASE_MS)
            );
            if (!claim) continue;
            launch(claim);
            claimedCount++;
        }
        return { claimed: claimedCount, active: activeRuns.size, circuit_open: false };
    }

    async function waitForIdle() {
        await Promise.allSettled([...activeRuns]);
    }

    return {
        tick,
        waitForIdle,
        _activeRuns: activeRuns,
        _getCircuitOpenUntil: () => circuitOpenUntil,
        _openCircuitForTests: ms => { circuitOpenUntil = now().getTime() + boundedCooldown(ms); },
    };
}

const singleton = createInspectorScheduler();

function registerScheduler(registry) {
    registry.register('inspector', tickNow => singleton.tick(tickNow));
}

module.exports = {
    DEFAULT_COOLDOWN_MS,
    LEASE_MS,
    MAX_COOLDOWN_MS,
    boundedCooldown,
    createInspectorScheduler,
    registerScheduler,
    tick: singleton.tick,
    waitForIdle: singleton.waitForIdle,
};
