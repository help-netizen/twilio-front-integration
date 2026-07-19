import { describe, expect, it } from 'vitest';
import {
    SETTINGS_NAV,
    findActiveSettingsGroup,
    getVisibleSettingsGroups,
    isSettingsNavLinkActive,
    resolveSettingsLanding,
} from './settingsNav';
import layoutSource from './SettingsLayout.tsx?raw';
import headerNavigationSource from '../layout/appLayoutNavigation.tsx?raw';

const allPermissions = [
    'tenant.company.manage',
    'schedule.dispatch',
    'tenant.telephony.manage',
    'tenant.integrations.manage',
    'price_book.manage',
    'tenant.users.manage',
    'tenant.roles.manage',
];

describe('SETTINGS-IA-001 navigation model', () => {
    it('defines the approved tenant groups and a separate platform group', () => {
        // Albusto's own subscription ("Billing") is deliberately last and split
        // from the money the company collects from customers ("Payments").
        expect(SETTINGS_NAV.filter(group => group.kind === 'tenant').map(group => group.title)).toEqual([
            'Business',
            'Scheduling & service areas',
            'Jobs and Leads',
            'Communication and AI',
            'Payments',
            'Apps & integrations',
            'Team & access',
            'Alerts & notifications',
            'Billing',
        ]);
        expect(SETTINGS_NAV.filter(group => group.kind === 'platform').map(group => group.title))
            .toEqual(['Platform administration']);
    });

    it('is consumed by both desktop Settings and header/mobile navigation', () => {
        expect(layoutSource).toContain('getVisibleSettingsGroups');
        expect(headerNavigationSource).toContain('getVisibleSettingsGroups');
        expect(headerNavigationSource).not.toContain('SETTINGS_ITEMS');
    });

    it('filters leaves by their existing permissions and removes empty groups', () => {
        const companyManager = getVisibleSettingsGroups({ permissions: ['tenant.company.manage'] });
        expect(companyManager.map(group => group.id)).toEqual([
            'business',
            'scheduling',
            'jobs',
            'phone-ai',
            'billing-payments',
            'alerts-notifications',
            'billing',
        ]);
        expect(companyManager.find(group => group.id === 'scheduling')?.links.map(link => link.label)).toEqual([
            'Company schedule', 'Service areas', 'Technicians',
        ]);
        expect(companyManager.find(group => group.id === 'phone-ai')?.links.map(link => link.label))
            .toEqual(['Message templates']);
    });

    it('keeps document templates integration-gated after moving it under billing', () => {
        const companyOnly = getVisibleSettingsGroups({ permissions: ['tenant.company.manage', 'price_book.manage'] });
        expect(companyOnly.find(group => group.id === 'billing-payments')?.links.map(link => link.id))
            .not.toContain('document-templates');

        const integrations = getVisibleSettingsGroups({ permissions: ['tenant.integrations.manage'] });
        expect(integrations.find(group => group.id === 'billing-payments')?.links.map(link => link.id))
            .toContain('document-templates');
    });

    it('shows platform administration only for the platform role', () => {
        expect(getVisibleSettingsGroups({ permissions: allPermissions }).some(group => group.kind === 'platform')).toBe(false);
        expect(getVisibleSettingsGroups({ platformRole: 'super_admin' }).map(group => group.id))
            .toEqual(['platform-administration']);
    });

    it('matches query-addressed subsections without highlighting their siblings', () => {
        const groups = getVisibleSettingsGroups({ permissions: allPermissions });
        const apps = groups.find(group => group.id === 'apps-integrations')!;
        const marketplace = apps.links.find(link => link.id === 'marketplace')!;
        const api = apps.links.find(link => link.id === 'api-access')!;

        expect(isSettingsNavLinkActive(marketplace, { pathname: '/settings/integrations', search: '' })).toBe(true);
        expect(isSettingsNavLinkActive(marketplace, { pathname: '/settings/integrations', search: '?tab=unknown' })).toBe(true);
        expect(isSettingsNavLinkActive(marketplace, { pathname: '/settings/integrations', search: '?tab=api-keys' })).toBe(false);
        expect(isSettingsNavLinkActive(api, { pathname: '/settings/integrations', search: '?tab=api-keys' })).toBe(true);
        expect(isSettingsNavLinkActive(api, { pathname: '/settings/api-docs' })).toBe(true);
        expect(findActiveSettingsGroup(groups, { pathname: '/settings/integrations', search: '?tab=zenbooker' })?.id)
            .toBe('apps-integrations');
    });

    it('matches the two Jobs subsections that share the lead-form route', () => {
        const jobs = getVisibleSettingsGroups({ permissions: ['tenant.company.manage'] })
            .find(group => group.id === 'jobs')!;
        const setup = jobs.links.find(link => link.id === 'job-setup')!;
        const workflows = jobs.links.find(link => link.id === 'job-workflows')!;
        expect(isSettingsNavLinkActive(setup, { pathname: '/settings/lead-form' })).toBe(true);
        expect(isSettingsNavLinkActive(setup, { pathname: '/settings/lead-form', search: '?tab=workflows' })).toBe(false);
        expect(isSettingsNavLinkActive(workflows, { pathname: '/settings/lead-form', search: '?tab=workflows' })).toBe(true);
        expect(isSettingsNavLinkActive(workflows, { pathname: '/settings/workflows/job' })).toBe(true);
    });

    it('does not highlight plan and bank-transfer leaves at the same time', () => {
        // Plan lives in the standalone "Billing" group, bank details under
        // "Payments" — but their paths still nest (/settings/billing vs
        // /settings/billing/bank-transfer-details), so the exact-match guard
        // still matters across groups.
        const groups = getVisibleSettingsGroups({ permissions: ['tenant.company.manage'] });
        const plan = groups.find(group => group.id === 'billing')!
            .links.find(link => link.id === 'plan-usage')!;
        const bank = groups.find(group => group.id === 'billing-payments')!
            .links.find(link => link.id === 'bank-transfer-details')!;
        const location = { pathname: '/settings/billing/bank-transfer-details' };
        expect(isSettingsNavLinkActive(plan, location)).toBe(false);
        expect(isSettingsNavLinkActive(bank, location)).toBe(true);
    });

    it('keeps every telephony context under the Phone system parent subsection', () => {
        const phoneSystem = getVisibleSettingsGroups({ permissions: ['tenant.telephony.manage'] })
            .find(group => group.id === 'phone-ai')!
            .links.find(link => link.id === 'phone-system')!;

        [
            '/settings/telephony',
            '/settings/telephony/dashboard',
            '/settings/telephony/user-groups/group-1',
            '/settings/telephony/user-groups/group-1/flow',
            '/settings/telephony/phone-numbers',
            '/settings/telephony/audio-library',
            '/settings/telephony/blacklist',
            '/settings/telephony/provider-settings',
            '/settings/telephony/routing-logs',
        ].forEach(pathname => {
            expect(isSettingsNavLinkActive(phoneSystem, { pathname })).toBe(true);
        });
    });
});

describe('Settings landing route resolution', () => {
    it('sends /settings to the first visible group and leaf', () => {
        expect(resolveSettingsLanding({ permissions: allPermissions })).toBe('/settings/company');
        expect(resolveSettingsLanding({ permissions: ['schedule.dispatch'] }))
            .toBe('/settings/scheduling/company-schedule');
        expect(resolveSettingsLanding({ platformRole: 'super_admin' })).toBe('/settings/admin');
    });

    it('resolves each group landing to its first visible leaf', () => {
        expect(resolveSettingsLanding({ permissions: allPermissions }, 'apps-integrations'))
            .toBe('/settings/integrations?tab=marketplace');
        expect(resolveSettingsLanding({ permissions: ['tenant.roles.manage'] }, 'team-access'))
            .toBe('/settings/roles');
    });

    it('falls back safely when a requested group is unavailable', () => {
        expect(resolveSettingsLanding({ permissions: ['schedule.dispatch'] }, 'business'))
            .toBe('/settings/scheduling/company-schedule');
        expect(resolveSettingsLanding({})).toBe('/pulse');
    });
});
