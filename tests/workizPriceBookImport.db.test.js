'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const importer = require('../scripts/import-workiz-price-book');

jest.setTimeout(60000);
const migration = fs.readFileSync(path.join(__dirname, '..', 'backend', 'db', 'migrations', '193_price_book_nested_categories.sql'), 'utf8');

function itemRow(row, fullName, price) {
    return { __row: row, 'Item name': fullName, Price: String(price), Cost: '', 'Item type': 'Service', Description: '', Taxability: '0', 'Category 1': '0 General fees', 'Category 2': '', 'Category 3': '' };
}
function groupRow() {
    return {
        ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => index + 1).flatMap(number => [
            [`Part ${number} name`, ''], [`Part ${number} price`, ''], [`Part ${number} cost`, ''], [`Part ${number} quantity`, ''],
        ])),
        __row: 2, 'Group name': '9000 - Test group', 'Group type': 'Individual items', 'Category 1': '0 General fees',
        'Part 1 name': '0003 - Service call fee paid', 'Part 1 price': '', 'Part 1 cost': '', 'Part 1 quantity': '1',
        'Part 2 name': '1000 - Labor', 'Part 2 price': '', 'Part 2 cost': '', 'Part 2 quantity': '2',
    };
}

describe('Workiz Price Book apply — real PostgreSQL', () => {
    test('SAB-PB-FLAT-LEGACY / SKU-IDEMPOTENT / IMPORT-BLAST: six legacy rows and foreign tenant survive two applies', async () => {
        let available = true;
        try { await db.query('SELECT 1 FROM price_book_categories LIMIT 1'); }
        catch (error) { available = false; console.warn(`Workiz importer SKIPPED-NEEDS-DB — ${error.message}`); }
        if (!available) return;

        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id,name,slug) VALUES ($1,'Importer A',$2),($3,'Importer B',$4)`,
                [companyA, `pb-import-a-${companyA}`, companyB, `pb-import-b-${companyB}`],
            );
            for (let index = 1; index <= 6; index++) {
                await client.query(
                    `INSERT INTO estimate_item_presets (company_id,name,default_unit_price) VALUES ($1,$2,$3)`,
                    [companyA, `Legacy ${index}`, index],
                );
            }
            const foreignCategory = await client.query(
                `INSERT INTO price_book_categories (company_id,name) VALUES ($1,'0 General fees') RETURNING id`, [companyB],
            );
            const foreignItem = await client.query(
                `INSERT INTO estimate_item_presets (company_id,name,code,category_id,default_unit_price)
                 VALUES ($1,'Foreign labor','1000',$2,999) RETURNING id`, [companyB, foreignCategory.rows[0].id],
            );
            const foreignGroup = await client.query(
                `INSERT INTO price_book_groups (company_id,name,category_id) VALUES ($1,'9000 - Test group',$2) RETURNING id`,
                [companyB, foreignCategory.rows[0].id],
            );
            await client.query(
                `INSERT INTO price_book_group_items (company_id,group_id,item_id,quantity) VALUES ($1,$2,$3,7)`,
                [companyB, foreignGroup.rows[0].id, foreignItem.rows[0].id],
            );

            const legacyBefore = await client.query(
                `SELECT to_jsonb(p) - 'item_type' AS row FROM estimate_item_presets p WHERE company_id=$1 ORDER BY id`, [companyA],
            );
            await client.query(migration);
            const foreignBefore = await client.query(
                `SELECT jsonb_build_object(
                    'categories',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM price_book_categories c WHERE c.company_id=$1),
                    'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM estimate_item_presets i WHERE i.company_id=$1),
                    'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM price_book_groups g WHERE g.company_id=$1),
                    'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM price_book_group_items l WHERE l.company_id=$1)
                 ) AS snapshot`, [companyB],
            );
            const data = importer.buildImportData([
                itemRow(280, '0003 - Service call fee paid', -95), itemRow(2, '1000 - Labor', 125),
            ], [groupRow()], { enforceEstablishedCounts: false });

            const first = await importer.applyImport(client, companyA, data);
            expect(first).toEqual({
                counts: {
                    categories: { created: 1, updated: 0 }, items: { created: 1, updated: 0 },
                    groups: { created: 1, updated: 0 }, links: { created: 1, updated: 0, removed_skipped: 0 },
                },
                legacy_presets_preserved: 6,
            });
            const afterFirst = await client.query(
                `SELECT jsonb_build_object(
                    'categories',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM price_book_categories c WHERE c.company_id=$1),
                    'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM estimate_item_presets i WHERE i.company_id=$1),
                    'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM price_book_groups g WHERE g.company_id=$1),
                    'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM price_book_group_items l WHERE l.company_id=$1)
                 ) AS snapshot`, [companyA],
            );
            const second = await importer.applyImport(client, companyA, data);
            expect(second.counts).toEqual({
                categories: { created: 0, updated: 0 }, items: { created: 0, updated: 0 },
                groups: { created: 0, updated: 0 }, links: { created: 0, updated: 0, removed_skipped: 0 },
            });
            const afterSecond = await client.query(
                `SELECT jsonb_build_object(
                    'categories',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM price_book_categories c WHERE c.company_id=$1),
                    'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM estimate_item_presets i WHERE i.company_id=$1),
                    'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM price_book_groups g WHERE g.company_id=$1),
                    'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM price_book_group_items l WHERE l.company_id=$1)
                 ) AS snapshot`, [companyA],
            );
            expect(afterSecond.rows).toEqual(afterFirst.rows);

            const legacyAfter = await client.query(
                `SELECT to_jsonb(p) - 'item_type' AS row FROM estimate_item_presets p WHERE company_id=$1 AND code IS NULL ORDER BY id`, [companyA],
            );
            expect(legacyAfter.rows).toEqual(legacyBefore.rows);
            const imported = await client.query(
                `SELECT code,item_type,default_unit_price FROM estimate_item_presets WHERE company_id=$1 AND code='1000'`, [companyA],
            );
            expect(imported.rows).toEqual([{ code: '1000', item_type: 'Service', default_unit_price: '125.00' }]);
            const importedLinks = await client.query(
                `SELECT count(*)::int AS count FROM price_book_group_items WHERE company_id=$1`, [companyA],
            );
            expect(importedLinks.rows[0].count).toBe(1);

            const foreignAfter = await client.query(
                `SELECT jsonb_build_object(
                    'categories',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM price_book_categories c WHERE c.company_id=$1),
                    'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM estimate_item_presets i WHERE i.company_id=$1),
                    'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM price_book_groups g WHERE g.company_id=$1),
                    'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM price_book_group_items l WHERE l.company_id=$1)
                 ) AS snapshot`, [companyB],
            );
            expect(foreignAfter.rows).toEqual(foreignBefore.rows);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});
