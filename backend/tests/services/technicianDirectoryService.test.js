'use strict';

/**
 * ZB-DECOUPLE Phase C3 — native-directory maintenance contracts.
 *
 *  • createNativeTechnician: crm link only for ACTIVE company members (unlink-
 *    before-link honors the one-technician-per-user partial unique index);
 *    a ZB external id already mapped to another technician is a 409, never a
 *    silent repoint.
 *  • updateNativeTechnician: uuid-shape gate, company-scoped 404, rename applies.
 *  • syncBridgeLink (deferred #3): the admin ZB-bridge edit re-links the native
 *    plane — clear → unlink only; set → unlink then link; unknown external id
 *    (pre-backfill) → explicit no-op reason, nothing linked.
 */

const mockQueries = {
    createTechnician: jest.fn(),
    upsertExternalIdentity: jest.fn(),
    resolveExternalToUuid: jest.fn(),
    getTechnicianById: jest.fn(),
    listTechnicians: jest.fn(),
    updateTechnician: jest.fn(),
    unlinkCrmUser: jest.fn(),
    linkCrmUser: jest.fn(),
    findTechnicianByCrmUserId: jest.fn(),
};
const mockGetActiveMembershipInCompany = jest.fn();
const mockListActiveMembershipsByRole = jest.fn();
let mockMode = 'native';

jest.mock('../../src/db/technicianDirectoryQueries', () => mockQueries);
jest.mock('../../src/db/membershipQueries', () => ({
    getActiveMembershipInCompany: (...args) => mockGetActiveMembershipInCompany(...args),
    listActiveMembershipsByRole: (...args) => mockListActiveMembershipsByRole(...args),
}));
jest.mock('../../src/config/featureFlags', () => ({
    getTechnicianDirectoryMode: () => mockMode,
}));

