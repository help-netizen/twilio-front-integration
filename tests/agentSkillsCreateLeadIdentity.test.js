/**
 * UNKNOWN-CALLER-LEAD-001 — createLead identity propagation.
 *
 * Runs the real runSkill choke-point, verification gate, and createLead skill.
 * Only the DB-facing identity resolver and lead insert are mocked.
 */

'use strict';

const CO_A = '00000000-0000-0000-0000-000000000001';
const CO_B = '00000000-0000-0000-0000-000000000002';

jest.mock('../backend/src/services/agentSkills/identityResolver', () => {
    const real = jest.requireActual('../backend/src/services/agentSkills/identityResolver');
    return { ...real, resolve: jest.fn() };
});
jest.mock('../backend/src/services/leadsService', () => ({
    createLead: jest.fn(),
}));
jest.mock('../backend/src/services/slotEngineService', () => ({
    resolveTimezone: jest.fn(),
    tzCombine: jest.fn(),
}));

const identityResolver = require('../backend/src/services/agentSkills/identityResolver');
const leadsService = require('../backend/src/services/leadsService');
const { runSkill } = require('../backend/src/services/agentSkills');

function noMatch() {
    return {
        matchType: 'new',
        contactId: null,
        customerName: null,
        matchedPhone: null,
        ambiguousCount: 0,
        phoneCandidateCount: 0,
        contact: null,
    };
}

function existing(overrides = {}) {
    return {
        matchType: 'existing',
        contactId: 4093,
        customerName: 'Terry T',
        matchedPhone: '8564043689',
        ambiguousCount: 0,
        phoneCandidateCount: 1,
        contact: { id: 4093, name: 'Terry T', zips: [], streets: [] },
        ...overrides,
    };
}

async function create(companyId, input = {}) {
    return runSkill('createLead', companyId, { source: 'test' }, {
        phone: '+18564043689',
        ...input,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    identityResolver.resolve.mockResolvedValue(noMatch());
    leadsService.createLead.mockResolvedValue({ uuid: 'lead-001' });
});

test('known caller: unique server-resolved contact links the lead and overrides model name with stored real name', async () => {
    identityResolver.resolve.mockResolvedValue(existing());

    const out = await create(CO_A, {
        firstName: 'Unknown',
        lastName: 'Caller',
        contactId: 999999,
    });

    expect(out).toEqual({ success: true, leadId: 'lead-001' });
    expect(leadsService.createLead).toHaveBeenCalledWith(
        expect.objectContaining({
            FirstName: 'Terry',
            LastName: 'T',
            Phone: '+18564043689',
            contact_id: 4093,
        }),
        CO_A,
    );
});

test('unknown caller: legacy Unknown Caller fallback remains unlinked', async () => {
    identityResolver.resolve.mockResolvedValue(noMatch());

    await create(CO_A);

    const body = leadsService.createLead.mock.calls[0][0];
    expect(body).toMatchObject({ FirstName: 'Unknown', LastName: 'Caller' });
    expect(body).not.toHaveProperty('contact_id');
});

test('ambiguous caller: explicit ambiguous resolution remains Unknown Caller and unlinked', async () => {
    identityResolver.resolve.mockResolvedValue({
        matchType: 'ambiguous',
        contactId: null,
        customerName: null,
        matchedPhone: '8564043689',
        ambiguousCount: 2,
        phoneCandidateCount: 0,
        contact: null,
    });

    await create(CO_A);

    const body = leadsService.createLead.mock.calls[0][0];
    expect(body).toMatchObject({ FirstName: 'Unknown', LastName: 'Caller' });
    expect(body).not.toHaveProperty('contact_id');
});

test('shared phone: a take-latest voice identity is not attached when the server saw multiple phone candidates', async () => {
    identityResolver.resolve.mockResolvedValue(existing({
        contactId: 777,
        customerName: 'Newest Contact',
        phoneCandidateCount: 2,
    }));

    await create(CO_A);

    const body = leadsService.createLead.mock.calls[0][0];
    expect(body).toMatchObject({ FirstName: 'Unknown', LastName: 'Caller' });
    expect(body).not.toHaveProperty('contact_id');
});

test('model-supplied contact ids are stripped before resolution and never written on an unresolved call', async () => {
    await create(CO_A, { contactId: 4093, contact_id: 4093 });

    const resolverClaims = identityResolver.resolve.mock.calls[0][1];
    expect(resolverClaims).not.toHaveProperty('contactId');
    expect(resolverClaims).not.toHaveProperty('contact_id');
    expect(leadsService.createLead.mock.calls[0][0]).not.toHaveProperty('contact_id');
});

test('tenant scoping: resolver and lead insert use the dispatcher company, never payload company/contact claims', async () => {
    identityResolver.resolve.mockImplementation(async (companyId) => existing({
        contactId: companyId === CO_B ? 84093 : 4093,
        customerName: companyId === CO_B ? 'Tenant B Caller' : 'Tenant A Caller',
    }));

    await create(CO_B, { companyId: CO_A, contactId: 4093 });

    expect(identityResolver.resolve.mock.calls[0][0]).toBe(CO_B);
    expect(leadsService.createLead).toHaveBeenCalledWith(
        expect.objectContaining({
            FirstName: 'Tenant',
            LastName: 'B Caller',
            contact_id: 84093,
        }),
        CO_B,
    );
});
