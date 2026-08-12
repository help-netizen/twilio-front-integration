jest.mock('../backend/src/db/technicianDirectoryQueries', () => ({
    listActiveTechnicians: jest.fn(),
    resolveTechnicianUuid: jest.fn(),
}));

const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const rosterService = require('../backend/src/services/technicianRosterService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const MAPPED_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NATIVE_ONLY_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
    jest.clearAllMocks();
    directoryQueries.listActiveTechnicians.mockResolvedValue([]);
    directoryQueries.resolveTechnicianUuid.mockImplementation(async (_companyId, id) => {
        if (String(id).toLowerCase() === MAPPED_UUID || String(id) === '17') return MAPPED_UUID;
        return null;
    });
});

it('reads the native directory and emits only Albusto technician UUIDs', async () => {
    directoryQueries.listActiveTechnicians.mockResolvedValue([
        {
            id: MAPPED_UUID,
            display_name: 'Alex Rivera',
            active: true,
            zenbooker_external_id: '17',
        },
        {
            id: NATIVE_ONLY_UUID,
            display_name: 'Native Only',
            active: true,
            zenbooker_external_id: null,
        },
    ]);

    await expect(rosterService.listActive(COMPANY)).resolves.toEqual([
        {
            id: MAPPED_UUID,
            name: 'Alex Rivera',
            active: true,
            technician_uuid: MAPPED_UUID,
        },
        {
            id: NATIVE_ONLY_UUID,
            name: 'Native Only',
            active: true,
            technician_uuid: NATIVE_ONLY_UUID,
        },
    ]);
    expect(directoryQueries.listActiveTechnicians).toHaveBeenCalledWith(COMPANY);
});

it('requireActive accepts mapped external ids and native UUIDs', async () => {
    directoryQueries.listActiveTechnicians.mockResolvedValue([{
        id: MAPPED_UUID,
        display_name: 'Alex Rivera',
        active: true,
        zenbooker_external_id: '17',
    }]);

    await expect(rosterService.requireActive(COMPANY, '17'))
        .resolves.toMatchObject({ id: MAPPED_UUID, technician_uuid: MAPPED_UUID });
    await expect(rosterService.requireActive(COMPANY, MAPPED_UUID.toUpperCase()))
        .resolves.toMatchObject({ id: MAPPED_UUID, technician_uuid: MAPPED_UUID });
});

it('canonicalizes legacy assignment ids, preserves names, and deduplicates aliases', async () => {
    directoryQueries.listActiveTechnicians.mockResolvedValue([{
        id: MAPPED_UUID,
        display_name: 'Alex Rivera',
        active: true,
    }]);

    await expect(rosterService.canonicalizeAssignments(COMPANY, [
        { id: '17', name: 'Historical spelling', source: 'mobile' },
        { id: MAPPED_UUID, name: 'Duplicate alias' },
    ])).resolves.toEqual([{
        id: MAPPED_UUID,
        name: 'Historical spelling',
        source: 'mobile',
    }]);
});

it('rejects a missing company before reading the native directory', async () => {
    await expect(rosterService.listActive()).rejects.toMatchObject({
        code: 'INVALID_COMPANY',
        httpStatus: 400,
    });
    expect(directoryQueries.listActiveTechnicians).not.toHaveBeenCalled();
});
