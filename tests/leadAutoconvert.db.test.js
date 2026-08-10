'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const eventBus = require('../backend/src/services/eventBus');
const eventService = require('../backend/src/services/eventService');
const fsmService = require('../backend/src/services/fsmService');
const jobsService = require('../backend/src/services/jobsService');
const leadsService = require('../backend/src/services/leadsService');
const { aiActor } = require('../backend/src/services/leadContactActivityService');

jest.setTimeout(60000);

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(
    path.join(MIGRATIONS, '245_lead_autoconvert_consistency.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_245_lead_autoconvert_consistency.sql'),
    'utf8'
);

const COMPANY_ID = randomUUID();
const COMPANY_SLUG = `lead-autoconvert-${COMPANY_ID}`;
const LEAD_SCXML = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       version="1.0"
       initial="Submitted"
       blanc:machine="lead"
       blanc:title="Lead Workflow">
  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_CONTACTED" target="Contacted" blanc:action="true" blanc:label="Contacted" />
  </state>
  <state id="Contacted" blanc:label="Contacted">
    <transition event="TO_REVIEW" target="Review" blanc:action="true" blanc:label="Review" />
  </state>
  <state id="Review" blanc:label="Review" />
  <final id="Lost" blanc:label="Lost" />
  <final id="Converted" blanc:label="Converted" />
</scxml>`;

let dbReady = false;
let eventEmitSpy;

function leadUuid(prefix = 'LA') {
    return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

async function seedLead(status = 'Contacted') {
    const uuid = leadUuid();
    const { rows } = await db.query(
        `INSERT INTO leads (
            uuid, company_id, status, converted_to_job, first_name, last_name,
            job_type, job_source
         ) VALUES ($1, $2, $3, false, 'Race', 'Fixture', 'Refrigerator Repair', 'AI Phone')
         RETURNING *`,
        [uuid, COMPANY_ID, status]
    );
    return rows[0];
}

async function expectConstraintViolation(client, sql, params) {
    await client.query('SAVEPOINT conversion_constraint_probe');
    try {
        await client.query(sql, params);
        throw new Error('Expected chk_leads_conversion_consistency to reject the write');
    } catch (error) {
        expect(error.constraint).toBe('chk_leads_conversion_consistency');
    } finally {
        await client.query('ROLLBACK TO SAVEPOINT conversion_constraint_probe');
        await client.query('RELEASE SAVEPOINT conversion_constraint_probe');
    }
}

async function blockedLeadWaiters(monitor) {
    const { rows } = await monitor.query(
        `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query ~* '(SELECT|UPDATE)[[:space:]]+.*leads'`
    );
    return rows[0].count;
}

async function waitForBlockedLeadWaiters(monitor, expected, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await blockedLeadWaiters(monitor) >= expected) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${expected} blocked Lead transaction(s)`);
}

beforeAll(async () => {
    try {
        await db.query('SELECT 1 FROM leads LIMIT 1');
        dbReady = true;
    } catch (error) {
        throw new Error(`LEAD-AUTOCONVERT-001 DB release blocker: ${error.message}`);
    }

    eventEmitSpy = jest.spyOn(eventBus, 'emit').mockResolvedValue({ id: null });
    await db.query(
        `INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3)`,
        [COMPANY_ID, 'Lead autoconvert fixture', COMPANY_SLUG]
    );
    const machine = await db.query(
        `INSERT INTO fsm_machines (machine_key, company_id, title)
         VALUES ('lead', $1, 'Lead Workflow') RETURNING id`,
        [COMPANY_ID]
    );
    const version = await db.query(
        `INSERT INTO fsm_versions (
            machine_id, company_id, version_number, status, scxml_source,
            change_note, created_by, published_by, published_at
         ) VALUES ($1, $2, 1, 'published', $3, 'lead autoconvert fixture',
                   'system', 'system', NOW())
         RETURNING id`,
        [machine.rows[0].id, COMPANY_ID, LEAD_SCXML]
    );
    await db.query(
        `UPDATE fsm_machines SET active_version_id = $1 WHERE id = $2`,
        [version.rows[0].id, machine.rows[0].id]
    );
    fsmService.invalidateCache(COMPANY_ID, 'lead');
});

afterEach(async () => {
    if (!dbReady) return;
    await db.query('DELETE FROM audit_log WHERE company_id = $1', [COMPANY_ID]);
    await db.query('DELETE FROM domain_events WHERE company_id = $1', [COMPANY_ID]);
    await db.query('DELETE FROM jobs WHERE company_id = $1', [COMPANY_ID]);
    await db.query('DELETE FROM leads WHERE company_id = $1', [COMPANY_ID]);
});

