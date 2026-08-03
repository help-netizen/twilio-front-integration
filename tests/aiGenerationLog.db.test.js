'use strict';

// AI-GEN-LOG-001 — real-PostgreSQL controls for the AI generation log:
// append-only insert, fire-safe record(), Markdown render, tenant scope.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const logService = require('../backend/src/services/aiGenerationLogService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const migrationSql = fs.readFileSync(path.join(MIGRATIONS, '230_ai_generation_log.sql'), 'utf8');
const migration231Sql = fs.readFileSync(path.join(MIGRATIONS, '231_ai_generation_log_final.sql'), 'utf8');

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `AIGENLOG-${Date.now()}`;

beforeAll(async () => {
    await db.query(migrationSql); // idempotent
    await db.query(migration231Sql); // idempotent
    for (const [company, name] of [[COMPANY_A, 'A'], [COMPANY_B, 'B']]) {
        await db.query(
            `INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            [company, `${TAG}-${name}`, `${TAG}-${name}`.toLowerCase()]
        );
    }
});

afterAll(async () => {
    await db.query('DELETE FROM ai_generation_log WHERE company_id IN ($1, $2)', [COMPANY_A, COMPANY_B]);
    await db.query('DELETE FROM companies WHERE id IN ($1, $2)', [COMPANY_A, COMPANY_B]);
    await db.pool?.end?.();
});

test('record() persists a generation with lines, order list and meta', async () => {
    await logService.record({
        companyId: COMPANY_A,
        crmUserId: null,
        jobId: 775546,
        reportText: `${TAG} Range hood: motor squeals, cleaned + replaced capacitor`,
        result: {
            summary: 'Range hood repair — capacitor replaced',
            line_items: [
                { source: 'item', item_id: 42, title: 'Drain pump replacement (dryer)', path: 'Appliances / Dryer', qty: 1, price: 180 },
                { source: 'new', title: 'Capacitor CBB61', path: null, qty: 1, price: 35 },
            ],
            order_list: [{ part_number: 'CBB61-2UF', part_name: 'Fan capacitor', quantity: 1 }],
        },
        model: 'gemini-2.5-flash',
        durationMs: 8421,
    });

    const { rows } = await db.query(
        'SELECT * FROM ai_generation_log WHERE company_id = $1', [COMPANY_A]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe('775546');
    expect(rows[0].line_items).toHaveLength(2);
    expect(rows[0].order_list).toHaveLength(1);
    expect(rows[0].model).toBe('gemini-2.5-flash');
    expect(rows[0].duration_ms).toBe(8421);
});

test('record() is fire-safe: missing company writes nothing and does not throw', async () => {
    await expect(logService.record({
        companyId: null,
        reportText: 'no tenant',
        result: { summary: 's', line_items: [], order_list: [] },
    })).resolves.toBeNull();
});

test('record() returns the generation id; linkFinal attaches the saved doc once, tenant-scoped', async () => {
    const { rows } = await db.query(
        'SELECT id FROM ai_generation_log WHERE company_id = $1', [COMPANY_A]
    );
    const genId = rows[0].id;
    expect(Number(genId)).toBeGreaterThan(0);

    // T-blast: a foreign tenant cannot finalize this generation.
    await logService.linkFinal({
        companyId: COMPANY_B,
        generationId: genId,
        estimateId: 999,
        finalLineItems: [{ name: 'FOREIGN', quantity: '1', unit_price: '1' }],
    });
    let row = (await db.query('SELECT finalized_at FROM ai_generation_log WHERE id = $1', [genId])).rows[0];
    expect(row.finalized_at).toBeNull();

    // Own tenant: first save wins.
    await logService.linkFinal({
        companyId: COMPANY_A,
        generationId: genId,
        estimateId: 501,
        finalLineItems: [{ name: 'Range hood repair', quantity: '1', unit_price: '220' }],
    });
    row = (await db.query('SELECT estimate_id, final_line_items, finalized_at FROM ai_generation_log WHERE id = $1', [genId])).rows[0];
    expect(row.estimate_id).toBe('501');
    expect(row.final_line_items).toHaveLength(1);
    expect(row.finalized_at).not.toBeNull();

    // Second save is a no-op (first save wins).
    await logService.linkFinal({
        companyId: COMPANY_A,
        generationId: genId,
        invoiceId: 777,
        finalLineItems: [{ name: 'LATER EDIT', quantity: '2', unit_price: '5' }],
    });
    row = (await db.query('SELECT estimate_id, invoice_id, final_line_items FROM ai_generation_log WHERE id = $1', [genId])).rows[0];
    expect(row.estimate_id).toBe('501');
    expect(row.invoice_id).toBeNull();
    expect(row.final_line_items[0].name).toBe('Range hood repair');
});

test('renderMarkdown shows the entry and is tenant-scoped (T-blast)', async () => {
    const mdA = await logService.renderMarkdown(COMPANY_A);
    expect(mdA).toContain('# AI generation log');
    expect(mdA).toContain('Entries: 1');
    expect(mdA).toContain(`${TAG} Range hood`);
    expect(mdA).toContain('item #42');
    expect(mdA).toContain('Drain pump replacement (dryer)');
    expect(mdA).toContain('Appliances / Dryer');
    expect(mdA).toContain('CBB61-2UF');
    expect(mdA).toContain('job #775546');
    expect(mdA).toContain('8.4s');
    // AI-GEN-LOG-002: the saved outcome appears next to the AI proposal.
    expect(mdA).toContain('Saved as estimate #501');
    expect(mdA).toContain('Range hood repair');

    // T-blast: company B sees NOTHING of A's log.
    const mdB = await logService.renderMarkdown(COMPANY_B);
    expect(mdB).toContain('Entries: 0');
    expect(mdB).not.toContain(TAG);
    expect(mdB).not.toContain('item #42');
});
