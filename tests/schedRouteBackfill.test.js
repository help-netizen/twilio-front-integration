/**
 * SCHED-ROUTE-001 SR-10 — route-segment seed orchestration.
 * Verifies the one-time seed iterates companies → today+future tech-days,
 * honours dry-run, and survives a per-company enumeration failure.
 */
jest.mock('../backend/src/db/connection', () => ({ pool: { end: jest.fn() }, query: jest.fn() }));
jest.mock('../backend/src/db/routeQueries');
jest.mock('../backend/src/services/routeSegmentService');

const routeQueries = require('../backend/src/db/routeQueries');
const routeSeg = require('../backend/src/services/routeSegmentService');
const { run } = require('../scripts/backfill-route-segments');

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore?.(); console.error.mockRestore?.(); });

describe('backfill-route-segments seed', () => {
    it('reconciles each company tech-day with its company tz', async () => {
        routeQueries.getCompaniesWithTimezone.mockResolvedValue([
            { companyId: 'c1', tz: 'America/New_York' },
            { companyId: 'c2', tz: 'America/Chicago' },
        ]);
        routeQueries.getSeedTechDays.mockImplementation(async (companyId) =>
            companyId === 'c1'
                ? [{ technicianId: 't1', scheduleDate: '2026-06-14' }, { technicianId: 't1', scheduleDate: '2026-06-15' }]
                : [{ technicianId: 't9', scheduleDate: '2026-06-14' }]);
        routeSeg.reconcileTechDay.mockResolvedValue({ stale: 0, created: 1, enqueuedCalc: true });

        await run({ dryRun: false });

        expect(routeQueries.getSeedTechDays).toHaveBeenCalledWith('c1', 'America/New_York');
        expect(routeQueries.getSeedTechDays).toHaveBeenCalledWith('c2', 'America/Chicago');
        expect(routeSeg.reconcileTechDay).toHaveBeenCalledTimes(3);
        expect(routeSeg.reconcileTechDay).toHaveBeenCalledWith('c1', 't1', '2026-06-15', { tz: 'America/New_York' });
    });

    it('dry-run enumerates but never writes', async () => {
        routeQueries.getCompaniesWithTimezone.mockResolvedValue([{ companyId: 'c1', tz: 'UTC' }]);
        routeQueries.getSeedTechDays.mockResolvedValue([{ technicianId: 't1', scheduleDate: '2026-06-14' }]);

        await run({ dryRun: true });

        expect(routeQueries.getSeedTechDays).toHaveBeenCalled();
        expect(routeSeg.reconcileTechDay).not.toHaveBeenCalled();
    });

    it('a failing company does not abort the rest', async () => {
        routeQueries.getCompaniesWithTimezone.mockResolvedValue([
            { companyId: 'bad', tz: 'UTC' },
            { companyId: 'ok', tz: 'UTC' },
        ]);
        routeQueries.getSeedTechDays.mockImplementation(async (companyId) => {
            if (companyId === 'bad') throw new Error('boom');
            return [{ technicianId: 't1', scheduleDate: '2026-06-14' }];
        });
        routeSeg.reconcileTechDay.mockResolvedValue({ stale: 0, created: 1, enqueuedCalc: false });

        await run({ dryRun: false });

        expect(routeSeg.reconcileTechDay).toHaveBeenCalledTimes(1);
        expect(routeSeg.reconcileTechDay).toHaveBeenCalledWith('ok', 't1', '2026-06-14', { tz: 'UTC' });
    });
});
