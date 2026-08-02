'use strict';

const {
    MAX_BLOCKS,
    MAX_STRING_LENGTH,
    MAX_TABLE_ROWS,
    TRUNCATION_MARKER,
    renderViewDocumentContract,
    validateViewDocument,
} = require('../backend/src/services/appViewDocumentValidator');

function validDocument() {
    return {
        view_version: 1,
        title: 'Daily operations',
        subtitle: 'Current company activity',
        blocks: [
            {
                type: 'stat_row',
                items: [
                    { label: 'Open jobs', value: 12, tone: 'positive', trend: '+2 today' },
                ],
            },
            {
                type: 'chart',
                chart_type: 'bar',
                format: 'currency',
                series: [{ label: 'Monday', value: 1250 }],
            },
            {
                type: 'chart',
                chart_type: 'line',
                series: [{ label: 'Tuesday', value: 9 }],
            },
            {
                type: 'table',
                columns: [
                    { key: 'name', label: 'Name', type: 'text', align: 'left' },
                    { key: 'count', label: 'Count', type: 'number', align: 'right' },
                    { key: 'amount', label: 'Amount', type: 'currency', align: 'right' },
                    { key: 'visit_date', label: 'Visit date', type: 'date', align: 'left' },
                    { key: 'state', label: 'State', type: 'badge', align: 'center' },
                    { key: 'job', label: 'Job', type: 'entity', align: 'left' },
                ],
                rows: [{
                    name: 'Water heater replacement',
                    count: 1,
                    amount: 950,
                    visit_date: '2026-08-01',
                    state: { label: 'Approved', tone: 'success' },
                    job: { entity: 'job', id: 1219 },
                }],
            },
            {
                type: 'list',
                items: [{
                    title: 'Job 1219',
                    subtitle: 'Water heater replacement',
                    badge: 'Approved',
                    ref: { entity: 'job', id: 1219 },
                }],
            },
            { type: 'text', text: 'Generated from approved application data.' },
            { type: 'empty', text: 'Nothing needs attention.' },
        ],
    };
}

describe('APP-VIEW-001 view_version 1 CRM validator', () => {
    test('accepts every v1 block/value type and marks every string truncated at 500 characters', () => {
        const input = validDocument();
        input.blocks[5].text = 'x'.repeat(MAX_STRING_LENGTH + 40);
        const validated = validateViewDocument(input);
        expect(validated.document).toMatchObject({
            view_version: 1,
            title: 'Daily operations',
        });
        expect(validated.document.blocks.map(block => block.type)).toEqual([
            'stat_row', 'chart', 'chart', 'table', 'list', 'text', 'empty',
        ]);
        expect(Array.from(validated.document.blocks[5].text)).toHaveLength(MAX_STRING_LENGTH);
        expect(validated.document.blocks[5].text.endsWith(TRUNCATION_MARKER)).toBe(true);
        expect(validated.bytes).toBeLessThanOrEqual(256 * 1024);
    });

    test('SAB rejects markup, URLs, scripts, unknown blocks and every hard document limit', () => {
        const attacks = [
            { ...validDocument(), title: '<strong>Owned</strong>' },
            { ...validDocument(), subtitle: 'Open https://evil.example/collect' },
            { ...validDocument(), blocks: [{ type: 'text', text: 'document.cookie' }] },
            { ...validDocument(), blocks: [{ type: 'html', html: '<b>Owned</b>' }] },
            { ...validDocument(), blocks: [{ type: 'link', href: 'https://evil.example' }] },
            { ...validDocument(), blocks: [{ type: 'image', src: 'data:text/html,owned' }] },
        ];
        for (const attack of attacks) {
            expect(() => validateViewDocument(attack)).toThrow(expect.objectContaining({
                code: 'VIEW_DOCUMENT_INVALID',
            }));
        }

        const tooManyBlocks = validDocument();
        tooManyBlocks.blocks = Array.from({ length: 65 }, () => ({ type: 'text', text: 'Safe' }));
        expect(() => validateViewDocument(tooManyBlocks)).toThrow(/no more than 64 blocks/i);

        const tooManyRows = validDocument();
        tooManyRows.blocks = [{
            type: 'table',
            columns: [{ key: 'value', label: 'Value', type: 'text', align: 'left' }],
            rows: Array.from({ length: 501 }, () => ({ value: 'Safe' })),
        }];
        expect(() => validateViewDocument(tooManyRows)).toThrow(/no more than 500 rows/i);

        const tooManyColumns = validDocument();
        tooManyColumns.blocks = [{
            type: 'table',
            columns: Array.from({ length: 21 }, (_, index) => ({
                key: `value${index}`,
                label: `Value ${index}`,
                type: 'text',
                align: 'left',
            })),
            rows: [],
        }];
        expect(() => validateViewDocument(tooManyColumns)).toThrow(/1 and 20 columns/i);

        const tooManySeries = validDocument();
        tooManySeries.blocks = [{
            type: 'chart',
            chart_type: 'bar',
            series: Array.from({ length: 25 }, (_, index) => ({ label: `Day ${index}`, value: index })),
        }];
        expect(() => validateViewDocument(tooManySeries)).toThrow(/no more than 24 entries/i);

        const tooLarge = validDocument();
        tooLarge.blocks = [{
            type: 'list',
            items: Array.from({ length: 500 }, (_, index) => ({
                title: `${index}-${'x'.repeat(495)}`,
                subtitle: 'y'.repeat(500),
            })),
        }];
        expect(() => validateViewDocument(tooLarge)).toThrow(/must not exceed 262144 bytes/i);
    });

    test('a plain sentence is accepted as one text block, markup still is not', () => {
        const { document } = validateViewDocument('Today: 6 jobs scheduled.');
        expect(document).toEqual({
            view_version: 1,
            title: 'Result',
            blocks: [{ type: 'text', text: 'Today: 6 jobs scheduled.' }],
        });
        expect(() => validateViewDocument('<img src=x onerror=alert(1)>')).toThrow(/markup/i);
    });

    test('the contract shown to the generator states the limits this file enforces', () => {
        const contract = renderViewDocumentContract();
        expect(contract).toContain('view_version');
        expect(contract).toContain('"type":"table"');
        expect(contract).toContain(String(MAX_TABLE_ROWS));
        expect(contract).toContain(String(MAX_BLOCKS));
    });

    test('every block example shown to the generator survives this validator', () => {
        // Three live runs failed today on examples the validator rejects: a chart
        // key, a table title, and an entity shape. The contract and the check are
        // the same file now, so a drifting example fails here instead of in an
        // app someone just published.
        const text = renderViewDocumentContract();
        const examples = [];
        let buffer = '';
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{"type"') && !buffer) continue;
            buffer += trimmed;
            let depth = 0;
            for (const character of buffer) {
                if (character === '{') depth += 1;
                if (character === '}') depth -= 1;
            }
            if (depth === 0) {
                for (const piece of buffer.split(/(?<=\})\s+(?=\{)/)) examples.push(piece);
                buffer = '';
            }
        }
        expect(examples.length).toBeGreaterThanOrEqual(6);
        for (const example of examples) {
            const block = JSON.parse(example);
            expect(() => validateViewDocument({
                view_version: 1,
                title: 'Contract check',
                blocks: [block],
            })).not.toThrow();
        }
    });
});
