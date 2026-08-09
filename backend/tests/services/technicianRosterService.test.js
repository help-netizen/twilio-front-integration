'use strict';

/**
 * ZB-DECOUPLE Phase C1 — the mode-switch contract that /api/zenbooker/team-members
 * now rides on (the route delegates to technicianRosterService.listActive).
 *
 * The three behaviors that must never regress:
 *  1. native mode serves the native directory and NEVER calls Zenbooker
 *     (id = legacy ZB external id when present → assignment flows stay
 *     byte-compatible; uuid fallback only for ZB-less technicians);
 *  2. legacy mode keeps the ZB fetch and the {id, name, active} shape;
 *  3. a ZB outage in legacy mode surfaces as TechnicianRosterError httpStatus 502
 *     (the route maps err.httpStatus — NOT err.status — to the response code).
 */

const mockListActiveTechnicians = jest.fn();
const mockGetTeamMembers = jest.fn();
let mockMode = 'legacy';

jest.mock('../../src/db/technicianDirectoryQueries', () => ({
    listActiveTechnicians: (...args) => mockListActiveTechnicians(...args),
}));
jest.mock('../../src/services/zenbookerClient', () => ({
    getTeamMembers: (...args) => mockGetTeamMembers(...args),
}));
jest.mock('../../src/config/featureFlags', () => ({
    getTechnicianDirectoryMode: () => mockMode,
}));

const roster = require('../../src/services/technicianRosterService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('technicianRosterService.listActive — ZB-DECOUPLE mode switch (Phase C1)', () => {
    beforeEach(() => {
        mockListActiveTechnicians.mockReset();
        mockGetTeamMembers.mockReset();
    });

    it('native mode serves the native directory and never calls Zenbooker', async () => {
        mockMode = 'native';
        mockListActiveTechnicians.mockResolvedValue([
            { id: UUID_A, display_name: 'Ali', zenbooker_external_id: '1770085964093x308143070595776500' },
            { id: UUID_B, display_name: 'Native Only', zenbooker_external_id: null },
        ]);

        const list = await roster.listActive(COMPANY);

        expect(mockGetTeamMembers).not.toHaveBeenCalled();
        expect(mockListActiveTechnicians).toHaveBeenCalledWith(COMPANY);
        expect(list).toEqual([
            // legacy ZB id preserved → downstream assignment stays byte-compatible
            { id: '1770085964093x308143070595776500', name: 'Ali', active: true, technician_uuid: UUID_A },
            // no ZB identity → uuid fallback
            { id: UUID_B, name: 'Native Only', active: true, technician_uuid: UUID_B },
        ]);
    });

    it('legacy mode fetches Zenbooker and maps {id, name, active}', async () => {
        mockMode = 'legacy';
        mockGetTeamMembers.mockResolvedValue([
            { id: 42, first_name: 'Robert', last_name: 'R', service_provider: true },
            { id: 43, name: 'Russell', deactivated: true }, // filtered out
        ]);

        const list = await roster.listActive(COMPANY);

        expect(mockListActiveTechnicians).not.toHaveBeenCalled();
        expect(list).toEqual([
            { id: '42', name: 'Robert R', active: true },
        ]);
    });

    it('a ZB outage in legacy mode is a TechnicianRosterError with httpStatus 502', async () => {
        mockMode = 'legacy';
        mockGetTeamMembers.mockRejectedValue(new Error('ZENBOOKER_API_KEY is not configured'));

        await expect(roster.listActive(COMPANY)).rejects.toMatchObject({
            name: 'TechnicianRosterError',
            code: 'ZENBOOKER_UNAVAILABLE',
            httpStatus: 502,
        });
        // and native was never consulted — legacy fails closed, not sideways
        expect(mockListActiveTechnicians).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID company id before touching either plane', async () => {
        mockMode = 'native';
        await expect(roster.listActive('not-a-uuid')).rejects.toMatchObject({
            name: 'TechnicianRosterError',
            code: 'INVALID_COMPANY',
            httpStatus: 400,
        });
        expect(mockGetTeamMembers).not.toHaveBeenCalled();
        expect(mockListActiveTechnicians).not.toHaveBeenCalled();
    });
});
