'use strict';

const fs = require('fs');
const importer = require('../scripts/import-workiz-price-book');

function itemRow(row, fullName, price, overrides = {}) {
    return {
        __row: row,
        'Item name': fullName,
        Price: String(price),
        Cost: '',
        'Item type': 'Service',
        Description: '',
        Taxability: '0',
        'Category 1': '0 General fees',
        'Category 2': '',
        'Category 3': '',
        ...overrides,
    };
}

function groupRow(overrides = {}) {
    return {
        ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => index + 1).flatMap(number => [
            [`Part ${number} name`, ''], [`Part ${number} price`, ''], [`Part ${number} cost`, ''], [`Part ${number} quantity`, ''],
        ])),
        __row: 2,
        'Group name': '9000 - Test group',
        'Group type': 'Individual items',
        'Category 1': '0 General fees',
        'Part 1 name': '0003 - Service call fee paid',
        'Part 1 price': '',
        'Part 1 cost': '',
        'Part 1 quantity': '1',
        'Part 2 name': '1000 - Labor',
        'Part 2 price': '',
        'Part 2 cost': '',
        'Part 2 quantity': '2',
        ...overrides,
    };
}

describe('PRICEBOOK-NESTED-001 Workiz importer', () => {
    test('D1 skips only 0003, drops its link, and leaves every group nonempty', () => {
        const data = importer.buildImportData([
            itemRow(280, '0003 - Service call fee paid', -95),
            itemRow(2, '1000 - Labor', 125),
        ], [groupRow()], { enforceEstablishedCounts: false });

        expect(data.items.map(item => item.sku)).toEqual(['1000']);
        expect(data.skipped_rows).toEqual([expect.objectContaining({ row: 280, sku: '0003', price: -95 })]);
        expect(data.dropped_links).toMatchObject({ count: 1, unit_credit_removed: 95 });
        expect(data.groups_zero_after_drop).toBe(0);
        expect(data.links).toEqual([expect.objectContaining({ item_sku: '1000', quantity: 2, sort_order: 0 })]);
    });

    test('SAB-PB-NO-SILENT-LOSS: nonempty cost fails instead of being discarded', () => {
        expect(() => importer.buildImportData([
            itemRow(280, '0003 - Service call fee paid', -95),
            itemRow(2, '1000 - Labor', 125, { Cost: '5' }),
        ], [groupRow()], { enforceEstablishedCounts: false })).toThrow(/Cost is nonempty/);
    });

    test('negative prices other than the owner-approved skipped row fail', () => {
        expect(() => importer.buildImportData([
            itemRow(280, '0003 - Service call fee paid', -95),
            itemRow(2, '1000 - Labor', -1),
        ], [groupRow()], { enforceEstablishedCounts: false })).toThrow(/Unexpected negative item price/);
    });

    test('default CLI mode is dry-run and apply requires an explicit flag', () => {
        expect(importer.parseArgs(['--company-id=00000000-0000-4000-8000-000000000001'])).toMatchObject({ dryRun: true, apply: false });
        expect(() => importer.parseArgs(['--dry-run', '--apply', '--company-id=00000000-0000-4000-8000-000000000001'])).toThrow(/mutually exclusive/);
    });

    test('accepts this deployment\'s SEEDED company id, not just RFC-4122 v1-v5 shapes', () => {
        // Regression: the validator demanded the version/variant nibbles, so the real
        // production company id was rejected outright and the import could never run
        // against it. The suite had hidden this by using a synthetic v4-shaped id.
        // Existence is verified against the DB, so a shape check is all this needs.
        expect(importer.parseArgs(['--company-id=00000000-0000-0000-0000-000000000001']))
            .toMatchObject({ companyId: '00000000-0000-0000-0000-000000000001', dryRun: true });
        expect(() => importer.parseArgs(['--company-id=not-a-uuid'])).toThrow(/company-id/);
        expect(() => importer.parseArgs(['--company-id=00000000-0000-0000-0000-00000000000'])).toThrow(/company-id/);
    });

    test('T-blast / SAB-PB-IMPORT-BLAST: target inspection binds company on every Price Book table read', async () => {
        const calls = [];
        const client = { query: jest.fn(async (sql, params) => {
            calls.push([String(sql), params]);
            if (String(sql).includes('FROM companies')) return { rows: [{ id: 'company-a' }] };
            return { rows: [] };
        }) };
        const data = importer.buildImportData([
            itemRow(280, '0003 - Service call fee paid', -95),
            itemRow(2, '1000 - Labor', 125),
        ], [groupRow()], { enforceEstablishedCounts: false });

        await importer.inspectTarget(client, 'company-a', data);

        for (const [sql, params] of calls.filter(([sql]) => /price_book_|estimate_item_presets/.test(sql))) {
            expect(sql).toMatch(/company_id = \$1/);
            expect(params[0]).toBe('company-a');
        }
    });

    const sourcesAvailable = fs.existsSync(importer.DEFAULT_ITEMS) && fs.existsSync(importer.DEFAULT_GROUPS);
    (sourcesAvailable ? test : test.skip)('live owner workbooks revalidate exact established and D1 consequence counts', () => {
        const data = importer.buildImportData(
            importer.readXlsxRows(importer.DEFAULT_ITEMS),
            importer.readXlsxRows(importer.DEFAULT_GROUPS),
        );
        const types = data.items.reduce((counts, item) => ({ ...counts, [item.item_type]: (counts[item.item_type] || 0) + 1 }), {});
        expect(data.source).toEqual({ items: 394, groups: 121, links: 396 });
        expect(data.import).toEqual({ items: 393, groups: 121, links: 275, categories: 45 });
        expect([1, 2, 3].map(level => data.categories.filter(category => category.level === level).length)).toEqual([9, 6, 30]);
        expect(data.dropped_links.count).toBe(121);
        expect(data.groups_zero_after_drop).toBe(0);
        expect(types).toEqual({ Service: 304, Product: 89 });
    });

    (sourcesAvailable ? test : test.skip)('--dry-run emits the full owner-file plan and executes no data-writing SQL', async () => {
        const sql = [];
        const client = {
            query: jest.fn(async (text) => {
                sql.push(String(text).trim());
                if (String(text).includes('FROM companies')) return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }] };
                return { rows: [] };
            }),
            release: jest.fn(),
        };
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const plan = await importer.run([
                '--dry-run', '--company-id=00000000-0000-4000-8000-000000000001',
                `--items=${importer.DEFAULT_ITEMS}`, `--groups=${importer.DEFAULT_GROUPS}`,
            ], { db: { getClient: async () => client } });
            expect(plan).toMatchObject({ mode: 'dry-run', writes: false, source: { items: 394, groups: 121, links: 396 }, import: { items: 393, groups: 121, links: 275, categories: 45 } });
            expect(plan.categories_per_level['1']).toHaveLength(9);
            expect(plan.categories_per_level['2']).toHaveLength(6);
            expect(plan.categories_per_level['3']).toHaveLength(30);
            expect(plan.items).toHaveLength(393);
            expect(plan.groups).toHaveLength(121);
            expect(plan.links).toHaveLength(275);
            expect(plan.skipped_rows).toHaveLength(1);
            expect(sql).toContain('BEGIN');
            expect(sql).toContain('ROLLBACK');
            expect(sql.some(statement => /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(statement))).toBe(false);
        } finally {
            write.mockRestore();
        }
    });
});
