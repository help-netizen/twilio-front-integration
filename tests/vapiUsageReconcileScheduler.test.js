'use strict';

const {
    createVapiUsageReconcileScheduler,
    registerScheduler,
} = require('../backend/src/services/vapiUsageReconcileScheduler');

describe('VAPI-AGENCY-001 T4 scheduler boundary', () => {
    test('global dispatcher passes explicit company ids and isolates one company failure', async () => {
        const now = new Date('2026-08-16T06:00:00.000Z');
        const reconcileService = {
            listDueCompanies: jest.fn().mockResolvedValue(['company-a', 'company-b']),
            processDueCompany: jest.fn(async (companyId) => {
                if (companyId === 'company-a') throw new Error('company-a failed');
                return {
                    companyId,
                    finalized: 1,
                    corrected: 2,
                    stale: 3,
                    providerErrors: 4,
                };
            }),
        };
        const auditService = {
            utcDayWindow: jest.fn().mockReturnValue({ auditDate: '2026-08-15' }),
            runNightlyAudit: jest.fn().mockResolvedValue({ status: 'succeeded' }),
        };
        const scheduler = createVapiUsageReconcileScheduler({
            reconcileService,
            auditService,
        });

        const result = await scheduler.tick(now);

        expect(reconcileService.processDueCompany).toHaveBeenNthCalledWith(
            1,
            'company-a',
            { now },
        );
        expect(reconcileService.processDueCompany).toHaveBeenNthCalledWith(
            2,
            'company-b',
            { now },
        );
        expect(result.metrics).toEqual({
            dueCompanies: 2,
            finalized: 1,
            corrected: 2,
            stale: 3,
            providerErrors: 4,
            failedCompanies: 1,
        });
        expect(result.companies[0]).toEqual({ companyId: 'company-a', failed: true });
    });

    test('same scheduler instance runs at most once per minute and one audit per UTC day', async () => {
        const reconcileService = {
            listDueCompanies: jest.fn().mockResolvedValue([]),
            processDueCompany: jest.fn(),
        };
        const auditService = {
            utcDayWindow: jest.fn().mockReturnValue({ auditDate: '2026-08-15' }),
            runNightlyAudit: jest.fn().mockResolvedValue({ status: 'succeeded' }),
        };
        const scheduler = createVapiUsageReconcileScheduler({
            reconcileService,
            auditService,
        });
        const now = new Date('2026-08-16T06:00:00.000Z');

        await expect(scheduler.tick(now)).resolves.toMatchObject({ skipped: false });
        await expect(scheduler.tick(new Date(now.getTime() + 30000)))
            .resolves.toEqual({ skipped: true });
        await expect(scheduler.tick(new Date(now.getTime() + 60000)))
            .resolves.toMatchObject({ skipped: false, audit: { skipped: true } });
        expect(auditService.runNightlyAudit).toHaveBeenCalledTimes(1);
    });

    test('registers one scheduler without a new server mount', () => {
        const registry = { register: jest.fn() };
        registerScheduler(registry);
        expect(registry.register).toHaveBeenCalledWith(
            'vapi-usage-reconcile',
            expect.any(Function),
        );
    });
});
