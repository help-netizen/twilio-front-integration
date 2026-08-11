'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const { parseSCXML } = require('../backend/src/services/fsmService');

jest.setTimeout(60000);

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD_FILE = '249_job_fsm_system_transitions.sql';
const ROLLBACK_FILE = 'rollback_249_job_fsm_system_transitions.sql';
const FORWARD = fs.readFileSync(path.join(MIGRATIONS, FORWARD_FILE), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, ROLLBACK_FILE), 'utf8');

const BASE_SCXML = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       initial="Submitted" blanc:machine="job">
  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true"
                blanc:button="true" blanc:op="notify_on_the_way" blanc:label="On the way"/>
    <transition event="TO_CUSTOM" target="Custom_source" blanc:action="true"/>
  </state>
  <state id="Custom_source" blanc:label="Custom source">
    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true"
                blanc:button="true" blanc:op="notify_on_the_way" blanc:label="On the way"/>
  </state>
  <state id="Plain_source" blanc:label="Plain source">
    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true"
                blanc:button="true" blanc:label="On the way"/>
  </state>
  <state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way">
    <transition event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true"/>
  </state>
  <state id="Visit_completed" blanc:label="Visit completed" blanc:statusName="Visit completed">
    <transition event="TO_JOB_DONE" target="Job_is_Done" blanc:action="true"/>
  </state>
  <final id="Job_is_Done" blanc:label="Job is Done" blanc:statusName="Job is Done" />
</scxml>`;

async function seedMachine(client, companyId, machineKey, scxml) {
    const machine = await client.query(
        `INSERT INTO fsm_machines (machine_key, company_id, title)
         VALUES ($1, $2, $3) RETURNING id`,
        [machineKey, companyId, `${machineKey} workflow`]
    );
    const version = await client.query(
        `INSERT INTO fsm_versions
            (machine_id, company_id, version_number, status, scxml_source,
             change_note, created_by, published_by, published_at)
         VALUES ($1, $2, 1, 'published', $3, 'fixture', 'system', 'system', NOW())
         RETURNING id`,
        [machine.rows[0].id, companyId, scxml]
    );
    await client.query(
        `UPDATE fsm_machines
         SET active_version_id = $1
         WHERE id = $2 AND company_id = $3`,
        [version.rows[0].id, machine.rows[0].id, companyId]
    );
    return { machineId: machine.rows[0].id, versionId: version.rows[0].id };
}

async function activeVersion(client, companyId, machineKey) {
    const { rows } = await client.query(
        `SELECT v.id, v.version_number, v.scxml_source
         FROM fsm_machines m
         JOIN fsm_versions v
           ON v.id = m.active_version_id
          AND v.company_id = m.company_id
         WHERE m.company_id = $1
           AND m.machine_key = $2
           AND v.status = 'published'`,
        [companyId, machineKey]
    );
    return rows[0];
}

afterAll(async () => {
    await db.pool.end().catch(() => {});
});

describe('migration 249 Job FSM system transitions', () => {
    test('ships one numbered pair and scopes every version mutation by company', () => {
        const files = fs.readdirSync(MIGRATIONS);
        expect(files.filter(file => /^249_/.test(file))).toEqual([FORWARD_FILE]);
        expect(files).toContain(ROLLBACK_FILE);
        expect(FORWARD).toContain('blanc:system="on_the_way"');
        expect(FORWARD).toContain('blanc:op="arrival_eta"');
        expect(FORWARD).toContain('blanc:op="notify_on_the_way"');
        expect(FORWARD).toMatch(/company_id = rec\.company_id/g);
        expect(ROLLBACK).toMatch(/company_id = rec\.company_id/g);
    });

    test('forward → replay → rollback → replay → forward is executable and idempotent', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug) VALUES
                    ($1, 'FSM system A', $3),
                    ($2, 'FSM system B', $4)`,
                [
                    companyA,
                    companyB,
                    `fsm-system-a-${companyA}`,
                    `fsm-system-b-${companyB}`,
                ]
            );
            const originalA = await seedMachine(client, companyA, 'job', BASE_SCXML);
            const originalB = await seedMachine(client, companyB, 'job', BASE_SCXML);
            const lead = await seedMachine(
                client,
                companyB,
                'lead',
                BASE_SCXML.replace('blanc:machine="job"', 'blanc:machine="lead"')
            );

            await client.query(FORWARD);
            const firstA = await activeVersion(client, companyA, 'job');
            const firstB = await activeVersion(client, companyB, 'job');
            for (const migrated of [firstA, firstB]) {
                const graph = parseSCXML(migrated.scxml_source);
                expect(graph.states.get('Submitted')).toMatchObject({ system: 'start' });
                expect(graph.states.get('Visit_completed')).toMatchObject({
                    system: 'visit_completed',
                });
                expect(graph.states.get('On_the_way')).toMatchObject({
                    system: 'on_the_way', op: 'arrival_eta',
                });
                expect(graph.states.get('Job_is_Done')).toMatchObject({ system: 'job_done' });
                expect(migrated.scxml_source).not.toContain('blanc:op="notify_on_the_way"');
                expect(migrated.scxml_source.match(/blanc:button="true"/g)).toHaveLength(3);
                expect(migrated.version_number).toBe(2);
            }

            await client.query(FORWARD);
            expect((await activeVersion(client, companyA, 'job')).id).toBe(firstA.id);
            expect((await activeVersion(client, companyB, 'job')).id).toBe(firstB.id);

            const leadAfterForward = await activeVersion(client, companyB, 'lead');
            expect(leadAfterForward.id).toBe(lead.versionId);
            expect(leadAfterForward.scxml_source).toBe(
                BASE_SCXML.replace('blanc:machine="job"', 'blanc:machine="lead"')
            );

            await client.query(ROLLBACK);
            const rolledBackA = await activeVersion(client, companyA, 'job');
            const rolledBackB = await activeVersion(client, companyB, 'job');
            expect(rolledBackA).toMatchObject({ id: originalA.versionId, version_number: 1 });
            expect(rolledBackB).toMatchObject({ id: originalB.versionId, version_number: 1 });
            expect(rolledBackA.scxml_source).toBe(BASE_SCXML);
            expect(rolledBackB.scxml_source).toBe(BASE_SCXML);

            await client.query(ROLLBACK);
            expect((await activeVersion(client, companyA, 'job')).id).toBe(originalA.versionId);
            expect((await activeVersion(client, companyB, 'job')).id).toBe(originalB.versionId);

            await client.query(FORWARD);
            const reappliedA = await activeVersion(client, companyA, 'job');
            const reappliedB = await activeVersion(client, companyB, 'job');
            expect(parseSCXML(reappliedA.scxml_source).states.get('On_the_way').op)
                .toBe('arrival_eta');
            expect(parseSCXML(reappliedB.scxml_source).states.get('On_the_way').op)
                .toBe('arrival_eta');
            expect(reappliedA.scxml_source).not.toContain('notify_on_the_way');
            expect(reappliedB.scxml_source).not.toContain('notify_on_the_way');
            expect(reappliedA.version_number).toBe(3);
            expect(reappliedB.version_number).toBe(3);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
