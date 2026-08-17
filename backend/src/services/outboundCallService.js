const axios = require('axios');
const vapiCallIdentity = require('./vapiCallIdentityService');

// =============================================================================
// Outbound Call Service — OUTBOUND-PARTS-CALL-001, Decision D (spec §C.3)
//
// Places a single outbound VAPI call for the "part arrived → book the finish
// visit" flow. The call opens with a concrete, pre-computed slot in
// `assistantOverrides.variableValues`; the worker has already resolved that
// scheduling context. Finance is intentionally NOT preloaded here: estimate or
// invoice amounts are fetched on demand through the authorized in-call skills.
//
// SAFE-FAIL: placeCall NEVER throws. A local session is reserved before the
// provider request. Definite provider rejection may feed the retry loop;
// ambiguous transport/bind outcomes stay provider_pending and MUST NOT POST
// again. Assistant and caller identity come only from the company registry.
// Provider transport secrets remain server-only.
// The Bearer token is never logged.
// =============================================================================

// Request timeout for the VAPI /call POST. Placing a call is non-idempotent;
// timeout/network uncertainty is therefore provider_pending, never retryable.
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
 * @param {number}  args.attemptId      Company-bound outbound attempt identity.
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
 * @param {string}  [args.slot.techId]  TECHSLOT-001: the dispatcher-picked (or
 *                                       single-assigned-default) technician the
 *                                       in-call recommendSlots must be scoped to.
 *                                       Injected as variableValues.technicianId
 *                                       ONLY when present (legacy slots omit it).
 * @param {number}  [args.slot.lat]     TECHSLOT-001: job latitude — the in-call
 * @param {number}  [args.slot.lng]     recs location. Injected ONLY when BOTH
 *                                       coords are present (never a half pair).
 * OUTBOUND-LEAD-CALL-001 (all optional; absent on parts calls — conditional
 * spreads keep the parts wire body byte-identical):
 * @param {string}  [args.scenario]           'lead_call' → prompt var scenario:'lead_booking'.
 * @param {string}  [args.leadUuid]           Triggering lead (confirmLeadBooking identity).
 * @param {string}  [args.zip]                Lead postal code (in-call slot re-lookups).
 * @param {string}  [args.problemDescription] lead_notes/comments, ≤300 chars.
 * @param {string}  [args.source]             Lead source display label ("Pro Referral").
 * @param {string}  [args.firstMessage]       Per-call greeting override (assistant's
 *                                            static firstMessage is parts-specific).
 * @returns {Promise<{ok:true, vapiCallId:string} | {ok:false, error:string}>}
 */
