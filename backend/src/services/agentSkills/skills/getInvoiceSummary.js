'use strict';

const invoicesService = require('../../invoicesService');
const financeDisclosure = require('../financeDisclosure');
const financeSummary = require('../financeSummary');
const resultShapes = require('../resultShapes');

const NO_BALANCE_STATUSES = new Set(['void', 'voided', 'refunded']);

function normalizeStatus(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function notFound() {
    return resultShapes.refusal(
        "I don't see an invoice I can discuss for that repair. I can have the team follow up.",
    );
}

function draftSilent() {
    return resultShapes.refusal(
        "That invoice is still being prepared. The team will follow up when it's ready.",
        { draftPending: true },
    );
}

function isDisclosable(invoice) {
    return normalizeStatus(invoice && invoice.status) !== 'draft';
}

function hasPositiveBalance(invoice) {
    return !NO_BALANCE_STATUSES.has(normalizeStatus(invoice && invoice.status))
        && financeSummary.toAmount(invoice && invoice.balance_due) > 0;
}

function selectionRequired(rows) {
    const candidates = rows.slice(0, 5).map((row) => ({
        invoiceId: String(row.id),
        invoiceNumber: row.invoice_number || '',
        status: normalizeStatus(row.status),
        hasBalance: hasPositiveBalance(row),
    }));
    const labels = candidates.map((candidate) => {
        const number = candidate.invoiceNumber ? `invoice ${candidate.invoiceNumber}` : 'an invoice';
        return `${number}, ${candidate.status}`;
    });
    return resultShapes.refusal(
        `I see more than one relevant invoice: ${labels.join('; ')}. Which one would you like?`,
        { selectionRequired: true, candidates },
    );
}

function summarize(invoice) {
    const invoiceNumber = invoice.invoice_number || '';
    const status = normalizeStatus(invoice.status);
    const numberPhrase = invoiceNumber ? `Invoice ${invoiceNumber}` : 'The invoice';
    const totals = financeSummary.totalsFrom(invoice);
    const amountPaid = financeSummary.toAmount(invoice.amount_paid);
    const noBalanceStatus = NO_BALANCE_STATUSES.has(status);
    const balanceDue = noBalanceStatus ? 0 : financeSummary.toAmount(invoice.balance_due);
    const items = financeSummary.sanitizeLineItems(invoice.items);
    const breakdown = financeSummary.itemSpeech(items.lineItems);

    let balancePhrase;
    if (status === 'void' || status === 'voided') {
        balancePhrase = `${numberPhrase} is void, so there is no balance due.`;
    } else if (status === 'refunded') {
        balancePhrase = `${numberPhrase} has been refunded, so there is no balance due.`;
    } else if (balanceDue > 0) {
        balancePhrase = `${numberPhrase} totals ${financeSummary.money(totals.total)}. We have received ${financeSummary.money(amountPaid)}, so ${financeSummary.money(balanceDue)} remains due.`;
    } else {
        balancePhrase = `${numberPhrase} is paid in full. The total was ${financeSummary.money(totals.total)}.`;
    }

    const speak = [
        balancePhrase,
        breakdown ? `The breakdown is ${breakdown}.` : '',
        financeSummary.totalsSpeech(totals),
        balanceDue > 0 ? "I can't take a card over the phone, but I can send a secure payment link or connect you with a teammate." : '',
    ].filter(Boolean).join(' ') + financeSummary.writtenDocumentOffer(items.remainingItemCount);

    return resultShapes.ok(speak, {
        invoiceNumber,
        status,
        ...totals,
        amountPaid,
        balanceDue,
        ...items,
    });
}

async function getDetail(companyId, invoiceId) {
    try {
        return await invoicesService.getInvoice(companyId, invoiceId);
    } catch (err) {
        if (err && (err.code === 'NOT_FOUND' || err.status === 404)) return null;
        throw err;
    }
}

function bestRows(rows) {
    const eligible = rows.filter(isDisclosable);
    const withBalance = eligible.filter(hasPositiveBalance);
    return withBalance.length > 0 ? withBalance : eligible;
}

async function run(companyId, verifiedContext, input = {}) {
    const subject = await financeDisclosure.resolveSubject(companyId, verifiedContext, input);
    if (!subject.ok) return subject.result;

    const invoiceId = input.invoiceId != null ? input.invoiceId : input.invoice_id;
    if (invoiceId != null && invoiceId !== '') {
        const invoice = await getDetail(companyId, invoiceId);
        if (!invoice || !financeDisclosure.documentMatchesScope(invoice, subject)) return notFound();
        if (!isDisclosable(invoice)) return draftSilent();
        return summarize(invoice);
    }

    const { rows } = await invoicesService.listInvoices(
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

    const invoice = await getDetail(companyId, best[0].id);
    if (!invoice || !financeDisclosure.documentMatchesScope(invoice, subject)) return notFound();
    if (!isDisclosable(invoice)) return draftSilent();
    return summarize(invoice);
}

module.exports = { run };
