'use strict';

const {
    AI_NOTE_AUTHOR,
    UNIT_LABEL_RESPONSE_SCHEMA,
    createGeminiTransport,
    createUnitLabelScanService,
    formatUnitLabelNote,
    parseVisionResult,
} = require('../backend/src/services/unitLabelScanService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

function label(overrides = {}) {
    return {
        is_nameplate: true,
        brand: 'LG',
        model: 'LFXS28968S',
        serial_number: '802KRHT2Q345',
        mfg_date_or_age: '2018',
        refrigerant: 'R600a',
        confidence: 0.97,
        ...overrides,
    };
}

function noLabel() {
    return {
        is_nameplate: false,
        brand: null,
        model: null,
        serial_number: null,
        mfg_date_or_age: null,
        refrigerant: null,
        confidence: 0.08,
    };
}

function input(overrides = {}) {
    return {
        companyId: COMPANY_A,
        entityType: 'job',
        entityId: 51,
        sourceNoteId: 'source-note-1',
        attachmentIds: [7],
        ...overrides,
    };
}

describe('UNIT-LABEL-SCAN-001 schema parsing and note formatting', () => {
    test('parses the complete structured response and rejects missing/invalid fields', () => {
        expect(parseVisionResult(label())).toEqual(label());
        expect(() => parseVisionResult({ ...label(), confidence: 2 })).toThrow(/confidence/);
        const missing = label();
        delete missing.serial_number;
        expect(() => parseVisionResult(missing)).toThrow(/serial_number/);
    });

    test('omits missing fields and derives age from a visible manufacturing year', () => {
        const text = formatUnitLabelNote([
            label({ model: null, refrigerant: null }),
        ], new Date('2026-08-03T12:00:00Z'));

        expect(text).toBe(
            'Unit label detected — Brand: LG · Serial: 802KRHT2Q345 · Mfg: 2018 (~8 years)'
        );
        expect(text).not.toContain('Model:');
        expect(text).not.toContain('Refrigerant:');
    });

    test('multiple label images produce one combined note and exact duplicates collapse', () => {
        const text = formatUnitLabelNote([
            label(),
            label(),
            label({ brand: 'Samsung', model: 'RF28', serial_number: null, refrigerant: 'R134a' }),
        ], new Date('2026-08-03T12:00:00Z'));

        expect(text).toMatch(/^Unit labels detected:/);
        expect(text.match(/^\d+\./gm)).toHaveLength(2);
    });

    test('Gemini transport sends image bytes with the structured schema and no in-trigger retry', async () => {
        const generateJson = jest.fn(async () => ({ json: label() }));
        const transport = createGeminiTransport({ generateJson });

        await expect(transport({
            imageBytes: Buffer.from('photo-bytes'),
            contentType: 'image/png',
        })).resolves.toEqual(label());

        const options = generateJson.mock.calls[0][0];
        expect(options.primaryModel).toBe('gemini-2.5-flash');
        expect(options.responseSchema).toEqual(UNIT_LABEL_RESPONSE_SCHEMA);
        expect(options.maxRetries).toBe(0);
        expect(options.userParts[1]).toEqual({
            inlineData: {
                mimeType: 'image/png',
                data: Buffer.from('photo-bytes').toString('base64'),
            },
        });
    });
});

describe('UNIT-LABEL-SCAN-001 worker', () => {
    function makeLogger() {
        return { debug: jest.fn(), warn: jest.fn() };
    }

    test('detected images create one scoped AI/system note and complete the attachments', async () => {
        const database = {
            query: jest.fn()
                .mockResolvedValueOnce({
                    rows: [
                        { id: 7, storage_key: 'co-a/7.png', content_type: 'image/png' },
                        { id: 8, storage_key: 'co-a/8.jpg', content_type: 'image/jpeg' },
                    ],
                })
                .mockResolvedValueOnce({ rows: [{ entity_count: '1', attachment_count: '2' }] }),
        };
        const storage = {
            downloadFile: jest.fn(async key => Buffer.from(key)),
        };
        const transport = jest.fn()
            .mockResolvedValueOnce(label())
            .mockResolvedValueOnce(label({ brand: 'Samsung', model: 'RF28', serial_number: 'S-2' }));
        const service = createUnitLabelScanService({
            database,
            storage,
            transport,
            logger: makeLogger(),
            now: () => new Date('2026-08-03T12:00:00Z'),
        });

        await expect(service.runForAttachments(input({ attachmentIds: [7, 8] }))).resolves.toEqual({
            claimed: 2,
            labels: 2,
            noteCreated: true,
        });

        expect(storage.downloadFile).toHaveBeenCalledTimes(2);
        expect(transport).toHaveBeenCalledTimes(2);
        const [writeSql, writeParams] = database.query.mock.calls[1];
        expect(writeSql).toMatch(/UPDATE jobs/);
        expect(writeSql).toMatch(/WHERE company_id = \$1/);
        expect(writeSql).toMatch(/'created_by', 'system'/);
        expect(writeParams.slice(0, 5)).toEqual([
            COMPANY_A, 'job', 51, 'source-note-1', [7, 8],
        ]);
        expect(writeParams[6]).toMatch(/^Unit labels detected:/);
        expect(writeParams[7]).toBe(AI_NOTE_AUTHOR);
    });

    test('no-label response is silent: marks scanned, logs debug, and creates no note', async () => {
        const database = {
            query: jest.fn()
                .mockResolvedValueOnce({
                    rows: [{ id: 7, storage_key: 'co-a/7.png', content_type: 'image/png' }],
                })
                .mockResolvedValueOnce({ rows: [] }),
        };
        const logger = makeLogger();
        const service = createUnitLabelScanService({
            database,
            storage: { downloadFile: jest.fn(async () => Buffer.from('image')) },
            transport: jest.fn(async () => noLabel()),
            logger,
        });

        await expect(service.runForAttachments(input())).resolves.toEqual({
            claimed: 1,
            labels: 0,
            noteCreated: false,
        });

        expect(database.query).toHaveBeenCalledTimes(2);
        expect(database.query.mock.calls[1][0]).toMatch(/unit_label_scan_state = 'completed'/);
        expect(database.query.mock.calls.some(([sql]) => /UPDATE jobs|UPDATE leads/.test(sql))).toBe(false);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith('[unit-label-scan] no unit label found');
    });

    test('lead result uses the company-scoped serial-id note target', async () => {
        const database = {
            query: jest.fn()
                .mockResolvedValueOnce({
                    rows: [{ id: 17, storage_key: 'co-a/17.png', content_type: 'image/png' }],
                })
                .mockResolvedValueOnce({ rows: [{ entity_count: '1', attachment_count: '1' }] }),
        };
        const service = createUnitLabelScanService({
            database,
            storage: { downloadFile: jest.fn(async () => Buffer.from('image')) },
            transport: jest.fn(async () => label()),
            logger: makeLogger(),
        });

        await service.runForAttachments(input({
            entityType: 'lead',
            entityId: 902,
            attachmentIds: [17],
        }));

        const [writeSql, writeParams] = database.query.mock.calls[1];
        expect(writeSql).toMatch(/UPDATE leads/);
        expect(writeSql).toMatch(/SET structured_notes/);
        expect(writeSql).toMatch(/WHERE company_id = \$1/);
        expect(writeSql).toMatch(/serial_id = \$3/);
        expect(writeParams.slice(0, 5)).toEqual([
            COMPANY_A, 'lead', 902, 'source-note-1', [17],
        ]);
    });

    test('vision failure warns and marks the attachment failed for at most one later retry', async () => {
        const database = {
            query: jest.fn()
                .mockResolvedValueOnce({
                    rows: [{ id: 7, storage_key: 'co-a/7.png', content_type: 'image/png' }],
                })
                .mockResolvedValueOnce({ rows: [] }),
        };
        const logger = makeLogger();
        const transport = jest.fn();
        const service = createUnitLabelScanService({
            database,
            storage: { downloadFile: jest.fn(async () => { throw new Error('S3 unavailable'); }) },
            transport,
            logger,
        });

        await expect(service.runForAttachments(input())).resolves.toEqual({
            claimed: 1,
            labels: 0,
            noteCreated: false,
        });

        expect(transport).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            '[unit-label-scan] attachment 7 failed:',
            'S3 unavailable'
        );
        expect(database.query.mock.calls[1][0]).toMatch(/unit_label_scan_state = 'failed'/);
        expect(database.query.mock.calls[0][0]).toMatch(/unit_label_scan_attempts < 2/);
    });

    test('completed attachment is not scanned or noted again on a duplicate trigger', async () => {
        const database = {
            query: jest.fn()
                .mockResolvedValueOnce({
                    rows: [{ id: 7, storage_key: 'co-a/7.png', content_type: 'image/png' }],
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] }),
        };
        const storage = { downloadFile: jest.fn(async () => Buffer.from('image')) };
        const transport = jest.fn(async () => noLabel());
        const service = createUnitLabelScanService({ database, storage, transport, logger: makeLogger() });

        await service.runForAttachments(input());
        await expect(service.runForAttachments(input())).resolves.toEqual({
            claimed: 0,
            labels: 0,
            noteCreated: false,
        });

        expect(storage.downloadFile).toHaveBeenCalledTimes(1);
        expect(transport).toHaveBeenCalledTimes(1);
        const claimSql = database.query.mock.calls[0][0];
        expect(claimSql).toMatch(/unit_label_scan_attempts < 2/);
        expect(claimSql).toMatch(/unit_label_scan_state = 'failed'/);
    });

    test('tenant scope: same attachment id under another company is not claimed or sent to Gemini', async () => {
        const database = {
            query: jest.fn(async (sql, params) => {
                if (/RETURNING id, storage_key, content_type/.test(sql) && params[0] === COMPANY_A) {
                    return { rows: [{ id: 7, storage_key: 'co-a/7.png', content_type: 'image/png' }] };
                }
                if (/WITH updated_entity/.test(sql)) {
                    return { rows: [{ entity_count: '1', attachment_count: '1' }] };
                }
                return { rows: [] };
            }),
        };
        const storage = { downloadFile: jest.fn(async () => Buffer.from('owned-image')) };
        const transport = jest.fn(async () => label());
        const service = createUnitLabelScanService({ database, storage, transport, logger: makeLogger() });

        await service.runForAttachments(input({ companyId: COMPANY_A }));
        await service.runForAttachments(input({ companyId: COMPANY_B }));

        expect(storage.downloadFile).toHaveBeenCalledTimes(1);
        expect(transport).toHaveBeenCalledTimes(1);
        const foreignClaim = database.query.mock.calls.find(([, params]) => params[0] === COMPANY_B);
        expect(foreignClaim[0]).toMatch(/company_id = \$1/);
        expect(foreignClaim[1]).toEqual([
            COMPANY_B, 'job', 51, [7], 'source-note-1',
        ]);
        const noteWrites = database.query.mock.calls.filter(([sql]) => /WITH updated_entity/.test(sql));
        expect(noteWrites).toHaveLength(1);
        expect(noteWrites[0][1][0]).toBe(COMPANY_A);
    });

    test('queueScan is detached and a rejected worker never reaches the note-create caller', async () => {
        const scheduled = [];
        const logger = makeLogger();
        const service = createUnitLabelScanService({
            database: { query: jest.fn(async () => { throw new Error('db down'); }) },
            storage: { downloadFile: jest.fn() },
            transport: jest.fn(),
            logger,
            schedule: fn => scheduled.push(fn),
        });

        expect(service.queueScan(input())).toBe(true);
        expect(scheduled).toHaveLength(1);
        scheduled[0]();
        await new Promise(resolve => setImmediate(resolve));
        expect(logger.warn).toHaveBeenCalledWith('[unit-label-scan] claim failed:', 'db down');
    });
});
