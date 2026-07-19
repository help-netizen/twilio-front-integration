jest.mock('../backend/src/services/zenbookerClient', () => ({
    getTeamMembers: jest.fn(),
}));

const zenbookerClient = require('../backend/src/services/zenbookerClient');
const rosterService = require('../backend/src/services/technicianRosterService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
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
    zenbookerClient.getTeamMembers.mockResolvedValue([MEMBER]);
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
