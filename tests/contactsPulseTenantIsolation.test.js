/**
 * PF007-HARDENING-001 / TASK-RBAC-016
 * Tenant isolation + provider client scope for Contacts and Pulse.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');
const contactsService = require('../backend/src/services/contactsService');
const contactsQueries = require('../backend/src/db/contactsQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';

beforeEach(() => db.query.mockReset());

// ─── Contacts service ────────────────────────────────────────────────────────

describe('contactsService tenant isolation', () => {
    it('listContacts refuses to run without tenant context', async () => {
        await expect(contactsService.listContacts({}))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('listContacts always filters by company_id', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await contactsService.listContacts({ companyId: COMPANY_A });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('c.company_id = $1');
        expect(params[0]).toBe(COMPANY_A);
    });

    it('provider scope restricts list to contacts of visible jobs', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await contactsService.listContacts({
            companyId: COMPANY_A,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
        });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('pj.assigned_provider_user_ids @>');
        expect(params).toContain(JSON.stringify([PROVIDER_USER]));
    });

    it('getById returns null for a foreign-company contact (route → 404)', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const contact = await contactsService.getById(42, COMPANY_B);
        expect(contact).toBeNull();
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('c.company_id = $2');
        expect(params).toEqual([42, COMPANY_B]);
    });
});

describe('contactsQueries phone lookups', () => {
    it('findContactByPhoneOrSecondary is company-scoped (no global search)', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await contactsQueries.findContactByPhoneOrSecondary('+15085140320', COMPANY_A);
        for (const [sql, params] of db.query.mock.calls) {
            expect(sql).toContain('company_id = $2');
            expect(params[1]).toBe(COMPANY_A);
        }
    });

    it('findContactByPhone is company-scoped', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await contactsQueries.findContactByPhone('+15085140320', COMPANY_A);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('company_id = $2');
        expect(params[1]).toBe(COMPANY_A);
    });
});

// ─── Pulse routes ────────────────────────────────────────────────────────────

jest.mock('../backend/src/db/queries', () => ({
    markThreadHandled: jest.fn(async () => null),
    snoozeThread: jest.fn(async () => null),
    assignThread: jest.fn(async () => null),
    setActionRequired: jest.fn(async () => null),
    createTask: jest.fn(async () => ({})),
    findOrCreateTimeline: jest.fn(async () => ({ id: 1 })),
}));
jest.mock('../backend/src/db/conversationsQueries', () => ({
    getMessages: jest.fn(async () => []),
}));

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                hostname: '127.0.0.1', port: server.address().port, path, method,
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            if (payload) req.write(payload);
            req.end();
        });
    });
}

function pulseApp({ permissions = ['pulse.view'], scopes = {} } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: { id: PROVIDER_USER } };
        req.authz = { scope: 'tenant', permissions, scopes, membership: { role_key: 'provider' } };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/', require('../backend/src/routes/pulse'));
    return app;
}

describe('pulse tenant isolation', () => {
    it('requires pulse.view on every surface', async () => {
        const res = await request(pulseApp({ permissions: [] }), 'GET', '/timeline/5');
        expect(res.status).toBe(403);
    });

    it('timeline by contact id 404s when the contact is not in the tenant', async () => {
        db.query.mockResolvedValue({ rows: [] }); // contact lookup scoped by company → empty
        const res = await request(pulseApp(), 'GET', '/timeline/42');
        expect(res.status).toBe(404);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('company_id = $2');
        expect(params).toEqual([42, COMPANY_A]);
    });

    it('provider cannot open a timeline for a client without visible assigned jobs', async () => {
        // contact exists in tenant…
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 42, company_id: COMPANY_A, phone_e164: '+1555' }] })
            // …but the visibility probe finds no assigned job
            .mockResolvedValueOnce({ rows: [] });
        const res = await request(
            pulseApp({ scopes: { job_visibility: 'assigned_only' } }),
            'GET', '/timeline/42'
        );
        expect(res.status).toBe(404);
    });

    it('thread mutations 404 on foreign-company timelines', async () => {
        db.query.mockResolvedValue({ rows: [] }); // getTimelineInCompany → none
        const res = await request(pulseApp(), 'POST', '/threads/9/mark-handled');
        expect(res.status).toBe(404);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('company_id = $2');
        expect(params).toEqual([9, COMPANY_A]);
    });
});

describe('AR-TASKS-001 manual mark-handled guard', () => {
    it('clears a taskless manual flag without issuing any task write', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 9, company_id: COMPANY_A, is_action_required: false }] });

        const result = await timelinesQueries.markThreadHandled(9, COMPANY_A);

        expect(result).toMatchObject({ id: 9, is_action_required: false });
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][0]).not.toMatch(/UPDATE tasks/i);
    });

    it('is company-scoped, refuses task-backed threads, and never bulk-updates tasks', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await timelinesQueries.markThreadHandled(9, COMPANY_A);

        expect(result).toBeNull();
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE id = $1 AND company_id = $2');
        expect(sql).toContain('open_task.company_id = $2');
        expect(sql).toContain("open_task.status = 'open'");
        expect(sql).not.toMatch(/UPDATE tasks/i);
        expect(params).toEqual([9, COMPANY_A]);
    });
});

// ─── Gap fixes from the PF007 audit ──────────────────────────────────────────

describe('timelinesQueries.findOrCreateTimeline tenant scope', () => {
    const timelinesQueries = require('../backend/src/db/timelinesQueries');

    it('contact and timeline phone matches are company-scoped', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await timelinesQueries.findOrCreateTimeline('+15085140320', COMPANY_A);
        // First call: contact lookup; later: orphan timeline lookup + insert.
        const contactCall = db.query.mock.calls[0];
        expect(contactCall[0]).toContain('company_id = $2');
        expect(contactCall[1]).toEqual(['15085140320', COMPANY_A]);
        const orphanCall = db.query.mock.calls[1];
        expect(orphanCall[0]).toContain('company_id = $2');
    });
});

describe('contactDedupeService company filter', () => {
    const dedupe = require('../backend/src/services/contactDedupeService');

    it('searchCandidates parameterizes the company filter', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await dedupe.searchCandidates({ first_name: 'John', last_name: 'Doe', phone: null, email: null }, COMPANY_A);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).not.toContain(COMPANY_A); // never interpolated into SQL text
        expect(sql).toContain('c.company_id = $1');
        expect(params[0]).toBe(COMPANY_A);
    });
});
