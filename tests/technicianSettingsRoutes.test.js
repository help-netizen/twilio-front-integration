jest.mock('../backend/src/services/technicianProfilesService', () => ({
    listProfiles: jest.fn(),
    uploadPhoto: jest.fn(),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    listActive: jest.fn(),
    requireActive: jest.fn(),
}));
jest.mock('../backend/src/services/technicianWorkScheduleService', () => ({
    listEffective: jest.fn(),
    getSettings: jest.fn(),
    save: jest.fn(),
}));
jest.mock('../backend/src/services/technicianServiceAreaService', () => ({
    getAssignmentState: jest.fn(),
    getTechnicianSettings: jest.fn(),
    activeSummary: jest.fn(),
    replaceTechnicianAssignments: jest.fn(),
}));
jest.mock('../backend/src/db/technicianBaseLocationQueries', () => ({
    listByCompany: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const profileService = require('../backend/src/services/technicianProfilesService');
const rosterService = require('../backend/src/services/technicianRosterService');
const workScheduleService = require('../backend/src/services/technicianWorkScheduleService');
const serviceAreaService = require('../backend/src/services/technicianServiceAreaService');
const baseLocationQueries = require('../backend/src/db/technicianBaseLocationQueries');
const router = require('../backend/src/routes/technicians');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const TECH = { id: 'tech-1', name: 'Alex Rivera', active: true };
const EFFECTIVE = {
    technician_id: TECH.id,
    inherits_company_schedule: true,
    effective_week: [],
    schedule_summary: 'Mon–Fri 08:00–18:00 · Sat–Sun off',
    exceeds_company_hours: false,
    degraded_to_company_schedule: false,
};

function appWith({ companyId = COMPANY_A, permissions = ['tenant.company.manage'] } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'keycloak-sub', crmUser: { id: 'crm-user-17' } };
        req.authz = { permissions, scopes: {} };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    rosterService.listActive.mockResolvedValue([TECH]);
    rosterService.requireActive.mockResolvedValue(TECH);
    profileService.listProfiles.mockResolvedValue([{ tech_id: TECH.id, name: null, has_photo: false }]);
    baseLocationQueries.listByCompany.mockResolvedValue([]);
    workScheduleService.listEffective.mockResolvedValue({ technicians: [EFFECTIVE] });
    workScheduleService.getSettings.mockResolvedValue({ ...EFFECTIVE, company_schedule: { days: [] } });
    workScheduleService.save.mockResolvedValue({ ...EFFECTIVE, inherits_company_schedule: false });
    serviceAreaService.getAssignmentState.mockResolvedValue({
        active_mode: 'list',
        _assignment_by_tech: new Map([[TECH.id, { wildcard_in_active_mode: true }]]),
    });
    serviceAreaService.getTechnicianSettings.mockResolvedValue({
        active_mode: 'list', districts: [], radii: [],
        district_assignments: [], radius_assignments: [], wildcard_in_active_mode: true,
    });
    serviceAreaService.activeSummary.mockReturnValue('All districts (wildcard)');
    serviceAreaService.replaceTechnicianAssignments.mockResolvedValue({
        active_mode: 'list', district_assignments: ['North'], radius_assignments: [],
    });
});

it('production mount keeps authentication and company-access middleware', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    expect(source).toMatch(/app\.use\('\/api\/settings\/technicians', authenticate, requireCompanyAccess,[\s\S]*routes\/technicians/);
});

it('requires tenant.company.manage on the canonical technician list', async () => {
    const response = await request(appWith({ permissions: [] })).get('/');
    expect(response.status).toBe(403);
    expect(rosterService.listActive).not.toHaveBeenCalled();
});

it('lists the active roster with profile/base and visible effective schedule summary', async () => {
    const response = await request(appWith()).get('/');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([expect.objectContaining({
        tech_id: TECH.id,
        name: TECH.name,
        schedule_summary: EFFECTIVE.schedule_summary,
        inherits_company_schedule: true,
    })]);
    expect(rosterService.listActive).toHaveBeenCalledWith(COMPANY_A);
    expect(profileService.listProfiles).toHaveBeenCalledWith(COMPANY_A, [TECH.id]);
});

it('passes only the caller company into every list read', async () => {
    await request(appWith({ companyId: COMPANY_B })).get('/');
    expect(rosterService.listActive).toHaveBeenCalledWith(COMPANY_B);
    expect(profileService.listProfiles).toHaveBeenCalledWith(COMPANY_B, [TECH.id]);
    expect(baseLocationQueries.listByCompany).toHaveBeenCalledWith(COMPANY_B);
    expect(workScheduleService.listEffective).toHaveBeenCalledWith(COMPANY_B, [TECH]);
    expect(serviceAreaService.getAssignmentState).toHaveBeenCalledWith(COMPANY_B, [TECH]);
});

it('surfaces active-roster operational failure instead of substituting job history', async () => {
    rosterService.listActive.mockRejectedValue(Object.assign(new Error('roster down'), {
        code: 'ZENBOOKER_UNAVAILABLE', httpStatus: 502,
    }));
    const response = await request(appWith()).get('/');
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('ZENBOOKER_UNAVAILABLE');
    expect(profileService.listProfiles).not.toHaveBeenCalled();
});

it('settings GET roster-validates the technician inside the caller company', async () => {
    const response = await request(appWith({ companyId: COMPANY_B })).get('/tech-1/settings');
    expect(response.status).toBe(200);
    expect(rosterService.requireActive).toHaveBeenCalledWith(COMPANY_B, 'tech-1');
    expect(workScheduleService.getSettings).toHaveBeenCalledWith(COMPANY_B, TECH);
    expect(serviceAreaService.getTechnicianSettings).toHaveBeenCalledWith(COMPANY_B, TECH);
});

it('service-area PUT uses the caller company and crmUser.id and replaces one requested mode', async () => {
    const response = await request(appWith({ companyId: COMPANY_B }))
        .put('/tech-1/service-areas/districts')
        .send({ assignments: ['North'] });
    expect(response.status).toBe(200);
    expect(serviceAreaService.replaceTechnicianAssignments).toHaveBeenCalledWith(
        COMPANY_B,
        'tech-1',
        'districts',
        ['North'],
        'crm-user-17'
    );
    expect(serviceAreaService.replaceTechnicianAssignments.mock.calls[0]).not.toContain('keycloak-sub');
});

it('foreign or inactive technician is indistinguishable from missing', async () => {
    rosterService.requireActive.mockRejectedValue(Object.assign(new Error('Technician not found'), {
        code: 'NOT_FOUND', httpStatus: 404,
    }));
    const response = await request(appWith({ companyId: COMPANY_B })).get('/foreign/settings');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(workScheduleService.getSettings).not.toHaveBeenCalled();
});

it('schedule PUT passes crmUser.id, never the Keycloak subject', async () => {
    const payload = { inherits_company_schedule: true };
    const response = await request(appWith({ companyId: COMPANY_B }))
        .put('/tech-1/work-schedule')
        .send(payload);
    expect(response.status).toBe(200);
    expect(workScheduleService.save).toHaveBeenCalledWith(
        COMPANY_B,
        TECH,
        payload,
        'crm-user-17'
    );
    expect(workScheduleService.save.mock.calls[0]).not.toContain('keycloak-sub');
});

it('schedule PUT preserves service validation status/code', async () => {
    workScheduleService.save.mockRejectedValue(Object.assign(new Error('Sunday is closed'), {
        code: 'COMPANY_CLOSED_DAY', httpStatus: 422,
    }));
    const response = await request(appWith())
        .put('/tech-1/work-schedule')
        .send({ inherits_company_schedule: false, days: [] });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('COMPANY_CLOSED_DAY');
});
