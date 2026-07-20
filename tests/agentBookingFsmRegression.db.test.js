'use strict';

/**
 * AGENT-BOOKING-FAIL-001 — real-PostgreSQL regression for the outbound lead
 * caller's confirmLeadBooking hold. The incident slot is Monday 2026-07-20,
 * 10:00–12:00 America/New_York.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const fsmService = require('../backend/src/services/fsmService');
const skill = require('../backend/src/services/agentSkills/skills/confirmLeadBooking');

jest.setTimeout(30000);

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(
    path.join(MIGRATIONS, '188_agent_booking_review_transition.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_188_agent_booking_review_transition.sql'),
    'utf8'
);

const SCXML_WITHOUT_REVIEW_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       version="1.0"
       initial="Submitted"
       blanc:machine="lead"
       blanc:title="Lead Workflow">
  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_CONTACTED" target="Contacted" blanc:action="true" blanc:label="Contacted" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" />
  </state>
  <state id="Contacted" blanc:label="Contacted">
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" />
  </state>
  <state id="Review" blanc:label="Review">
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Reviewed" />
  </state>
  <final id="Lost" blanc:label="Lost" />
  <final id="Converted" blanc:label="Converted" />
</scxml>`;

let dbReady = false;

beforeAll(async () => {
    try {
        await db.query('SELECT 1 FROM fsm_machines LIMIT 1');
        dbReady = true;
    } catch (error) {
        console.warn('[agentBookingFsmRegression.db] SKIPPED-NEEDS-DB —', error.message);
    }
});

afterAll(async () => {
    // A successful updateLead lazily loads the SSE singleton, whose production
    // keepalive interval is intentionally long-lived. This focused process owns
    // that import, so stop it explicitly instead of leaking a Jest process.
    try { require('../backend/src/services/realtimeService').stopKeepAlive(); } catch (_) { /* ignore */ }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

async function seedIncident(client, companyId, leadUuid) {
    await client.query(
        `INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3)`,
        [companyId, 'Agent booking regression fixture', `agent-booking-${companyId}`]
    );
    const machine = await client.query(
        `INSERT INTO fsm_machines (machine_key, company_id, title)
         VALUES ('lead', $1, 'Lead Workflow') RETURNING id`,
        [companyId]
    );
    const version = await client.query(
        `INSERT INTO fsm_versions
            (machine_id, company_id, version_number, status, scxml_source,
             change_note, created_by, published_by, published_at)
         VALUES ($1, $2, 1, 'published', $3, 'incident fixture',
                 'system', 'system', NOW()) RETURNING id`,
        [machine.rows[0].id, companyId, SCXML_WITHOUT_REVIEW_ENTRY]
    );
    await client.query(
        `UPDATE fsm_machines SET active_version_id = $1 WHERE id = $2`,
        [version.rows[0].id, machine.rows[0].id]
    );
    await client.query(
        `INSERT INTO leads
            (uuid, company_id, status, first_name, last_name, phone, address, city,
             state, postal_code, latitude, longitude, job_type)
         VALUES ($1, $2, 'Submitted', 'Test', 'Customer', '+16175550104', '58 Example Street',
                 'Everett', 'MA', '02149', 42.4084, -71.0537,
                 'Refrigerator Repair')`,
        [leadUuid, companyId]
    );
}

