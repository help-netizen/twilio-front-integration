'use strict';

const axios = require('axios');
const { normalizeUsPhone } = require('./phoneAttributionCore');

const API_BASE_URL = 'https://apis.elocal.com/advertisers/v2/campaign-results';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ElocalAdapterError extends Error {
    constructor(code, message, httpStatus = 502) {
        super(message);
        this.name = 'ElocalAdapterError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function validateDate(value, name) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            `${name} must be a valid YYYY-MM-DD date.`,
            400
        );
    }
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() + 1 !== month
        || parsed.getUTCDate() !== day) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            `${name} must be a valid YYYY-MM-DD date.`,
            400
        );
    }
    return value;
}

function validateCampaignIds(value) {
    if (!Array.isArray(value)) {
        throw new ElocalAdapterError(
            'ELOCAL_CONFIGURATION_MISSING',
            'eLocal campaign ids are not configured.',
            503
        );
    }
    const campaignIds = Array.from(new Set(value
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)));
    if (campaignIds.length === 0) {
        throw new ElocalAdapterError(
            'ELOCAL_CONFIGURATION_MISSING',
            'eLocal campaign ids are not configured.',
            503
        );
    }
    return campaignIds;
}

function requireApiKey(value) {
    if (typeof value !== 'string' || !value) {
        throw new ElocalAdapterError(
            'ELOCAL_CONFIGURATION_MISSING',
            'eLocal API access is not configured.',
            503
        );
    }
    return value;
}

function usdToCents(value) {
    const normalized = String(value ?? '').trim();
    const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            'eLocal returned an invalid call cost.'
        );
    }
    const cents = (BigInt(match[1]) * 100n)
        + BigInt((match[2] || '').padEnd(2, '0'));
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            'eLocal returned an invalid call cost.'
        );
    }
    return Number(cents);
}

function nullableString(value) {
    return typeof value === 'string' && value ? value : null;
}

function mapCall(record, campaignId) {
    const externalCallId = nullableString(record?.call_id);
    const callAt = new Date(record?.call_date_time);
    if (!externalCallId || !Number.isFinite(callAt.getTime())) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            'eLocal returned an invalid call record.'
        );
    }
    const phone = normalizeUsPhone(record?.caller_phone_number);
    const supplyEventStatus = String(record?.supply_event_status || '').toUpperCase();
    if (!supplyEventStatus) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            'eLocal returned a call without a supply event status.'
        );
    }
    const duration = Number(record?.call_duration_in_seconds);
    return {
        campaign_id: campaignId,
        external_call_id: externalCallId,
        caller_phone_e164: phone?.phoneE164 || null,
        normalized_phone: phone?.normalizedPhone || null,
        cost_cents: usdToCents(record?.cost),
        supply_event_status: supplyEventStatus,
        supply_event_status_reason: nullableString(
            record?.supply_event_status_reason
        ),
        billable: supplyEventStatus === 'BILLABLE',
        call_at: callAt,
        service_zip_code: nullableString(record?.service_zip_code),
        service_city: nullableString(record?.service_city),
        service_state_abbr: nullableString(record?.service_state_abbr),
        campaign_name: nullableString(record?.campaign_name),
        category_name: nullableString(record?.category_name),
        call_duration_seconds: Number.isInteger(duration) && duration >= 0
            ? duration
            : null,
        call_quality_tags: Array.isArray(record?.call_quality_tags)
            ? record.call_quality_tags
            : [],
        forwarding_number: nullableString(record?.forwarding_number),
        external_campaign_id: nullableString(record?.external_campaign_id),
        lead_source_id: nullableString(record?.lead_source_id),
    };
}

function responseStatus(error) {
    return Number(error?.response?.status) || null;
}

async function fetchResultType({
    campaignId,
    resultType,
    apiKey,
    startDate,
    endDate,
    httpClient,
}) {
    try {
        const response = await httpClient.get(
            `${API_BASE_URL}/${encodeURIComponent(campaignId)}/${resultType}.json`,
            {
                headers: { 'X-API-Key': apiKey },
                params: {
                    start_date: startDate,
                    end_date: endDate,
                },
                timeout: 30_000,
            }
        );
        const key = resultType === 'calls' ? 'calls' : 'web_leads';
        if (!Array.isArray(response?.data?.[key])) {
            throw new Error('invalid response shape');
        }
        return response.data[key];
    } catch (error) {
        if ([401, 403].includes(responseStatus(error))) {
            throw new ElocalAdapterError(
                'ELOCAL_ACCESS_DENIED',
                'eLocal API access was denied.',
                403
            );
        }
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            'eLocal could not complete the requested query.'
        );
    }
}

async function fetchCampaignResults(params) {
    const campaignIds = validateCampaignIds(params.campaignIds);
    const apiKey = requireApiKey(params.apiKey);
    const startDate = validateDate(params.startDate, 'startDate');
    const endDate = validateDate(params.endDate, 'endDate');
    if (startDate > endDate) {
        throw new ElocalAdapterError(
            'ELOCAL_QUERY_FAILED',
            'startDate must not be after endDate.',
            400
        );
    }
    const httpClient = params.httpClient || axios;
    const callsById = new Map();
    const webLeads = [];
    let skippedCalls = 0;
    for (const campaignId of campaignIds) {
        const calls = await fetchResultType({
            campaignId,
            resultType: 'calls',
            apiKey,
            startDate,
            endDate,
            httpClient,
        });
        for (const record of calls) {
            let mapped;
            try {
                mapped = mapCall(record, campaignId);
            } catch {
                // Tolerate an individual malformed record (missing supply-event
                // status / call_date_time / call_id, or an unparseable cost)
                // instead of aborting the whole range. Throwing here silently
                // dropped EVERY other call in the same 30-day chunk — the eLocal
                // backfill undercount (2026-08-11): a 90-day window returned 130
                // calls instead of 401 because a few chunks each had one bad row.
                skippedCalls += 1;
                continue;
            }
            if (!callsById.has(mapped.external_call_id)) {
                callsById.set(mapped.external_call_id, mapped);
            }
        }
        const campaignWebLeads = await fetchResultType({
            campaignId,
            resultType: 'web-leads',
            apiKey,
            startDate,
            endDate,
            httpClient,
        });
        webLeads.push(...campaignWebLeads);
    }
    const calls = Array.from(callsById.values()).sort((left, right) => (
        left.call_at.getTime() - right.call_at.getTime()
        || left.external_call_id.localeCompare(right.external_call_id)
    ));
    return { calls, webLeads, skippedCalls };
}

module.exports = {
    API_BASE_URL,
    ElocalAdapterError,
    fetchCampaignResults,
    validateDate,
    _mapCall: mapCall,
    _usdToCents: usdToCents,
};
