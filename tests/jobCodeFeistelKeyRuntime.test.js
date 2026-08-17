'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const db = require('../backend/src/db/connection');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'backend', 'db', 'migrations');
const NUMBERING = fs.readFileSync(path.join(MIGRATIONS, '271_job_numbering.sql'), 'utf8');
const ROTATION = fs.readFileSync(
    path.join(MIGRATIONS, '273_job_public_code_key_rotation.sql'),
    'utf8',
);
const TEST_KEY = '3550090444';
const DIFFERENT_KEY = '3550090445';
const SCHEMA = `job_key_runtime_${Date.now().toString(36)}_${process.pid}`;

let client;
let rotatedSnapshot;

beforeAll(async () => {
    client = await db.getClient();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    await client.query(`SET app.job_code_feistel_key = '${TEST_KEY}'`);
    await client.query(`
        CREATE TABLE jobs (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TRIGGER trg_jobs_updated_at
            BEFORE UPDATE ON jobs
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);
    await client.query(NUMBERING);
    const old = await client.query(
        `INSERT INTO jobs (company_id, updated_at)
         VALUES ('60000000-0000-4000-8000-000000000012', '2025-01-02T03:04:05.000Z')
         RETURNING id, public_code, updated_at`,
    );
    await client.query(ROTATION);
    const rotated = await client.query(
        `SELECT id, public_code, updated_at
         FROM jobs WHERE id = $1`,
        [old.rows[0].id],
    );
    rotatedSnapshot = rotated.rows[0];
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK').catch(() => {});
        await client.query('RESET search_path').catch(() => {});
        await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        client.release();
    }
    await db.pool.end();
});

test('SAB-FIX13: process and telephony modules initialize without JOB_CODE_FEISTEL_KEY', () => {
    const environment = { ...process.env, NODE_ENV: 'production' };
    delete environment.JOB_CODE_FEISTEL_KEY;

    const output = execFileSync(
        process.execPath,
        ['-e', "require('./backend/src/services/callFlowRuntime'); process.stdout.write('started'); process.exit(0)"],
        { cwd: ROOT, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output.toString()).toBe('started');
});

test('missing key is a degraded diagnostic, not a module-load exception', () => {
    expect(db.inspectJobCodeFeistelKey({ NODE_ENV: 'production' })).toEqual({
        configured: false,
        key: null,
        code: 'JOB_CODE_FEISTEL_KEY_REQUIRED',
    });
});

test('invalid or out-of-range JOB_CODE_FEISTEL_KEY is rejected lazily', () => {
    for (const value of ['not-a-number', '0', '4294967296']) {
        expect(() => db.resolveJobCodeFeistelKey({
            NODE_ENV: 'production',
            JOB_CODE_FEISTEL_KEY: value,
        })).toThrow(expect.objectContaining({ code: 'JOB_CODE_FEISTEL_KEY_INVALID' }));
    }
});

test('configured application pools pin the key on every physical connection', () => {
    const environment = {
        ...process.env,
        NODE_ENV: 'production',
        JOB_CODE_FEISTEL_KEY: TEST_KEY,
    };
    const output = execFileSync(
        process.execPath,
        ['-e', "const db=require('./backend/src/db/connection'); process.stdout.write(db.pool.options.options); process.exit(0)"],
        { cwd: ROOT, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output.toString()).toBe(`-c app.job_code_feistel_key=${TEST_KEY}`);
});

test('migration pins only a fingerprint and preserves updated_at during rotation', async () => {
    const state = await client.query(
        `SELECT key_fingerprint, diagnostic_code
         FROM job_public_code_key_state
         WHERE singleton = true`,
    );
    expect(state.rows).toEqual([{
        key_fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
        diagnostic_code: null,
    }]);
    expect(JSON.stringify(state.rows)).not.toContain(TEST_KEY);
    expect(rotatedSnapshot.public_code).toMatch(/^[0-9A-Za-z]{5}$/);
    expect(rotatedSnapshot.updated_at.toISOString()).toBe('2025-01-02T03:04:05.000Z');
});

test('same-key migration replay is a no-op for codes and timestamps', async () => {
    const before = await client.query('SELECT id, public_code, updated_at FROM jobs ORDER BY id');
    await client.query(ROTATION);
    const after = await client.query('SELECT id, public_code, updated_at FROM jobs ORDER BY id');
    expect(after.rows).toEqual(before.rows);
});

test('different-key migration replay aborts before renaming jobs', async () => {
    const before = await client.query('SELECT id, public_code, updated_at FROM jobs ORDER BY id');
    await client.query(`SET app.job_code_feistel_key = '${DIFFERENT_KEY}'`);
    await expect(client.query(ROTATION)).rejects.toThrow(/JOB_CODE_FEISTEL_KEY_MISMATCH/);
    await client.query('ROLLBACK');
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    await client.query(`SET app.job_code_feistel_key = '${TEST_KEY}'`);
    const after = await client.query('SELECT id, public_code, updated_at FROM jobs ORDER BY id');
    expect(after.rows).toEqual(before.rows);
});

test('job creation alone fails clearly when the session key is absent', async () => {
    await client.query("SET app.job_code_feistel_key = ''");
    await expect(client.query(
        `INSERT INTO jobs (company_id)
         VALUES ('60000000-0000-4000-8000-000000000013')`,
    )).rejects.toThrow(/JOB_CODE_FEISTEL_KEY_REQUIRED: job creation disabled/);
    await client.query(`SET app.job_code_feistel_key = '${TEST_KEY}'`);
    const count = await client.query('SELECT COUNT(*)::int AS count FROM jobs');
    expect(count.rows[0].count).toBe(1);
});
