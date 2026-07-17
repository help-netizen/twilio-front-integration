/**
 * NOTE-ATTACH-UPLOAD-001 — staging upload route + service.
 * DB is mocked; storageService (S3) is mocked. The real service runs against them.
 */
const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../../backend/src/services/storageService', () => ({
    generateStorageKey: jest.fn(() => 'co/job/5/key.png'),
    uploadFile: jest.fn(async () => {}),
    getPresignedUrl: jest.fn(async () => 'https://signed/url'),
    deleteFile: jest.fn(async () => {}),
}));

const noteAttachmentsRouter = require('../../backend/src/routes/noteAttachments');
const service = require('../../backend/src/services/noteAttachmentsService');
const storageService = require('../../backend/src/services/storageService');

const COMPANY = '00000000-0000-0000-0000-000000000001';

function makeApp() {
    const app = express();
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'crm-1' } };
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    app.use('/api/note-attachments', noteAttachmentsRouter);
    return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /upload (stage)', () => {
    test('invalid entity_type → 400, no query', async () => {
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'widget').field('entity_id', '5')
            .attach('attachments', Buffer.from('img'), 'a.png');
        expect(res.status).toBe(400);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('foreign/unknown entity → 404 (only the existence check ran)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // entityExistsInCompany → none
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'job').field('entity_id', '999')
            .attach('attachments', Buffer.from('img'), 'a.png');
        expect(res.status).toBe(404);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(storageService.uploadFile).not.toHaveBeenCalled();
    });

    test('valid → 200, uploads to S3 + inserts a STAGED row (note_index NULL), returns id', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });                          // entityExists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, file_name: 'a.png', content_type: 'image/png', file_size: 3 }] }); // INSERT
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'job').field('entity_id', '5')
            .attach('attachments', Buffer.from('img'), 'a.png');
        expect(res.status).toBe(200);
        expect(res.body.data.attachments).toEqual([{ id: 42, file_name: 'a.png', content_type: 'image/png', file_size: 3 }]);
        expect(storageService.uploadFile).toHaveBeenCalledTimes(1);
        const insert = mockQuery.mock.calls[1][0];
        expect(insert).toMatch(/INSERT INTO note_attachments/i);
        expect(insert).toMatch(/NULL, NULL/);   // note_index, note_id staged
    });

    test('own lead UUID → 200 and stages against the lead serial_id', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, serial_id: 700 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 43, file_name: 'a.png', content_type: 'image/png', file_size: 3 }] });
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'lead').field('entity_id', '0NMHI5')
            .attach('attachments', Buffer.from('img'), 'a.png');

        expect(res.status).toBe(200);
        expect(mockQuery.mock.calls[0][0]).toMatch(/FROM leads WHERE uuid = \$1 AND company_id = \$2/i);
        expect(mockQuery.mock.calls[0][1]).toEqual(['0NMHI5', COMPANY]);
        expect(mockQuery.mock.calls[1][1][2]).toBe(700);
    });

    test('foreign lead UUID → 404 without staging or upload', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'lead').field('entity_id', 'FOREIGN-UUID')
            .attach('attachments', Buffer.from('img'), 'a.png');

        expect(res.status).toBe(404);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][1]).toEqual(['FOREIGN-UUID', COMPANY]);
        expect(storageService.uploadFile).not.toHaveBeenCalled();
    });

    test('numeric lead id fallback → 200 and stages against the lead serial_id', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, serial_id: 700 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 44, file_name: 'a.png', content_type: 'image/png', file_size: 3 }] });
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'lead').field('entity_id', '42')
            .attach('attachments', Buffer.from('img'), 'a.png');

        expect(res.status).toBe(200);
        expect(mockQuery.mock.calls[1][0]).toMatch(/FROM leads WHERE id = \$1 AND company_id = \$2/i);
        expect(mockQuery.mock.calls[1][1]).toEqual([42, COMPANY]);
        expect(mockQuery.mock.calls[2][1][2]).toBe(700);
    });

    test('no files → 400', async () => {
        const res = await request(makeApp()).post('/api/note-attachments/upload')
            .field('entity_type', 'job').field('entity_id', '5');
        expect(res.status).toBe(400);
    });
});

describe('service: associateStagedAttachments', () => {
    test('UPDATEs only staged rows of this company+entity; returns committed rows', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, file_name: 'a.png', content_type: 'image/png', file_size: 3 }] });
        const out = await service.associateStagedAttachments(COMPANY, 'job', 5, [7, 'x', -1], 'note-uuid', 0);
        expect(out).toHaveLength(1);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/UPDATE note_attachments/i);
        expect(sql).toMatch(/note_index IS NULL/);
        expect(params[0]).toBe('note-uuid');     // note_id
        expect(params[1]).toBe(0);               // note_index
        expect(params[2]).toEqual([7]);          // only the valid positive int id
        expect(params[3]).toBe(COMPANY);
    });

    test('empty/blank ids → no query, returns []', async () => {
        const out = await service.associateStagedAttachments(COMPANY, 'job', 5, [], 'n', 0);
        expect(out).toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('exceeding MAX_FILES_PER_NOTE → 400', async () => {
        await expect(
            service.associateStagedAttachments(COMPANY, 'job', 5, [1, 2, 3], 'n', 0, { existingCount: 4 })
        ).rejects.toMatchObject({ status: 400 });
    });
});

describe('service: getAttachmentsForEntity excludes staged', () => {
    test('query filters note_index IS NOT NULL', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await service.getAttachmentsForEntity(COMPANY, 'job', 5);
        expect(mockQuery.mock.calls[0][0]).toMatch(/note_index IS NOT NULL/);
    });
});

describe('service: deleteStaleStagedAttachments', () => {
    test('deletes old staged rows + their S3 objects, returns count', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ storage_key: 'k1' }, { storage_key: 'k2' }] });
        const n = await service.deleteStaleStagedAttachments(24);
        expect(n).toBe(2);
        expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM note_attachments/i);
        expect(mockQuery.mock.calls[0][0]).toMatch(/note_index IS NULL/);
        expect(storageService.deleteFile).toHaveBeenCalledTimes(2);
    });
});
