'use strict';

/**
 * ZB-DECOUPLE Phase E — timeOffService provider own-scope goes native.
 *
 * A provider with `assigned_only` sees ONLY his own time-off. Pre-E this resolved
 * his id through the ZB bridge, so a native-only technician (no bridge) was
 * denied his OWN blocks. Now native mode resolves crm_user → technician; legacy
 * keeps the bridge; both deny-by-default when unresolved (E-14). Request params
 * never widen a provider's visibility (S-8).
 */

const mockListRange = jest.fn();
const mockGetZbId = jest.fn();
const mockFindActiveTechByUser = jest.fn();
let mockMode = 'native';

jest.mock('../../src/db/timeOffQueries', () => ({ listRange: (...a) => mockListRange(...a) }));
jest.mock('../../src/db/membershipQueries', () => ({
    getZenbookerTeamMemberIdForUser: (...a) => mockGetZbId(...a),
}));
jest.mock('../../src/db/technicianDirectoryQueries', () => ({
    findActiveTechnicianByCrmUserId: (...a) => mockFindActiveTechByUser(...a),
}));
jest.mock('../../src/services/technicianRosterService', () => ({}));
jest.mock('../../src/config/featureFlags', () => ({ getTechnicianDirectoryMode: () => mockMode }));

const timeOffService = require('../../src/services/timeOffService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const USER = 'a1b2c3d4-0000-4000-8000-000000000042';
const TECH_UUID = '73edf9e7-bbbf-4129-a690-2eb6fc72a1ef';
const RANGE = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' };

describe('timeOffService.listTimeOff provider own-scope — ZB-DECOUPLE Phase E', () => {
    beforeEach(() => {
        mockListRange.mockReset().mockResolvedValue([{ id: 'block-1' }]);
        mockGetZbId.mockReset();
        mockFindActiveTechByUser.mockReset();
    });

    it('native mode: resolves the provider OWN id from crm_user (no ZB bridge)', async () => {
        mockMode = 'native';
        mockFindActiveTechByUser.mockResolvedValue({ id: TECH_UUID });
        const out = await timeOffService.listTimeOff(COMPANY, RANGE, { assignedOnly: true, userId: USER });
        expect(mockFindActiveTechByUser).toHaveBeenCalledWith(COMPANY, USER);
        expect(mockGetZbId).not.toHaveBeenCalled();
        // scoped to HIS technician, regardless of any request technicianId (S-8)
        expect(mockListRange).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ technicianId: TECH_UUID }));
        expect(out).toEqual([{ id: 'block-1' }]);
    });

    it('native mode: a user with no native technician is denied (empty, not tenant-wide)', async () => {
        mockMode = 'native';
        mockFindActiveTechByUser.mockResolvedValue(null);
        const out = await timeOffService.listTimeOff(COMPANY, RANGE, { assignedOnly: true, userId: USER });
        expect(out).toEqual([]);
        expect(mockListRange).not.toHaveBeenCalled();
    });

    it('legacy mode: keeps the ZB bridge resolution', async () => {
        mockMode = 'legacy';
        mockGetZbId.mockResolvedValue('1770x-ali');
        await timeOffService.listTimeOff(COMPANY, RANGE, { assignedOnly: true, userId: USER });
        expect(mockGetZbId).toHaveBeenCalledWith(COMPANY, USER);
        expect(mockFindActiveTechByUser).not.toHaveBeenCalled();
        expect(mockListRange).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ technicianId: '1770x-ali' }));
    });

    it('a provider request without a userId is denied outright', async () => {
        mockMode = 'native';
        const out = await timeOffService.listTimeOff(COMPANY, RANGE, { assignedOnly: true, userId: null });
        expect(out).toEqual([]);
        expect(mockListRange).not.toHaveBeenCalled();
    });

    it('non-provider (no scope) reads the full range unscoped', async () => {
        mockMode = 'native';
        await timeOffService.listTimeOff(COMPANY, RANGE, { assignedOnly: false });
        expect(mockFindActiveTechByUser).not.toHaveBeenCalled();
        expect(mockListRange).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ technicianId: undefined }));
    });
});
