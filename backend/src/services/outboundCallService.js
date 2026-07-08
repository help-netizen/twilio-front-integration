const axios = require('axios');

// =============================================================================
// Outbound Call Service — OUTBOUND-PARTS-CALL-001, Decision D (spec §C.3)
//
// Places a single outbound VAPI call for the "part arrived → book the finish
// visit" flow. The call opens with a concrete, pre-computed slot in
// `assistantOverrides.variableValues` and performs NO API lookup during the
// open (D3): the worker (outboundCallWorker) has already resolved the slot and
// passes it in here.
//
// SAFE-FAIL: placeCall NEVER throws. It returns { ok:false, error } on any
// failure (bad config, non-2xx, timeout, network) so the worker can record a
// failed attempt and feed the retry loop without a try/catch at the call site.
// All VAPI_* config is read from server env ONLY (OQ-3) — never client-provided,
// never hardcoded. The Bearer token is never logged.
// =============================================================================

// Request timeout for the VAPI /call POST. Placing a call is non-idempotent, so
// keep this bounded; the worker treats a timeout as a failed attempt (retryable).
const VAPI_CALL_TIMEOUT_MS = Number(process.env.VAPI_CALL_TIMEOUT_MS) || 15000;

const VAPI_CALL_URL = 'https://api.vapi.ai/call';

// Lazy, cached axios client. Built on first use so tests can mock `axios`
// (jest.mock('axios')) before the module places a call, and so a missing key at
// require-time doesn't crash module load.
let client = null;
function getClient() {
    if (client) return client;
    client = axios.create({
        baseURL: VAPI_CALL_URL,
        timeout: VAPI_CALL_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
    });
    return client;
}

/**
 * Place one outbound VAPI call. Safe-fail — resolves, never rejects.
 *
 * @param {Object}  args
 * @param {string}  args.companyId      Owning company (flows from job.company_id).
 * @param {string}  args.jobId          Job the completion visit belongs to.
 * @param {string}  args.contactId      Bound (known) contact for the call.
 * @param {string}  args.customerName   Customer display name (greeting).
 * @param {string}  args.customerNumber E.164 number to dial.
 * @param {Object}  args.slot           Pre-computed top slot from recommendSlots.
 * @param {string}  args.slot.label     Human slot label ("Tue, Jul 8, 9–11am").
 * @param {string}  args.slot.date      Slot date (YYYY-MM-DD).
 * @param {string}  args.slot.start     Slot start.
 * @param {string}  args.slot.end       Slot end.
 * @param {string}  args.slot.key       Slot key (engine idempotency handle).
 * @returns {Promise<{ok:true, vapiCallId:string} | {ok:false, error:string}>}
 */
async function placeCall({ companyId, jobId, contactId, customerName, customerNumber, slot } = {}) {
    const apiKey = process.env.VAPI_API_KEY;
    const assistantId = process.env.VAPI_OUTBOUND_ASSISTANT_ID;
    const phoneNumberId = process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID;
    // Caller-ID source. Prefer a registered VAPI phone number (phoneNumberId).
    // Otherwise place via a TRANSIENT Twilio number (BYO creds): VAPI originates
    // the outbound leg through Twilio from our own business line WITHOUT importing
    // the number into VAPI — so that number's inbound Twilio webhook (which routes
    // customer calls to the CRM) is never rewritten/hijacked.
    const twilioNumber = process.env.VAPI_OUTBOUND_TWILIO_NUMBER;
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const hasTransient = twilioNumber && twilioSid && twilioToken;

    // Fail fast on missing config or number — never expose which secret is unset
    // beyond a coarse label, and never dial without a destination.
    if (!apiKey || !assistantId || (!phoneNumberId && !hasTransient)) {
        console.error('[outboundCallService] VAPI outbound config missing (assistant/caller-number/api key)');
        return { ok: false, error: 'vapi_config_missing' };
    }
    if (!customerNumber) {
        console.error('[outboundCallService] placeCall called without customerNumber', { companyId, jobId });
        return { ok: false, error: 'missing_customer_number' };
    }

    const s = slot || {};
    const body = {
        assistantId,
        // Registered number wins; else transient Twilio caller-ID (no VAPI import).
        // VAPI transient Twilio caller-ID: the inline phoneNumber object uses
        // `twilioPhoneNumber` (E.164) — NOT `provider`/`number`. Sending provider/number
        // gets a 400 ("property provider/number should not exist"; twilioPhoneNumber
        // required) and the call never places. (OUTBOUND-PARTS-CALL-DIAL-FIX-001.)
        ...(phoneNumberId
            ? { phoneNumberId }
            : { phoneNumber: { twilioPhoneNumber: twilioNumber, twilioAccountSid: twilioSid, twilioAuthToken: twilioToken } }),
        customer: { number: customerNumber },
        assistantOverrides: {
            variableValues: {
                jobId,
                contactId,
                companyId,
                customerName,
                slotLabel: s.label,
                slotDate: s.date,
                slotStart: s.start,
                slotEnd: s.end,
                slotKey: s.key,
            },
        },
    };

    try {
        const resp = await getClient().post('', body, {
            // Per-request Authorization so the token is never baked into the
            // cached client instance (and never logged with it).
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const vapiCallId = resp && resp.data && resp.data.id;
        if (!vapiCallId) {
            console.error('[outboundCallService] VAPI /call returned no call id', { companyId, jobId });
            return { ok: false, error: 'no_call_id' };
        }
        return { ok: true, vapiCallId };
    } catch (err) {
        // Never let the Bearer token or full config leak into logs. axios error
        // for a non-2xx carries err.response.status; timeouts/network carry code.
        const status = err && err.response && err.response.status;
        const code = err && err.code;
        const error = status ? `vapi_http_${status}` : (code || 'vapi_request_failed');
        console.error('[outboundCallService] placeCall failed', { companyId, jobId, status, code });
        return { ok: false, error };
    }
}

module.exports = { placeCall };
