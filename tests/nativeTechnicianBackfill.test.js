'use strict';

const {
    BackfillRefusalError,
    parseArgs,
    readConfigExternalIds,
    resolveDisplayName,
    run,
} = require('../scripts/backfillNativeTechnicians');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const LIVE_TECH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STALE_TECH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NATIVE_TECH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function defaultState(overrides = {}) {
    return {
        jobs: [],
        configIds: [],
        profiles: [],
        technicians: [],
        mappings: [],
        crmUsers: [],
        ...overrides,
    };
}

function makeDependencies({ roster = [{ id: 'zb-live', name: 'Live Tech' }], state = defaultState(), resolve, bridge } = {}) {
    const query = jest.fn(async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
        if (/FROM companies/.test(sql)) return { rows: [{ id: params[0] }] };
        if (/WITH snapshots AS/.test(sql)) return { rows: state.jobs };
        if (/FROM \(\s*SELECT NULLIF\(BTRIM\(tech_id\)/s.test(sql)) {
            return { rows: state.configIds.map(external_id => ({ external_id })) };
        }
        if (/FROM technician_profiles\s+WHERE company_id/.test(sql)) return { rows: state.profiles };
        if (/FROM technicians\s+WHERE company_id/.test(sql)) return { rows: state.technicians };
        if (/FROM technician_external_identities e/.test(sql)) return { rows: state.mappings };
        if (/FROM company_memberships m/.test(sql)) return { rows: state.crmUsers };
        if (/UPDATE technicians/.test(sql)) return { rows: [{ id: params[1] }] };
        throw new Error(`Unexpected SQL in test: ${sql}`);
    });
    const client = { query, release: jest.fn() };
    const db = { query, getClient: jest.fn().mockResolvedValue(client) };
    const directoryQueries = {
        resolveExternalToUuid: jest.fn(async (_companyId, _source, externalId) => {
            if (resolve) return resolve(externalId);
            const mapping = state.mappings.find(row => row.external_id === externalId);
            return mapping?.technician_id || null;
        }),
        createTechnician: jest.fn(async ({ displayName, active, crmUserId }) => ({
            id: `new-${displayName}-${active}-${crmUserId || 'none'}`,
        })),
        upsertExternalIdentity: jest.fn(async ({ technicianId }) => ({ technician_id: technicianId })),
        linkCrmUser: jest.fn(async ({ technicianId, crmUserId }) => ({ id: technicianId, crm_user_id: crmUserId })),
    };
    const membershipQueries = {
        resolveProviderUserIds: jest.fn(async (_companyId, externalIds) => bridge ? bridge(externalIds[0]) : []),
    };
    const zenbookerClient = {
        getClientForCompany: jest.fn().mockResolvedValue({ companyScoped: true }),
        getTeamMembers: jest.fn().mockResolvedValue(roster),
    };
    return {
        db,
        directoryQueries,
        membershipQueries,
        zenbookerClient,
        output: jest.fn(),
        query,
        client,
    };
}

function expectNoDataWrites(deps) {
    expect(deps.directoryQueries.createTechnician).not.toHaveBeenCalled();
    expect(deps.directoryQueries.upsertExternalIdentity).not.toHaveBeenCalled();
    expect(deps.directoryQueries.linkCrmUser).not.toHaveBeenCalled();
    const dataWrites = deps.query.mock.calls.filter(([sql]) => /^(?:\s*)(?:INSERT|UPDATE|DELETE)\b/i.test(sql));
    expect(dataWrites).toEqual([]);
}

describe('argument and name resolution', () => {
    test('dry-run is the default and both documented company-id syntaxes work', () => {
        expect(parseArgs(['--company-id', COMPANY])).toMatchObject({ companyId: COMPANY, dryRun: true, apply: false });
        expect(parseArgs([`--company-id=${COMPANY}`, '--apply'])).toMatchObject({ companyId: COMPANY, dryRun: false, apply: true });
    });

    test('name precedence is live roster → latest job → profile → CRM user → external id', () => {
        const base = {
            liveName: ' Live ',
            jobName: 'Job',
            profileName: 'Profile',
            crmUserName: 'CRM',
            externalId: 'zb-1',
        };
        expect(resolveDisplayName(base)).toBe('Live');
        expect(resolveDisplayName({ ...base, liveName: ' ' })).toBe('Job');
        expect(resolveDisplayName({ ...base, liveName: null, jobName: '' })).toBe('Profile');
        expect(resolveDisplayName({ ...base, liveName: null, jobName: null, profileName: null })).toBe('CRM');
        expect(resolveDisplayName({ ...base, liveName: null, jobName: null, profileName: null, crmUserName: null })).toBe('zb-1');
    });
});

test('dry-run reports the plan and performs zero writes', async () => {
    const deps = makeDependencies();
    const result = await run(['--company-id', COMPANY], deps);
    expect(result).toMatchObject({
        mode: 'dry-run',
        writes_performed: 0,
        summary: { create_technicians: 1, create_external_identities: 1 },
    });
    expect(deps.zenbookerClient.getTeamMembers).toHaveBeenCalledWith(
        { service_provider: true, deactivated: false },
        COMPANY
    );
    expectNoDataWrites(deps);
});

describe('refusal guards abort before writes', () => {
    test('no company-scoped client', async () => {
        const deps = makeDependencies();
        deps.zenbookerClient.getClientForCompany.mockResolvedValue(null);
        await expect(run(['--company-id', COMPANY, '--apply'], deps)).rejects.toMatchObject({
            code: 'NO_COMPANY_SCOPED_CLIENT',
        });
        expect(deps.zenbookerClient.getTeamMembers).not.toHaveBeenCalled();
        expectNoDataWrites(deps);
    });

    test.each([
        ['failed', new Error('upstream unavailable'), 'ROSTER_FETCH_FAILED'],
        ['unexpectedly empty', [], 'ROSTER_UNEXPECTEDLY_EMPTY'],
    ])('roster fetch %s', async (_label, outcome, code) => {
        const deps = makeDependencies();
        if (outcome instanceof Error) deps.zenbookerClient.getTeamMembers.mockRejectedValue(outcome);
        else deps.zenbookerClient.getTeamMembers.mockResolvedValue(outcome);
        await expect(run(['--company-id', COMPANY, '--apply'], deps)).rejects.toMatchObject({ code });
        expectNoDataWrites(deps);
    });

    test('duplicate external ids in the fetched roster', async () => {
        const deps = makeDependencies({
            roster: [{ id: 'same', name: 'One' }, { id: ' same ', name: 'Two' }],
        });
        await expect(run(['--company-id', COMPANY, '--apply'], deps)).rejects.toMatchObject({
            code: 'DUPLICATE_ROSTER_EXTERNAL_ID',
        });
        expectNoDataWrites(deps);
    });

    test('one external id resolving to multiple active memberships', async () => {
        const deps = makeDependencies({ bridge: () => [USER, NATIVE_TECH] });
        await expect(run(['--company-id', COMPANY, '--apply'], deps)).rejects.toMatchObject({
            code: 'EXTERNAL_ID_MULTIPLE_MEMBERSHIPS',
        });
        expectNoDataWrites(deps);
        expect(deps.client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('one CRM user linking to multiple technicians', async () => {
        const deps = makeDependencies({
            roster: [{ id: 'zb-a', name: 'A' }, { id: 'zb-b', name: 'B' }],
            bridge: () => [USER],
        });
        const attempt = run(['--company-id', COMPANY, '--apply'], deps);
        await expect(attempt).rejects.toBeInstanceOf(BackfillRefusalError);
        await expect(attempt).rejects.toMatchObject({ code: 'CRM_USER_MULTIPLE_TECHNICIANS' });
        expectNoDataWrites(deps);
    });
});

test('deactivation changes only previously mapped Zenbooker technicians', async () => {
    const state = defaultState({
        technicians: [
            { id: LIVE_TECH, display_name: 'Live Tech', active: true, crm_user_id: null },
            { id: STALE_TECH, display_name: 'Stale Tech', active: true, crm_user_id: null },
            { id: NATIVE_TECH, display_name: 'Native Only', active: true, crm_user_id: null },
        ],
        mappings: [
            { external_id: 'zb-live', technician_id: LIVE_TECH },
            { external_id: 'zb-stale', technician_id: STALE_TECH },
        ],
    });
    const deps = makeDependencies({ state });
    const result = await run(['--company-id', COMPANY, '--apply'], deps);
    expect(result.deactivate_technician_ids).toEqual([STALE_TECH]);
    const updates = deps.query.mock.calls.filter(([sql]) => /UPDATE technicians/.test(sql));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([COMPANY, STALE_TECH, 'Stale Tech', false]);
    expect(JSON.stringify(updates)).not.toContain(NATIVE_TECH);
});

test('__company__ base sentinel is excluded from historical closure import', async () => {
    const queryable = {
        query: jest.fn().mockResolvedValue({
            rows: [{ external_id: '__company__' }, { external_id: 'zb-config' }],
        }),
    };
    await expect(readConfigExternalIds(queryable, COMPANY)).resolves.toEqual(['zb-config']);
    const [sql, params] = queryable.query.mock.calls[0];
    expect(sql).toMatch(/FROM technician_base_locations[\s\S]*BTRIM\(tech_id\) <> '__company__'/);
    expect(params).toEqual([COMPANY]);
});

test('rerun resolves existing UUIDs and is a zero-write no-op', async () => {
    const state = defaultState({
        technicians: [{ id: LIVE_TECH, display_name: 'Live Tech', active: true, crm_user_id: USER }],
        mappings: [{ external_id: 'zb-live', technician_id: LIVE_TECH }],
        crmUsers: [{ id: USER, full_name: 'Live Tech' }],
    });
    const deps = makeDependencies({
        state,
        resolve: externalId => externalId === 'zb-live' ? LIVE_TECH : null,
        bridge: externalId => externalId === 'zb-live' ? [USER] : [],
    });
    const result = await run(['--company-id', COMPANY, '--apply'], deps);
    expect(deps.directoryQueries.resolveExternalToUuid).toHaveBeenCalledWith(COMPANY, 'zenbooker', 'zb-live');
    expect(result.summary).toEqual({
        create_technicians: 0,
        create_external_identities: 0,
        update_names: 0,
        activate: 0,
        deactivate: 0,
        change_crm_user_links: 0,
    });
    expect(result.writes_performed).toBe(0);
    expectNoDataWrites(deps);
    expect(deps.client.query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(1);
    expect(deps.client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
});