afterAll(async () => {
    if (dbReady) {
        fsmService.invalidateCache(COMPANY_ID, 'lead');
        try {
            await db.query(
                `UPDATE fsm_machines SET active_version_id = NULL WHERE company_id = $1`,
                [COMPANY_ID]
            );
            await db.query('DELETE FROM fsm_versions WHERE company_id = $1', [COMPANY_ID]);
            await db.query('DELETE FROM fsm_machines WHERE company_id = $1', [COMPANY_ID]);
            await db.query('DELETE FROM companies WHERE id = $1', [COMPANY_ID]);
        } finally {
            eventEmitSpy?.mockRestore();
        }
    }
    try { require('../backend/src/services/realtimeService').stopKeepAlive(); } catch (_) { /* ignore */ }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

const databaseTest = test;

describe('LEAD-AUTOCONVERT-001 · canonical conversion', () => {
    test('migration 245 contains the consistency guard and a rollback', () => {
        expect(FORWARD).toMatch(/chk_leads_conversion_consistency/);
        expect(FORWARD).toMatch(/j\.company_id = l\.company_id/);
        expect(FORWARD).toMatch(/ORDER BY l\.id, j\.id ASC/);
        expect(ROLLBACK).toMatch(/DROP CONSTRAINT IF EXISTS chk_leads_conversion_consistency/);
    });

    databaseTest('LEAD-AUTOCONVERT-NEW: a new Job converts both fields and records both system History actions', async () => {
        const lead = await seedLead();

        const result = await leadsService.convertLead(lead.uuid, {}, COMPANY_ID);

        const stored = await db.query(
            `SELECT status, converted_to_job FROM leads WHERE id = $1 AND company_id = $2`,
            [lead.id, COMPANY_ID]
        );
        expect(stored.rows[0]).toEqual({ status: 'Converted', converted_to_job: true });
        const jobs = await db.query(
            `SELECT id, lead_id FROM jobs WHERE company_id = $1 AND lead_id = $2`,
            [COMPANY_ID, lead.id]
        );
        expect(jobs.rows).toHaveLength(1);
        expect(String(jobs.rows[0].id)).toBe(String(result.job_id));

        const audits = await db.query(
            `SELECT action, details
             FROM audit_log
             WHERE company_id = $1 AND target_type = 'lead' AND target_id = $2
             ORDER BY action`,
            [COMPANY_ID, String(lead.id)]
        );
        expect(audits.rows.map(row => row.action)).toEqual([
            'lead.converted',
            'lead.status_changed',
        ]);
        expect(audits.rows.every(row => row.details.actor_type === 'system')).toBe(true);

        const originalQuery = db.query;
        db.query = (sql, params) => (
            /FROM activity_log_config/.test(String(sql))
                ? Promise.resolve({ rows: [{ cutover_at: new Date('2000-01-01T00:00:00Z') }] })
                : originalQuery(sql, params)
        );
        eventService.resetActivityLogCutoverCache();
        try {
            const history = await eventService.getEntityHistory(COMPANY_ID, 'lead', lead.id);
            expect(history.map(item => item.event_type)).toEqual(expect.arrayContaining([
                'lead.converted',
                'lead.status_changed',
            ]));
        } finally {
            db.query = originalQuery;
            eventService.resetActivityLogCutoverCache();
        }
    });

    databaseTest('LEAD-AUTOCONVERT-REUSE: the oldest existing linked Job is reused and the Lead converts', async () => {
        const lead = await seedLead();
        const first = await db.query(
            `INSERT INTO jobs (lead_id, company_id, blanc_status, service_name)
             VALUES ($1, $2, 'Submitted', 'Existing held job') RETURNING id`,
            [lead.id, COMPANY_ID]
        );
        await db.query(
            `INSERT INTO jobs (lead_id, company_id, blanc_status, service_name)
             VALUES ($1, $2, 'Submitted', 'Newer duplicate')`,
            [lead.id, COMPANY_ID]
        );

        const result = await leadsService.convertLead(lead.uuid, {}, COMPANY_ID);
        const stored = await db.query(
            `SELECT status, converted_to_job FROM leads WHERE id = $1 AND company_id = $2`,
            [lead.id, COMPANY_ID]
        );

        expect(String(result.job_id)).toBe(String(first.rows[0].id));
        expect(stored.rows[0]).toEqual({ status: 'Converted', converted_to_job: true });
        const audits = await db.query(
            `SELECT action FROM audit_log
             WHERE company_id = $1 AND target_type = 'lead' AND target_id = $2`,
            [COMPANY_ID, String(lead.id)]
        );
        expect(audits.rows.map(row => row.action).sort()).toEqual([
            'lead.converted',
            'lead.status_changed',
        ]);
    });

    databaseTest('LEAD-AUTOCONVERT-CREATEJOB: low-level createJob with leadId converts with an AI actor', async () => {
        const lead = await seedLead();
        const job = await jobsService.createJob({
            leadId: lead.id,
            zenbookerJobId: `legacy-${randomUUID()}`,
            zbData: { service_name: 'Refrigerator Repair' },
            companyId: COMPANY_ID,
            activityActor: aiActor('AI Phone', 'agent'),
        });

        expect(String(job.lead_id)).toBe(String(lead.id));
        const stored = await db.query(
            `SELECT status, converted_to_job FROM leads WHERE id = $1 AND company_id = $2`,
            [lead.id, COMPANY_ID]
        );
        expect(stored.rows[0]).toEqual({ status: 'Converted', converted_to_job: true });
        const audits = await db.query(
            `SELECT action, details->>'actor_type' AS actor_type
             FROM audit_log
             WHERE company_id = $1 AND target_type = 'lead' AND target_id = $2
             ORDER BY action`,
            [COMPANY_ID, String(lead.id)]
        );
        expect(audits.rows).toEqual([
            { action: 'lead.converted', actor_type: 'ai' },
            { action: 'lead.status_changed', actor_type: 'ai' },
        ]);
    });

    databaseTest('LEAD-AUTOCONVERT-LOST: terminal Lost is preserved and no Job or conversion audit is created', async () => {
        const lead = await seedLead('Lost');
        await db.query(
            `UPDATE leads SET lead_lost = true WHERE id = $1 AND company_id = $2`,
            [lead.id, COMPANY_ID]
        );

        await expect(
            leadsService.convertLead(lead.uuid, {}, COMPANY_ID)
        ).rejects.toMatchObject({ code: 'LEAD_LOST', httpStatus: 409 });

        const stored = await db.query(
            `SELECT status, lead_lost, converted_to_job
             FROM leads WHERE id = $1 AND company_id = $2`,
            [lead.id, COMPANY_ID]
        );
        expect(stored.rows[0]).toEqual({
            status: 'Lost',
            lead_lost: true,
            converted_to_job: false,
        });
        expect((await db.query(
            `SELECT id FROM jobs WHERE lead_id = $1 AND company_id = $2`,
            [lead.id, COMPANY_ID]
        )).rows).toHaveLength(0);
        expect((await db.query(
            `SELECT id FROM audit_log
             WHERE company_id = $1 AND target_type = 'lead' AND target_id = $2
               AND action IN ('lead.converted', 'lead.status_changed')`,
            [COMPANY_ID, String(lead.id)]
        )).rows).toHaveLength(0);
    });

    databaseTest('LEAD-AUTOCONVERT-RACE: stale Contacted PATCH queues behind conversion and cannot clobber Converted', async () => {
        const lead = await seedLead();
        const blocker = await db.pool.connect();
        const monitor = await db.pool.connect();
        let blockerOpen = false;
        try {
            const baseline = await blockedLeadWaiters(monitor);
            await blocker.query('BEGIN');
            blockerOpen = true;
            await blocker.query(
                `SELECT id FROM leads WHERE id = $1 AND company_id = $2 FOR UPDATE`,
                [lead.id, COMPANY_ID]
            );

            const conversion = leadsService.convertLead(lead.uuid, {}, COMPANY_ID);
            await waitForBlockedLeadWaiters(monitor, baseline + 1);

            const stalePatch = leadsService.updateLead(
                lead.uuid,
                { Status: 'Contacted' },
                COMPANY_ID
            );
            await waitForBlockedLeadWaiters(monitor, baseline + 2);

            await blocker.query('COMMIT');
            blockerOpen = false;
            await expect(conversion).resolves.toMatchObject({ ClientId: String(lead.id) });
            await expect(stalePatch).rejects.toMatchObject({
                code: 'FSM_TRANSITION_DENIED',
                httpStatus: 403,
            });

            const stored = await db.query(
                `SELECT status, converted_to_job FROM leads WHERE id = $1 AND company_id = $2`,
                [lead.id, COMPANY_ID]
            );
            expect(stored.rows[0]).toEqual({ status: 'Converted', converted_to_job: true });
        } finally {
            if (blockerOpen) await blocker.query('ROLLBACK');
            blocker.release();
            monitor.release();
        }
    });
});

describe('LEAD-AUTOCONVERT-001 · migration backfill and constraint', () => {
    databaseTest('LEAD-AUTOCONVERT-BACKFILL: T-own repairs; T-foreign, T-blast, Lost, and unlinked remain byte-unchanged', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(`
                CREATE TEMP TABLE leads (
                    id BIGINT PRIMARY KEY,
                    company_id UUID NOT NULL,
                    status TEXT NOT NULL,
                    lead_lost BOOLEAN NOT NULL DEFAULT false,
                    converted_to_job BOOLEAN NOT NULL DEFAULT false,
                    zenbooker_job_id TEXT
                ) ON COMMIT DROP;
                CREATE TEMP TABLE jobs (
                    id BIGINT PRIMARY KEY,
                    company_id UUID NOT NULL,
                    lead_id BIGINT,
                    zenbooker_job_id TEXT,
                    updated_at TIMESTAMPTZ DEFAULT now()
                ) ON COMMIT DROP;
                CREATE TEMP TABLE audit_log (
                    id BIGSERIAL PRIMARY KEY,
                    actor_id UUID,
                    action TEXT NOT NULL,
                    target_type TEXT,
                    target_id TEXT,
                    company_id UUID,
                    details JSONB NOT NULL DEFAULT '{}'
                ) ON COMMIT DROP;
            `);
            await client.query(
                `INSERT INTO leads (id, company_id, status, lead_lost, converted_to_job, zenbooker_job_id)
                 VALUES
                    (1, $1, 'Contacted', false, false, NULL),
                    (2, $2, 'Contacted', false, false, 'blast-zb'),
                    (3, $2, 'Review', false, false, 'foreign-zb'),
                    (4, $1, 'Lost', true, false, NULL),
                    (5, $1, 'Contacted', false, false, NULL),
                    (6, $1, 'Converted', false, false, NULL),
                    (7, $1, 'Review', false, true, NULL),
                    (8, $1, 'Contacted', false, false, 'orphan-zb')`,
                [companyA, companyB]
            );
            await client.query(
                `INSERT INTO jobs (id, company_id, lead_id, zenbooker_job_id)
                 VALUES
                    (10, $1, 1, NULL),
                    (11, $1, 1, NULL),
                    (12, $1, 4, NULL),
                    (13, $1, NULL, 'orphan-zb'),
                    (14, $1, NULL, 'blast-zb'),
                    (15, $1, NULL, 'foreign-zb')`,
                [companyA]
            );

            const preservedBefore = await client.query(
                `SELECT id, row_to_json(leads.*) AS bytes
                 FROM leads WHERE id IN (2, 3, 4, 5) ORDER BY id`
            );

            await client.query(FORWARD);

            const converted = await client.query(
                `SELECT id, status, converted_to_job FROM leads WHERE id IN (1, 8) ORDER BY id`
            );
            expect(converted.rows).toEqual([
                { id: '1', status: 'Converted', converted_to_job: true },
                { id: '8', status: 'Converted', converted_to_job: true },
            ]);
            const adopted = await client.query('SELECT lead_id FROM jobs WHERE id = 13');
            expect(adopted.rows[0].lead_id).toBe('8');

            const preservedAfter = await client.query(
                `SELECT id, row_to_json(leads.*) AS bytes
                 FROM leads WHERE id IN (2, 3, 4, 5) ORDER BY id`
            );
            expect(preservedAfter.rows).toStrictEqual(preservedBefore.rows);

            const repairedDivergence = await client.query(
                `SELECT id, status, converted_to_job FROM leads WHERE id IN (6, 7) ORDER BY id`
            );
            expect(repairedDivergence.rows).toEqual([
                { id: '6', status: 'Converted', converted_to_job: true },
                { id: '7', status: 'Review', converted_to_job: false },
            ]);

            const ownAudit = await client.query(
                `SELECT target_id, action, details->'summary'->>'job_id' AS job_id
                 FROM audit_log ORDER BY target_id, action`
            );
            expect(ownAudit.rows).toEqual([
                { target_id: '1', action: 'lead.converted', job_id: '10' },
                { target_id: '1', action: 'lead.status_changed', job_id: '10' },
                { target_id: '8', action: 'lead.converted', job_id: '13' },
                { target_id: '8', action: 'lead.status_changed', job_id: '13' },
            ]);

            await expectConstraintViolation(
                client,
                `UPDATE leads SET status = 'Converted' WHERE id = $1 AND company_id = $2`,
                [5, companyA]
            );
            await expectConstraintViolation(
                client,
                `UPDATE leads SET converted_to_job = true WHERE id = $1 AND company_id = $2`,
                [5, companyA]
            );
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});
