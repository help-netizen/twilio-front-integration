#!/usr/bin/env node
/**
 * capture-golden.js — AGENT-SKILLS-001 T3
 *
 * Records the golden `JSON.stringify` output of the 5 relocated L0 legacy tools
 * (checkServiceArea / validateAddress / checkAvailability / recommendSlots /
 * createLead) on a matrix of representative inputs, so T4's thin `vapi-tools.js`
 * refactor and T9/T10 can be proven BYTE-IDENTICAL (gate G3, spec §7.3, AC-11).
 *
 * WHY these bytes are the source of truth: the capture drives the CURRENT
 * behavior of each tool with all external services stubbed (deterministic), and
 * the stubbed shapes match exactly what the pre-T4 `vapi-tools.js` handlers
 * produce for the same inputs (cross-checked against the live cases in
 * `tests/routes/vapi-tools.test.js`). The relocated `skills/<name>.run` modules
 * are invoked here (not the old handlers) because T3's contract is that the
 * relocation is byte-identical — so the module output IS the golden, and T4 must
 * reproduce it through the adapter.
 *
 * Determinism knobs:
 *   - fixed env (GOOGLE_GEOCODING_KEY set; VITE_GOOGLE_MAPS_API_KEY unset);
 *   - service stubs injected via each module's `require` cache (no DB / no HTTP /
 *     no marketplace / no engine);
 *   - a frozen `Date` for the one date-derived value (recommendSlots daysAhead
 *     `latest_allowed_date`), matching the vapi-tools test's freeze to
 *     2026-07-04T12:00:00Z.
 *
 * Usage:
 *   node tests/agentSkills/golden/capture-golden.js          # writes golden.json
 *   node tests/agentSkills/golden/capture-golden.js --check  # verify current
 *        modules still match the recorded golden.json (non-zero exit on drift)
 *
 * The recorded `golden.json` is the durable artifact consumed by
 * `tests/agentSkillsLegacyGolden.test.js` (jest parity gate) and, later, by
 * `scripts/verify-agent-skills-001.js` (ASK-INT-14…17 real-DB byte-compat).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const GOLDEN_PATH = path.join(__dirname, 'golden.json');

const ROOT = path.resolve(__dirname, '../../..');
const SKILLS_DIR = path.join(ROOT, 'backend/src/services/agentSkills/skills');

// ─── Deterministic env (mirror tests/routes/vapi-tools.test.js beforeEach) ──────
process.env.GOOGLE_GEOCODING_KEY = 'test-geocoding-key';
delete process.env.VITE_GOOGLE_MAPS_API_KEY;

// ─── Service stubs (via a Module._load override — symlink/cwd-proof) ────────────
// WHY NOT require.cache injection: keying the cache by `require.resolve(path…)`
// from THIS file can compute a different absolute path than the one a skill
// resolves for `require('../../scheduleService')` when the worktree is reached
// through a symlink (node_modules → main repo) or from a different cwd. A miss
// silently loads the REAL service (random lead UUIDs, live schedule rows) →
// non-deterministic, non-byte-stable golden. Intercepting `Module._load(request,
// parent)` and matching on the SAME `Module._resolveFilename(request, parent)`
// Node will use guarantees the stub wins for ANY runner. Each stub is
// deterministic and mirrors exactly what the real service returns for these
// inputs in the live vapi-tools suite, so captured bytes == pre-refactor bytes.

const EventEmitter = require('events');
let geocodePayload = null;
let geocodeError = null;

// serviceTerritoryQueries.search(companyId, zip)
const stQueries = {
    _next: null,
    search: async () => stQueries._next,
};
// scheduleService.getAvailableSlots(companyId, opts)
const scheduleService = {
    _next: null,
    _throw: null,
    getAvailableSlots: async () => {
        if (scheduleService._throw) throw new Error(scheduleService._throw);
        return scheduleService._next;
    },
};
// marketplaceService.isAppConnected(companyId, appKey)
const marketplaceService = {
    SMART_SLOT_ENGINE_APP_KEY: 'smart-slot-engine',
    _connected: true,
    isAppConnected: async () => marketplaceService._connected,
};
// slotEngineService.getRecommendations / resolveTimezone / tzCombine
const slotEngineService = {
    _recs: { recommendations: [], engine_status: 'ok' },
    _throw: null,
    getRecommendations: async () => {
        if (slotEngineService._throw) throw new Error(slotEngineService._throw);
        return slotEngineService._recs;
    },
    resolveTimezone: async () => 'America/New_York',
    // Deterministic combine (mirrors the vapi-tools slot-persist test double).
    tzCombine: (date, hhmm) => `${date}T${hhmm}:00.000Z-COMBINED`,
};
// leadsService.createLead(body, companyId) — fixed leadId (never a random UUID).
const leadsService = {
    _result: { uuid: 'lead-uuid-001' },
    _throwTimes: 0,
    _calls: 0,
    createLead: async () => {
        leadsService._calls += 1;
        if (leadsService._calls <= leadsService._throwTimes) throw new Error('db down');
        return leadsService._result;
    },
};
// A deterministic `https` whose .get emits the fixed geocode payload/error.
const httpsStub = {
    get(url, cb) {
        if (geocodeError) {
            const req = new EventEmitter();
            process.nextTick(() => req.emit('error', new Error(geocodeError)));
            return req;
        }
        const res = new EventEmitter();
        process.nextTick(() => {
            res.emit('data', JSON.stringify(geocodePayload));
            res.emit('end');
        });
        const req = { on: () => req };
        cb(res);
        return req;
    },
};

// Map: absolute-resolved service file (or core name) → stub exports.
// Built by resolving each service the way the skills import it (from SKILLS_DIR).
const skillsRequire = Module.createRequire(path.join(SKILLS_DIR, 'noop.js'));
const STUB_BY_FILE = new Map([
    [skillsRequire.resolve('../../../db/serviceTerritoryQueries'), stQueries],
    [skillsRequire.resolve('../../scheduleService'), scheduleService],
    [skillsRequire.resolve('../../marketplaceService'), marketplaceService],
    [skillsRequire.resolve('../../slotEngineService'), slotEngineService],
    [skillsRequire.resolve('../../leadsService'), leadsService],
    ['https', httpsStub],
]);

const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
    if (request === 'https') return httpsStub;
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (STUB_BY_FILE.has(resolved)) return STUB_BY_FILE.get(resolved);
    } catch (_e) { /* fall through to the real loader */ }
    return origLoad.call(this, request, parent, isMain);
};

