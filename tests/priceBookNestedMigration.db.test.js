'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');

jest.setTimeout(60000);

const migration = fs.readFileSync(path.join(__dirname, '..', 'backend', 'db', 'migrations', '193_price_book_nested_categories.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_193_price_book_nested_categories.sql'), 'utf8');

async function rejectedAtSavepoint(client, name, sql, params, code) {
    await client.query(`SAVEPOINT ${name}`);
    await expect(client.query(sql, params)).rejects.toMatchObject({ code });
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
}

describe('migration 193 — nested Price Book invariants on real PostgreSQL', () => {
    test('SAB-PB migration invariants, legacy-six preservation, and guarded rollback', async () => {
        let available = true;
        try {
            await db.query('SELECT 1 FROM price_book_categories LIMIT 1');
            await db.query('SELECT 1 FROM estimate_item_presets LIMIT 1');
        } catch (error) {
            available = false;
            console.warn(`PRICEBOOK-NESTED-001 SKIPPED-NEEDS-DB — ${error.message}`);
        }
        if (!available) return;

        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug) VALUES ($1,'PB Nested A',$2),($3,'PB Nested B',$4)`,
                [companyA, `pb-nested-a-${companyA}`, companyB, `pb-nested-b-${companyB}`],
            );
            for (let index = 1; index <= 6; index++) {
                await client.query(
                    `INSERT INTO estimate_item_presets (company_id, name, default_unit_price)
                     VALUES ($1,$2,$3)`,
                    [companyA, `Legacy preset ${index}`, index * 10],
                );
            }
            const before = await client.query(
                `SELECT to_jsonb(p) - 'item_type' AS row FROM estimate_item_presets p WHERE company_id=$1 ORDER BY id`,
                [companyA],
            );

            await client.query(migration);
            await client.query(migration);

            const after = await client.query(
                `SELECT to_jsonb(p) - 'item_type' AS row FROM estimate_item_presets p WHERE company_id=$1 ORDER BY id`,
                [companyA],
            );
            expect(after.rows).toEqual(before.rows.map(entry => ({ row: entry.row })));
            const reachable = await client.query(
                `SELECT id, name FROM estimate_item_presets
                 WHERE company_id=$1 AND category_id IS NULL AND archived_at IS NULL ORDER BY id`,
                [companyA],
            );
            expect(reachable.rows).toHaveLength(6);

            const education = await client.query(
                `INSERT INTO price_book_categories (company_id,name) VALUES ($1,'8 Education') RETURNING id`, [companyA],
            );
            await rejectedAtSavepoint(client, 'duplicate_root',
                `INSERT INTO price_book_categories (company_id,name) VALUES ($1,'8 education')`, [companyA], '23505');

            const dishwasher = await client.query(
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Dishwasher') RETURNING id`,
                [companyA, education.rows[0].id],
            );
            const refrigerator = await client.query(
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Refrigerator') RETURNING id`,
                [companyA, education.rows[0].id],
            );
            await client.query(
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Standard'),($1,$3,'Standard')`,
                [companyA, dishwasher.rows[0].id, refrigerator.rows[0].id],
            );
            await rejectedAtSavepoint(client, 'duplicate_sibling',
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'standard')`,
                [companyA, dishwasher.rows[0].id], '23505');

            const standard = await client.query(
                `SELECT id FROM price_book_categories WHERE company_id=$1 AND parent_id=$2 AND name='Standard'`,
                [companyA, dishwasher.rows[0].id],
            );
            await rejectedAtSavepoint(client, 'fourth_level',
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Fourth')`,
                [companyA, standard.rows[0].id], '23514');
            await rejectedAtSavepoint(client, 'cycle',
                `UPDATE price_book_categories SET parent_id=$1 WHERE id=$2 AND company_id=$3`,
                [standard.rows[0].id, education.rows[0].id, companyA], '23514');

            const rootA = await client.query(
                `INSERT INTO price_book_categories (company_id,name) VALUES ($1,'Root A') RETURNING id`, [companyA],
            );
            await client.query(
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Root A child')`, [companyA, rootA.rows[0].id],
            );
            const rootP = await client.query(
                `INSERT INTO price_book_categories (company_id,name) VALUES ($1,'Root P') RETURNING id`, [companyA],
            );
            const level2 = await client.query(
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Level 2') RETURNING id`, [companyA, rootP.rows[0].id],
            );
            await rejectedAtSavepoint(client, 'subtree_overflow',
                `UPDATE price_book_categories SET parent_id=$1 WHERE id=$2 AND company_id=$3`,
                [level2.rows[0].id, rootA.rows[0].id, companyA], '23514');
            await rejectedAtSavepoint(client, 'cross_tenant_parent',
                `INSERT INTO price_book_categories (company_id,parent_id,name) VALUES ($1,$2,'Foreign child')`,
                [companyB, education.rows[0].id], '23503');

            await client.query(
                `INSERT INTO estimate_item_presets (company_id,name,code,item_type,default_unit_price)
                 VALUES ($1,'Repeated name','1000','Service',10),($1,'Repeated name','1001','Product',20)`,
                [companyA],
            );
            await rejectedAtSavepoint(client, 'duplicate_sku',
                `INSERT INTO estimate_item_presets (company_id,name,code,default_unit_price) VALUES ($1,'Other','1000',30)`,
                [companyA], '23505');
            const types = await client.query(
                `SELECT code,item_type FROM estimate_item_presets WHERE company_id=$1 AND code IS NOT NULL ORDER BY code`, [companyA],
            );
            expect(types.rows).toEqual([{ code: '1000', item_type: 'Service' }, { code: '1001', item_type: 'Product' }]);

            await client.query('SAVEPOINT guarded_rollback');
            await expect(client.query(rollback)).rejects.toThrow(/cannot rollback 193/);
            await client.query('ROLLBACK TO SAVEPOINT guarded_rollback');

            await client.query(`DELETE FROM estimate_item_presets WHERE company_id=$1 AND code IS NOT NULL`, [companyA]);
            await client.query(`DELETE FROM price_book_categories WHERE company_id=$1 AND parent_id IN (SELECT id FROM price_book_categories WHERE company_id=$1 AND parent_id IS NOT NULL)`, [companyA]);
            await client.query(`DELETE FROM price_book_categories WHERE company_id=$1 AND parent_id IS NOT NULL`, [companyA]);
            await client.query(`DELETE FROM price_book_categories WHERE company_id=$1`, [companyA]);
            await client.query(rollback);
            await client.query(rollback);

            const finalLegacy = await client.query(
                `SELECT to_jsonb(p) AS row FROM estimate_item_presets p WHERE company_id=$1 ORDER BY id`, [companyA],
            );
            expect(finalLegacy.rows).toEqual(before.rows);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    test('concurrent opposing reparent attempts cannot commit a cycle', async () => {
        let available = true;
        try { await db.query('SELECT 1'); } catch (error) { available = false; console.warn(`PRICEBOOK concurrent guard SKIPPED-NEEDS-DB — ${error.message}`); }
        if (!available) return;

        const schema = `pb_nested_${Date.now()}_${process.pid}`;
        const companyId = randomUUID();
        const setup = await db.pool.connect();
        const first = await db.pool.connect();
        const second = await db.pool.connect();
        try {
            await setup.query(`CREATE SCHEMA ${schema}`);
            await setup.query(`SET search_path TO ${schema}, public`);
            await setup.query(`CREATE TABLE price_book_categories (
                id BIGSERIAL PRIMARY KEY, company_id UUID NOT NULL, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, archived_at TIMESTAMPTZ, created_by UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
            await setup.query(`CREATE UNIQUE INDEX uq_price_book_categories_active_name ON price_book_categories(company_id,lower(name)) WHERE archived_at IS NULL`);
            await setup.query(`CREATE TABLE estimate_item_presets (
                id BIGSERIAL PRIMARY KEY, company_id UUID NOT NULL, name TEXT NOT NULL, code TEXT, archived_at TIMESTAMPTZ
            )`);
            await setup.query(`CREATE UNIQUE INDEX uq_estimate_item_presets_active_name ON estimate_item_presets(company_id,lower(name)) WHERE archived_at IS NULL`);
            await setup.query(migration);
            const roots = await setup.query(
                `INSERT INTO price_book_categories(company_id,name) VALUES ($1,'Root one'),($1,'Root two') RETURNING id`,
                [companyId],
            );

            await first.query(`SET search_path TO ${schema}, public`);
            await second.query(`SET search_path TO ${schema}, public`);
            await first.query('BEGIN');
            await second.query('BEGIN');
            await first.query(`UPDATE price_book_categories SET parent_id=$1 WHERE id=$2`, [roots.rows[1].id, roots.rows[0].id]);
            const opposing = second.query(`UPDATE price_book_categories SET parent_id=$1 WHERE id=$2`, [roots.rows[0].id, roots.rows[1].id]);
            await new Promise(resolve => setTimeout(resolve, 100));
            await first.query('COMMIT');
            await expect(opposing).rejects.toMatchObject({ code: '23514' });
            await second.query('ROLLBACK');

            const graph = await setup.query(`SELECT id,parent_id FROM price_book_categories ORDER BY id`);
            expect(graph.rows).toEqual([
                { id: roots.rows[0].id, parent_id: roots.rows[1].id },
                { id: roots.rows[1].id, parent_id: null },
            ]);
        } finally {
            try { await first.query('ROLLBACK'); } catch (_) { /* noop */ }
            try { await second.query('ROLLBACK'); } catch (_) { /* noop */ }
            try { await setup.query('RESET search_path'); } catch (_) { /* noop */ }
            try { await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* noop */ }
            first.release(); second.release(); setup.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});
