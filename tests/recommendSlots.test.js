/**
 * recommendSlots.test.js — OUTBOUND-PARTS-CALL-TECHSLOT-001 §4 (TC-TS-06…13).
 *
 * The in-call `recommendSlots` skill gains three optional args:
 *   - `technicianId` (server-injected via variableValues) → `new_job.technician_id`;
 *   - `targetDay` ('YYYY-MM-DD', model-resolved) → `earliest = latest = targetDay`;
 *   - `targetTime` ('HH:MM' 24h, with targetDay) → EXACTLY ONE window: the one whose
 *     [start,end) contains T (distance 0), else argmin |start − T|, tie → earlier start.
 * No new args → byte-identical legacy behavior; every fault → SLOT_FALLBACK
 * ({ available:false, slots:[], fallback:true }); the call always continues.
 *
 * Mock boundary = the services the skill requires (marketplace gate + engine proxy),
 * mirroring tests/slotEngineProxy.test.js / the golden capture stubs.
 */

'use strict';

jest.mock('../backend/src/services/marketplaceService', () => ({
    SMART_SLOT_ENGINE_APP_KEY: 'smart-slot-engine',
    isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/slotEngineService', () => ({
    getRecommendations: jest.fn(),
    resolveTimezone: jest.fn(async () => 'America/New_York'),
}));