// ─── Load the relocated skill modules (with the loader override active) ─────────
const checkServiceArea = require(path.join(SKILLS_DIR, 'checkServiceArea'));
const validateAddress = require(path.join(SKILLS_DIR, 'validateAddress'));
const checkAvailability = require(path.join(SKILLS_DIR, 'checkAvailability'));
const recommendSlots = require(path.join(SKILLS_DIR, 'recommendSlots'));
const createLead = require(path.join(SKILLS_DIR, 'createLead'));

// ─── The input matrix (representative per tool; mirrors ASK-VAPI-* fixtures) ────

const GEOCODE_OK = {
    status: 'OK',
    results: [{
        formatted_address: '45 Tremont St Apt 3, Boston, MA 02108, USA',
        geometry: { location: { lat: 42.357, lng: -71.059 } },
        address_components: [
            { types: ['postal_code'], short_name: '02108', long_name: '02108' },
        ],
    }],
};

const FULL_LEAD_ARGS = {
    firstName: 'John', lastName: 'Smith', phone: '+16175551234',
    zip: '02101', city: 'Boston', state: 'MA',
    unitType: 'Refrigerator', brand: 'Samsung', unitAge: '5 years',
    problemDescription: 'not cooling', preferredSlot: 'Tuesday June 10th 10am-1pm',
    addressValidated: true,
};

function rec(date, start, end, tech = 'Alex', confidence = 'high') {
    return {
        date,
        time_frame: { start, end },
        technicians: tech ? [{ id: 't1', name: tech }] : [],
        confidence,
    };
}

/**
 * A case = { name, run } where run() sets up the stubs and returns the tool
 * output. Each is wrapped by capture() so the recorded value is exactly the
 * `JSON.stringify` bytes a caller (the VAPI adapter) would serialize.
 */
