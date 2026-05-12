const { hasIntegrationScope, normalizeScopes } = require('../../backend/src/middleware/integrationScopes');

describe('integrationScopes', () => {
    test('normalizes arrays and JSON strings', () => {
        expect(normalizeScopes(['leads:create'])).toEqual(['leads:create']);
        expect(normalizeScopes('["analytics:read"]')).toEqual(['analytics:read']);
        expect(normalizeScopes('not-json')).toEqual([]);
    });

    test('allows exact scope', () => {
        expect(hasIntegrationScope(['leads:create'], 'leads:create')).toBe(true);
        expect(hasIntegrationScope(['analytics:read'], 'leads:create')).toBe(false);
    });

    test('allows full_access as scope alias', () => {
        expect(hasIntegrationScope(['full_access'], 'calls.transcripts:read')).toBe(true);
        expect(hasIntegrationScope(['full_access'], 'leads:create')).toBe(true);
    });
});
