'use strict';

/**
 * REPAIR-ADVISOR-001 (REPAIR-ADVISOR-T1) — marketplace seed 161 + gate (Group G).
 *
 * Two Jest-observable surfaces of the data foundation:
 *
 *   - TC-RA-070: ensureMarketplaceSchema() registers seed 161 via readMigration,
 *     alongside the existing 126/132/145 seed registrations, and is idempotent.
 *   - TC-RA-074: isAppConnected(company, 'ai-repair-advisor') resolves through the
 *     GENERIC marketplace_installations status='connected' path — NOT the
 *     google-email mailbox special-case, NOT the telephony-twilio overlay.
 *
 * The two cases require opposite treatment of ../backend/src/db/marketplaceQueries
 * (real module for 070, mocked for 074), so each test drives its own module
 * registry via jest.resetModules() + jest.doMock() + require() — the same seam the
 * ragClient/zenbookerClient suites use, and mirroring tests/googleEmailMarketplace.test.js.
 *
 * TC-RA-071 (SQL seed insert + ON CONFLICT no-op) and TC-RA-072 (rollback removes
 * exactly that row) are MANUAL/psql — no house precedent executes raw .sql under
 * Jest. TC-RA-073 (tile connect/disconnect) is MANUAL/E2E. None are automated here.
 *
 * Run (worktree override is MANDATORY — the root jest config ignores /.claude/worktrees/):
 *   npx jest --runTestsByPath tests/repairAdvisorEvents.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const fs = require('fs');
const path = require('path');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const SEED_161 = '161_seed_ai_repair_advisor_marketplace_app.sql';

function readMigrationText(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'backend', 'db', 'migrations', name), 'utf8');
}

afterEach(() => {
    jest.resetModules();
});

// ─── TC-RA-070: ensureMarketplaceSchema registers seed 161 (Group G) ─────────
describe('REPAIR-ADVISOR-001 — marketplace seed 161 registration (Group G)', () => {
    it('TC-RA-070: ensureMarketplaceSchema registers seed 161 via readMigration, alongside 126/132/145; idempotent', async () => {
        jest.resetModules();
        jest.dontMock('../backend/src/db/marketplaceQueries'); // exercise the REAL queries module

        // Every query resolves empty; capture the SQL text each call carries.
        const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
        const client = { query: clientQuery, release: jest.fn() };
        const connect = jest.fn().mockResolvedValue(client);
        jest.doMock('../backend/src/db/connection', () => ({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            pool: { connect },
        }));

        const marketplaceQueries = require('../backend/src/db/marketplaceQueries');

        await marketplaceQueries.ensureMarketplaceSchema();
        await marketplaceQueries.ensureMarketplaceSchema(); // second call must be a no-op (idempotent)

        const sqlPassed = clientQuery.mock.calls.map(([sql]) => sql);

        // The exact seed-161 file text reached query() → readMigration('161_…sql') ran.
        expect(sqlPassed).toContain(readMigrationText(SEED_161));
        // …registered ALONGSIDE the existing seed registrations (not replacing them).
        expect(sqlPassed).toContain(readMigrationText('126_seed_smart_slot_engine_marketplace_app.sql'));
        expect(sqlPassed).toContain(readMigrationText('132_seed_google_email_marketplace_app.sql'));
        expect(sqlPassed).toContain(readMigrationText('145_seed_telephony_twilio_marketplace_app.sql'));
        // Idempotent: the schema is ensured exactly once despite two calls.
        expect(connect).toHaveBeenCalledTimes(1);

        jest.dontMock('../backend/src/db/connection');
    });
});

// ─── TC-RA-074: gate resolves via the GENERIC install path (Group G) ─────────
describe("REPAIR-ADVISOR-001 — isAppConnected('ai-repair-advisor') gate (Group G)", () => {
    it('TC-RA-074: true iff a connected install exists — via the GENERIC path (no mailbox/telephony overlay)', async () => {
        jest.resetModules();

        const mockGetPublishedAppByKey = jest.fn();
        const mockFindActiveInstallation = jest.fn();
        const mockListPublished = jest.fn();
        const mockGetMailboxStatus = jest.fn();

        // Mirror tests/googleEmailMarketplace.test.js seam: mock the query layer +
        // mailbox truth, run the REAL marketplaceService over them; stub the
        // remaining top-level requires so the module loads in isolation.
        jest.doMock('../backend/src/db/marketplaceQueries', () => ({
            getPublishedAppByKey: (...a) => mockGetPublishedAppByKey(...a),
            findActiveInstallation: (...a) => mockFindActiveInstallation(...a),
            listPublishedAppsWithInstallation: (...a) => mockListPublished(...a),
        }));
        jest.doMock('../backend/src/services/emailMailboxService', () => ({
            getMailboxStatus: (...a) => mockGetMailboxStatus(...a),
        }));
        jest.doMock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
        jest.doMock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
        jest.doMock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
        jest.doMock('../backend/src/services/marketplaceProvisioningService', () => ({
            pushCredentials: jest.fn(), sanitizeErrorMessage: (m) => m,
        }));

        const marketplaceService = require('../backend/src/services/marketplaceService');

        // The app-key const is exported for the subscriber/orchestrator to import.
        expect(marketplaceService.AI_REPAIR_ADVISOR_APP_KEY).toBe('ai-repair-advisor');
        const APP_KEY = marketplaceService.AI_REPAIR_ADVISOR_APP_KEY;

        // Connected install → true.
        mockGetPublishedAppByKey.mockResolvedValue({ id: 'app-ra' });
        mockFindActiveInstallation.mockResolvedValue({ status: 'connected' });
        await expect(marketplaceService.isAppConnected(COMPANY_A, APP_KEY)).resolves.toBe(true);

        // Proof the GENERIC path was taken: published-app-by-key + company-scoped
        // install lookup; the google-email mailbox overlay is NEVER consulted.
        expect(mockGetPublishedAppByKey).toHaveBeenCalledWith(APP_KEY);
        expect(mockFindActiveInstallation).toHaveBeenCalledWith(COMPANY_A, 'app-ra');
        expect(mockGetMailboxStatus).not.toHaveBeenCalled();

        // Disconnected install → false.
        mockFindActiveInstallation.mockResolvedValue({ status: 'disconnected' });
        await expect(marketplaceService.isAppConnected(COMPANY_A, APP_KEY)).resolves.toBe(false);

        // No active install → false.
        mockFindActiveInstallation.mockResolvedValue(null);
        await expect(marketplaceService.isAppConnected(COMPANY_A, APP_KEY)).resolves.toBe(false);

        // App not published → false (short-circuits before the install lookup).
        mockGetPublishedAppByKey.mockResolvedValue(null);
        await expect(marketplaceService.isAppConnected(COMPANY_A, APP_KEY)).resolves.toBe(false);

        // The mailbox/telephony overlays were never consulted for this key.
        expect(mockGetMailboxStatus).not.toHaveBeenCalled();
    });
});

// ─── Group F: kb-diagnostics subscriber (REPAIR-ADVISOR-T5) ───────────────────
//
// Seam (spec §3.8, test-plan §F): drive the REAL eventBus + REAL eventSubscribers
// (the wiring under test), with the db connection and the two sibling subscribers
// mocked to no-ops so the ONLY async work in flight is kb-diagnostics' own offload.
// `kbDiagnosticsService` is mocked to `{ runForJob: jest.fn() }`.
//
// The offload is proven by a DOUBLE `setImmediate` flush (mirrors
// tests/rulesEngine.test.js): eventBus.emit schedules setImmediate #1
// (dispatchToSubscribers → the subscriber's `handle`), and `handle` schedules
// setImmediate #2 (the detached `runForJob`). After flush #1 the subscriber has
// already returned but runForJob has NOT run; only flush #2 fires it — so the
// ~30s RAG round-trip can never block the sequential dispatch loop.
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

describe('REPAIR-ADVISOR-001 — kb-diagnostics subscriber (Group F)', () => {
    let eventBus;
    let mockRunForJob;

    // One macrotask (setImmediate) tick.
    const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
        jest.resetModules();

        // eventBus.emit persists to domain_events FIRST and only dispatches when that
        // INSERT returns a row; everything else (dispatch_log, mocked siblings) → [].
        jest.doMock('../backend/src/db/connection', () => ({
            query: jest.fn().mockImplementation((sql) =>
                (typeof sql === 'string' && sql.includes('INSERT INTO domain_events'))
                    ? Promise.resolve({ rows: [{ id: 1, created_at: 'now' }] })
                    : Promise.resolve({ rows: [] })
            ),
            pool: { connect: jest.fn() },
        }));

        // Neutralize the sibling subscribers so the only async hop is kb-diagnostics'
        // offload — makes the double-flush ordering deterministic. (billing-meter never
        // matches job.created, so its lazy billingService require never runs.)
        jest.doMock('../backend/src/services/rulesEngine', () => ({ onEvent: jest.fn() }));

        mockRunForJob = jest.fn().mockResolvedValue(undefined);
        jest.doMock('../backend/src/services/kbDiagnosticsService', () => ({
            runForJob: (...a) => mockRunForJob(...a),
        }));

        eventBus = require('../backend/src/services/eventBus');
        require('../backend/src/services/eventSubscribers').registerSubscribers();
    });

    afterEach(() => {
        // Undo doMocks so T6's emit-site blocks (appended later) load real services.
        jest.dontMock('../backend/src/services/kbDiagnosticsService');
        jest.dontMock('../backend/src/services/rulesEngine');
        jest.dontMock('../backend/src/db/connection');
    });

    it('TC-RA-064: fires runForJob for job.created only, not for other event types', async () => {
        // Unrelated type ⇒ subscriber pattern does not match ⇒ handler never runs.
        await eventBus.emit(COMPANY_A, 'job.status_changed', { id: 'J1' }, { dispatch: true });
        await flushImmediate();
        await flushImmediate();
        expect(mockRunForJob).not.toHaveBeenCalled();

        // Positive control on the SAME wiring: job.created DOES fire it.
        await eventBus.emit(COMPANY_A, 'job.created', { id: 'J1' }, { dispatch: true });
        await flushImmediate();
        await flushImmediate();
        expect(mockRunForJob).toHaveBeenCalledTimes(1);
        expect(mockRunForJob).toHaveBeenCalledWith({ jobId: 'J1', companyId: COMPANY_A });
    });

    it('TC-RA-065: returns FAST — offloads runForJob via setImmediate, never awaits it', async () => {
        // runForJob never settles: had the handler awaited it, the sequential dispatch
        // loop would hang and this test would time out.
        mockRunForJob.mockImplementation(() => new Promise(() => {}));

        await eventBus.emit(COMPANY_A, 'job.created', { id: 'J1' }, { dispatch: true });

        // Flush #1 = eventBus dispatch → handler runs and RETURNS, having only SCHEDULED
        // runForJob (its setImmediate is queued after this flush).
        await flushImmediate();
        expect(mockRunForJob).not.toHaveBeenCalled();

        // Flush #2 = the handler's own setImmediate → the detached runForJob finally runs.
        await flushImmediate();
        expect(mockRunForJob).toHaveBeenCalledTimes(1);
        expect(mockRunForJob).toHaveBeenCalledWith({ jobId: 'J1', companyId: COMPANY_A });
        // Reaching here without a timeout proves dispatch did NOT block on the pending call.
    });

    it('TC-RA-066: guards missing payload.id or company_id — never schedules runForJob', async () => {
        // Missing jobId, exercised through a real emit (payload carries no id).
        await eventBus.emit(COMPANY_A, 'job.created', {}, { dispatch: true });
        await flushImmediate();
        await flushImmediate();
        expect(mockRunForJob).not.toHaveBeenCalled();

        // Missing company_id cannot arise from emit (it guards companyId itself), so drive
        // the registered handler directly to cover the defense-in-depth guard branch.
        const sub = eventBus._subscribers.find((s) => s.name === 'kb-diagnostics');
        expect(sub).toBeTruthy();
        await sub.handle({ event_type: 'job.created', company_id: null, payload: { id: 'J1' } });
        await flushImmediate();
        await flushImmediate();
        expect(mockRunForJob).not.toHaveBeenCalled();
    });

    it('TC-RA-067: detached runForJob rejection is swallowed by the call-site .catch', async () => {
        const unhandled = [];
        const onUnhandled = (err) => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockRunForJob.mockRejectedValue(new Error('rag exploded'));

        await eventBus.emit(COMPANY_A, 'job.created', { id: 'J1' }, { dispatch: true });
        await flushImmediate();
        await flushImmediate();
        await flushImmediate(); // extra tick: give any unhandledRejection a chance to surface

        expect(mockRunForJob).toHaveBeenCalledTimes(1);
        expect(unhandled).toHaveLength(0); // .catch(()=>console.warn) absorbed it
        expect(warnSpy).toHaveBeenCalledWith('[kb-diagnostics] runForJob failed:', 'rag exploded');

        process.off('unhandledRejection', onUnhandled);
        warnSpy.mockRestore();
    });

    it('TC-RA-081: uses event.company_id, ignoring an adversarial payload.companyId decoy', async () => {
        // Authoritative company id is the 1st emit arg (event.company_id); the payload
        // carries a DIFFERENT company id that a cross-tenant attacker might plant.
        await eventBus.emit(
            COMPANY_A,
            'job.created',
            { id: 'J1', companyId: COMPANY_B }, // decoy
            { dispatch: true }
        );
        await flushImmediate();
        await flushImmediate();

        expect(mockRunForJob).toHaveBeenCalledTimes(1);
        expect(mockRunForJob).toHaveBeenCalledWith({ jobId: 'J1', companyId: COMPANY_A });
        const arg = mockRunForJob.mock.calls[0][0];
        expect(arg.companyId).toBe(COMPANY_A);
        expect(arg.companyId).not.toBe(COMPANY_B); // decoy never leaks through
    });
});

// ─── Group E: emit sites (REPAIR-ADVISOR-T6) ─────────────────────────────────
//
// TC-RA-060/061 (createDirectJob), 062/063 (convertLead), 083 (out-of-scope).
//
// Seam (§3.2; mirrors tests/jobsCreate.test.js + tests/leadsService.convert.test.js):
// load the REAL create service inside jest.isolateModules with its heavy deps
// jest.doMock'd — crucially `eventBus` → `{ emit: jest.fn() }` — then drive the
// service far enough to reach the post-commit emit and spy the single emit call.
// Integration-lite: no live DB; the transaction/upsert SQL is stubbed to return the
// rows the code path needs, and eventBus.emit is the observed seam (never touches
// domain_events).

describe('REPAIR-ADVISOR-001 — createDirectJob emits job.created (Group E)', () => {
    const JOB_ID = 42;

    // Mirror tests/jobsCreate.test.js loadService, plus the eventBus seam.
    function loadJobsService({ dbQuery, resolveContact, createJob, emit }) {
        let svc;
        jest.isolateModules(() => {
            jest.doMock('../backend/src/db/connection', () => ({
                query: dbQuery, getClient: jest.fn(), pool: { connect: jest.fn() },
            }));
            jest.doMock('../backend/src/services/contactDedupeService', () => ({
                resolveContact: resolveContact || jest.fn(),
            }));
            jest.doMock('../backend/src/services/zenbookerClient', () => ({
                findTerritoryByPostalCode: jest.fn().mockResolvedValue('terr_01'),
                createJob: createJob || jest.fn(),
                getJob: jest.fn(),
            }));
            jest.doMock('../backend/src/services/fsmService', () => ({}));
            jest.doMock('../backend/src/services/eventService', () => ({}));
            jest.doMock('../backend/src/db/membershipQueries', () => ({
                resolveProviderUserIds: jest.fn().mockResolvedValue([]),
            }));
            jest.doMock('../backend/src/config/featureFlags', () => ({
                isZenbookerSyncEnabled: () => false,
            }));
            // Observed seam: spy emit so we never hit domain_events.
            jest.doMock('../backend/src/services/eventBus', () => ({ emit }));
            svc = require('../backend/src/services/jobsService');
        });
        return svc;
    }

    // Drive the ZB-failure fallback so a local job row (id 42) is persisted with no
    // external calls — the same path tests/jobsCreate.test.js exercises.
    function zbFailureDeps(emit) {
        const zbErr = new Error('request failed');
        zbErr.response = { data: { error: { message: 'INVALID_ADDRESS' } } };
        const dbQuery = jest.fn((sql) =>
            /INSERT INTO jobs/.test(sql)
                ? Promise.resolve({ rows: [{ id: JOB_ID, blanc_status: 'Submitted' }] })
                : Promise.resolve({ rows: [] })
        );
        return {
            dbQuery,
            resolveContact: jest.fn().mockResolvedValue({ contact_id: 5, status: 'created' }),
            createJob: jest.fn().mockRejectedValue(zbErr),
            emit,
        };
    }

    const CREATE_INPUT = {
        contact: { name: 'Jane Doe', phone: '+16175551234' },
        address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721' },
        slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' },
        job_type: 'Refrigerator repair',
    };

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../backend/src/services/eventBus');
        jest.dontMock('../backend/src/db/connection');
    });

    it('TC-RA-060: emits job.created exactly once, post-commit, with load-bearing payload + opts; return shape unchanged', async () => {
        const emit = jest.fn().mockResolvedValue({});
        const deps = zbFailureDeps(emit);
        const svc = loadJobsService(deps);

        const out = await svc.createDirectJob(COMPANY_A, CREATE_INPUT);

        // Return value is byte-for-byte the pre-existing shape (additive-only).
        expect(out).toEqual({ job_id: JOB_ID, zenbooker_job_id: null, zb_warning: 'INVALID_ADDRESS' });

        // Emitted once, with the fields the subscriber reads + the opts from §3.2.
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith(
            COMPANY_A,
            'job.created',
            expect.objectContaining({ id: JOB_ID, jobId: JOB_ID, companyId: COMPANY_A }),
            expect.objectContaining({ actorType: 'user', aggregateType: 'job', aggregateId: JOB_ID }),
        );

        // POST-commit: the jobs INSERT ran strictly BEFORE the emit fired.
        const insertIdx = deps.dbQuery.mock.calls.findIndex(([sql]) => /INSERT INTO jobs/.test(sql));
        expect(insertIdx).toBeGreaterThanOrEqual(0);
        expect(deps.dbQuery.mock.invocationCallOrder[insertIdx])
            .toBeLessThan(emit.mock.invocationCallOrder[0]);
    });

    it('TC-RA-061: create still resolves when emit rejects — a failing bus never breaks the create', async () => {
        const unhandled = [];
        const onUnhandled = (e) => unhandled.push(e);
        process.on('unhandledRejection', onUnhandled);

        const emit = jest.fn().mockRejectedValue(new Error('bus down'));
        const svc = loadJobsService(zbFailureDeps(emit));

        const out = await svc.createDirectJob(COMPANY_A, CREATE_INPUT);

        // Same success result despite the rejecting bus.
        expect(out).toEqual({ job_id: JOB_ID, zenbooker_job_id: null, zb_warning: 'INVALID_ADDRESS' });
        expect(emit).toHaveBeenCalledTimes(1);

        // The .catch(()=>{}) at the emit site swallowed the rejection (no unhandled).
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toHaveLength(0);
        process.off('unhandledRejection', onUnhandled);
    });
});

describe('REPAIR-ADVISOR-001 — convertLead emits job.created only on the new-local-job branch (Group E)', () => {
    const CID = 'company-1';

    function makeLeadRow(overrides = {}) {
        return {
            id: 42, uuid: 'ABC123', serial_id: 1001, company_id: CID,
            status: 'Submitted', sub_status: null, lead_lost: false, converted_to_job: false,
            zenbooker_job_id: null, contact_id: 123, first_name: 'Ada', last_name: 'Lovelace',
            company: null, phone: '+16175550000', email: 'ada@example.com',
            address: '1 Main St', unit: null, city: 'Boston', state: 'MA', postal_code: '02110',
            country: 'US', job_type: 'Repair', job_source: 'Phone', lead_notes: 'Fix appliance',
            comments: null, metadata: {}, tags: null, structured_notes: [],
            lead_date_time: null, lead_end_date_time: null, created_at: new Date('2026-06-01T12:00:00Z'),
            payment_due_date: null, latitude: null, longitude: null, ...overrides,
        };
    }

    // REAL leadsService with the same deps tests/leadsService.convert.test.js mocks,
    // plus the eventBus seam. eventService/membershipQueries/featureFlags load real
    // (proven harmless by the sibling suite, which requires the real leadsService).
    function loadLeadsService({ dbQuery, client, createJob, getJob, emit }) {
        let svc;
        jest.isolateModules(() => {
            jest.doMock('../backend/src/db/connection', () => ({
                query: dbQuery,
                pool: { connect: jest.fn().mockResolvedValue(client) },
            }));
            jest.doMock('../backend/src/services/zenbookerClient', () => ({
                createJob: createJob || jest.fn(),
                createJobFromLead: jest.fn(),
                getJob: getJob || jest.fn(),
            }));
            jest.doMock('../backend/src/services/fsmService', () => ({}));
            jest.doMock('../backend/src/services/eventBus', () => ({ emit }));
            svc = require('../backend/src/services/leadsService');
        });
        return svc;
    }

    function poolQuery(leadRow) {
        return jest.fn((sql) =>
            String(sql).includes('SELECT * FROM leads')
                ? Promise.resolve({ rows: [leadRow] })
                : Promise.resolve({ rows: [] })
        );
    }

    const ZB_OVERRIDES = {
        zb_job_payload: {
            territory_id: 'territory-1',
            timeslot: { start: '2026-06-08T13:00:00Z', end: '2026-06-08T15:00:00Z' },
        },
    };

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../backend/src/services/eventBus');
        jest.dontMock('../backend/src/db/connection');
    });

    it('TC-RA-062: emits job.created once when a NEW local job is created (localJobCreated===true)', async () => {
        const emit = jest.fn().mockResolvedValue({});
        const NEW_JOB_ID = 2222;
        // Transaction, CREATE branch: existing-job lookup EMPTY → INSERT returns the new id.
        const client = { query: jest.fn(), release: jest.fn() };
        client.query
            .mockResolvedValueOnce({ rows: [] })                   // BEGIN
            .mockResolvedValueOnce({ rows: [] })                   // pg_advisory_xact_lock
            .mockResolvedValueOnce({ rows: [] })                   // existing local job lookup → none
            .mockResolvedValueOnce({ rows: [{ id: NEW_JOB_ID }] }) // INSERT INTO jobs RETURNING id
            .mockResolvedValueOnce({ rows: [] })                   // UPDATE leads converted
            .mockResolvedValueOnce({ rows: [] });                  // COMMIT
        client.query.mockResolvedValue({ rows: [] });              // any trailing tx call

        const svc = loadLeadsService({
            dbQuery: poolQuery(makeLeadRow()),
            client,
            createJob: jest.fn().mockResolvedValue({ job_id: 'zb-2222' }),
            getJob: jest.fn().mockResolvedValue({ job_number: '971346', status: 'scheduled', customer: { id: 'cust-1' } }),
            emit,
        });

        const result = await svc.convertLead('ABC123', ZB_OVERRIDES, CID);

        expect(result).toMatchObject({ job_id: NEW_JOB_ID, link: `/jobs/${NEW_JOB_ID}` });
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith(
            CID,
            'job.created',
            expect.objectContaining({ id: NEW_JOB_ID, jobId: NEW_JOB_ID, companyId: CID }),
            expect.objectContaining({ actorType: 'user', aggregateType: 'job', aggregateId: NEW_JOB_ID }),
        );
    });

    it('TC-RA-063: does NOT emit when an existing local job is reused (localJobCreated===false)', async () => {
        const emit = jest.fn().mockResolvedValue({});
        // Transaction, REUSE branch: existing-job lookup RETURNS a row (mirror the sibling
        // suite's mockClaimExistingJob) → no INSERT, localJobCreated=false.
        const client = { query: jest.fn(), release: jest.fn() };
        client.query
            .mockResolvedValueOnce({ rows: [] })   // BEGIN
            .mockResolvedValueOnce({ rows: [] })   // pg_advisory_xact_lock
            .mockResolvedValueOnce({ rows: [{ id: 1131, contact_id: 123, zenbooker_job_id: null }] }) // existing job → reuse
            .mockResolvedValueOnce({ rows: [] })   // UPDATE leads converted
            .mockResolvedValueOnce({ rows: [] });  // COMMIT
        client.query.mockResolvedValue({ rows: [] });

        const svc = loadLeadsService({
            dbQuery: poolQuery(makeLeadRow()),
            client,
            createJob: jest.fn().mockResolvedValue({ job_id: 'zb-1131' }),
            getJob: jest.fn().mockResolvedValue({ job_number: '971346', status: 'scheduled', customer: { id: 'cust-1' } }),
            emit,
        });

        const result = await svc.convertLead('ABC123', ZB_OVERRIDES, CID);

        expect(result).toMatchObject({ job_id: 1131, link: '/jobs/1131' });
        // Reuse must stay note-free — no job.created ⇒ no duplicate advisor note.
        expect(emit).not.toHaveBeenCalled();
    });
});

describe('REPAIR-ADVISOR-001 — out-of-scope create paths stay note-free (Group E)', () => {
    // ZB-webhook-sync and scheduler/agentWorker job inserts funnel through
    // jobsService.createJob (upsert) / enqueueZbJobSync — NEITHER touches the two human
    // create sites, so NEITHER emits job.created (AC-06 / E-11). Exercise the real
    // functions with eventBus spied and assert zero emits.
    function loadJobsService(emit, dbQuery) {
        let svc;
        jest.isolateModules(() => {
            jest.doMock('../backend/src/db/connection', () => ({
                query: dbQuery, getClient: jest.fn(), pool: { connect: jest.fn() },
            }));
            jest.doMock('../backend/src/services/zenbookerClient', () => ({}));
            jest.doMock('../backend/src/services/fsmService', () => ({}));
            jest.doMock('../backend/src/services/eventService', () => ({}));
            jest.doMock('../backend/src/db/membershipQueries', () => ({
                resolveProviderUserIds: jest.fn().mockResolvedValue([]),
            }));
            jest.doMock('../backend/src/config/featureFlags', () => ({
                isZenbookerSyncEnabled: () => false,
            }));
            jest.doMock('../backend/src/services/eventBus', () => ({ emit }));
            svc = require('../backend/src/services/jobsService');
        });
        return svc;
    }

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../backend/src/services/eventBus');
        jest.dontMock('../backend/src/db/connection');
    });

    it('TC-RA-083: ZB-sync/agentWorker upsert (createJob) + scheduler enqueue emit no job.created', async () => {
        const emit = jest.fn().mockResolvedValue({});
        const dbQuery = jest.fn((sql) =>
            /INSERT INTO jobs/.test(sql)
                ? Promise.resolve({ rows: [{ id: 99, blanc_status: 'Submitted' }] })
                : Promise.resolve({ rows: [] })
        );
        const svc = loadJobsService(emit, dbQuery);

        // Generic upsert used by the Zenbooker webhook sync + the agentWorker handler.
        const job = await svc.createJob({ zenbookerJobId: 'zb-ext-1', companyId: COMPANY_A });
        expect(job).toBeTruthy();

        // Scheduler enqueue path (marks a job for one-shot ZB sync) — also note-free.
        await svc.enqueueZbJobSync(COMPANY_A, 99, {});

        expect(emit).not.toHaveBeenCalled();
    });
});
