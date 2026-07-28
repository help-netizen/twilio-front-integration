'use strict';

const axios = require('axios');

const API_VERSION = 'v23';
const API_BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class GoogleAdsAdapterError extends Error {
    constructor(code, message, httpStatus = 502) {
        super(message);
        this.name = 'GoogleAdsAdapterError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function requireParam(value, name) {
    if (typeof value !== 'string' || !value) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            `Google Ads ${name} is not configured.`,
            503
        );
    }
}

function validateDate(value, name) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            `${name} must be a valid YYYY-MM-DD date.`,
            400
        );
    }
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() + 1 !== month
        || parsed.getUTCDate() !== day) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            `${name} must be a valid YYYY-MM-DD date.`,
            400
        );
    }
    return value;
}

function responseStatus(error) {
    return Number(error?.response?.status) || null;
}

async function refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken,
    httpClient = axios,
}) {
    requireParam(clientId, 'OAuth client id');
    requireParam(clientSecret, 'OAuth client secret');
    requireParam(refreshToken, 'OAuth refresh token');

    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    }).toString();

    try {
        const response = await httpClient.post(TOKEN_URL, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10_000,
        });
        if (typeof response?.data?.access_token !== 'string'
            || !response.data.access_token) {
            throw new Error('missing access token');
        }
        return response.data.access_token;
    } catch {
        throw new GoogleAdsAdapterError(
            'AUTH_REFRESH_FAILED',
            'Google Ads authorization must be refreshed.',
            401
        );
    }
}

async function executeQuery({
    customerId,
    developerToken,
    accessToken,
    query,
    httpClient = axios,
}) {
    requireParam(customerId, 'customer id');
    requireParam(developerToken, 'developer token');
    requireParam(accessToken, 'access token');
    requireParam(query, 'query');

    const results = [];
    let pageToken = null;
    do {
        try {
            const response = await httpClient.post(
                `${API_BASE_URL}/customers/${customerId}/googleAds:search`,
                pageToken ? { query, pageToken } : { query },
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'developer-token': developerToken,
                        'Content-Type': 'application/json',
                    },
                    timeout: 30_000,
                }
            );
            if (Array.isArray(response?.data?.results)) {
                results.push(...response.data.results);
            }
            pageToken = typeof response?.data?.nextPageToken === 'string'
                && response.data.nextPageToken
                ? response.data.nextPageToken
                : null;
        } catch (error) {
            if ([401, 403].includes(responseStatus(error))) {
                throw new GoogleAdsAdapterError(
                    'ACCOUNT_ACCESS_DENIED',
                    'Google Ads account access was denied.',
                    403
                );
            }
            throw new GoogleAdsAdapterError(
                'GOOGLE_ADS_QUERY_FAILED',
                'Google Ads could not complete the requested query.'
            );
        }
    } while (pageToken);
    return results;
}

async function fetchAccountMetadata(params) {
    const accessToken = params.accessToken || await refreshAccessToken(params);
    const results = await executeQuery({
        ...params,
        accessToken,
        query: 'SELECT customer.currency_code, customer.time_zone FROM customer',
    });
    const customer = results[0]?.customer || {};
    const currencyCode = customer.currencyCode || null;
    const accountTimezone = customer.timeZone || null;

    if (currencyCode !== 'USD') {
        throw new GoogleAdsAdapterError(
            'UNSUPPORTED_CURRENCY',
            'Google Ads accounts must use USD for this connector.',
            422
        );
    }
    if (typeof accountTimezone !== 'string' || !accountTimezone) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            'Google Ads did not return an account timezone.'
        );
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: accountTimezone }).format();
    } catch {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            'Google Ads returned an invalid account timezone.'
        );
    }

    return {
        currency_code: currencyCode,
        account_timezone: accountTimezone,
    };
}

function integerString(value, field) {
    try {
        return BigInt(value ?? 0).toString();
    } catch {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            `Google Ads returned an invalid ${field}.`
        );
    }
}

function decimalString(value, field) {
    const normalized = String(value ?? 0);
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            `Google Ads returned an invalid ${field}.`
        );
    }
    return normalized;
}

function mapCampaignDay(result) {
    const date = validateDate(result?.segments?.date, 'Google Ads segment date');
    const campaignId = String(result?.campaign?.id || '');
    if (!campaignId) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            'Google Ads returned a campaign without an id.'
        );
    }
    return {
        external_campaign_id: campaignId,
        external_campaign_name: result?.campaign?.name || null,
        performance_date: date,
        cost_micros: integerString(result?.metrics?.costMicros, 'cost_micros'),
        impressions: integerString(result?.metrics?.impressions, 'impressions'),
        clicks: integerString(result?.metrics?.clicks, 'clicks'),
        conversions: decimalString(result?.metrics?.conversions, 'conversions'),
        conversions_value: decimalString(
            result?.metrics?.conversionsValue,
            'conversions_value'
        ),
    };
}

async function fetchCampaignPerformance(params) {
    const startDate = validateDate(params.startDate, 'startDate');
    const endDate = validateDate(params.endDate, 'endDate');
    if (startDate > endDate) {
        throw new GoogleAdsAdapterError(
            'GOOGLE_ADS_QUERY_FAILED',
            'startDate must not be after endDate.',
            400
        );
    }
    const accessToken = params.accessToken || await refreshAccessToken(params);
    const query = `
        SELECT
          segments.date,
          campaign.id,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
          AND campaign.status != 'REMOVED'
        ORDER BY segments.date ASC, campaign.id ASC
    `;
    const results = await executeQuery({
        ...params,
        accessToken,
        query,
    });
    return results.map(mapCampaignDay);
}

module.exports = {
    API_BASE_URL,
    API_VERSION,
    GoogleAdsAdapterError,
    TOKEN_URL,
    executeQuery,
    fetchAccountMetadata,
    fetchCampaignPerformance,
    refreshAccessToken,
    validateDate,
};
