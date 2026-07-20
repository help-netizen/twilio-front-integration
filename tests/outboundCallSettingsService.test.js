'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const service = require('../backend/src/services/outboundCallSettingsService');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const marketplaceService = require('../backend/src/services/marketplaceService');

afterEach(() => jest.clearAllMocks());

describe('AGENT-CALL-WINDOW-001 parts settings persistence', () => {
    test('SAB-CW-PARTS-INHERIT: missing row resolves to nullable company inheritance', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const settings = await service.get('company-a');

        expect(settings.calling_window_mode).toBeNull();
        expect(settings.calling_window_work_days).toBeNull();
        expect(db.query.mock.calls[0][0]).toMatch(/WHERE company_id = \$1/);
        expect(db.query.mock.calls[0][1]).toEqual(['company-a']);
    });

    test('SAB-CW-PARTS-TENANT: custom upsert is company-scoped and leaves retry fields untouched', async () => {
        db.query.mockResolvedValue({ rows: [{
            max_attempts: 3,
            backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
            next_morning_hour: 9,
            enabled: true,
            calling_window_mode: 'custom',
            custom_start_time: '09:00',
            custom_end_time: '17:00',
            calling_window_work_days: [1, 2, 3, 4, 5],
        }] });

        const settings = await service.saveCallingWindow('company-b', {
            calling_window_mode: 'custom',
            custom_start_time: '09:00',
            custom_end_time: '17:00',
            calling_window_work_days: [5, 1, 2, 3, 4, 1],
        });

        expect(db.query.mock.calls[0][1]).toEqual([
            'company-b', 'custom', '09:00', '17:00', JSON.stringify([1, 2, 3, 4, 5]),
        ]);
        expect(db.query.mock.calls[0][0]).not.toMatch(/max_attempts\s*=|backoff_schedule\s*=/i);
        expect(settings.calling_window_work_days).toEqual([1, 2, 3, 4, 5]);
    });

    test('invalid stored custom data is a resolver failure, not a silent inherit', async () => {
        db.query.mockResolvedValue({ rows: [{
            calling_window_mode: 'custom',
            custom_start_time: '17:00',
            custom_end_time: '09:00',
            calling_window_work_days: [1],
        }] });

        await expect(service.get('company-a')).rejects.toThrow(/invalid stored parts caller window/);
    });
});

describe('outbound-parts-caller marketplace settings contract', () => {
    afterEach(() => jest.restoreAllMocks());

    test('validator accepts inherit/custom and rejects incomplete custom input', () => {
        expect(marketplaceService.validateAgentCallingWindowInput({
            calling_window_mode: null,
        })).toEqual({
            calling_window_mode: null,
            custom_start_time: null,
            custom_end_time: null,
            calling_window_work_days: null,
        });
        expect(marketplaceService.validateAgentCallingWindowInput({
            calling_window_mode: 'custom',
            custom_start_time: '09:00',
            custom_end_time: '17:00',
            calling_window_work_days: [5, 1, 1],
        }).calling_window_work_days).toEqual([1, 5]);
        expect(() => marketplaceService.validateAgentCallingWindowInput({
            calling_window_mode: 'custom',
            custom_start_time: '17:00',
            custom_end_time: '09:00',
            calling_window_work_days: [1],
        })).toThrow(/Custom calling window/);
    });

    test('SAB-CW-PARTS-API-TENANT: GET and PUT pass only the authenticated company scope', async () => {
        jest.spyOn(marketplaceQueries, 'getPublishedAppByKey').mockResolvedValue({
            id: 190,
            app_key: 'outbound-parts-caller',
        });
        jest.spyOn(marketplaceQueries, 'findActiveInstallation').mockResolvedValue({
            id: 901,
            status: 'connected',
            metadata: {},
        });
        jest.spyOn(marketplaceQueries, 'writeEvent').mockResolvedValue({});
        const getSpy = jest.spyOn(service, 'get').mockResolvedValue({ ...service.DEFAULTS });
        const saveSpy = jest.spyOn(service, 'saveCallingWindow').mockResolvedValue({
            ...service.DEFAULTS,
            calling_window_mode: 'custom',
            custom_start_time: '09:00',
            custom_end_time: '17:00',
            calling_window_work_days: [1, 2, 3, 4, 5],
        });

        await marketplaceService.getAppSettings('company-own', 'outbound-parts-caller');
        await marketplaceService.updateAppSettings(
            'company-own',
            'crm-user-1',
            'outbound-parts-caller',
            {
                calling_window_mode: 'custom',
                custom_start_time: '09:00',
                custom_end_time: '17:00',
                calling_window_work_days: [1, 2, 3, 4, 5],
            }
        );

        expect(getSpy).toHaveBeenCalledWith('company-own');
        expect(saveSpy).toHaveBeenCalledWith('company-own', expect.objectContaining({
            calling_window_mode: 'custom',
        }));
        expect(marketplaceQueries.findActiveInstallation)
            .toHaveBeenNthCalledWith(1, 'company-own', 190);
        expect(marketplaceQueries.findActiveInstallation)
            .toHaveBeenNthCalledWith(2, 'company-own', 190);
    });
});
