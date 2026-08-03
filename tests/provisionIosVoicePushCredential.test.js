const mockGetClientForCompany = jest.fn();
const mockGetIosPushCredentialSid = jest.fn();
const mockSetIosPushCredentialSid = jest.fn();

jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getClientForCompany: (...args) => mockGetClientForCompany(...args),
    getIosPushCredentialSid: (...args) => mockGetIosPushCredentialSid(...args),
    setIosPushCredentialSid: (...args) => mockSetIosPushCredentialSid(...args),
    DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
}));

const {
    parseArgs,
    provisionIosPushCredential,
    validatePem,
} = require('../backend/scripts/provision-ios-voice-push-credential');

const CERTIFICATE = '-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----';
const PUSH_SID = `CR${'a'.repeat(32)}`;

beforeEach(() => {
    jest.clearAllMocks();
    mockSetIosPushCredentialSid.mockResolvedValue(PUSH_SID);
});

test('defaults to production APNs and requires exactly one tenant target', () => {
    expect(parseArgs(['--company', 'company-1', '--cert', 'cert.pem', '--key', 'key.pem']))
        .toEqual({
            sandbox: false,
            master: false,
            companyId: 'company-1',
            certPath: 'cert.pem',
            keyPath: 'key.pem',
        });
    expect(parseArgs(['--master', '--cert', 'cert.pem', '--key', 'key.pem', '--sandbox']))
        .toMatchObject({ master: true, sandbox: true });
    expect(() => parseArgs(['--cert', 'cert.pem', '--key', 'key.pem'])).toThrow();
    expect(() => validatePem('not a cert', PRIVATE_KEY)).toThrow();
});

test('idempotently updates the stored credential on the resolved tenant account', async () => {
    const update = jest.fn().mockResolvedValue({ sid: PUSH_SID });
    const credentials = jest.fn(() => ({ update }));
    credentials.create = jest.fn();
    mockGetClientForCompany.mockResolvedValue({ client: { chat: { v2: { credentials } } } });
    mockGetIosPushCredentialSid.mockResolvedValue(PUSH_SID);

    await expect(provisionIosPushCredential({
        companyId: 'company-1',
        certificate: CERTIFICATE,
        privateKey: PRIVATE_KEY,
        sandbox: false,
    })).resolves.toBe(PUSH_SID);

    expect(mockGetClientForCompany).toHaveBeenCalledWith('company-1');
    expect(credentials).toHaveBeenCalledWith(PUSH_SID);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
        certificate: CERTIFICATE,
        privateKey: PRIVATE_KEY,
        sandbox: false,
    }));
    expect(credentials.create).not.toHaveBeenCalled();
    expect(mockSetIosPushCredentialSid).toHaveBeenCalledWith('company-1', PUSH_SID);
});

test('creates an APN credential when the resolved account has no stored SID', async () => {
    const credentials = jest.fn();
    credentials.create = jest.fn().mockResolvedValue({ sid: PUSH_SID });
    mockGetClientForCompany.mockResolvedValue({ client: { chat: { v2: { credentials } } } });
    mockGetIosPushCredentialSid.mockResolvedValue(null);

    await provisionIosPushCredential({
        companyId: 'company-1',
        certificate: CERTIFICATE,
        privateKey: PRIVATE_KEY,
        sandbox: true,
    });

    expect(credentials.create).toHaveBeenCalledWith(expect.objectContaining({
        type: 'apn',
        sandbox: true,
        certificate: CERTIFICATE,
        privateKey: PRIVATE_KEY,
    }));
    expect(mockSetIosPushCredentialSid).toHaveBeenCalledWith('company-1', PUSH_SID);
});