const CASES = [
    // ── checkServiceArea ────────────────────────────────────────────────────
    { tool: 'checkServiceArea', name: 'in_area', run: async () => {
        stQueries._next = { zip: '02101', area: 'Boston', city: 'Boston', state: 'MA' };
        return checkServiceArea.run(DEFAULT_COMPANY_ID, {}, { zip: '02101' });
    } },
    { tool: 'checkServiceArea', name: 'out_of_area', run: async () => {
        stQueries._next = null;
        return checkServiceArea.run(DEFAULT_COMPANY_ID, {}, { zip: '03801' });
    } },
    { tool: 'checkServiceArea', name: 'missing_zip', run: async () => {
        stQueries._next = null;
        return checkServiceArea.run(DEFAULT_COMPANY_ID, {}, {});
    } },
    { tool: 'checkServiceArea', name: 'leading_zero_normalized', run: async () => {
        stQueries._next = { zip: '02101', area: 'Boston', city: 'Boston', state: 'MA' };
        return checkServiceArea.run(DEFAULT_COMPANY_ID, {}, { zip: '2101' });
    } },

    // ── validateAddress ─────────────────────────────────────────────────────
    { tool: 'validateAddress', name: 'valid', run: async () => {
        geocodeError = null; geocodePayload = GEOCODE_OK;
        return validateAddress.run(DEFAULT_COMPANY_ID, {}, { street: '45 Tremont St', apt: '3', city: 'Boston', state: 'MA', zip: '02108' });
    } },
    { tool: 'validateAddress', name: 'zero_results', run: async () => {
        geocodeError = null; geocodePayload = { status: 'ZERO_RESULTS', results: [] };
        return validateAddress.run(DEFAULT_COMPANY_ID, {}, { street: '999 Fake St', city: 'Nowhere' });
    } },
    { tool: 'validateAddress', name: 'network_error', run: async () => {
        geocodeError = 'Network timeout'; geocodePayload = null;
        return validateAddress.run(DEFAULT_COMPANY_ID, {}, { street: '45 Tremont St' });
    } },
    { tool: 'validateAddress', name: 'missing_key', run: async () => {
        const saved = process.env.GOOGLE_GEOCODING_KEY;
        delete process.env.GOOGLE_GEOCODING_KEY;
        const out = await validateAddress.run(DEFAULT_COMPANY_ID, {}, { street: '45 Tremont St' });
        process.env.GOOGLE_GEOCODING_KEY = saved;
        return out;
    } },

    // ── checkAvailability ───────────────────────────────────────────────────
    { tool: 'checkAvailability', name: 'success', run: async () => {
        scheduleService._throw = null;
        scheduleService._next = { slots: [
            { date: '2026-06-10', label: 'Tuesday, June 10th between 10am and 1pm', start: '10:00', end: '13:00' },
        ] };
        return checkAvailability.run(DEFAULT_COMPANY_ID, {}, { zip: '02101', unitType: 'Refrigerator' });
    } },
    { tool: 'checkAvailability', name: 'no_slots', run: async () => {
        scheduleService._throw = null;
        scheduleService._next = { slots: [], error: 'No availability found in the next 5 days' };
        return checkAvailability.run(DEFAULT_COMPANY_ID, {}, { zip: '02101' });
    } },
    { tool: 'checkAvailability', name: 'throws', run: async () => {
        scheduleService._throw = 'schedule unreachable';
        return checkAvailability.run(DEFAULT_COMPANY_ID, {}, { zip: '02101' });
    } },

    // ── recommendSlots ──────────────────────────────────────────────────────
    { tool: 'recommendSlots', name: 'not_connected', run: async () => {
        marketplaceService._connected = false;
        slotEngineService._throw = null;
        return recommendSlots.run(DEFAULT_COMPANY_ID, {}, { zip: '02101' });
    } },
    { tool: 'recommendSlots', name: 'happy', run: async () => {
        marketplaceService._connected = true;
        slotEngineService._throw = null;
        slotEngineService._recs = { recommendations: [rec('2026-07-08', '10:00', '13:00', 'Alex', 'high')], engine_status: 'ok' };
        return recommendSlots.run(DEFAULT_COMPANY_ID, {}, { lat: 42.35, lng: -71.06, unitType: 'Refrigerator' });
    } },
    { tool: 'recommendSlots', name: 'engine_unavailable', run: async () => {
        marketplaceService._connected = true;
        slotEngineService._throw = null;
        slotEngineService._recs = { recommendations: [rec('2026-07-08', '10:00', '13:00')], engine_status: 'unavailable' };
        return recommendSlots.run(DEFAULT_COMPANY_ID, {}, { zip: '02101' });
    } },
    { tool: 'recommendSlots', name: 'empty_recs', run: async () => {
        marketplaceService._connected = true;
        slotEngineService._throw = null;
        slotEngineService._recs = { recommendations: [], engine_status: 'ok' };
        return recommendSlots.run(DEFAULT_COMPANY_ID, {}, { lat: 42.35, lng: -71.06 });
    } },
    { tool: 'recommendSlots', name: 'throws', run: async () => {
        marketplaceService._connected = true;
        slotEngineService._throw = 'NEW_JOB_LOCATION_REQUIRED';
        return recommendSlots.run(DEFAULT_COMPANY_ID, {}, {});
    } },

    // ── createLead ──────────────────────────────────────────────────────────
    { tool: 'createLead', name: 'full_success', run: async () => {
        leadsService._calls = 0; leadsService._throwTimes = 0; leadsService._result = { uuid: 'lead-uuid-001' };
        return createLead.run(DEFAULT_COMPANY_ID, {}, FULL_LEAD_ARGS);
    } },
    { tool: 'createLead', name: 'no_phone', run: async () => {
        leadsService._calls = 0; leadsService._throwTimes = 0;
        const { phone, ...noPhone } = FULL_LEAD_ARGS;
        return createLead.run(DEFAULT_COMPANY_ID, {}, noPhone);
    } },
    { tool: 'createLead', name: 'disqualified', run: async () => {
        leadsService._calls = 0; leadsService._throwTimes = 0; leadsService._result = { uuid: 'dq' };
        return createLead.run(DEFAULT_COMPANY_ID, {}, {
            firstName: 'Jane', lastName: 'Caller', zip: '03801', unitType: 'Refrigerator',
            disqualified: true, disqualReason: 'out_of_area',
        });
    } },
    { tool: 'createLead', name: 'chosen_slot_with_coords', run: async () => {
        leadsService._calls = 0; leadsService._throwTimes = 0; leadsService._result = { uuid: 'lead-slot-1' };
        return createLead.run(DEFAULT_COMPANY_ID, {}, {
            ...FULL_LEAD_ARGS,
            chosenSlot: { date: '2026-07-08', start: '10:00', end: '13:00' },
            lat: 42.35, lng: -71.06,
        });
    } },
    { tool: 'createLead', name: 'no_chosen_slot', run: async () => {
        leadsService._calls = 0; leadsService._throwTimes = 0; leadsService._result = { uuid: 'lead-uuid-001' };
        return createLead.run(DEFAULT_COMPANY_ID, {}, FULL_LEAD_ARGS);
    } },
];