const marketplaceService = require('../backend/src/services/marketplaceService');
const slotEngineService = require('../backend/src/services/slotEngineService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const D = '2026-07-16';

/** Engine-shaped recommendation for day/start/end. */
function rec(date, start, end, tech = 'Bob', confidence = 'high') {
    return {
        date,
        time_frame: { start, end },
        technicians: [{ id: 'B', name: tech }],
        confidence,
    };
}

/** The five candidate windows of one day (engine candidate_timeframes). */
function fullDay(date) {
    return [
        rec(date, '08:00', '10:00'),
        rec(date, '10:00', '12:00'),
        rec(date, '12:00', '14:00'),
        rec(date, '14:00', '16:00'),
        rec(date, '16:00', '18:00'),
    ];
}

const newJobArg = () => slotEngineService.getRecommendations.mock.calls[0][1].new_job;

beforeEach(() => {
    jest.clearAllMocks();
    marketplaceService.isAppConnected.mockResolvedValue(true);
    slotEngineService.getRecommendations.mockResolvedValue({
        recommendations: fullDay(D),
        engine_status: 'ok',
    });
});

describe('TECHSLOT-001 §4 — technicianId / targetDay / targetTime', () => {
    it('TC-TS-06: technicianId sets new_job.technician_id', async () => {
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B',
        });
        expect(slotEngineService.getRecommendations).toHaveBeenCalledWith(
            COMPANY, expect.objectContaining({ new_job: expect.objectContaining({ technician_id: 'B' }) }),
        );
        expect(out.available).toBe(true);
    });

    it('TC-TS-07: targetDay → earliest==latest==targetDay; returns that day\'s windows (≤MAX_SLOTS)', async () => {
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D,
        });
        const nj = newJobArg();
        expect(nj.earliest_allowed_date).toBe(D);
        expect(nj.latest_allowed_date).toBe(D);
        expect(nj.technician_id).toBe('B');
        expect(out.available).toBe(true);
        expect(out.slots.length).toBeLessThanOrEqual(3);
        expect(out.slots.length).toBe(3);
        for (const s of out.slots) expect(s.date).toBe(D);
    });

    it('TC-TS-08: targetDay+targetTime, requested window free → exactly the containing window', async () => {
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '14:30',
        });
        expect(out.available).toBe(true);
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0]).toMatchObject({ date: D, start: '14:00', end: '16:00' });
    });

    it('TC-TS-09: targetDay+targetTime, requested window busy → the single nearest available', async () => {
        // 12:00–14:00 and 14:00–16:00 occupied; nearest to 14:30 by start = 16:00 (dist 90).
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [rec(D, '08:00', '10:00'), rec(D, '10:00', '12:00'), rec(D, '16:00', '18:00')],
            engine_status: 'ok',
        });
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '14:30',
        });
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0]).toMatchObject({ date: D, start: '16:00', end: '18:00' });
    });

    it('TC-TS-09b: nearest considers ALL of the day\'s windows, not just the first MAX_SLOTS', async () => {
        // The true nearest (16:00) is the 5th window — a pre-cap pick would miss it.
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '17:00',
        });
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0]).toMatchObject({ start: '16:00', end: '18:00' }); // contains 17:00
    });

    it('TC-TS-10: nearest tie → earlier start wins (deterministic single slot)', async () => {
        // T=13:00; 10:00–12:00 (|600−780|=180, no contain) vs 16:00–18:00 (|960−780|=180).
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [rec(D, '10:00', '12:00'), rec(D, '16:00', '18:00')],
            engine_status: 'ok',
        });
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '13:00',
        });
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0]).toMatchObject({ start: '10:00', end: '12:00' });
    });

    it('TC-TS-11: targetTime WITHOUT targetDay → ignored (legacy soonest, tech-constrained)', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [
                rec('2026-07-14', '08:00', '10:00'), rec('2026-07-14', '10:00', '12:00'),
                rec('2026-07-15', '08:00', '10:00'), rec('2026-07-15', '10:00', '12:00'),
                rec('2026-07-16', '08:00', '10:00'),
            ],
            engine_status: 'ok',
        });
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetTime: '14:30',
        });
        const nj = newJobArg();
        expect(nj.technician_id).toBe('B');
        expect(nj.earliest_allowed_date).toBeUndefined();
        expect(nj.latest_allowed_date).toBeUndefined();
        // Legacy list mapping (≤MAX_SLOTS), NOT a single-nearest pick.
        expect(out.available).toBe(true);
        expect(out.slots).toHaveLength(3);
        expect(out.slots[0]).toMatchObject({ date: '2026-07-14', start: '08:00' });
    });

    it('invalid targetDay format → arg ignored (no day scoping)', async () => {
        for (const bad of ['July 16', '2026-7-16', 'tomorrow', '20260716']) {
            slotEngineService.getRecommendations.mockClear();
            const out = await recommendSlots.run(COMPANY, {}, {
                lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: bad, targetTime: '14:30',
            });
            const nj = newJobArg();
            expect(nj.earliest_allowed_date).toBeUndefined();
            expect(nj.latest_allowed_date).toBeUndefined();
            // targetTime is meaningless without a valid day → legacy list, not single.
            expect(out.slots.length).toBe(3);
        }
    });

    it('invalid targetTime format → arg ignored (day windows, not single-nearest)', async () => {
        for (const bad of ['2:30 PM', '25:00', '14:60', 'afternoon']) {
            slotEngineService.getRecommendations.mockClear();
            const out = await recommendSlots.run(COMPANY, {}, {
                lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: bad,
            });
            expect(newJobArg().earliest_allowed_date).toBe(D);
            expect(out.slots.length).toBe(3); // req-4 day list, no re-rank
        }
    });

    it('TC-TS-12: no new args → byte-identical legacy behavior (regression guard)', async () => {
        const out = await recommendSlots.run(COMPANY, {}, { lat: 42.35, lng: -71.06 });
        // Engine input has NO technician_id / date scoping keys at all.
        expect(newJobArg()).toEqual({
            lat: 42.35, lng: -71.06,
            job_type: 'Appliance Repair',
            duration_minutes: 120,
        });
        // Legacy mapping: first MAX_SLOTS windows, frozen slot shape.
        expect(out.available).toBe(true);
        expect(out.slots).toHaveLength(3);
        expect(out.slots[0]).toEqual({
            key: `${D}|08:00|10:00`,
            date: D,
            start: '08:00',
            end: '10:00',
            label: recommendSlots.formatSlotLabel(D, '08:00', '10:00'),
            techName: 'Bob',
            confidence: 'high',
        });
        expect(Object.prototype.hasOwnProperty.call(out, 'fallback')).toBe(false);
    });

    it('TC-TS-13: empty recs for the day → SLOT_FALLBACK (call continues)', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({ recommendations: [], engine_status: 'ok' });
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '14:30',
        });
        expect(out).toEqual({ available: false, slots: [], fallback: true });
    });

    it('safe-fail intact: engine throw with the new args → SLOT_FALLBACK, never throws', async () => {
        slotEngineService.getRecommendations.mockRejectedValue(new Error('engine down'));
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '14:30',
        });
        expect(out).toEqual({ available: false, slots: [], fallback: true });
    });

    it('safe-fail intact: app not connected with the new args → SLOT_FALLBACK, engine untouched', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '14:30',
        });
        expect(out).toEqual({ available: false, slots: [], fallback: true });
        expect(slotEngineService.getRecommendations).not.toHaveBeenCalled();
    });

    it('excludeSlots still drops already-offered keys before the nearest pick', async () => {
        // 14:00–16:00 contains 14:30 but was already offered → nearest of the rest = 16:00.
        const out = await recommendSlots.run(COMPANY, {}, {
            lat: 42.35, lng: -71.06, technicianId: 'B', targetDay: D, targetTime: '14:30',
            excludeSlots: [`${D}|14:00|16:00`],
        });
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0]).toMatchObject({ start: '16:00', end: '18:00' });
    });
});
