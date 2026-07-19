import { describe, expect, it } from 'vitest';
import appSource from '../../App.tsx?raw';
import settingsLayoutSource from './SettingsLayout.tsx?raw';
import telephonyLayoutSource from '../telephony/TelephonyLayout.tsx?raw';
import { SETTINGS_NAV, isSettingsNavLinkActive } from './settingsNav';

const settingsStart = appSource.indexOf('<Route element={<SettingsLayout />}>');
const settingsEnd = appSource.indexOf('<Route path="/payments"', settingsStart);
const settingsRoutes = appSource.slice(settingsStart, settingsEnd);

const regularTelephonyPages = [
    ['/settings/telephony', 'RouteManagerOverviewPage'],
    ['/settings/telephony/user-groups', 'UserGroupsPage'],
    ['/settings/telephony/user-groups/:groupId', 'UserGroupDetailPage'],
    ['/settings/telephony/phone-numbers', 'PhoneNumbersPage'],
    ['/settings/telephony/audio-library', 'AudioLibraryPage'],
    ['/settings/telephony/blacklist', 'BlacklistPage'],
    ['/settings/telephony/provider-settings', 'ProviderSettingsPage'],
    ['/settings/telephony/routing-logs', 'RoutingLogsPage'],
    ['/settings/telephony/dashboard', 'OperationsDashboardPage'],
] as const;

describe('SETTINGS-IA-001 Batch 2 routes', () => {
    it.each(regularTelephonyPages)('%s renders under the unified Settings layout', (path, page) => {
        expect(settingsRoutes).toContain(`path="${path}"`);
        expect(settingsRoutes).toContain(`<TelephonyLayout><${page} /></TelephonyLayout>`);
        expect(appSource.split(`path="${path}"`)).toHaveLength(2);
    });

    it('retains the connection gate but removes the second telephony navigation and height scroller', () => {
        expect(telephonyLayoutSource).toContain("authedFetch('/api/telephony/numbers/status')");
        expect(telephonyLayoutSource).toContain('to="/settings/integrations/telephony-twilio"');
        expect(telephonyLayoutSource).not.toContain('TelephonyNav');
        expect(telephonyLayoutSource).not.toContain('100dvh');
        expect(settingsLayoutSource).toContain('md:h-full');
        expect(settingsLayoutSource).toContain('md:overflow-y-auto');
    });

    it('keeps the call-flow builder full-screen and highlights its Phone system parent', () => {
        const builderRoute = 'path="/settings/telephony/user-groups/:groupId/flow"';
        expect(settingsRoutes).not.toContain(builderRoute);
        expect(appSource).toContain(builderRoute);

        const phoneSystem = SETTINGS_NAV
            .find(group => group.id === 'phone-ai')!
            .links.find(link => link.id === 'phone-system')!;
        expect(isSettingsNavLinkActive(phoneSystem, {
            pathname: '/settings/telephony/user-groups/group-1/flow',
        })).toBe(true);
    });

    it('redirects the legacy Providers URL and removes its navigation leaf', () => {
        expect(settingsRoutes).toContain('path="/settings/providers" element={<Navigate to="/settings/technicians" replace />}');
        expect(appSource).not.toContain("import ProvidersPage from './pages/ProvidersPage'");
        expect(SETTINGS_NAV.flatMap(group => group.links).some(link => link.id === 'providers')).toBe(false);
    });

    it('keeps the backward-compatible operations dashboard URL', () => {
        expect(appSource).toContain('path="/calls/dashboard" element={<Navigate to="/settings/telephony/dashboard" replace />}');
    });
});
