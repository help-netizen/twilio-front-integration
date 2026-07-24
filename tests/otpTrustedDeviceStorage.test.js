'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const otpService = require('../backend/src/services/otpService');

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
});

describe('trusted-device credential storage', () => {
    test('stores only the credential hash bound to the crm user and resolves the same hash on use', async () => {
        const trusted = await otpService.trustDevice('crm-user-a', {
            ip: '127.0.0.1',
            label: 'native:binding:iPhone',
        });

        const [insertSql, insertParams] = db.query.mock.calls[0];
        expect(insertSql).toContain('INSERT INTO trusted_devices');
        expect(insertParams[0]).toBe('crm-user-a');
        expect(insertParams[1]).toMatch(/^[a-f0-9]{64}$/);
        expect(insertParams[1]).not.toBe(trusted.deviceId);
        expect(insertParams[2]).toBe('native:binding:iPhone');
        expect(trusted.deviceId).toMatch(/^[a-f0-9]{32}$/);

        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        await expect(otpService.isDeviceTrusted('crm-user-a', trusted.deviceId)).resolves.toBe(true);

        const [lookupSql, lookupParams] = db.query.mock.calls[1];
        expect(lookupSql).toContain('WHERE user_id = $1 AND device_id_hash = $2');
        expect(lookupParams).toEqual(['crm-user-a', insertParams[1]]);
    });
});
