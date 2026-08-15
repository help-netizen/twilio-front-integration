'use strict';

const mockProvisionCredential = jest.fn();
const mockProvisionVapi = jest.fn();
const mockWriteFile = jest.fn();
const mockAccess = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ pool: { end: jest.fn() } }));
jest.mock('../backend/src/services/machineCredentialService', () => ({
    provisionCredential: mockProvisionCredential,
}));
jest.mock('../backend/src/services/vapiOrgProvisioningService', () => ({
    provision: mockProvisionVapi,
}));
jest.mock('fs/promises', () => ({
    access: mockAccess,
    writeFile: mockWriteFile,
}));

const machineCli = require('../backend/scripts/provision-machine-credential');
const vapiCli = require('../backend/scripts/provision-vapi-tenant');

beforeEach(() => {
    jest.clearAllMocks();
});

test('both provisioning CLIs require explicit --company-id', () => {
    expect(() => machineCli.parseArgs([
        '--surface', 'vapi_tools', '--scope', 'vapi_tools:invoke', '--secret-env', 'SECRET',
    ])).toThrow('--company-id is required');
    expect(() => vapiCli.parseArgs([
        '--secret-output-file', '/secure/secret',
    ])).toThrow('--company-id is required');
});

test('machine credential CLI never prints the plaintext env secret', async () => {
    process.env.TEST_MACHINE_SECRET = 'machine-plaintext-secret-never-log-123456';
    mockProvisionCredential.mockResolvedValue({
        id: 'credential-1', companyId: 'company-1', surface: 'vapi_tools', created: true,
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        await machineCli.main([
            '--company-id', 'company-1',
            '--surface', 'vapi_tools',
            '--scope', 'vapi_tools:invoke',
            '--secret-env', 'TEST_MACHINE_SECRET',
        ]);
        expect(JSON.stringify(log.mock.calls)).not.toContain(process.env.TEST_MACHINE_SECRET);
    } finally {
        log.mockRestore();
        delete process.env.TEST_MACHINE_SECRET;
    }
});

test('Vapi CLI accepts an env-supplied secret without printing or writing it', async () => {
    process.env.TEST_VAPI_SECRET = 'vapi-plaintext-secret-never-log-123456789';
    mockProvisionVapi.mockResolvedValue({
        companyId: 'company-1',
        environment: 'prod',
        connectionId: 'connection-1',
        providerOrgId: 'org-1',
        organizationCreated: true,
        credential: { id: 'credential-1', created: true, secret: process.env.TEST_VAPI_SECRET },
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        await vapiCli.main([
            '--company-id', 'company-1',
            '--tools-secret-env', 'TEST_VAPI_SECRET',
        ]);
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain(process.env.TEST_VAPI_SECRET);
    } finally {
        log.mockRestore();
        delete process.env.TEST_VAPI_SECRET;
    }
});