async function collect() {
    const golden = {};
    // Freeze Date so recommendSlots daysAhead (not exercised above, but kept
    // stable for any future daysAhead case) and any date logic is deterministic.
    const RealDate = Date;
    const fixedNow = new RealDate('2026-07-04T12:00:00Z');
    // eslint-disable-next-line no-global-assign
    global.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : fixedNow; }
        static now() { return fixedNow.getTime(); }
    };
    global.Date.UTC = RealDate.UTC;
    try {
        for (const c of CASES) {
            const out = await c.run();
            golden[`${c.tool}.${c.name}`] = JSON.stringify(out);
        }
    } finally {
        // eslint-disable-next-line no-global-assign
        global.Date = RealDate;
    }
    return golden;
}

async function main() {
    const check = process.argv.includes('--check');
    const golden = await collect();

    if (check) {
        if (!fs.existsSync(GOLDEN_PATH)) {
            console.error('[golden] --check: golden.json does not exist; run without --check first.');
            process.exit(2);
        }
        const recorded = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        let drift = 0;
        for (const key of Object.keys(golden)) {
            if (recorded[key] !== golden[key]) {
                drift += 1;
                console.error(`[golden] DRIFT ${key}\n  recorded: ${recorded[key]}\n  current:  ${golden[key]}`);
            }
        }
        for (const key of Object.keys(recorded)) {
            if (!(key in golden)) { drift += 1; console.error(`[golden] MISSING case in current run: ${key}`); }
        }
        if (drift) { console.error(`[golden] ${drift} drift(s) — modules no longer byte-match golden.json`); process.exit(1); }
        console.log(`[golden] --check OK — all ${Object.keys(golden).length} cases byte-match golden.json`);
        return;
    }

    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`);
    console.log(`[golden] wrote ${Object.keys(golden).length} cases → ${path.relative(ROOT, GOLDEN_PATH)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { collect, CASES, GOLDEN_PATH };
