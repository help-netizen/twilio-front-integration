'use strict';

const crypto = require('crypto');

const VERSION_ID = '10000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = '20000000-0000-4000-8000-000000000001';
const COMPANY_ID = '30000000-0000-4000-8000-000000000001';
const SOURCE = 'export async function run() { return null; }';
const SOURCE_SHA256 = crypto.createHash('sha256').update(SOURCE).digest('hex');

const mockProvision = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    pool: { connect: mockPoolConnect },
    query: jest.fn(),
}));
jest.mock('../backend/src/services/appRuntimeIdentityService', () => ({
    provisionInstallationPrincipal: mockProvision,
}));

const tokenService = require('../backend/src/services/appRuntimeTokenService');

function client() {
    const query = jest.fn(async sql => {
        if (/FROM app_runtime_installation_controls/.test(sql)) {
            return { rows: [{ suspended_at: null, suspension_reason: null }] };
        }
        if (/FROM app_versions version/.test(sql)) {
            return { rows: [{
                id: VERSION_ID,
                app_id: '81',
                source_code: SOURCE,
                source_sha256: SOURCE_SHA256,
                allowed_tools: ['svc.list_jobs'],
            }] };
        }
        return { rows: [] };
    });
    return { query, release: jest.fn() };
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_RUNTIME_RUN_TOKEN_SECRET = 'app-view-test-secret-that-is-at-least-32-bytes';
    mockProvision.mockResolvedValue({
        installation: {
            installation_id: '91',
            company_id: COMPANY_ID,
            app_id: '81',
            installation_metadata: {
                app_runtime: {
                    version_id: VERSION_ID,
                    consented_tools: ['svc.list_jobs'],
                },
            },
        },
        principal: { id: PRINCIPAL_ID },
    });
});

afterAll(() => {
    delete process.env.APP_RUNTIME_RUN_TOKEN_SECRET;
});

describe('APP-VIEW-001 token transaction reuse', () => {
    test('the standard mint owns its transaction while single-flight mint reuses the installation row-lock transaction', async () => {
        const owned = client();
        mockPoolConnect.mockResolvedValueOnce(owned);
        await expect(tokenService.mintRunToken({
            installationId: '91',
            versionId: VERSION_ID,
        })).resolves.toMatchObject({ artifactSha256: SOURCE_SHA256 });
        expect(owned.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
            'BEGIN',
            'COMMIT',
        ]));
        expect(owned.release).toHaveBeenCalledTimes(1);

        const shared = client();
        await expect(tokenService.mintRunToken({
            installationId: '91',
            versionId: VERSION_ID,
        }, { client: shared })).resolves.toMatchObject({ artifactSha256: SOURCE_SHA256 });
        expect(shared.query.mock.calls.map(([sql]) => sql)).not.toEqual(expect.arrayContaining([
            'BEGIN',
            'COMMIT',
            'ROLLBACK',
        ]));
        expect(shared.release).not.toHaveBeenCalled();
        expect(mockProvision).toHaveBeenLastCalledWith(
            { installationId: '91' },
            shared
        );
    });
});
