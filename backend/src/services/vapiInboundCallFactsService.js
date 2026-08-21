'use strict';

/**
 * OB-71 — what the SERVER established during one inbound Vapi call.
 *
 * The voice model calls `createLead` with `{}` intermittently: observed on prod
 * 2026-08-19, and again 2026-08-20 with `strict: true` set on the tool, which
 * settles it — the schema's own `required` array is enforced by nobody on this
 * path, and one 17:44 call produced two empty calls in a row. Every field it
 * dropped had already been handed to us, by its OWN earlier tool calls, tens of
 * seconds earlier (29s checkServiceArea, 66s validateAddress, 95s recommendSlots,
 * 121s the empty createLead). Waiting for a model to restate what we already hold
 * is the wrong contract; this is the store that lets us stop waiting.
 *
 * Two rules keep this honest:
 *   - Only values our own tools RETURNED, or values a tool ACCEPTED and validated,
 *     are kept. Nothing is inferred, guessed, or carried across calls.
 *   - Identity is NOT kept here. `createLead.resolvedLeadIdentity` decides the
 *     contact and the name from the verification gate and fails closed when a
 *     phone maps to more than one contact (the owner's test number maps to
 *     twelve). Filling a name from here would walk straight around that guard.
 */

const db = require('./../db/connection');

const FACT_KEYS = Object.freeze([
    'street', 'apt', 'city', 'state', 'zip', 'unitType', 'lat', 'lng', 'standardizedAddress',
]);

function queryFor(client) {
    return client ? client.query.bind(client) : db.query.bind(db);
}

/** Drop null/undefined/blank so a later tool cannot erase an earlier good value. */
function compact(candidate) {
    const out = {};
    for (const key of FACT_KEYS) {
        const value = candidate[key];
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        out[key] = typeof value === 'string' ? value.trim() : value;
    }
    return out;
}

/**
 * Project one tool call into facts. `args` count ONLY where the tool confirmed
 * them: an address the model proposed becomes evidence once validateAddress
 * answers `valid:true`. `unitType` is the appliance the model already stated to
 * the slot engine in this same call — reusing it is not inventing it.
 */
function factsFromTool(tool, args = {}, result = {}) {
    const a = args && typeof args === 'object' ? args : {};
    const r = result && typeof result === 'object' ? result : {};

    if (tool === 'validateAddress') {
        if (r.valid !== true) return {};
        return compact({
            street: a.street,
            apt: a.apt,
            city: a.city,
            state: a.state,
            zip: r.correctedZip || a.zip,
            lat: r.lat,
            lng: r.lng,
            standardizedAddress: r.standardized,
        });
    }

    if (tool === 'checkServiceArea') {
        return compact({ city: r.city, state: r.state, zip: r.zip || a.zip });
    }

    if (tool === 'recommendSlots') {
        return compact({ unitType: a.unitType, zip: a.zip, lat: a.lat, lng: a.lng });
    }

    return {};
}

async function recordFromTool(input, client = null) {
    const companyId = String(input.companyId || '').trim();
    const providerCallId = String(input.providerCallId || input.call?.id || '').trim();
    if (!companyId || !providerCallId) return { recorded: false, facts: {} };

    const delta = factsFromTool(input.tool, input.arguments, input.result);
    if (Object.keys(delta).length === 0) return { recorded: false, facts: {} };

    // `||` on jsonb lets the right side win per key, so a corrected address
    // supersedes the earlier one. Blank values were dropped by compact(), so a
    // later tool can add to the picture but never blank out part of it.
    const { rows } = await queryFor(client)(
        `INSERT INTO vapi_inbound_call_facts (provider_call_id, company_id, facts)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (provider_call_id) DO UPDATE
         SET facts = vapi_inbound_call_facts.facts || EXCLUDED.facts,
             updated_at = now()
         WHERE vapi_inbound_call_facts.company_id = EXCLUDED.company_id
         RETURNING facts`,
        [providerCallId, companyId, JSON.stringify(delta)],
    );
    return { recorded: rows.length === 1, facts: rows[0]?.facts || {} };
}

async function resolve(input, client = null) {
    const companyId = String(input.companyId || '').trim();
    const providerCallId = String(input.providerCallId || input.call?.id || '').trim();
    if (!companyId || !providerCallId) return {};
    const { rows } = await queryFor(client)(
        `SELECT facts FROM vapi_inbound_call_facts
         WHERE provider_call_id = $1 AND company_id = $2`,
        [providerCallId, companyId],
    );
    const facts = rows[0]?.facts;
    return facts && typeof facts === 'object' ? facts : {};
}

/**
 * Model arguments always win. A fact only lands where the model left the field
 * out or sent it blank — so a caller who corrects themselves is never overruled
 * by what an earlier tool happened to resolve.
 */
function fillGaps(args = {}, facts = {}) {
    const merged = { ...(args && typeof args === 'object' ? args : {}) };
    const filled = [];
    for (const key of FACT_KEYS) {
        if (key === 'standardizedAddress') continue;
        if (!Object.prototype.hasOwnProperty.call(facts, key)) continue;
        const current = merged[key];
        const missing = current === null || current === undefined
            || (typeof current === 'string' && current.trim() === '');
        if (!missing) continue;
        merged[key] = facts[key];
        filled.push(key);
    }
    return { merged, filled };
}

module.exports = {
    FACT_KEYS,
    factsFromTool,
    recordFromTool,
    resolve,
    fillGaps,
};