describe('AGENT-BOOKING-FAIL-001 · DB-driven Review transition', () => {
    test('migration is hidden, tenant-scoped, replay-safe, and has a versioned rollback', () => {
        expect(FORWARD).toMatch(/AI_BOOKING_TO_REVIEW/);
        expect(FORWARD).not.toMatch(/AI_BOOKING_TO_REVIEW[^\n]*blanc:action="true"/);
        expect(FORWARD).toMatch(/m\.company_id/);
        expect(FORWARD).toMatch(/company_id = rec\.company_id/);
        expect(FORWARD).toMatch(/new_scxml = rec\.scxml_source/);
        expect(ROLLBACK).toMatch(/AI_BOOKING_TO_REVIEW/);
        expect(ROLLBACK).toMatch(/Rollback AGENT-BOOKING-FAIL-001/);
    });

    test('incident lead + Monday chosen slot is refused before migration and books after it', async () => {
        if (!dbReady) return console.warn('AGENT-BOOKING-FAIL-001 SKIPPED-NEEDS-DB');

        const client = await db.pool.connect();
        const originalQuery = db.query;
        const companyId = randomUUID();
        const foreignCompanyId = randomUUID();
        const leadUuid = `AB${process.pid}${Date.now()}`.slice(-20);
        const foreignLeadUuid = `FB${process.pid}${Date.now()}`.slice(-20);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await client.query('BEGIN');
            db.query = (text, params) => client.query(text, params);
            await seedIncident(client, companyId, leadUuid);
            await seedIncident(client, foreignCompanyId, foreignLeadUuid);

            const input = {
                companyId,
                leadUuid,
                slotKey: '2026-07-20|10:00|12:00',
                chosenSlot: { date: '2026-07-20', start: '10:00', end: '12:00' },
                zip: '02149',
                lat: 42.4084,
                lng: -71.0537,
            };

            // T-foreign + T-blast: the same natural phone exists in both tenants;
            // an A-scoped call naming B's lead is indistinguishable from missing
            // and the B row remains byte-unchanged.
            const foreignBefore = await client.query(
                `SELECT status, lead_date_time, lead_end_date_time, phone
                 FROM leads WHERE company_id = $1 AND uuid = $2`,
                [foreignCompanyId, foreignLeadUuid]
            );
            const foreign = await skill.run('transport-company', {}, {
                ...input,
                leadUuid: foreignLeadUuid,
            });
            expect(foreign.speak).toBe(
                "I couldn't find that request on file — let me have a teammate follow up with you."
            );
            const foreignAfter = await client.query(
                `SELECT status, lead_date_time, lead_end_date_time, phone
                 FROM leads WHERE company_id = $1 AND uuid = $2`,
                [foreignCompanyId, foreignLeadUuid]
            );
            expect(foreignAfter.rows[0]).toStrictEqual(foreignBefore.rows[0]);

            // This is the production regression: the Review state exists, but
            // Submitted has no inbound edge to it, so the atomic hold is refused.
            const before = await skill.run('transport-company', {}, input);
            expect(before).toMatchObject({
                ok: false,
                speak: 'I had trouble locking that time in — let me have a teammate confirm it with you.',
            });
            const untouched = await client.query(
                `SELECT status, lead_date_time, lead_end_date_time
                 FROM leads WHERE company_id = $1 AND uuid = $2`,
                [companyId, leadUuid]
            );
            expect(untouched.rows[0]).toMatchObject({
                status: 'Submitted',
                lead_date_time: null,
                lead_end_date_time: null,
            });

            await client.query(FORWARD);
            fsmService.invalidateCache(companyId, 'lead');
            expect(await fsmService.resolveTransition(
                companyId, 'lead', 'Submitted', 'Review'
            )).toMatchObject({ valid: true, targetState: 'Review' });

            const migrated = await client.query(
                `SELECT m.active_version_id, v.version_number, v.scxml_source
                 FROM fsm_machines m
                 JOIN fsm_versions v ON v.id = m.active_version_id
                 WHERE m.company_id = $1 AND m.machine_key = 'lead'`,
                [companyId]
            );
            expect(migrated.rows[0].version_number).toBe(2);
            const graph = fsmService.parseSCXML(migrated.rows[0].scxml_source);
            expect(graph.states.get('Submitted').transitions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    event: 'AI_BOOKING_TO_REVIEW', target: 'Review', action: false,
                }),
            ]));
            expect(graph.states.get('Contacted').transitions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    event: 'AI_BOOKING_TO_REVIEW', target: 'Review', action: false,
                }),
            ]));
            expect(graph.states.get('Review').transitions)
                .not.toEqual(expect.arrayContaining([
                    expect.objectContaining({ event: 'AI_BOOKING_TO_REVIEW' }),
                ]));

            // Replay does not create another published version.
            await client.query(FORWARD);
            const replayed = await client.query(
                `SELECT active_version_id FROM fsm_machines
                 WHERE company_id = $1 AND machine_key = 'lead'`,
                [companyId]
            );
            expect(replayed.rows[0].active_version_id)
                .toBe(migrated.rows[0].active_version_id);

            const out = await skill.run('transport-company', {}, input);

            expect(out.success).toBe(true);
            const stored = await client.query(
                `SELECT status, lead_date_time, lead_end_date_time
                 FROM leads WHERE company_id = $1 AND uuid = $2`,
                [companyId, leadUuid]
            );
            expect(stored.rows[0].status).toBe('Review');
            expect(stored.rows[0].lead_date_time.toISOString()).toBe('2026-07-20T14:00:00.000Z');
            expect(stored.rows[0].lead_end_date_time.toISOString()).toBe('2026-07-20T16:00:00.000Z');
            expect((await client.query(
                `SELECT status, lead_date_time, lead_end_date_time, phone
                 FROM leads WHERE company_id = $1 AND uuid = $2`,
                [foreignCompanyId, foreignLeadUuid]
            )).rows[0]).toStrictEqual(foreignBefore.rows[0]);

            await client.query(ROLLBACK);
            fsmService.invalidateCache(companyId, 'lead');
            expect(await fsmService.resolveTransition(
                companyId, 'lead', 'Submitted', 'Review'
            )).toMatchObject({ valid: false });
        } finally {
            db.query = originalQuery;
            fsmService.invalidateCache(companyId, 'lead');
            fsmService.invalidateCache(foreignCompanyId, 'lead');
            try {
                await client.query('ROLLBACK');
            } finally {
                client.release();
                errorSpy.mockRestore();
            }
        }
    });
});
