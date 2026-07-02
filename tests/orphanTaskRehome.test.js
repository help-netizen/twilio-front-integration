/**
 * ORPHAN-TASK-REHOME-001
 *
 * The Pulse sidebar page (getUnifiedTimelinePage) drops a contactless "shadow"
 * orphan timeline whose phone is already covered by a contact-linked timeline in
 * the same company (the "one row per person" dedup). An OPEN task is keyed on the
 * orphan's timeline id (tasks.thread_id), so a task stranded on that orphan would
 * silently vanish from Action Required.
 *
 * The dedup WHERE predicate is CORRECT and must not change (it guarantees exactly
 * one row per person before the LIMIT). The fix is on the data/adoption path:
 * every place that resolves a contact to its canonical timeline while a shadow
 * orphan may exist re-homes the orphan's OPEN tasks onto the surviving timeline
 * FIRST (timelinesQueries.reassignShadowOrphanOpenTasks), and mig 144 backfills
 * anything stranded before the fix. The merge path additionally re-points open
 * tasks before its CASCADE delete, so they are not destroyed outright.
 *
 * House style (cf. listPaginationByContact.test.js): mock the db connection and
 * assert on the emitted SQL + params + call ordering.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const { mergeOrphanTimelines } = require('../backend/src/services/timelineMergeService');

const CO = '00000000-0000-0000-0000-00000000000a';
const P = (v) => Promise.resolve(v);

beforeEach(() => db.query.mockReset());

// A small router so multi-query functions get plausible results per step; every
// `UPDATE tasks …` call (the re-home) is captured for assertions.
function install(state) {
    state.taskUpdates = [];
    db.query.mockImplementation((sql, params) => {
        if (/FROM contacts\s+WHERE/i.test(sql) && /SELECT (\*|id, phone_e164)/i.test(sql)) {
            return P({ rows: state.contact ? [state.contact] : [] });
        }
        if (/SELECT \* FROM timelines WHERE contact_id = \$1 AND company_id = \$2 LIMIT 1/i.test(sql)) {
            return P({ rows: state.existing ? [state.existing] : [] });
        }
        if (/SELECT id FROM timelines[\s\S]*contact_id IS NULL/i.test(sql)) {
            return P({ rows: state.orphan ? [{ id: state.orphan.id }] : [] });
        }
        if (/UPDATE timelines SET contact_id/i.test(sql)) {
            return P({ rows: [{ id: state.orphan && state.orphan.id, contact_id: state.contactId }], rowCount: 1 });
        }
        if (/UPDATE calls SET contact_id/i.test(sql)) return P({ rowCount: 0 });
        if (/UPDATE tasks/i.test(sql)) {
            state.taskUpdates.push({ sql, params, order: db.query.mock.calls.length });
            return P({ rowCount: state.rehomeCount != null ? state.rehomeCount : 0 });
        }
        if (/SELECT \* FROM timelines WHERE id = \$1/i.test(sql)) {
            return P({ rows: [{ id: state.orphan && state.orphan.id, contact_id: state.contactId }] });
        }
        if (/INSERT INTO timelines/i.test(sql)) return P({ rows: [{ id: state.insertId || 999 }] });
        if (/DELETE FROM timelines/i.test(sql)) { state.deleteOrder = db.query.mock.calls.length; return P({ rowCount: 1 }); }
        if (/UPDATE calls SET timeline_id/i.test(sql)) return P({ rowCount: 3 });
        return P({ rows: [] });
    });
}

// ─── reassignShadowOrphanOpenTasks — the helper's SQL contract ────────────────

describe('reassignShadowOrphanOpenTasks — SQL contract', () => {
    it('emits an UPDATE tasks scoped to OPEN tasks on a contactless shadow orphan', async () => {
        db.query.mockResolvedValue({ rowCount: 2 });
        const n = await timelinesQueries.reassignShadowOrphanOpenTasks(20, 5000, CO);
        expect(n).toBe(2);
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/UPDATE tasks/i);
        expect(sql).toContain('thread_id = $1');
        expect(sql).toContain("t.status = 'open'");   // only OPEN tasks move
        expect(sql).toContain('o.contact_id IS NULL'); // only FROM a contactless orphan
        expect(sql).toContain('o.id <> $1');            // never treat the survivor as its own shadow
        // Matches the contact's primary OR secondary digits (mirrors the dedup).
        expect(sql).toMatch(/c\.phone_e164/);
        expect(sql).toMatch(/c\.secondary_phone/);
        expect(sql).toContain('NULLIF(regexp_replace(o.phone_e164'); // '' guard
        expect(params).toEqual([20, 5000, CO]);
    });

    it('is a no-op (no query) when the surviving timeline id or contact id is missing', async () => {
        expect(await timelinesQueries.reassignShadowOrphanOpenTasks(null, 5000, CO)).toBe(0);
        expect(await timelinesQueries.reassignShadowOrphanOpenTasks(20, null, CO)).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ─── findOrCreateTimeline — re-homes on every contact-resolution branch ───────

describe('findOrCreateTimeline re-homes stranded open tasks', () => {
    it('early-return (contact already has a canonical timeline) re-homes onto it', async () => {
        const state = {
            contact: { id: 5000, company_id: CO, phone_e164: '+15085551111', secondary_phone: '+15085552222' },
            existing: { id: 700, contact_id: 5000 },
            contactId: 5000,
        };
        install(state);
        const tl = await timelinesQueries.findOrCreateTimeline('+15085552222', CO);
        expect(tl.id).toBe(700);
        expect(state.taskUpdates).toHaveLength(1);
        // survivor = existing canonical timeline; contact + company threaded through.
        expect(state.taskUpdates[0].params).toEqual([700, 5000, CO]);
    });

    it('adoption branch re-homes tasks from a SECOND shadow orphan onto the adopted row', async () => {
        const state = {
            contact: { id: 5001, company_id: CO, phone_e164: '+15085553333', secondary_phone: '+15085554444' },
            existing: null,
            orphan: { id: 801 },
            contactId: 5001,
        };
        install(state);
        const tl = await timelinesQueries.findOrCreateTimeline('+15085553333', CO);
        expect(tl.contact_id).toBe(5001);
        expect(state.taskUpdates).toHaveLength(1);
        expect(state.taskUpdates[0].params).toEqual([801, 5001, CO]); // survivor = adopted orphan id
    });

    it('fresh-insert branch sweeps a secondary-number orphan onto the new timeline', async () => {
        const state = {
            contact: { id: 5002, company_id: CO, phone_e164: '+15085555555', secondary_phone: '+15085556666' },
            existing: null,
            orphan: null,          // no orphan on the incoming number
            insertId: 950,
            contactId: 5002,
        };
        install(state);
        const tl = await timelinesQueries.findOrCreateTimeline('+15085555555', CO);
        expect(tl.id).toBe(950);
        expect(state.taskUpdates).toHaveLength(1);
        expect(state.taskUpdates[0].params).toEqual([950, 5002, CO]);
    });
});

// ─── findOrCreateTimelineByContact — same three branches ──────────────────────

describe('findOrCreateTimelineByContact re-homes stranded open tasks', () => {
    it('early-return branch re-homes onto the existing canonical timeline', async () => {
        const state = {
            contact: { id: 6000, phone_e164: '+15085557777', secondary_phone: null },
            existing: { id: 710, contact_id: 6000 },
            contactId: 6000,
        };
        install(state);
        const tl = await timelinesQueries.findOrCreateTimelineByContact(6000, CO);
        expect(tl.id).toBe(710);
        expect(state.taskUpdates).toHaveLength(1);
        expect(state.taskUpdates[0].params).toEqual([710, 6000, CO]);
    });

    it('fresh-insert branch re-homes onto the created timeline', async () => {
        const state = {
            contact: { id: 6002, phone_e164: '+15085559999', secondary_phone: null },
            existing: null,
            orphan: null,
            insertId: 960,
            contactId: 6002,
        };
        install(state);
        const tl = await timelinesQueries.findOrCreateTimelineByContact(6002, CO);
        expect(tl.id).toBe(960);
        expect(state.taskUpdates).toHaveLength(1);
        expect(state.taskUpdates[0].params).toEqual([960, 6002, CO]);
    });
});

// ─── merge service — re-point OPEN tasks BEFORE the CASCADE delete ────────────

describe('timelineMergeService re-points open tasks before deleting the orphan', () => {
    it('moves open tasks onto the main timeline BEFORE DELETE FROM timelines (no CASCADE loss)', async () => {
        const state = {
            contact: { id: 7000 },
            existing: { id: 720 },              // contact already has a main timeline
            contactId: 7000,
        };
        // Custom router: orphan list + existing main timeline, capture ordering.
        state.taskUpdates = [];
        db.query.mockImplementation((sql, params) => {
            if (/SELECT id, phone_e164\s+FROM timelines\s+WHERE contact_id IS NULL/i.test(sql)) {
                return P({ rows: [{ id: 801, phone_e164: '+15085550801' }] });
            }
            if (/SELECT id FROM timelines WHERE contact_id = \$1 LIMIT 1/i.test(sql)) {
                return P({ rows: [{ id: 720 }] });
            }
            if (/UPDATE calls SET timeline_id/i.test(sql)) return P({ rowCount: 4 });
            if (/UPDATE tasks/i.test(sql)) {
                state.taskUpdates.push({ sql, params, order: db.query.mock.calls.length });
                return P({ rowCount: 1 });
            }
            if (/DELETE FROM timelines/i.test(sql)) { state.deleteOrder = db.query.mock.calls.length; return P({ rowCount: 1 }); }
            if (/UPDATE calls SET contact_id/i.test(sql)) return P({ rowCount: 0 });
            return P({ rows: [] });
        });

        await mergeOrphanTimelines(7000, ['+15085550801']);

        expect(state.taskUpdates).toHaveLength(1);
        const upd = state.taskUpdates[0];
        expect(upd.sql).toMatch(/UPDATE tasks SET thread_id = \$1/i);
        expect(upd.sql).toContain("status = 'open'");
        expect(upd.params).toEqual([720, 801]);          // moved orphan(801) → main(720)
        // Ordering: the task re-point ran BEFORE the orphan was deleted.
        expect(upd.order).toBeLessThan(state.deleteOrder);
    });
});
