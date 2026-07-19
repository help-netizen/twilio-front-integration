import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import appSource from '../../App.tsx?raw';

const authz = vi.hoisted(() => ({
    loading: false,
    permissions: [] as string[],
    platformRole: null as string | null,
}));

vi.mock('../../hooks/useAuthz', () => ({ useAuthz: () => authz }));
vi.mock('react-router-dom', () => ({
    Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
        <span data-to={to} data-replace={String(!!replace)} />
    ),
}));

import { SettingsLandingRedirect } from './SettingsLandingRedirect';

beforeEach(() => {
    authz.loading = false;
    authz.permissions = [];
    authz.platformRole = null;
});

describe('SettingsLandingRedirect routes', () => {
    it('redirects the Settings root to the first authorized leaf', () => {
        authz.permissions = ['tenant.company.manage'];
        const markup = renderToStaticMarkup(<SettingsLandingRedirect />);
        expect(markup).toContain('data-to="/settings/company"');
        expect(markup).toContain('data-replace="true"');
    });

    it('redirects a group landing to that group\'s first authorized leaf', () => {
        authz.permissions = ['tenant.integrations.manage'];
        const markup = renderToStaticMarkup(<SettingsLandingRedirect groupId="apps-integrations" />);
        expect(markup).toContain('data-to="/settings/integrations?tab=marketplace"');
    });

    it('does not redirect while authorization is loading', () => {
        authz.loading = true;
        expect(renderToStaticMarkup(<SettingsLandingRedirect />)).toBe('');
    });

    it('registers every group landing and preserves the two legacy redirects', () => {
        [
            '/settings/business',
            '/settings/scheduling',
            '/settings/jobs',
            '/settings/phone-ai',
            '/settings/billing-payments',
            '/settings/apps-integrations',
            '/settings/team-access',
            '/settings/alerts-notifications',
            '/settings/platform-administration',
        ].forEach(path => expect(appSource).toContain(`path="${path}"`));
        expect(appSource).toContain('path="/settings/action-required"');
        expect(appSource).toContain('path="/settings/email"');
    });
});
