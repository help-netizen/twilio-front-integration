'use strict';

const conversationsService = require('./conversationsService');
const companyQueries = require('../db/companyQueries');
const { toE164 } = require('../utils/phoneUtils');
const { resolveCompanyProxyE164 } = require('./messagingHelper');
const { logJobActivity } = require('./jobActivityService');

function notifyError(httpStatus, code, message) {
    return Object.assign(new Error(message), { httpStatus, statusCode: httpStatus, code });
}

function validateEtaMinutes(etaMinutes) {
    return typeof etaMinutes === 'number'
        && Number.isInteger(etaMinutes)
        && etaMinutes >= 1
        && etaMinutes <= 600;
}

async function notifyOnTheWay({ job, companyId, etaMinutes, activityActor = null, client = null }) {
    if (!validateEtaMinutes(etaMinutes)) {
        throw notifyError(400, 'invalid_eta', 'invalid_eta');
    }

    const rawPhone = (job?.customer_phone || '').trim();
    const customerE164 = rawPhone ? toE164(rawPhone) : null;
    if (!customerE164) {
        throw notifyError(422, 'NO_PHONE', 'No phone number on file for this customer.');
    }

    const proxyE164 = await resolveCompanyProxyE164(companyId);
    if (!proxyE164) {
        throw notifyError(422, 'NO_PROXY', 'No sending number configured for your company.');
    }

    const techName = (job.assigned_techs?.[0]?.name || '').trim();
    let companyName = null;
    try {
        const company = companyId ? await companyQueries.getCompanyById(companyId) : null;
        companyName = (company?.name || '').trim() || null;
    } catch (error) {
        console.warn('[JobOnTheWay] company name lookup failed:', error.message);
    }
    const companyLabel = companyName || 'your service team';
    const leadIn = techName ? `Your technician ${techName} ` : 'Your technician ';
    const body = `Hi! ${leadIn}from ${companyLabel} is on the way and should arrive in about ${etaMinutes} minutes.`;

    try {
        const conversation = await conversationsService.getOrCreateConversation(
            customerE164,
            proxyE164,
            companyId
        );
        await conversationsService.sendMessage(conversation.id, { companyId, body, author: 'agent' });
    } catch (error) {
        if (error.code === 'WALLET_BLOCKED') {
            throw notifyError(
                error.httpStatus || 402,
                'WALLET_BLOCKED',
                'Messaging is paused — top up your balance.'
            );
        }
        console.error('[JobOnTheWay] SMS send error:', error.message);
        throw notifyError(502, 'SMS_FAILED', "Couldn't send the message. Please try again.");
    }

    const activity = {
        companyId,
        action: 'job.eta_notified',
        jobId: job.id,
        actor: activityActor,
        summary: { channel: 'sms' },
    };
    if (client) await logJobActivity(activity, { client });
    else await logJobActivity(activity);

    return { sent: true };
}

module.exports = { notifyOnTheWay, validateEtaMinutes };
