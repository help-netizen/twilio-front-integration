'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const { PULSE_INACTIVE_JOB_STATUSES } = require('../backend/src/middleware/providerScope');
const {
    buildActiveAssignedContactPredicate,
    providerHasActiveJobForContact,
    listProvidersWithActiveJobForContact,
} = require('../backend/src/db/providerContactAccessQueries');

beforeEach(() => db.query.mockReset());

describe('shared active assigned-contact predicate', () => {
    test('uses the one canonical deny-list and leaves null/custom statuses active', () => {
        const sql = buildActiveAssignedContactPredicate({
            jobsAlias: 'pj',
            contactIdExpression: 'c.id',
            companyPlaceholder: '$1',
            userPlaceholder: '$2',
        });

        expect(PULSE_INACTIVE_JOB_STATUSES).toEqual(['Canceled', 'Job is Done']);
        expect(sql).toContain('pj.contact_id = c.id');
        expect(sql).toContain('pj.company_id = $1');
        expect(sql).toContain('pj.assigned_provider_user_ids @> $2::jsonb');
        expect(sql).toContain("pj.blanc_status <> ALL(ARRAY['Canceled', 'Job is Done']::text[])");
        expect(sql).toContain('pj.blanc_status IS NULL');
        expect(sql).not.toMatch(/blanc_status\s*=\s*ANY/);
    });

    test('rejects unsafe/missing server-owned SQL fragments', () => {
        expect(() => buildActiveAssignedContactPredicate({
            jobsAlias: 'pj; DROP TABLE jobs',
            contactIdExpression: 'c.id',
            companyPlaceholder: '$1',
            userPlaceholder: '$2',
        })).toThrow('jobsAlias must be a SQL identifier');
    });

    test('provider lookup validates contact and job in the same company', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

        await expect(providerHasActiveJobForContact('company-a', 'user-a', 42))
            .resolves.toBe(true);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('c.company_id = $1');
        expect(sql).toContain('c.id = $3');
        expect(sql).toContain('pj.company_id = $1');
        expect(params).toEqual(['company-a', JSON.stringify(['user-a']), 42]);
    });

    test('provider list is active-member, user, company, contact, and role scoped', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ user_id: 'provider-a' }] });

        await expect(listProvidersWithActiveJobForContact('company-a', 42))
            .resolves.toEqual(['provider-a']);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("m.status = 'active'");
        expect(sql).toContain("m.role_key = 'provider'");
        expect(sql).toContain("u.status = 'active'");
        expect(sql).toContain('c.company_id = $1');
        expect(sql).toContain('c.id = $2');
        expect(sql).toContain('pj.company_id = c.company_id');
        expect(params).toEqual(['company-a', 42]);
    });

    test('all active-contact consumers import the helper instead of their own status list', () => {
        const root = path.join(__dirname, '..');
        for (const relativePath of [
            'backend/src/routes/pulse.js',
            'backend/src/routes/messaging.js',
            'backend/src/db/conversationsQueries.js',
            'backend/src/db/timelinesQueries.js',
            'backend/src/services/contactsService.js',
        ]) {
            const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
            expect(source).toMatch(/providerContactAccessQueries/);
            expect(source).not.toContain('PULSE_INACTIVE_JOB_STATUSES');
            expect(source).not.toMatch(/blanc_status\s+IS\s+NULL\s+OR[\s\S]{0,120}blanc_status\s+<>\s+ALL/);
        }
    });
});
