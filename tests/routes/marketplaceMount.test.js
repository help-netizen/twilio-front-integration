const fs = require('fs');
const path = require('path');

describe('marketplace server mount', () => {
    test('uses auth, integrations permission, and tenant access middleware', () => {
        const serverPath = path.join(__dirname, '../../src/server.js');
        const source = fs.readFileSync(serverPath, 'utf8');

        expect(source).toContain("const marketplaceRouter = require('../backend/src/routes/marketplace');");
        expect(source).toContain(
            "app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter);"
        );
    });
});

// TC-F016-004: vapi-ai seed migration exists and is idempotent
describe('VAPI AI marketplace seed — F016', () => {
    test('migration 088 file exists with correct app_key and provisioning_mode', () => {
        const migPath = path.join(__dirname, '../../backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql');
        expect(fs.existsSync(migPath)).toBe(true);

        const sql = fs.readFileSync(migPath, 'utf8');
        expect(sql).toContain("'vapi-ai'");
        expect(sql).toContain("'none'");
        expect(sql).toContain("'published'");
        expect(sql).toContain("'telephony'");
        expect(sql).toContain('ON CONFLICT (app_key) DO UPDATE');
    });

    test('marketplaceQueries.js loads migration 088 in ensureMarketplaceSchema', () => {
        const queriesPath = path.join(__dirname, '../../backend/src/db/marketplaceQueries.js');
        const source = fs.readFileSync(queriesPath, 'utf8');
        expect(source).toContain("readMigration('088_seed_vapi_ai_marketplace_app.sql')");
    });
});
