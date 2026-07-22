'use strict';

const estimatesService = require('../../estimatesService');
const financeDisclosure = require('../financeDisclosure');
const financeSummary = require('../financeSummary');
const resultShapes = require('../resultShapes');

const DISCLOSABLE_STATUSES = new Set(['approved', 'sent']);

function normalizeStatus(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function notFound() {
    return resultShapes.refusal(
        "I don't see an estimate that's ready for that repair. I can have the team follow up.",
    );
}

function draftSilent() {
    return resultShapes.refusal(
        "We're still preparing that estimate. The team will follow up when it's ready.",
        { draftPending: true },
    );
}

function selectionRequired(rows) {
    const candidates = rows.slice(0, 5).map((row) => ({
        estimateId: String(row.id),
        estimateNumber: row.estimate_number || '',
        status: normalizeStatus(row.status),
    }));
    const labels = candidates.map((candidate) => {
        const number = candidate.estimateNumber ? `estimate ${candidate.estimateNumber}` : 'an estimate';
        return `${number}, ${candidate.status}`;
    });
    return resultShapes.refusal(
        `I see more than one relevant estimate: ${labels.join('; ')}. Which one would you like?`,
        { selectionRequired: true, candidates },
    );
}

function summarize(estimate) {
    const status = normalizeStatus(estimate.status);
    const estimateNumber = estimate.estimate_number || '';
    const numberPhrase = estimateNumber ? `Estimate ${estimateNumber}` : 'The estimate';
    const statusPhrase = status === 'approved'
        ? `${numberPhrase} is approved.`
        : `${numberPhrase} was sent and has not been approved yet.`;
    const totals = financeSummary.totalsFrom(estimate);
    const items = financeSummary.sanitizeLineItems(estimate.items);
    const breakdown = financeSummary.itemSpeech(items.lineItems);
    const speak = [
        statusPhrase,
        breakdown ? `The breakdown is ${breakdown}.` : '',
        financeSummary.totalsSpeech(totals),
    ].filter(Boolean).join(' ') + financeSummary.writtenDocumentOffer(items.remainingItemCount);

    return resultShapes.ok(speak, {
        estimateNumber,
        status,
        ...totals,
        ...items,
        summaryText: speak,
    });
}

async function getDetail(companyId, estimateId) {
    try {
        return await estimatesService.getEstimate(companyId, estimateId);
    } catch (err) {
        if (err && (err.code === 'NOT_FOUND' || err.status === 404)) return null;
        throw err;
    }
}

function bestRows(rows) {
    const owned = rows.filter((row) => DISCLOSABLE_STATUSES.has(normalizeStatus(row.status)));
    const approved = owned.filter((row) => normalizeStatus(row.status) === 'approved');
    return approved.length > 0 ? approved : owned.filter((row) => normalizeStatus(row.status) === 'sent');
}

async function run(companyId, verifiedContext, input = {}) {
    const subject = await financeDisclosure.resolveSubject(companyId, verifiedContext, input);
    if (!subject.ok) return subject.result;

    const estimateId = input.estimateId != null ? input.estimateId : input.estimate_id;
    if (estimateId != null && estimateId !== '') {
        const estimate = await getDetail(companyId, estimateId);
        if (!estimate || !financeDisclosure.documentMatchesScope(estimate, subject)) return notFound();
        if (normalizeStatus(estimate.status) === 'draft') return draftSilent();
        if (!DISCLOSABLE_STATUSES.has(normalizeStatus(estimate.status))) return notFound();
        return summarize(estimate);
    }

    const { rows } = await estimatesService.listEstimates(
        companyId,
        financeDisclosure.listFilters(subject),
    );
    const matching = (Array.isArray(rows) ? rows : [])
        .filter((row) => financeDisclosure.documentMatchesScope(row, subject));
    const best = bestRows(matching);
    if (best.length > 1) return selectionRequired(best);
    if (best.length === 0) {
        return matching.some((row) => normalizeStatus(row.status) === 'draft') ? draftSilent() : notFound();
    }

    const estimate = await getDetail(companyId, best[0].id);
    if (!estimate || !financeDisclosure.documentMatchesScope(estimate, subject)) return notFound();
    if (!DISCLOSABLE_STATUSES.has(normalizeStatus(estimate.status))) {
        return normalizeStatus(estimate.status) === 'draft' ? draftSilent() : notFound();
    }
    return summarize(estimate);
}

module.exports = { run };