async function placeCall({
    companyId, attemptId, jobId, contactId, customerName, customerNumber, slot,
    scenario, leadUuid, zip, problemDescription, source, firstMessage,
    applianceType, applianceBrand, applianceProblem,
} = {}) {
    const apiKey = process.env.VAPI_API_KEY;
    if (!apiKey) {
        console.error('[VAPI_OUTBOUND_ALERT] platform API credential missing', { companyId });
        return { ok: false, error: 'vapi_config_missing' };
    }
    if (!customerNumber) {
        console.error('[outboundCallService] placeCall called without customerNumber', { companyId, jobId });
        return { ok: false, error: 'missing_customer_number' };
    }

    let reservation;
    try {
        reservation = await vapiCallIdentity.reserveOutboundSession({
            companyId,
            outboundCallAttemptId: attemptId,
            environment: 'prod',
        });
    } catch (error) {
        console.error('[VAPI_OUTBOUND_ALERT] registry/session refused placement', {
            companyId,
            attemptId,
            code: error?.code || 'VAPI_OUTBOUND_RESERVATION_FAILED',
        });
        return { ok: false, error: 'outbound_registry_unavailable' };
    }
    if (reservation.alreadyBound) {
        return {
            ok: true,
            vapiCallId: reservation.providerCallId,
            sessionId: reservation.sessionId,
            idempotent: true,
            callerId: null,
        };
    }
    if (reservation.providerPending) {
        console.error('[VAPI_OUTBOUND_ALERT] provider placement already pending', {
            companyId,
            attemptId,
            sessionId: reservation.sessionId,
        });
        return {
            ok: false,
            error: 'provider_pending',
            providerPending: true,
            sessionId: reservation.sessionId,
        };
    }

    const assistantId = reservation.assistantId;
    const isLeadCall = reservation.purpose === 'outbound_lead_call';
    const phoneNumberId = reservation.resourceType === 'vapi_phone_number'
        ? reservation.phoneNumberId
        : null;
    const twilioNumber = reservation.resourceType === 'transient_twilio'
        ? reservation.twilioPhoneNumber
        : null;
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const callerShapeValid = (phoneNumberId && !twilioNumber)
        || (twilioNumber && twilioSid && twilioToken && !phoneNumberId);
    if (!assistantId || !callerShapeValid) {
        console.error('[VAPI_OUTBOUND_ALERT] reserved outbound tuple is not executable', {
            companyId,
            attemptId,
            sessionId: reservation.sessionId,
            resourceType: reservation.resourceType || null,
        });
        await vapiCallIdentity.quarantineOutboundReservation({
            companyId,
            sessionId: reservation.sessionId,
            outboundCallAttemptId: attemptId,
            reason: 'outbound_transport_config_missing',
        }).catch((error) => {
            console.error('[VAPI_OUTBOUND_ALERT] reservation quarantine failed', {
                companyId,
                attemptId,
                code: error?.code || error?.message,
            });
        });
        return { ok: false, error: 'vapi_config_missing' };
    }

    const s = slot || {};
    const body = {
        assistantId,
        // Vapi persists call metadata and returns it from call reads/lists. This
        // server-owned UUID is the only repair key for an ambiguous POST; it is
        // not tenant input and is not exposed to the assistant prompt.
        metadata: { albustoCallSessionId: reservation.sessionId },
        // Registry selects exactly one company-owned caller resource. Runtime
        // environment variables cannot select either assistant or caller number.
        // VAPI transient Twilio caller-ID: the inline phoneNumber object uses
        // `twilioPhoneNumber` (E.164) — NOT `provider`/`number`. Sending provider/number
        // gets a 400 ("property provider/number should not exist"; twilioPhoneNumber
        // required) and the call never places. (OUTBOUND-PARTS-CALL-DIAL-FIX-001.)
        ...(phoneNumberId
            ? { phoneNumberId }
            : { phoneNumber: { twilioPhoneNumber: twilioNumber, twilioAccountSid: twilioSid, twilioAuthToken: twilioToken } }),
        customer: { number: customerNumber },
        assistantOverrides: {
            // OUTBOUND-LEAD-CALL-001: per-call greeting override — the assistant's
            // static firstMessage is parts-specific. Parts calls never send the
            // key, so their greeting is untouched.
            ...(firstMessage ? { firstMessage } : {}),
            variableValues: {
                // Parts calls always pass non-null jobId/contactId — conditional
                // spreads change nothing on the parts wire body (golden-pinned).
                ...(jobId != null ? { jobId } : {}),
                ...(contactId != null ? { contactId } : {}),
                companyId,
                customerName,
                slotLabel: s.label,
                slotDate: s.date,
                slotStart: s.start,
                slotEnd: s.end,
                slotKey: s.key,
                // TECHSLOT-001 (§2 hop 3 / §5): server-injected in-call scheduling
                // constraint + location. Present ONLY when the slot_json carries
                // them (dispatcher lane pick / single-tech default + job coords
                // stamped by startRobotCall) — absent keys keep the legacy /
                // auto-compute call body byte-identical. Downstream,
                // vapi-tools.buildSkillInput spreads variableValues LAST over the
                // model args, so the model can never override these; recommendSlots
                // then scopes to that technician and locates at the job.
                ...(s.techId ? { technicianId: s.techId } : {}),
                ...(s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : {}),
                // OUTBOUND-LEAD-CALL-001 — absent keys keep the parts body
                // byte-identical. Discriminator naming (exact, per architecture):
                // DB column value 'lead_call'; PROMPT variable 'lead_booking'.
                ...(isLeadCall ? { scenario: 'lead_booking' } : {}),
                ...(leadUuid ? { leadUuid } : {}),
                ...(zip ? { zip } : {}),
                ...(problemDescription ? { problemDescription } : {}),
                ...(source ? { source } : {}),
                // Structured appliance context so the lead agent confirms the
                // SPECIFIC job ("your Samsung refrigerator that isn't cooling —
                // is that right?") before scheduling. Absent keys → the prompt's
                // Liquid conditionals skip them.
                ...(applianceType ? { applianceType } : {}),
                ...(applianceBrand ? { applianceBrand } : {}),
                ...(applianceProblem ? { applianceProblem } : {}),
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
            console.error('[VAPI_OUTBOUND_ALERT] VAPI /call returned no call id; outcome pending', {
                companyId,
                attemptId,
                sessionId: reservation.sessionId,
            });
            return {
                ok: false,
                error: 'no_call_id',
                providerPending: true,
                sessionId: reservation.sessionId,
            };
        }
        try {
            await vapiCallIdentity.bindOutboundPlacement({
                companyId,
                sessionId: reservation.sessionId,
                outboundCallAttemptId: attemptId,
                providerCallId: vapiCallId,
                subscriptionLimits: resp.data.subscriptionLimits,
                slotJson: isLeadCall ? slot : undefined,
            });
        } catch (error) {
            console.error('[VAPI_OUTBOUND_ALERT] provider call placed but atomic bind failed', {
                companyId,
                attemptId,
                sessionId: reservation.sessionId,
                providerCallId: vapiCallId,
                code: error?.code || 'VAPI_OUTBOUND_BIND_FAILED',
            });
            return {
                ok: false,
                error: 'provider_bind_pending',
                providerPending: true,
                sessionId: reservation.sessionId,
                providerCallId: vapiCallId,
            };
        }
        return {
            ok: true,
            vapiCallId,
            sessionId: reservation.sessionId,
            callerId: twilioNumber || null,
        };
    } catch (err) {
        // Never let the Bearer token or full config leak into logs. axios error
        // for a non-2xx carries err.response.status; timeouts/network carry code.
        const status = err && err.response && err.response.status;
        const code = err && err.code;
        const error = status ? `vapi_http_${status}` : (code || 'vapi_request_failed');
        if (!status) {
            console.error('[VAPI_OUTBOUND_ALERT] VAPI placement outcome unknown', {
                companyId,
                attemptId,
                sessionId: reservation.sessionId,
                code,
            });
            return {
                ok: false,
                error,
                providerPending: true,
                sessionId: reservation.sessionId,
            };
        }
        console.error('[outboundCallService] placeCall rejected', {
            companyId,
            attemptId,
            status,
        });
        await vapiCallIdentity.quarantineOutboundReservation({
            companyId,
            sessionId: reservation.sessionId,
            outboundCallAttemptId: attemptId,
            reason: `provider_http_${status}`,
        }).catch((quarantineError) => {
            console.error('[VAPI_OUTBOUND_ALERT] reservation quarantine failed', {
                companyId,
                attemptId,
                code: quarantineError?.code || quarantineError?.message,
            });
        });
        return { ok: false, error };
    }
}

module.exports = { placeCall };
