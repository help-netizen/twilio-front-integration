jest.mock('../backend/src/services/zenbookerClient', () => ({
    getTeamMembers: jest.fn(),
}));
jest.mock('../backend/src/db/technicianDirectoryQueries', () => ({
    listActiveTechnicians: jest.fn(),
    resolveUuidToExternal: jest.fn(),
}));

const zenbookerClient = require('../backend/src/services/zenbookerClient');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const rosterService = require('../backend/src/services/technicianRosterService');
const flags = require('../backend/src/config/featureFlags');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const OTHER_COMPANY = '00000000-0000-0000-0000-00000000000b';
const MAPPED_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NATIVE_ONLY_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = {
    id: 17,
    first_name: 'Alex',
    last_name: 'Rivera',
    phone: '+12125550123',
    email: 'alex@example.com',
    user_status: 'activated',
    service_provider: true,
    deactivated: false,
    assigned_territories: [{ id: 3, name: 'North' }],
    skill_tags: [{ id: 9, name: 'HVAC' }],
    calendar_color: '#7f42e1',
    avatar: '//cdn.example.com/alex.jpg',
};

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TECHNICIAN_DIRECTORY_MODE;
    delete process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS;
    zenbookerClient.getTeamMembers.mockResolvedValue([MEMBER]);
    directoryQueries.listActiveTechnicians.mockResolvedValue([]);
    directoryQueries.resolveUuidToExternal.mockResolvedValue(null);
});

afterAll(() => {
    delete process.env.TECHNICIAN_DIRECTORY_MODE;
    delete process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS;
});

it('keeps the default roster minimal for operational consumers', async () => {
    await expect(rosterService.listActive(COMPANY)).resolves.toEqual([{
        id: '17', name: 'Alex Rivera', active: true,
    }]);
    expect(zenbookerClient.getTeamMembers).toHaveBeenCalledWith(
        { service_provider: true, deactivated: false },
        COMPANY
    );
});

it('includes only the approved Zenbooker profile fields for Settings', async () => {
    await expect(rosterService.listActive(COMPANY, { includeZenbookerProfile: true }))
        .resolves.toEqual([{
            id: '17',
            name: 'Alex Rivera',
            active: true,
            zenbooker: {
                name: 'Alex Rivera',
                phone: '+12125550123',
                email: 'alex@example.com',
                user_status: 'activated',
                assigned_territories: [{ id: '3', name: 'North' }],
                skill_tags: [{ id: '9', name: 'HVAC' }],
                calendar_color: '#7f42e1',
                avatar: '//cdn.example.com/alex.jpg',
            },
        }]);
});

it('filters inactive and non-provider rows before returning profile data', async () => {
    zenbookerClient.getTeamMembers.mockResolvedValue([
        MEMBER,
        { ...MEMBER, id: 18, deactivated: true },
        { ...MEMBER, id: 19, service_provider: false },
    ]);
    const result = await rosterService.listActive(COMPANY, { includeZenbookerProfile: true });
    expect(result.map(member => member.id)).toEqual(['17']);
});

it('native mode reads the directory, emits compatibility ids, and never calls Zenbooker', async () => {
    process.env.TECHNICIAN_DIRECTORY_MODE = 'native';
    process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS = COMPANY;
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
    expect(zenbookerClient.getTeamMembers).not.toHaveBeenCalled();
});

it('compare mode returns legacy and logs active-set and name mismatches', async () => {
    process.env.TECHNICIAN_DIRECTORY_MODE = 'compare';
    process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS = COMPANY;
    directoryQueries.listActiveTechnicians.mockResolvedValue([
        {
            id: MAPPED_UUID,
            display_name: 'Different Name',
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
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await rosterService.listActive(COMPANY);

    expect(result).toEqual([{ id: '17', name: 'Alex Rivera', active: true }]);
    expect(warn).toHaveBeenCalledWith(
        '[TechnicianRoster] Native roster mismatch:',
        expect.objectContaining({
            company_id: COMPANY,
            missing_in_native: [],
            missing_in_legacy: [NATIVE_ONLY_UUID],
            name_mismatches: [{
                id: '17',
                legacy_name: 'Alex Rivera',
                native_name: 'Different Name',
            }],
        })
    );
    warn.mockRestore();
});

it('requireActive accepts mapped external ids and native UUIDs in native mode', async () => {
    process.env.TECHNICIAN_DIRECTORY_MODE = 'native';
    process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS = COMPANY;
    directoryQueries.listActiveTechnicians.mockResolvedValue([
        {
            id: MAPPED_UUID,
            display_name: 'Alex Rivera',
            active: true,
            zenbooker_external_id: '17',
        },
    ]);

    await expect(rosterService.requireActive(COMPANY, '17'))
        .resolves.toMatchObject({ id: '17', technician_uuid: MAPPED_UUID });
    await expect(rosterService.requireActive(COMPANY, MAPPED_UUID.toUpperCase()))
        .resolves.toMatchObject({ id: '17', technician_uuid: MAPPED_UUID });
});

it('defaults to legacy and fails closed for an unallowlisted company or malformed allowlist', async () => {
    expect(flags.getTechnicianDirectoryMode(COMPANY)).toBe('legacy');
    await rosterService.listActive(COMPANY);
    expect(zenbookerClient.getTeamMembers).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    zenbookerClient.getTeamMembers.mockResolvedValue([MEMBER]);
    process.env.TECHNICIAN_DIRECTORY_MODE = 'native';
    process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS = COMPANY;
    expect(flags.getTechnicianDirectoryMode(OTHER_COMPANY)).toBe('legacy');
    await rosterService.listActive(OTHER_COMPANY);
    expect(zenbookerClient.getTeamMembers).toHaveBeenCalledWith(
        { service_provider: true, deactivated: false },
        OTHER_COMPANY
    );
    expect(directoryQueries.listActiveTechnicians).not.toHaveBeenCalled();

    jest.clearAllMocks();
    zenbookerClient.getTeamMembers.mockResolvedValue([MEMBER]);
    process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS = `${COMPANY},not-a-uuid`;
    expect(flags.getTechnicianDirectoryMode(COMPANY)).toBe('legacy');
    await rosterService.listActive(COMPANY);
    expect(zenbookerClient.getTeamMembers).toHaveBeenCalledTimes(1);
    expect(directoryQueries.listActiveTechnicians).not.toHaveBeenCalled();
});

it('rejects a missing company before either roster source can be called', async () => {
    await expect(rosterService.listActive()).rejects.toMatchObject({
        code: 'INVALID_COMPANY',
        httpStatus: 400,
    });
    expect(zenbookerClient.getTeamMembers).not.toHaveBeenCalled();
    expect(directoryQueries.listActiveTechnicians).not.toHaveBeenCalled();
});
