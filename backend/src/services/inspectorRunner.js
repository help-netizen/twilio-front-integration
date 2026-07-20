'use strict';

const { requireCompanyId } = require('../db/crmUtils');
const inspectorQueries = require('../db/inspectorQueries');
const inspectorClassifier = require('./inspectorClassifier');
const inspectorTaskService = require('./inspectorTaskService');
const { startOfLocalDay } = require('../utils/companyTime');

const PAGE_SIZE = 50;

function safeCode(error, fallback) {
    return String(error?.code || fallback || 'unknown_error')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .slice(0, 80);
}

function companyWarning(companyId, runId, code) {
    console.warn(`[Inspector] company_id=${companyId} run_id=${runId} warning=${code}`);
}

function reviewFromModel(claim, candidate, modelResult, verdict) {
    return {
        company_local_date: claim.companyLocalDate,
        entity_type: candidate.entityType,
        entity_id: candidate.id,
        verdict,
        provider: modelResult?.provider || null,
        model: modelResult?.model || null,
        latency_ms: modelResult?.latency_ms ?? null,
        token_usage: modelResult?.token_usage || {},
        explanation: modelResult?.verdict?.reason || verdict,
        task_id: null,
    };
}

async function listAllCandidates(claim, settings, queries) {
    const out = [];
    for (const entityType of ['job', 'lead']) {
        let afterId = 0;
        while (true) {
            const list = entityType === 'job' ? queries.listCandidateJobs : queries.listCandidateLeads;
            const ignored = entityType === 'job'
                ? settings.ignored_job_statuses
                : settings.ignored_lead_statuses;
            const rows = await list(
                claim.companyId,
                claim.boundary,
                ignored,
                claim.companyLocalDate,
                { afterId, limit: PAGE_SIZE }
            );
            for (const row of rows) out.push({ ...row, entityType });
            if (rows.length < PAGE_SIZE) break;
            afterId = rows.at(-1).id;
        }
    }
    return out;
}

async function runCompany(input, dependencies = {}) {
    requireCompanyId(input?.companyId);
    const queries = dependencies.queries || inspectorQueries;
    const classifier = dependencies.classifier || inspectorClassifier;
    const taskService = dependencies.taskService || inspectorTaskService;
    const now = dependencies.now || (() => new Date());
    const claim = {
        ...input,
        boundary: startOfLocalDay(input.startedAt || now(), input.timezone),
    };
    const counts = {
        candidate_count: 0,
        reviewed_count: 0,
        task_count: 0,
        no_action_count: 0,
        deduped_count: 0,
        warning_count: 0,
        warning_code: null,
        warning_summary: null,
    };
    let spendCap = false;
    let retryAfterMs = null;

    const settings = await queries.getRuntimeConfiguration(claim.companyId);
    if (!settings) {
        counts.warning_count = 1;
        counts.warning_code = 'runtime_authorization_revoked';
        counts.warning_summary = 'Inspector run aborted because its installation or company is no longer active.';
        companyWarning(claim.companyId, claim.runId, counts.warning_code);
        await queries.finishRun(claim.companyId, claim.runId, { status: 'aborted', ...counts });
        return { ...counts, spend_cap: false, aborted: true };
    }

    const candidates = await listAllCandidates(claim, settings, queries);
    counts.candidate_count = candidates.length;

    for (const candidate of candidates) {
        const ignoredStatuses = candidate.entityType === 'job'
            ? settings.ignored_job_statuses
            : settings.ignored_lead_statuses;
        await queries.refreshRunLease(
            claim.companyId,
            claim.runId,
            new Date(now().getTime() + 15 * 60 * 1000)
        );

        const openTask = await queries.getOpenInspectorTask(
            claim.companyId,
            candidate.entityType,
            candidate.id
        );
        if (openTask) {
            await queries.insertReview(claim.companyId, {
                ...reviewFromModel(claim, candidate, null, 'deduped_open_task'),
                task_id: openTask.id,
            });
            counts.reviewed_count++;
            counts.deduped_count++;
            continue;
        }

        const eligible = await queries.reloadEligibleEntity(
            claim.companyId,
            candidate.entityType,
            candidate.id,
            claim.boundary,
            ignoredStatuses
        );
        if (!eligible) {
            const owned = await queries.getEntityRecord(
                claim.companyId,
                candidate.entityType,
                candidate.id
            );
            if (owned) {
                await queries.insertReview(
                    claim.companyId,
                    reviewFromModel(claim, candidate, null, 'became_ineligible')
                );
                counts.reviewed_count++;
            }
            continue;
        }

        const context = await queries.getEntityContext(
            claim.companyId,
            candidate.entityType,
            candidate.id
        );
        if (!context) continue;

        let modelResult;
        try {
            modelResult = await classifier.classifyEntity({
                ...context,
                company_local_date: claim.companyLocalDate,
            }, settings.instruction);
        } catch (error) {
            const code = safeCode(error, 'provider_error');
            await queries.insertReview(claim.companyId, {
                ...reviewFromModel(claim, candidate, null, 'provider_error'),
                provider: error?.provider || null,
                model: error?.model || null,
                explanation: code,
            });
            counts.reviewed_count++;
            counts.warning_count++;
            counts.warning_code ||= code;
            counts.warning_summary ||= 'One or more Inspector judgments were skipped safely.';
            companyWarning(claim.companyId, claim.runId, code);
            if (classifier.isSpendCapError(error)) {
                spendCap = true;
                retryAfterMs = error.retryAfterMs || null;
                break;
            }
            continue;
        }

        if (!modelResult.verdict.needs_attention) {
            await queries.insertReview(
                claim.companyId,
                reviewFromModel(claim, candidate, modelResult, 'no_action')
            );
            counts.reviewed_count++;
            counts.no_action_count++;
            continue;
        }

        try {
            const taskResult = await taskService.createInspectorTask({
                companyId: claim.companyId,
                runId: claim.runId,
                companyLocalDate: claim.companyLocalDate,
                entityType: candidate.entityType,
                entityId: candidate.id,
                boundary: claim.boundary,
                ignoredStatuses,
                verdict: modelResult.verdict,
                modelResult,
            });
            counts.reviewed_count++;
            if (taskResult.status === 'created') counts.task_count++;
            else if (taskResult.status === 'deduped') counts.deduped_count++;
            else if (taskResult.status === 'already_reviewed') counts.reviewed_count--;
        } catch (error) {
            const code = safeCode(error, 'task_create_failed');
            await queries.insertReview(claim.companyId, {
                ...reviewFromModel(claim, candidate, modelResult, 'provider_error'),
                explanation: code,
            });
            counts.reviewed_count++;
            counts.warning_count++;
            counts.warning_code ||= code;
            counts.warning_summary ||= 'One or more Inspector tasks could not be created.';
            companyWarning(claim.companyId, claim.runId, code);
        }
    }

    const status = counts.warning_count > 0 ? 'completed_with_warnings' : 'succeeded';
    await queries.finishRun(claim.companyId, claim.runId, { status, ...counts });
    return { ...counts, spend_cap: spendCap, retry_after_ms: retryAfterMs };
}

module.exports = {
    PAGE_SIZE,
    companyWarning,
    listAllCandidates,
    runCompany,
    safeCode,
};
