import { describe, expect, it } from 'vitest';
import appSource from '../../App.tsx?raw';
import documentTemplatesSource from '../../pages/DocumentTemplatesPage.tsx?raw';
import integrationsSource from '../../pages/IntegrationsPage.tsx?raw';
import phoneSystemOverviewSource from '../../pages/telephony/RouteManagerOverviewPage.tsx?raw';
import userGroupsSource from '../../pages/telephony/UserGroupsPage.tsx?raw';
import companiesManagerSource from '../super-admin/CompaniesManager.tsx?raw';
import machineListSource from '../workflows/MachineList.tsx?raw';
import { PHONE_SYSTEM_LINKS, SETTINGS_NAV } from './settingsNav';

const mountedSettingsRoutes = [...appSource.matchAll(/<Route\s+path="(\/settings[^"]*)"/g)]
    .map(match => match[1]);

const navModelRoutes = new Set(
    SETTINGS_NAV.flatMap(group => group.links).flatMap(link => [
        link.to.split('?')[0],
        ...(link.matches ?? []).map(match => match.pathname),
    ]),
);

const inSectionRouteLinks = [
    {
        route: '/settings/api-docs',
        source: integrationsSource,
        link: "navigate('/settings/api-docs')",
    },
    {
        route: '/settings/document-templates/:id',
        source: documentTemplatesSource,
        link: '/settings/document-templates/${t.id}',
    },
    {
        route: '/settings/telephony/user-groups/:groupId',
        source: userGroupsSource,
        link: '/settings/telephony/user-groups/${g.id}',
    },
    {
        route: '/settings/telephony/user-groups/:groupId/flow',
        source: userGroupsSource,
        link: '/settings/telephony/user-groups/${g.id}/flow',
    },
    {
        route: '/settings/workflows/:machineKey',
        source: machineListSource,
        link: '/settings/workflows/${machine.machine_key}',
    },
    {
        route: '/settings/admin/companies/:companyId',
        source: companiesManagerSource,
        link: '/settings/admin/companies/${c.id}',
    },
] as const;

const intentionalUnlistedRoutes: Record<string, string> = {
    '/settings': 'Routing-only root that redirects to the first authorized Settings subsection.',
    '/settings/action-required': 'Backward-compatible alias that redirects to Alerts & notifications.',
    '/settings/email': 'Backward-compatible alias that redirects to the Google Email subsection.',
    '/settings/business': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/scheduling': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/jobs': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/phone-ai': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/billing-payments': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/apps-integrations': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/team-access': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/alerts-notifications': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/billing-group': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/platform-administration': 'Routing-only group landing that resolves to its first authorized subsection.',
    '/settings/providers': 'Backward-compatible alias; Providers was intentionally merged into Technicians.',
};

describe('Settings route navigation completeness', () => {
    it('keeps every mounted /settings route reachable or in the reasoned omission ledger', () => {
        expect(mountedSettingsRoutes.length).toBe(new Set(mountedSettingsRoutes).size);
        expect(phoneSystemOverviewSource).toContain('PHONE_SYSTEM_LINKS.map');
        expect(phoneSystemOverviewSource).toContain('navigate(card.to)');

        for (const { source, link } of inSectionRouteLinks) {
            expect(source).toContain(link);
        }

        for (const { route } of inSectionRouteLinks) {
            expect(mountedSettingsRoutes, `${route} is no longer mounted; remove its in-section link assertion`)
                .toContain(route);
        }

        const inSectionRoutes = new Set<string>([
            ...PHONE_SYSTEM_LINKS.map(link => link.to),
            ...inSectionRouteLinks.map(link => link.route),
        ]);
        const uncovered = mountedSettingsRoutes.filter(route => (
            !navModelRoutes.has(route)
            && !inSectionRoutes.has(route)
            && !intentionalUnlistedRoutes[route]
        ));

        expect(uncovered).toEqual([]);
    });

    it('keeps the intentional-omission ledger honest and limited to mounted routes', () => {
        for (const [route, reason] of Object.entries(intentionalUnlistedRoutes)) {
            expect(reason.trim().length, `${route} needs a non-empty reason`).toBeGreaterThan(0);
            expect(mountedSettingsRoutes, `${route} is no longer mounted; remove it from the ledger`).toContain(route);
            expect(navModelRoutes.has(route), `${route} is now in the nav model; remove it from the ledger`).toBe(false);
        }
    });

    it('keeps Phone system child-link permissions aligned with their route guards', () => {
        for (const link of PHONE_SYSTEM_LINKS) {
            expect(link.permissions).toEqual(['tenant.telephony.manage']);
            const routeStart = appSource.indexOf(`path="${link.to}"`);
            expect(routeStart, `${link.to} must stay mounted`).toBeGreaterThan(-1);
            expect(appSource.slice(routeStart, routeStart + 180))
                .toContain("permissions={['tenant.telephony.manage']}");
        }
    });
});
