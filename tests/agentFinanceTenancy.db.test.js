'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const estimatesService = require('../backend/src/services/estimatesService');

jest.setTimeout(30000);

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const SHARED_PHONE = `+1555${String(Date.now()).slice(-7)}`;
const TAG = `agent-finance-${Date.now()}-${process.pid}`;
let contactA;
let contactB;
let estimateA;
let estimateB;

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try {
                await client.connect();
                await client.query('SELECT 1');
                await client.end();
                process.exit(0);
            } catch (error) {
                process.stderr.write(String(error.message || error));
                try { await client.end(); } catch {}
                process.exit(2);
            }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('AGENT-FINANCE tenancy release blocker: PostgreSQL must be available', () => {
        throw new Error(`AGENT-FINANCE tenancy tests are pending: ${DATABASE.reason}`);
    });
}

beforeAll(async () => {
    if (!DATABASE.ready) return;
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            COMPANY_A, `${TAG} A`, `${TAG}-a`,
            COMPANY_B, `${TAG} B`, `${TAG}-b`,
        ],
    );
    const contacts = await db.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164)
         VALUES ($1, 'Finance A', $3), ($2, 'Finance B', $3)
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B, SHARED_PHONE],
    );
    contactA = contacts.rows.find((row) => row.company_id === COMPANY_A).id;
    contactB = contacts.rows.find((row) => row.company_id === COMPANY_B).id;
    const estimates = await db.query(
        `INSERT INTO estimates
            (company_id, contact_id, estimate_number, status, subtotal, total)
         VALUES ($1, $2, 'FIN-A', 'sent', 111.11, 111.11),
                ($3, $4, 'FIN-B', 'sent', 999.99, 999.99)
         RETURNING id, company_id`,
        [COMPANY_A, contactA, COMPANY_B, contactB],
    );
    estimateA = estimates.rows.find((row) => row.company_id === COMPANY_A).id;
    estimateB = estimates.rows.find((row) => row.company_id === COMPANY_B).id;
});

afterAll(async () => {
    if (DATABASE.ready) {
        await db.query(
            `DELETE FROM estimate_items
             WHERE estimate_id IN (
                 SELECT id FROM estimates WHERE company_id = ANY($1::uuid[])
             )`,
            [[COMPANY_A, COMPANY_B]],
        );
        await db.query('DELETE FROM estimates WHERE company_id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
        await db.query('DELETE FROM contacts WHERE company_id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
        await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
    }
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});

describe('real PostgreSQL finance parent tenancy', () => {
    databaseTest('T-own: own estimate is returned with its items', async () => {
        const own = await estimatesService.getEstimate(COMPANY_A, estimateA);
        expect(own).toMatchObject({ estimate_number: 'FIN-A', contact_id: contactA });
    });

    databaseTest('T-foreign + SAB-FIN-COMPANY-SCOPE: foreign estimate id is not found', async () => {
        await expect(estimatesService.getEstimate(COMPANY_A, estimateB)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    databaseTest('T-blast: same-phone company B finance is byte-unchanged after company A reads', async () => {
        const before = await db.query('SELECT to_jsonb(e.*) AS row FROM estimates e WHERE id = $1 AND company_id = $2', [estimateB, COMPANY_B]);
        const listed = await estimatesService.listEstimates(COMPANY_A, { contactId: contactA });
        const after = await db.query('SELECT to_jsonb(e.*) AS row FROM estimates e WHERE id = $1 AND company_id = $2', [estimateB, COMPANY_B]);

        expect(listed.rows.map((row) => row.estimate_number)).toEqual(['FIN-A']);
        expect(JSON.stringify(listed)).not.toContain('999.99');
        expect(after.rows[0].row).toStrictEqual(before.rows[0].row);
    });
});
