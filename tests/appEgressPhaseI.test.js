'use strict';

const {
    AppConnectionValidationError,
    renderConnectionsContract,
    validateConnectionDestinations,
    validateConnections,
} = require('../backend/src/services/appConnectionValidator');
const {
    MAX_EGRESS_RESPONSE_BYTES,
    composeRequest,
    createAppEgressService,
} = require('../backend/src/services/appEgressService');
const {
    encryptSecret,
} = require('../backend/src/services/appInstallationSecretService');
const { AppRuntimeError } = require('../backend/src/services/appRuntimeErrors');
const { buildPrompt } = require('../backend/src/services/appBuilderService');
const {
    createAppVersionTransitionService,
} = require('../backend/src/services/appVersionTransitionService');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const VERSION_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '30000000-0000-4000-8000-000000000001';
const SECRET = 'supplier-secret-that-must-never-return';
const ORIGINAL_KEY = process.env.APP_SECRETS_KEY;
const CONNECTION = {
    name: 'supplier',
    base_url: 'https://api.supplier.test',
    auth: { kind: 'header', header: 'X-API-Key' },
};

function context() {
    return {
        company_id: COMPANY_ID,
        app_id: '91',
        installation_id: '101',
        version_id: VERSION_ID,
        run_id: RUN_ID,
        nonce_sha256: 'a'.repeat(64),
    };
}

