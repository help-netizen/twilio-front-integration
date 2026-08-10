jest.mock('../backend/src/db/technicianDirectoryQueries', () => ({
    listActiveTechnicians: jest.fn(),
    resolveUuidToExternal: jest.fn(),
}));

const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const rosterService = require('../backend/src/services/technicianRosterService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const MAPPED_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NATIVE_ONLY_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
    jest.clearAllMocks();
    directoryQueries.listActiveTechnicians.mockResolvedValue([]);
    directoryQueries.resolveUuidToExternal.mockResolvedValue(null);
});

it('reads the native directory and emits assignment-compatible ids', async () => {
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
            id: '17',
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
        .resolves.toMatchObject({ id: '17', technician_uuid: MAPPED_UUID });
    await expect(rosterService.requireActive(COMPANY, MAPPED_UUID.toUpperCase()))
        .resolves.toMatchObject({ id: '17', technician_uuid: MAPPED_UUID });
});

it('rejects a missing company before reading the native directory', async () => {
    await expect(rosterService.listActive()).rejects.toMatchObject({
        code: 'INVALID_COMPANY',
        httpStatus: 400,
    });
    expect(directoryQueries.listActiveTechnicians).not.toHaveBeenCalled();
});
