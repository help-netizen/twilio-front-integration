'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const { DEFAULT_INSPECTOR_INSTRUCTION } = require('../backend/src/services/inspectorDefaults');

const ROOT = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const SCHEMA = fs.readFileSync(path.join(ROOT, '191_inspector_agent.sql'), 'utf8');
const SCHEMA_ROLLBACK = fs.readFileSync(path.join(ROOT, 'rollback_191_inspector_agent.sql'), 'utf8');
const SEED = fs.readFileSync(path.join(ROOT, '192_seed_inspector_marketplace_app.sql'), 'utf8');
const SEED_ROLLBACK = fs.readFileSync(path.join(ROOT, 'rollback_192_seed_inspector_marketplace_app.sql'), 'utf8');

jest.setTimeout(30000);

describe('INSPECTOR-AGENT-001 migrations', () => {
    test('static contract contains company-first claims, exact defaults, assistant metadata, and paired rollbacks', () => {
        expect(SCHEMA).toContain('UNIQUE (company_id, company_local_date)');
        expect(SCHEMA).toContain("ARRAY['Visit completed', 'Job is Done', 'Canceled']");
        expect(SCHEMA).toContain("ARRAY['Converted', 'Lost']");
        expect(SCHEMA).toContain(DEFAULT_INSPECTOR_INSTRUCTION);
        expect(SCHEMA).toContain('uq_tasks_open_inspector_job');
        expect(SCHEMA).toContain('uq_tasks_open_inspector_lead');
        expect(SCHEMA).toContain("agent_type = 'inspector'");
        expect(SCHEMA).toContain("'failed', 'aborted'");
        for (const key of ['what_it_does', 'prerequisites', 'setup_steps', 'outcome', 'recommend_when', 'gotchas']) {
            expect(SEED).toContain(`"${key}"`);
        }
        expect(SEED).toContain("'Albusto'");
        expect(SCHEMA_ROLLBACK).toContain('DROP TABLE IF EXISTS inspector_settings');
        expect(SEED_ROLLBACK).toContain("app_key = 'inspector'");
    });

    test('SAB-INSP-DEDUP-OPEN: real PostgreSQL double-apply/reject/rollback gate', async () => {
        let client;
        try {
            client = await db.pool.connect();
            await client.query('SELECT kind, agent_type FROM tasks LIMIT 0');
        } catch (error) {
            if (client) client.release();
            console.warn(`SAB-INSP-DEDUP-OPEN SKIPPED-NEEDS-DB — ${error.message}`);
            return;
        }

        const companyId = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(SCHEMA);
            await client.query(SEED);
            await client.query(SEED);

            const app = await client.query(
                `SELECT provider_name, metadata->'assistant' AS assistant
                 FROM marketplace_apps WHERE app_key = 'inspector'`
            );
            expect(app.rows[0].provider_name).toBe('Albusto');
            expect(Object.keys(app.rows[0].assistant).sort()).toEqual([
                'gotchas', 'outcome', 'prerequisites', 'recommend_when', 'setup_steps', 'what_it_does',
            ]);

            await client.query(
                `INSERT INTO companies (id, name, slug) VALUES ($1, 'Inspector migration fixture', $2)`,
                [companyId, `insp-mig-${companyId}`]
            );
            const settings = await client.query(
                `INSERT INTO inspector_settings (company_id)
                 VALUES ($1)
                 RETURNING instruction, ignored_job_statuses, ignored_lead_statuses`,
                [companyId]
            );
            expect(settings.rows[0]).toEqual({
                instruction: DEFAULT_INSPECTOR_INSTRUCTION,
                ignored_job_statuses: ['Visit completed', 'Job is Done', 'Canceled'],
                ignored_lead_statuses: ['Converted', 'Lost'],
            });
            const job = await client.query(
                `INSERT INTO jobs (company_id, start_date, blanc_status)
                 VALUES ($1, NOW() - INTERVAL '2 days', 'Submitted') RETURNING id`,
                [companyId]
            );
            const taskParams = [companyId, job.rows[0].id];
            await client.query(
                `INSERT INTO tasks
                    (company_id, title, description, status, created_by, kind,
                     agent_type, agent_status, job_id)
                 VALUES ($1, 'one', 'one', 'open', 'agent', 'agent',
                         'inspector', 'succeeded', $2)`,
                taskParams
            );
            await client.query('SAVEPOINT duplicate_task');
            await expect(client.query(
                `INSERT INTO tasks
                    (company_id, title, description, status, created_by, kind,
                     agent_type, agent_status, job_id)
                 VALUES ($1, 'two', 'two', 'open', 'agent', 'agent',
                         'inspector', 'succeeded', $2)`,
                taskParams
            )).rejects.toMatchObject({ code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT duplicate_task');

            await client.query(SEED_ROLLBACK);
            await client.query(SEED_ROLLBACK);
            await client.query(SCHEMA_ROLLBACK);
            await client.query(SCHEMA_ROLLBACK);
            const tables = await client.query(
                `SELECT to_regclass('inspector_settings') AS settings,
                        to_regclass('inspector_daily_runs') AS runs,
                        to_regclass('inspector_reviews') AS reviews`
            );
            expect(tables.rows[0]).toEqual({ settings: null, runs: null, reviews: null });
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* ignore */ }
});