function databaseFor({ connections = [CONNECTION], ciphertext = encryptSecret(SECRET) } = {}) {
    return {
        query: jest.fn(async sql => {
            if (/scanner_report->'connections'/.test(sql)) {
                return { rows: [{ connections }] };
            }
            if (/FROM app_installation_secrets/.test(sql)) {
                return { rows: ciphertext === null ? [] : [{ ciphertext }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }),
    };
}

function publicLookup() {
    return Promise.resolve([{ address: '203.0.113.20', family: 4 }]);
}

beforeEach(() => {
    process.env.APP_SECRETS_KEY = '11'.repeat(32);
});

afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.APP_SECRETS_KEY;
    else process.env.APP_SECRETS_KEY = ORIGINAL_KEY;
});

describe('APP-EGRESS-001 CRM proxy security contract', () => {
    test('1 happy: declared secret injects auth and returns JSON without exposing the secret to response, logs, meter, or DB history', async () => {
        const database = databaseFor();
        const meter = { consumeRunEgressCall: jest.fn().mockResolvedValue(1) };
        const fetchImpl = jest.fn().mockResolvedValue(new Response(
            JSON.stringify({ order_id: 'PO-41' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
        ));
        const consoleSpies = ['log', 'warn', 'error'].map(method => (
            jest.spyOn(console, method).mockImplementation(() => {})
        ));
        try {
            const service = createAppEgressService({
                database,
                meter,
                fetchImpl,
                lookup: publicLookup,
            });
            const result = await service.execute(context(), 'supplier', {
                method: 'POST',
                path: '/orders',
                query: { dry_run: false },
                body: { sku: 'P-41' },
            });

            expect(result).toEqual({ status: 201, body: { order_id: 'PO-41' } });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(fetchImpl.mock.calls[0][0]).toBe(
                'https://api.supplier.test/orders?dry_run=false'
            );
            expect(fetchImpl.mock.calls[0][1]).toMatchObject({
                method: 'POST',
                redirect: 'manual',
                headers: {
                    'X-API-Key': SECRET,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ sku: 'P-41' }),
            });
            const pinnedLookup = fetchImpl.mock.calls[0][1].agent.options.lookup;
            await expect(new Promise((resolve, reject) => {
                pinnedLookup('api.supplier.test', {}, (error, address, family) => {
                    if (error) reject(error);
                    else resolve({ address, family });
                });
            })).resolves.toEqual({ address: '203.0.113.20', family: 4 });
            expect(JSON.stringify(result)).not.toContain(SECRET);
            expect(JSON.stringify(meter.consumeRunEgressCall.mock.calls)).not.toContain(SECRET);
            expect(JSON.stringify(database.query.mock.calls)).not.toContain(SECRET);
            expect(consoleSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
        } finally {
            consoleSpies.forEach(spy => spy.mockRestore());
        }
    });

    test('2 declaration and secret gates refuse before the network in their strict order', async () => {
        const undeclaredDatabase = databaseFor({ connections: [] });
        const undeclaredFetch = jest.fn();
        const undeclared = createAppEgressService({
            database: undeclaredDatabase,
            meter: { consumeRunEgressCall: jest.fn() },
            fetchImpl: undeclaredFetch,
            lookup: publicLookup,
        });
        await expect(undeclared.execute(context(), 'supplier', {
            method: 'GET', path: '/orders',
        })).rejects.toMatchObject({ code: 'CONNECTION_NOT_DECLARED', httpStatus: 403 });
        expect(undeclaredDatabase.query).toHaveBeenCalledTimes(1);
        expect(undeclaredFetch).not.toHaveBeenCalled();

        const missingDatabase = databaseFor({ ciphertext: null });
        const missingFetch = jest.fn();
        const missing = createAppEgressService({
            database: missingDatabase,
            meter: { consumeRunEgressCall: jest.fn() },
            fetchImpl: missingFetch,
            lookup: publicLookup,
        });
        await expect(missing.execute(context(), 'supplier', {
            method: 'GET', path: '/orders',
        })).rejects.toMatchObject({
            code: 'CONNECTION_SECRET_NOT_SET',
            message: expect.stringContaining('Settings screen'),
        });
        expect(missingDatabase.query).toHaveBeenCalledTimes(2);
        expect(missingFetch).not.toHaveBeenCalled();

        const encrypted = encryptSecret(SECRET);
        process.env.APP_SECRETS_KEY = 'too-short';
        const unconfiguredFetch = jest.fn();
        const unconfiguredLookup = jest.fn();
        const unconfigured = createAppEgressService({
            database: databaseFor({ ciphertext: encrypted }),
            meter: { consumeRunEgressCall: jest.fn() },
            fetchImpl: unconfiguredFetch,
            lookup: unconfiguredLookup,
        });
        await expect(unconfigured.execute(context(), 'supplier', {
            method: 'GET', path: '/orders',
        })).rejects.toMatchObject({
            code: 'APP_SECRETS_NOT_CONFIGURED',
            httpStatus: 503,
        });
        expect(unconfiguredLookup).not.toHaveBeenCalled();
        expect(unconfiguredFetch).not.toHaveBeenCalled();
    });

    test('3 SSRF: version validation and runtime DNS reject private targets, while redirects are never followed', async () => {
        for (const baseUrl of [
            'https://127.0.0.1',
            'https://10.0.0.8',
            'https://169.254.169.254',
            'https://[::1]',
            'https://[fe80::1]',
            'https://[fec0::1]',
        ]) {
            expect(() => validateConnections([{ ...CONNECTION, base_url: baseUrl }]))
                .toThrow(AppConnectionValidationError);
        }
        await expect(validateConnectionDestinations([CONNECTION], {
            lookup: async () => [{ address: '192.168.1.20', family: 4 }],
        })).rejects.toThrow('not public');

        const privateFetch = jest.fn();
        const privateService = createAppEgressService({
            database: databaseFor(),
            meter: { consumeRunEgressCall: jest.fn() },
            fetchImpl: privateFetch,
            lookup: async () => [{ address: '10.1.2.3', family: 4 }],
        });
        await expect(privateService.execute(context(), 'supplier', {
            method: 'GET', path: '/orders',
        })).rejects.toMatchObject({ code: 'EGRESS_DESTINATION_DENIED' });
        expect(privateFetch).not.toHaveBeenCalled();

        const redirectFetch = jest.fn().mockResolvedValue(new Response('', {
            status: 302,
            headers: { Location: 'https://127.0.0.1/admin' },
        }));
        const redirectService = createAppEgressService({
            database: databaseFor(),
            meter: { consumeRunEgressCall: jest.fn().mockResolvedValue(1) },
            fetchImpl: redirectFetch,
            lookup: publicLookup,
        });
        await expect(redirectService.execute(context(), 'supplier', {
            method: 'GET', path: '/redirect',
        })).rejects.toMatchObject({ code: 'EGRESS_REDIRECT_DENIED' });
        expect(redirectFetch).toHaveBeenCalledTimes(1);
        expect(redirectFetch.mock.calls[0][1].redirect).toBe('manual');
    });

    test('secret hygiene rejects a JSON-escaped secret after parsing', async () => {
        const escapedSecret = 'supplier-secret-with-line\nbreak';
        const service = createAppEgressService({
            database: databaseFor({ ciphertext: encryptSecret(escapedSecret) }),
            meter: { consumeRunEgressCall: jest.fn().mockResolvedValue(1) },
            fetchImpl: jest.fn().mockResolvedValue(new Response(
                JSON.stringify({ reflected: escapedSecret }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )),
            lookup: publicLookup,
        });
        await expect(service.execute(context(), 'supplier', {
            method: 'GET', path: '/reflect',
        })).rejects.toMatchObject({ code: 'EGRESS_SECRET_EXPOSURE_BLOCKED' });
    });

    test('4 caps: sixth/daily refusals stay catchable, 33 KiB body and oversized response fail without partial data', async () => {
        expect(() => composeRequest(CONNECTION, {
            method: 'POST', path: '/orders', body: { value: 'x'.repeat(33 * 1024) },
        })).toThrow(expect.objectContaining({ code: 'EGRESS_BODY_TOO_LARGE' }));

        for (const failure of [
            new AppRuntimeError('EGRESS_CALL_LIMIT', 'Egress call limit of 5 reached.', 429),
            new AppRuntimeError(
                'EGRESS_DAILY_CALL_LIMIT',
                'Daily egress call limit of 500 reached.',
                429
            ),
        ]) {
            const fetchImpl = jest.fn();
            const service = createAppEgressService({
                database: databaseFor(),
                meter: { consumeRunEgressCall: jest.fn().mockRejectedValue(failure) },
                fetchImpl,
                lookup: publicLookup,
            });
            await expect(service.execute(context(), 'supplier', {
                method: 'GET', path: '/orders',
            })).rejects.toMatchObject({ code: failure.code, message: failure.message });
            expect(fetchImpl).not.toHaveBeenCalled();
        }

        const oversized = createAppEgressService({
            database: databaseFor(),
            meter: { consumeRunEgressCall: jest.fn().mockResolvedValue(1) },
            fetchImpl: jest.fn().mockResolvedValue(
                new Response('x'.repeat(MAX_EGRESS_RESPONSE_BYTES + 1), { status: 200 })
            ),
            lookup: publicLookup,
        });
        await expect(oversized.execute(context(), 'supplier', {
            method: 'GET', path: '/large',
        })).rejects.toMatchObject({
            code: 'EGRESS_RESPONSE_TOO_LARGE',
            message: expect.stringContaining('256 KiB'),
        });
    });

    test('7 sabotage control: removing the declared-connection subset gate makes this attack test red', async () => {
        const database = databaseFor({ connections: [] });
        const service = createAppEgressService({
            database,
            meter: { consumeRunEgressCall: jest.fn() },
            fetchImpl: jest.fn(),
            lookup: publicLookup,
        });
        await expect(service.execute(context(), 'attacker_connection', {
            method: 'GET', path: '/steal',
        })).rejects.toMatchObject({
            code: 'CONNECTION_NOT_DECLARED',
            message: 'Connection is not declared by the accepted app version.',
        });
        expect(database.query).toHaveBeenCalledTimes(1);
    });

    test('builder prompt renders ctx.http and connection declarations from the validator contract', () => {
        const prompt = buildPrompt({ history: [], current_connections: [CONNECTION] });
        const contract = renderConnectionsContract();
        expect(prompt).toContain(contract);
        expect(prompt).toContain('ctx.http.request');
        expect(prompt).toContain(JSON.stringify([CONNECTION]));
    });

    test('version submission invokes the same validator boundary before changing draft status', async () => {
        const validateConnectionOrigins = jest.fn().mockResolvedValue([CONNECTION]);
        const draft = {
            id: VERSION_ID,
            app_id: '91',
            version_number: 'builder-1',
            source_sha256: 'a'.repeat(64),
            scanner_report: { connections: [CONNECTION] },
            status: 'draft',
            company_id: COMPANY_ID,
            data_collections: [],
            actions: [],
            subscribes: [],
            connections: [CONNECTION],
        };
        const query = jest.fn(async sql => {
            if (/FROM app_versions version/.test(sql) && /FOR UPDATE OF version/.test(sql)) {
                return { rows: [draft] };
            }
            if (/SELECT prior.data_collections/.test(sql)) return { rows: [] };
            if (/UPDATE app_versions/.test(sql) && /SET status = 'submitted'/.test(sql)) {
                return { rows: [{ ...draft, status: 'submitted' }] };
            }
            if (/INSERT INTO audit_log/.test(sql)) return { rows: [{ id: 1 }] };
            return { rows: [] };
        });
        const service = createAppVersionTransitionService({
            database: {
                getClient: jest.fn().mockResolvedValue({ query, release: jest.fn() }),
            },
            validateConnectionOrigins,
        });
        await expect(service.submitVersion({
            versionId: VERSION_ID,
            appId: '91',
            companyId: COMPANY_ID,
            actorId: '40000000-0000-4000-8000-000000000001',
        })).resolves.toMatchObject({ status: 'submitted', connections: [CONNECTION] });
        expect(validateConnectionOrigins).toHaveBeenCalledWith([CONNECTION]);
        expect(validateConnectionOrigins.mock.invocationCallOrder[0])
            .toBeLessThan(query.mock.invocationCallOrder.find((_order, index) => (
                /SET status = 'submitted'/.test(query.mock.calls[index][0])
            )));
    });
});
