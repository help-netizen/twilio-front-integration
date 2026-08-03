const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '../backend/db/migrations');
const upFile = '232_native_voice_push.sql';
const rollbackFile = 'rollback_232_native_voice_push.sql';
const up = fs.readFileSync(path.join(migrationsDir, upFile), 'utf8');
const rollback = fs.readFileSync(path.join(migrationsDir, rollbackFile), 'utf8');

describe('SOFTPHONE-NATIVE-001 migration 232', () => {
    test('stores the tenant Push Credential SID and creates the 30-day tenant/user registry', () => {
        expect(up).toMatch(/ALTER TABLE company_telephony[\s\S]*ADD COLUMN IF NOT EXISTS ios_push_credential_sid TEXT/);
        expect(up).toMatch(/CREATE TABLE IF NOT EXISTS native_voice_registrations/);
        expect(up).toMatch(/PRIMARY KEY \(company_id, user_id\)/);
        expect(up).toMatch(/REFERENCES company_memberships\(user_id, company_id\) ON DELETE CASCADE/);
        expect(up).toMatch(/INTERVAL '30 days'/);
    });

    test('ships a matching idempotent rollback and has no local number collision', () => {
        expect(rollback).toMatch(/DROP TABLE IF EXISTS native_voice_registrations/);
        expect(rollback).toMatch(/DROP COLUMN IF EXISTS ios_push_credential_sid/);
        const files = fs.readdirSync(migrationsDir);
        expect(files.filter(file => /^232_/.test(file))).toEqual([upFile]);
        expect(files).toContain(rollbackFile);
    });
});
