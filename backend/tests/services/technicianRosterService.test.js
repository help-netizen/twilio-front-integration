'use strict';

/**
 * ZB-DECOUPLE Phase F5 — the native roster contract that /api/zenbooker/team-members
 * now rides on (the route delegates to technicianRosterService.listActive).
 *
 * Native results preserve the assignment-compatible id shape: historical
 * external id when present, native uuid fallback otherwise.
 */

const mockListActiveTechnicians = jest.fn();

jest.mock('../../src/db/technicianDirectoryQueries', () => ({
    listActiveTechnicians: (...args) => mockListActiveTechnicians(...args),
}));

const roster = require('../../src/services/technicianRosterService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('technicianRosterService.listActive — native directory (Phase F5)', () => {
    beforeEach(() => {
        mockListActiveTechnicians.mockReset();
    });

    it('serves the native directory with assignment-compatible ids', async () => {
        mockListActiveTechnicians.mockResolvedValue([
            { id: UUID_A, display_name: 'Ali', zenbooker_external_id: '1770085964093x308143070595776500' },
            { id: UUID_B, display_name: 'Native Only', zenbooker_external_id: null },
        ]);

        const list = await roster.listActive(COMPANY);

        expect(mockListActiveTechnicians).toHaveBeenCalledWith(COMPANY);
        expect(list).toEqual([
            // legacy ZB id preserved → downstream assignment stays byte-compatible
            { id: '1770085964093x308143070595776500', name: 'Ali', active: true, technician_uuid: UUID_A },
            // no ZB identity → uuid fallback
            { id: UUID_B, name: 'Native Only', active: true, technician_uuid: UUID_B },
        ]);
    });

    it('rejects a non-UUID company id before touching the native directory', async () => {
        await expect(roster.listActive('not-a-uuid')).rejects.toMatchObject({
            name: 'TechnicianRosterError',
            code: 'INVALID_COMPANY',
            httpStatus: 400,
        });
        expect(mockListActiveTechnicians).not.toHaveBeenCalled();
    });
});
