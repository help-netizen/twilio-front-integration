const fs = require('fs');
const path = require('path');

describe('CRM server rollout mounts', () => {
    const serverSource = fs.readFileSync(path.resolve(__dirname, '../../src/server.js'), 'utf8');

    test('mounts authenticated CRM REST and MCP endpoints behind auth and tenant middleware', () => {
        expect(serverSource).toContain("const crmRouter = require('../backend/src/routes/crm');");
        expect(serverSource).toContain("const crmMcpRouter = require('../backend/src/routes/crmMcp');");
        expect(serverSource).toContain("app.use('/api/crm', authenticate, requireCompanyAccess, crmRouter);");
        expect(serverSource).toContain("app.use('/api/crm/mcp', authenticate, requireCompanyAccess, crmMcpRouter);");
    });

    test('mounts public MCP transport separately from authenticated CRM API', () => {
        expect(serverSource).toContain("const crmMcpPublicRouter = require('../backend/src/routes/crmMcpPublic');");
        expect(serverSource).toContain("app.use('/mcp/crm', crmMcpPublicRouter);");
        expect(serverSource).not.toContain("app.use('/mcp/crm', authenticate");
    });
});
