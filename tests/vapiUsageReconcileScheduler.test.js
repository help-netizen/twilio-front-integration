'use strict';

const {
    createVapiUsageReconcileScheduler,
    registerScheduler,
} = require('../backend/src/services/vapiUsageReconcileScheduler');

describe('VAPI-AGENCY-001 T4 scheduler boundary', () => {
    function lossProtectionDependencies() {
        return {
            fallbackRatingService: {
                syncConfiguredRate: jest.fn().mockResolvedValue({ version: '1' }),
                listDueCompanies: jest.fn().mockResolvedValue([]),
                processCompany: jest.fn(),
            },
            alertDeliveryService: {
                dispatchAlerts: jest.fn().mockResolvedValue({ skipped: true }),
            },
            inboundVoiceRecoveryService: {
                sweepRetryPending: jest.fn().mockResolvedValue({
                    due: 0,
                    tasksCreated: 0,
                    stillPending: 0,
                }),
            },
        };
    }

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
            runNightlyAudit: jest.fn().mockResolvedValue({
                status: 'succeeded',
                auditDate: '2026-08-15',
            }),
        };
        const scheduler = createVapiUsageReconcileScheduler({
            reconcileService,
            auditService,
            ...lossProtectionDependencies(),
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
            runNightlyAudit: jest.fn().mockResolvedValue({
                status: 'succeeded',
                auditDate: '2026-08-15',
            }),
        };
        const scheduler = createVapiUsageReconcileScheduler({
            reconcileService,
            auditService,
            ...lossProtectionDependencies(),
        });
        const now = new Date('2026-08-16T06:00:00.000Z');

        await expect(scheduler.tick(now)).resolves.toMatchObject({ skipped: false });
        await expect(scheduler.tick(new Date(now.getTime() + 30000)))
            .resolves.toEqual({ skipped: true });
        await expect(scheduler.tick(new Date(now.getTime() + 60000)))
            .resolves.toMatchObject({ skipped: false, audit: { skipped: true } });
        expect(auditService.runNightlyAudit).toHaveBeenCalledTimes(1);
    });

    test('continues oldest-first audit catch-up until yesterday succeeds', async () => {
        const reconcileService = {
            listDueCompanies: jest.fn().mockResolvedValue([]),
            processDueCompany: jest.fn(),
        };
        const auditService = {
            utcDayWindow: jest.fn().mockReturnValue({ auditDate: '2026-08-15' }),
            runNightlyAudit: jest.fn()
                .mockResolvedValueOnce({
                    status: 'succeeded',
                    auditDate: '2026-08-14',
                })
                .mockResolvedValueOnce({
                    status: 'succeeded',
                    auditDate: '2026-08-15',
                }),
        };
        const scheduler = createVapiUsageReconcileScheduler({
            reconcileService,
            auditService,
            ...lossProtectionDependencies(),
        });
        const now = new Date('2026-08-16T06:00:00.000Z');

        await scheduler.tick(now);
        await scheduler.tick(new Date(now.getTime() + 60000));
        const caughtUp = await scheduler.tick(new Date(now.getTime() + 120000));

        expect(auditService.runNightlyAudit).toHaveBeenCalledTimes(2);
        expect(caughtUp.audit).toEqual({ skipped: true });
    });

    test('runs fallback rating before alert delivery inside the existing scheduler', async () => {
        const calls = [];
        const scheduler = createVapiUsageReconcileScheduler({
            reconcileService: {
                listDueCompanies: jest.fn().mockResolvedValue([]),
                processDueCompany: jest.fn(),
            },
            auditService: {
                utcDayWindow: jest.fn().mockReturnValue({ auditDate: '2026-08-15' }),
                runNightlyAudit: jest.fn().mockResolvedValue({
                    status: 'succeeded',
                    auditDate: '2026-08-15',
                }),
            },
            fallbackRatingService: {
                syncConfiguredRate: jest.fn().mockResolvedValue({ version: '1' }),
                listDueCompanies: jest.fn().mockResolvedValue(['company-a']),
                processCompany: jest.fn().mockImplementation(async (companyId) => {
                    calls.push('fallback');
                    return { companyId, estimatesCreated: 1, correctionsCreated: 0 };
                }),
            },
            alertDeliveryService: {
                dispatchAlerts: jest.fn().mockImplementation(async () => {
                    calls.push('delivery');
                    return { sent: true };
                }),
            },
            inboundVoiceRecoveryService: {
                sweepRetryPending: jest.fn().mockResolvedValue({
                    due: 0,
                    tasksCreated: 0,
                    stillPending: 0,
                }),
            },
        });

        const result = await scheduler.tick(new Date('2026-08-16T06:00:00.000Z'));

        expect(calls).toEqual(['fallback', 'delivery']);
        expect(result).toMatchObject({
            fallbackRating: { estimatesCreated: 1, dueCompanies: 1 },
            alertDelivery: { sent: true },
        });
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
