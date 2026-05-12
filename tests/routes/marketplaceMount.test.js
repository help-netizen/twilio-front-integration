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
