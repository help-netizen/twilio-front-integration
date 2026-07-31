'use strict';

const callMaskingService = require('./callMaskingService');

const MASK_PERMISSION = 'call_masking.use';
const REQUEST_CACHE = Symbol('pulseMaskViewer');

function normalizedKey(key) {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
}

function isPhoneKey(key) {
    const normalized = normalizedKey(key);
    if (normalized.endsWith('_phone_name')) return false;
    return normalized === 'phone'
        || normalized.endsWith('_phone')
        || normalized.startsWith('phone_')
        || normalized.includes('phone_e164')
        || normalized.includes('phone_number')
        || normalized.includes('phone_ext')
        || normalized === 'from_number'
        || normalized === 'to_number'
        || normalized === 'customer_e164'
        || normalized === 'proxy_e164'
        || normalized === 'tl_phone'
        || normalized === 'last_interaction_phone'
        || normalized === 'customer_phone'
        || normalized === 'friendly_name'
        || normalized === 'masking_number'
        || normalized === 'display_number'
        || normalized === 'tel_uri';
}

function isCallDto(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = new Set(Object.keys(value).map(normalizedKey));
    return keys.has('direction')
        && (keys.has('call_sid') || keys.has('duration_sec') || keys.has('duration'));
}

function isCallInternalKey(key) {
    const normalized = normalizedKey(key);
    return normalized === 'call_sid'
        || normalized === 'parent_call_sid'
        || normalized === 'parent_call'
        || normalized === 'answered_by'
        || normalized === 'price'
        || normalized === 'price_unit'
        || normalized === 'cost'
        || normalized === 'raw_payload'
        || normalized === 'routing_group'
        || normalized === 'total_duration'
        || normalized === 'talk_time'
        || normalized === 'wait_time'
        || normalized === 'queue_time'
        || normalized === 'recording_duration'
        || normalized === 'recording'
        || normalized === 'recordings'
        || normalized === 'audio_url'
        || normalized === 'transcript'
        || normalized === 'transcripts'
        || normalized === 'transcription'
        || normalized === 'summary'
        || normalized === 'entities'
        || normalized.startsWith('recording_')
        || normalized.startsWith('audio_')
        || normalized.startsWith('playback_')
        || normalized.startsWith('transcript_')
        || normalized.startsWith('transcription_')
        || normalized.startsWith('sentiment')
        || normalized.startsWith('flow_')
        || normalized.startsWith('gemini_');
}

/**
 * Resolve whether this authenticated viewer must receive Pulse redaction.
 * req.authz.permissions is already the effective role + per-user permission set.
 * Unknown auth/tenant/settings state fails closed; an explicit absence of the
 * masking permission or an explicitly inactive company setting does not redact.
 */
async function resolveMaskViewer(req) {
    if (req.user?._devMode) return false;

    const permissions = req.authz?.permissions;
    if (!Array.isArray(permissions)) return true;
    if (!permissions.includes(MASK_PERMISSION)) return false;

    const companyId = req.companyFilter?.company_id;
    if (!companyId) return true;

    try {
        return Boolean(await callMaskingService.getActiveSettings(companyId));
    } catch (error) {
        console.warn('[PulseMasking] Masking scope resolution failed; redacting:', error.message);
        return true;
    }
}

function getMaskViewer(req) {
    if (!req[REQUEST_CACHE]) {
        req[REQUEST_CACHE] = Promise.resolve(resolveMaskViewer(req));
    }
    return req[REQUEST_CACHE];
}

/**
 * Final response-boundary projector shared by Pulse timeline/list/call-detail
 * surfaces. It clones the payload and removes phone-bearing keys everywhere;
 * call DTOs additionally collapse to event metadata by removing media, transcript,
 * summary, sentiment, and other internal fields.
 */
function redactPulsePayload(payload, maskViewer) {
    if (maskViewer !== true) return payload;

    const visit = value => {
        if (Array.isArray(value)) return value.map(visit);
        if (!value || typeof value !== 'object' || value instanceof Date) return value;

        const callDto = isCallDto(value);
        const output = {};
        for (const [key, child] of Object.entries(value)) {
            if (normalizedKey(key) === 'leads_map') {
                output[key] = {};
                continue;
            }
            if (isPhoneKey(key)) continue;
            if (callDto && isCallInternalKey(key)) continue;
            output[key] = visit(child);
        }
        if (callDto) output.details_redacted = true;
        return output;
    };

    return visit(payload);
}

function phoneDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

/**
 * Masked viewers address SMS by an opaque, server-resolved target. A matching
 * existing conversation can be used directly; otherwise the messaging route
 * resolves the requested contact slot inside the authenticated company.
 */
function buildMaskedSmsTargets(contact, conversations) {
    if (!contact?.id) return [];

    const byCustomer = new Map();
    for (const conversation of conversations || []) {
        const digits = phoneDigits(conversation.customer_e164);
        if (digits && !byCustomer.has(digits)) byCustomer.set(digits, conversation);
    }

    const targets = [];
    const add = (slot, phone, label) => {
        const digits = phoneDigits(phone);
        if (!digits) return;
        const conversation = byCustomer.get(digits);
        targets.push({
            channel: 'sms',
            target_ref: `contact:${slot}`,
            conversation_id: conversation?.id || null,
            label,
        });
    };

    add('primary', contact.phone_e164, 'Main number');
    if (phoneDigits(contact.secondary_phone) !== phoneDigits(contact.phone_e164)) {
        add('secondary', contact.secondary_phone, contact.secondary_phone_name || 'Secondary number');
    }
    return targets;
}

module.exports = {
    MASK_PERMISSION,
    resolveMaskViewer,
    getMaskViewer,
    redactPulsePayload,
    buildMaskedSmsTargets,
};