const service = require('../../src/services/technicianDirectoryService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const TECH_UUID = '73edf9e7-bbbf-4129-a690-2eb6fc72a1ef';
const OTHER_UUID = 'e2ae7e60-c85b-41e2-aaaa-e6c2a95831a2';
const CRM_USER = 'a1b2c3d4-0000-4000-8000-000000000042';

describe('technicianDirectoryService — ZB-DECOUPLE C3', () => {
    beforeEach(() => {
        Object.values(mockQueries).forEach(fn => fn.mockReset());
        mockGetActiveMembershipInCompany.mockReset();
        mockQueries.createTechnician.mockResolvedValue({ id: TECH_UUID, display_name: 'New Tech' });
        mockQueries.getTechnicianById.mockResolvedValue({ id: TECH_UUID, display_name: 'New Tech', active: true });
    });

    describe('createNativeTechnician', () => {
        it('creates with a bare display name (no link, no external id)', async () => {
            const tech = await service.createNativeTechnician(COMPANY, { display_name: '  New Tech  ' });
            expect(mockQueries.createTechnician).toHaveBeenCalledWith({
                companyId: COMPANY, displayName: 'New Tech', active: true, crmUserId: null,
            });
            expect(mockQueries.unlinkCrmUser).not.toHaveBeenCalled();
            expect(tech.id).toBe(TECH_UUID);
        });

        it('links an ACTIVE member and clears their stale link first', async () => {
            mockGetActiveMembershipInCompany.mockResolvedValue({ id: 'm1' });
            mockQueries.unlinkCrmUser.mockResolvedValue([OTHER_UUID]);
            await service.createNativeTechnician(COMPANY, { display_name: 'Tech', crm_user_id: CRM_USER });
            expect(mockGetActiveMembershipInCompany).toHaveBeenCalledWith(CRM_USER, COMPANY);
            expect(mockQueries.unlinkCrmUser).toHaveBeenCalledWith({ companyId: COMPANY, crmUserId: CRM_USER });
            expect(mockQueries.createTechnician).toHaveBeenCalledWith(
                expect.objectContaining({ crmUserId: CRM_USER })
            );
        });

        it('rejects a non-member crm_user_id with 400 and creates nothing', async () => {
            mockGetActiveMembershipInCompany.mockResolvedValue(null);
            await expect(
                service.createNativeTechnician(COMPANY, { display_name: 'Tech', crm_user_id: CRM_USER })
            ).rejects.toMatchObject({ code: 'INVALID_CRM_USER', httpStatus: 400 });
            expect(mockQueries.createTechnician).not.toHaveBeenCalled();
        });

        it('rejects an empty display name', async () => {
            await expect(
                service.createNativeTechnician(COMPANY, { display_name: '   ' })
            ).rejects.toMatchObject({ code: 'INVALID_NAME', httpStatus: 400 });
        });

        it('attaches a free ZB external id', async () => {
            mockQueries.upsertExternalIdentity.mockResolvedValue({ technician_id: TECH_UUID });
            await service.createNativeTechnician(COMPANY, {
                display_name: 'Tech', zenbooker_external_id: ' 1770x1 ',
            });
            expect(mockQueries.upsertExternalIdentity).toHaveBeenCalledWith({
                companyId: COMPANY, source: 'zenbooker', externalId: '1770x1', technicianId: TECH_UUID,
            });
        });

        it('a ZB external id owned by ANOTHER technician is a 409, never a repoint', async () => {
            mockQueries.upsertExternalIdentity.mockResolvedValue({ technician_id: OTHER_UUID });
            await expect(
                service.createNativeTechnician(COMPANY, { display_name: 'Tech', zenbooker_external_id: '1770x1' })
            ).rejects.toMatchObject({ code: 'EXTERNAL_ID_TAKEN', httpStatus: 409 });
        });
    });

    describe('updateNativeTechnician', () => {
        it('rejects a non-uuid technician id', async () => {
            await expect(
                service.updateNativeTechnician(COMPANY, '1770x1', { display_name: 'X' })
            ).rejects.toMatchObject({ code: 'INVALID_TECHNICIAN_ID', httpStatus: 400 });
        });

        it('404 on a technician outside this company', async () => {
            mockQueries.getTechnicianById.mockResolvedValue(null);
            await expect(
                service.updateNativeTechnician(COMPANY, TECH_UUID, { active: false })
            ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            expect(mockQueries.updateTechnician).not.toHaveBeenCalled();
        });

        it('renames and deactivates through the company-scoped update', async () => {
            await service.updateNativeTechnician(COMPANY, TECH_UUID.toUpperCase(), {
                display_name: ' Renamed ', active: false,
            });
            expect(mockQueries.updateTechnician).toHaveBeenCalledWith({
                companyId: COMPANY, technicianId: TECH_UUID, displayName: 'Renamed', active: false,
            });
        });
    });

    describe('syncBridgeLink (deferred #3 — bridge edit follows into the native plane)', () => {
        it('a cleared bridge unlinks and stops', async () => {
            mockQueries.unlinkCrmUser.mockResolvedValue([TECH_UUID]);
            const out = await service.syncBridgeLink(COMPANY, CRM_USER, null);
            expect(mockQueries.unlinkCrmUser).toHaveBeenCalledWith({ companyId: COMPANY, crmUserId: CRM_USER });
            expect(mockQueries.linkCrmUser).not.toHaveBeenCalled();
            expect(out).toMatchObject({ linked: false, unlinked_count: 1, reason: 'BRIDGE_CLEARED' });
        });

        it('a mapped external id re-links: unlink first, then link the native technician', async () => {
            mockQueries.unlinkCrmUser.mockResolvedValue([]);
            mockQueries.resolveExternalToUuid.mockResolvedValue(TECH_UUID);
            mockQueries.linkCrmUser.mockResolvedValue({ id: TECH_UUID });
            const out = await service.syncBridgeLink(COMPANY, CRM_USER, '1770x1');
            expect(mockQueries.resolveExternalToUuid).toHaveBeenCalledWith(COMPANY, 'zenbooker', '1770x1');
            expect(mockQueries.linkCrmUser).toHaveBeenCalledWith({
                companyId: COMPANY, technicianId: TECH_UUID, crmUserId: CRM_USER,
            });
            expect(out).toMatchObject({ linked: true, technician_uuid: TECH_UUID });
        });

        it('an external id with no native row (pre-backfill) is an explicit no-op', async () => {
            mockQueries.unlinkCrmUser.mockResolvedValue([]);
            mockQueries.resolveExternalToUuid.mockResolvedValue(null);
            const out = await service.syncBridgeLink(COMPANY, CRM_USER, 'unknown-zb-id');
            expect(mockQueries.linkCrmUser).not.toHaveBeenCalled();
            expect(out).toMatchObject({ linked: false, reason: 'NO_NATIVE_TECHNICIAN' });
        });
    });

    describe('projectFromMemberships (USERS-FIRST: роль provider ⇔ активный техник)', () => {
        beforeEach(() => {
            mockMode = 'native';
            mockListActiveMembershipsByRole.mockResolvedValue([]);
            mockQueries.listTechnicians.mockResolvedValue([]);
            mockQueries.findTechnicianByCrmUserId.mockResolvedValue(null);
        });

        it('is a no-op in legacy mode (pre-backfill prod must not mint rows)', async () => {
            mockMode = 'legacy';
            const out = await service.projectFromMemberships(COMPANY);
            expect(out).toEqual({ skipped: 'legacy-mode' });
            expect(mockListActiveMembershipsByRole).not.toHaveBeenCalled();
        });

        it('creates a linked technician for a provider without one (name from the user)', async () => {
            mockListActiveMembershipsByRole.mockResolvedValue([
                { user_id: CRM_USER, full_name: 'New Provider', email: 'p@x.com', zenbooker_team_member_id: null },
            ]);
            const out = await service.projectFromMemberships(COMPANY);
            expect(mockQueries.createTechnician).toHaveBeenCalledWith({
                companyId: COMPANY, displayName: 'New Provider', active: true, crmUserId: CRM_USER,
            });
            expect(out).toMatchObject({ created: 1, reactivated: 0, adopted: 0, deactivated: 0 });
        });

        it('reactivates an inactive linked technician instead of creating (rename preserved)', async () => {
            mockListActiveMembershipsByRole.mockResolvedValue([
                { user_id: CRM_USER, full_name: 'Provider', email: 'p@x.com', zenbooker_team_member_id: null },
            ]);
            mockQueries.findTechnicianByCrmUserId.mockResolvedValue({ id: TECH_UUID, active: false, display_name: 'Manual Rename' });
            const out = await service.projectFromMemberships(COMPANY);
            expect(mockQueries.updateTechnician).toHaveBeenCalledWith({
                companyId: COMPANY, technicianId: TECH_UUID, active: true,
            });
            // display_name is NOT part of the reactivation patch — manual renames stick.
            expect(mockQueries.createTechnician).not.toHaveBeenCalled();
            expect(out).toMatchObject({ reactivated: 1, created: 0 });
        });

        it('adopts an UNLINKED backfilled technician via the ZB bridge instead of duplicating', async () => {
            mockListActiveMembershipsByRole.mockResolvedValue([
                { user_id: CRM_USER, full_name: 'Ali', email: 'a@x.com', zenbooker_team_member_id: '1770x-ali' },
            ]);
            mockQueries.resolveExternalToUuid.mockResolvedValue(TECH_UUID);
            mockQueries.getTechnicianById.mockResolvedValue({ id: TECH_UUID, active: true, crm_user_id: null });
            const out = await service.projectFromMemberships(COMPANY);
            expect(mockQueries.linkCrmUser).toHaveBeenCalledWith({
                companyId: COMPANY, technicianId: TECH_UUID, crmUserId: CRM_USER,
            });
            expect(mockQueries.createTechnician).not.toHaveBeenCalled();
            expect(out).toMatchObject({ adopted: 1, created: 0 });
        });

        it('does NOT adopt a technician already linked to a DIFFERENT user — creates instead', async () => {
            mockListActiveMembershipsByRole.mockResolvedValue([
                { user_id: CRM_USER, full_name: 'P', email: 'p@x.com', zenbooker_team_member_id: '1770x-taken' },
            ]);
            mockQueries.resolveExternalToUuid.mockResolvedValue(TECH_UUID);
            mockQueries.getTechnicianById.mockResolvedValue({ id: TECH_UUID, active: true, crm_user_id: 'someone-else' });
            const out = await service.projectFromMemberships(COMPANY);
            expect(mockQueries.linkCrmUser).not.toHaveBeenCalled();
            expect(mockQueries.createTechnician).toHaveBeenCalled();
            expect(out).toMatchObject({ created: 1, adopted: 0 });
        });

        it('deactivates a linked technician whose user lost the provider role; unlinked rows untouched', async () => {
            mockListActiveMembershipsByRole.mockResolvedValue([]); // no providers anymore
            mockQueries.listTechnicians.mockResolvedValue([
                { id: TECH_UUID, active: true, crm_user_id: CRM_USER },        // linked → deactivate
                { id: OTHER_UUID, active: true, crm_user_id: null },           // unlinked → NEVER touched
                { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', active: false, crm_user_id: CRM_USER }, // already off
            ]);
            const out = await service.projectFromMemberships(COMPANY);
            expect(mockQueries.updateTechnician).toHaveBeenCalledTimes(1);
            expect(mockQueries.updateTechnician).toHaveBeenCalledWith({
                companyId: COMPANY, technicianId: TECH_UUID, active: false,
            });
            expect(out).toMatchObject({ deactivated: 1 });
        });
    });
});
