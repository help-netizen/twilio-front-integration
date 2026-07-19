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
jest.mock('../../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

const noteAttachmentsRouter = require('../../backend/src/routes/noteAttachments');
const service = require('../../backend/src/services/noteAttachmentsService');
const storageService = require('../../backend/src/services/storageService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const OFFICE_PERMISSIONS = [
    'jobs.view', 'jobs.edit',
    'leads.view', 'leads.edit',
    'contacts.view', 'contacts.edit',
];
const PROVIDER_PERMISSIONS = ['jobs.view', 'jobs.done_pending_approval'];
const PROVIDER_SCOPES = { job_visibility: 'assigned_only' };

function makeApp(permissions = OFFICE_PERMISSIONS, scopes = {}) {
    const app = express();
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'crm-1' } };
        req.authz = { permissions, scopes, company: { id: COMPANY } };
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

describe('Wave 1 attachment RBAC matrix', () => {
    test('job upload allows a provider through jobs.done_pending_approval', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, file_name: 'a.png', content_type: 'image/png', file_size: 3 }] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES)).post('/api/note-attachments/upload')
            .field('entity_type', 'job').field('entity_id', '5')
            .attach('attachments', Buffer.from('img'), 'a.png');

        expect(res.status).toBe(200);
        expect(mockQuery.mock.calls[1][0]).toMatch(/assigned_provider_user_ids @> \$3::jsonb/);
        expect(mockQuery.mock.calls[1][1]).toEqual([5, COMPANY, JSON.stringify(['crm-1'])]);
        expect(storageService.uploadFile).toHaveBeenCalledTimes(1);
    });

    test('provider gets 404 when uploading against an unassigned in-tenant job', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES)).post('/api/note-attachments/upload')
            .field('entity_type', 'job').field('entity_id', '5')
            .attach('attachments', Buffer.from('img'), 'a.png');

        expect(res.status).toBe(404);
        expect(storageService.uploadFile).not.toHaveBeenCalled();
    });

    test.each([
        ['lead', 'LEAD-1'],
        ['contact', '5'],
    ])('provider is denied %s upload', async (entityType, entityId) => {
        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES)).post('/api/note-attachments/upload')
            .field('entity_type', entityType).field('entity_id', entityId)
            .attach('attachments', Buffer.from('img'), 'a.png');

        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(storageService.uploadFile).not.toHaveBeenCalled();
    });

    test.each([
        ['job', PROVIDER_PERMISSIONS, { entity_id: 5 }, PROVIDER_SCOPES],
        ['lead', ['leads.view']],
        ['contact', ['contacts.view']],
    ])('%s attachment URL allows its entity-view permission', async (entityType, permissions, metadata = {}, scopes = {}) => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: entityType, ...metadata }] });
        if (scopes.job_visibility === 'assigned_only') {
            mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        }
        mockQuery.mockResolvedValueOnce({ rows: [{ storage_key: 'own/key.png' }] });

        const res = await request(makeApp(permissions, scopes)).get('/api/note-attachments/7/url');

        expect(res.status).toBe(200);
        expect(res.body.url).toBe('https://signed/url');
        expect(mockQuery.mock.calls[0][0]).toMatch(/WHERE id = \$1 AND company_id = \$2/);
        expect(mockQuery.mock.calls[0][1]).toEqual([7, COMPANY]);
    });

    test('provider gets 404 for an unassigned in-tenant job attachment URL', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: 'job', entity_id: 5 }] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES))
            .get('/api/note-attachments/7/url');

        expect(res.status).toBe(404);
        expect(storageService.getPresignedUrl).not.toHaveBeenCalled();
    });

    test.each(['lead', 'contact'])('provider is denied a %s attachment URL', async (entityType) => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: entityType }] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES)).get('/api/note-attachments/7/url');

        expect(res.status).toBe(403);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(storageService.getPresignedUrl).not.toHaveBeenCalled();
    });

    test.each([
        ['job', PROVIDER_PERMISSIONS, { entity_id: 5, note_index: null, uploaded_by: 'crm-1' }, PROVIDER_SCOPES],
        ['lead', ['leads.edit']],
        ['contact', ['contacts.edit']],
    ])('%s attachment delete allows its entity-edit permission', async (entityType, permissions, metadata = {}, scopes = {}) => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: entityType, ...metadata }] });
        if (scopes.job_visibility === 'assigned_only') {
            mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        }
        mockQuery.mockResolvedValueOnce({ rows: [{ storage_key: 'own/key.png' }] });

        const res = await request(makeApp(permissions, scopes)).delete('/api/note-attachments/7');

        expect(res.status).toBe(200);
        const deleteCall = mockQuery.mock.calls.find(([sql]) => /DELETE FROM note_attachments/.test(sql));
        expect(deleteCall[0]).toMatch(/DELETE FROM note_attachments WHERE id = \$1 AND company_id = \$2/);
        expect(deleteCall[1]).toEqual([7, COMPANY]);
        expect(storageService.deleteFile).toHaveBeenCalledWith('own/key.png');
    });

    test('provider gets 404 deleting an unassigned in-tenant job attachment', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: 'job', entity_id: 5, note_index: null, uploaded_by: 'crm-1' }] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES))
            .delete('/api/note-attachments/7');

        expect(res.status).toBe(404);
        expect(storageService.deleteFile).not.toHaveBeenCalled();
    });

    test('provider cannot use the staging delete route on a committed job attachment', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: 'job', entity_id: 5, note_index: 0, uploaded_by: 'crm-1' }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES)).delete('/api/note-attachments/7');

        expect(res.status).toBe(403);
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(storageService.deleteFile).not.toHaveBeenCalled();
    });

    test.each(['lead', 'contact'])('provider is denied a %s attachment delete', async (entityType) => {
        mockQuery.mockResolvedValueOnce({ rows: [{ entity_type: entityType }] });

        const res = await request(makeApp(PROVIDER_PERMISSIONS, PROVIDER_SCOPES)).delete('/api/note-attachments/7');

        expect(res.status).toBe(403);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(storageService.deleteFile).not.toHaveBeenCalled();
    });
});

describe('Wave 1 attachment tenant isolation', () => {
    test('T-foreign GET: foreign attachment is 404 before RBAC or S3 access', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp()).get('/api/note-attachments/999/url');

        expect(res.status).toBe(404);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][1]).toEqual([999, COMPANY]);
        expect(storageService.getPresignedUrl).not.toHaveBeenCalled();
    });

    test('T-foreign DELETE: foreign attachment is 404 and no delete runs', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp()).delete('/api/note-attachments/999');

        expect(res.status).toBe(404);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][0]).toMatch(/^\s*SELECT entity_type/);
        expect(mockQuery.mock.calls[0][1]).toEqual([999, COMPANY]);
        expect(storageService.deleteFile).not.toHaveBeenCalled();
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
