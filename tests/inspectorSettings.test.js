'use strict';

jest.mock('../backend/src/db/inspectorQueries', () => ({
    getSettings: jest.fn(),
    getCompanyTimezone: jest.fn(),
    saveSettings: jest.fn(),
}));
jest.mock('../backend/src/services/fsmService', () => ({
    getPublishedGraph: jest.fn(),
}));

const queries = require('../backend/src/db/inspectorQueries');
const fsmService = require('../backend/src/services/fsmService');
const service = require('../backend/src/services/inspectorSettingsService');
const {
    DEFAULT_INSPECTOR_INSTRUCTION,
    DEFAULT_IGNORED_JOB_STATUSES,
    DEFAULT_IGNORED_LEAD_STATUSES,
} = require('../backend/src/services/inspectorDefaults');

const COMPANY = '11111111-1111-1111-1111-111111111111';

function graph(names) {
    return { states: new Map(names.map((name, index) => [`s${index}`, { statusName: name }])) };
}

describe('Inspector settings service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        fsmService.getPublishedGraph
            .mockResolvedValueOnce(graph(['Submitted', ...DEFAULT_IGNORED_JOB_STATUSES]))
            .mockResolvedValueOnce(graph(['New', ...DEFAULT_IGNORED_LEAD_STATUSES]));
    });

    test('returns exact approved virtual defaults and company-published catalogs', async () => {
        queries.getSettings.mockResolvedValue({
            company_id: COMPANY,
            enabled: true,
            ignored_job_statuses: [...DEFAULT_IGNORED_JOB_STATUSES],
            ignored_lead_statuses: [...DEFAULT_IGNORED_LEAD_STATUSES],
            instruction: DEFAULT_INSPECTOR_INSTRUCTION,
            updated_at: null,
        });
        queries.getCompanyTimezone.mockResolvedValue('America/Chicago');
        const result = await service.buildResponse(COMPANY, 'inspector', { id: 9 });
        expect(result.settings).toEqual({
            enabled: true,
            ignored_job_statuses: [...DEFAULT_IGNORED_JOB_STATUSES],
            ignored_lead_statuses: [...DEFAULT_IGNORED_LEAD_STATUSES],
            instruction: DEFAULT_INSPECTOR_INSTRUCTION,
        });
        expect(result.schedule).toEqual({
            frequency: 'daily', after_local_time: '12:00', timezone: 'America/Chicago',
        });
        expect(fsmService.getPublishedGraph).toHaveBeenNthCalledWith(1, COMPANY, 'job');
        expect(fsmService.getPublishedGraph).toHaveBeenNthCalledWith(2, COMPANY, 'lead');
    });

    test('validates exact FSM values and saves with explicit company and CRM actor', async () => {
        const input = {
            enabled: false,
            ignored_job_statuses: ['Canceled'],
            ignored_lead_statuses: ['Lost'],
            instruction: ' Keep the task factual. ',
        };
        const validated = await service.validateInput(COMPANY, input);
        expect(validated).toEqual({ ...input, instruction: 'Keep the task factual.' });
        queries.saveSettings.mockResolvedValue({ ...validated, company_id: COMPANY });
        await service.save(COMPANY, validated, 'crm-user-id');
        expect(queries.saveSettings).toHaveBeenCalledWith(COMPANY, validated, 'crm-user-id');
    });

    test('rejects unknown status, missing field, extra key, and empty instruction', async () => {
        const base = {
            enabled: true,
            ignored_job_statuses: ['Not real'],
            ignored_lead_statuses: ['Lost'],
            instruction: 'x',
        };
        await expect(service.validateInput(COMPANY, base)).rejects.toMatchObject({ httpStatus: 400 });

        fsmService.getPublishedGraph.mockReset();
        await expect(service.validateInput(COMPANY, { enabled: true }))
            .rejects.toThrow('Missing Inspector setting');
        await expect(service.validateInput(COMPANY, { ...base, company_id: COMPANY }))
            .rejects.toThrow('Unexpected Inspector setting');
        await expect(service.validateInput(COMPANY, { ...base, ignored_job_statuses: [], instruction: ' ' }))
            .rejects.toThrow('1 to 12,000');
    });
});
