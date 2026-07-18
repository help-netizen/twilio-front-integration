'use strict';

/**
 * DOC-SEND-NOTE-001 — best-effort job notes for successful document sends.
 * Recipient details belong in the note itself, never in application logs.
 */

function actorFromRequest(req) {
    return {
        id: req.user?.crmUser?.id || null,
        name: req.user?.name?.split(' ')[0] || req.user?.email || null,
    };
}

function documentLabel({ documentType, number, amount }) {
    if (documentType === 'receipt') {
        const numericAmount = Number(amount);
        return `Receipt for $${(Number.isFinite(numericAmount) ? numericAmount : 0).toFixed(2)}`;
    }
    if (documentType === 'invoice') return `Invoice #${number}`;
    if (documentType === 'estimate') return `Estimate #${number}`;
    throw new Error(`Unsupported document note type: ${documentType}`);
}

function buildDocumentSendNote({ documentType, number, amount, channel, recipient }) {
    const destination = channel === 'sms'
        ? `sent by SMS to ${recipient}`
        : `sent to ${recipient}`;
    return `${documentLabel({ documentType, number, amount })} ${destination}`;
}

/**
 * The delivery has already succeeded when this runs. Every branch is non-fatal.
 * A missing job has no canonical free-form fallback on invoices/estimates/receipts.
 */
async function recordDocumentSendNote({
    companyId,
    jobId,
    actor,
    documentType,
    number,
    amount,
    channel,
    recipient,
}) {
    if (!jobId) {
        console.warn('[DocumentSendNote] Document has no job binding; note skipped');
        return false;
    }
    if (!actor?.id) {
        console.warn('[DocumentSendNote] Acting CRM user unavailable; note skipped');
        return false;
    }

    try {
        const jobsService = require('./jobsService');
        const text = buildDocumentSendNote({ documentType, number, amount, channel, recipient });
        await jobsService.addNote(jobId, text, [], actor.name, actor.id, null, companyId);
        return true;
    } catch {
        console.warn('[DocumentSendNote] Job note failed after successful send (non-fatal)');
        return false;
    }
}

module.exports = {
    actorFromRequest,
    buildDocumentSendNote,
    recordDocumentSendNote,
};
