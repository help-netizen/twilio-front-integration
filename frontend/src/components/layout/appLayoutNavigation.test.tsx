import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// MOBILE-NAV-001 — the mobile bottom bar carries the four primary workspaces plus
// a "More" gear; the remaining workspaces + settings + log out live in the sheet.

const authz = vi.hoisted(() => ({
    loading: false,
    permissions: [] as string[],
    platformRole: null as string | null,
    hasPermission: (_k: string): boolean => false,
}));
authz.hasPermission = (k: string) => authz.permissions.includes(k);

vi.mock('../../hooks/useAuthz', () => ({ useAuthz: () => authz }));
vi.mock('react-router-dom', () => ({
    useNavigate: () => () => {},
    useLocation: () => ({ pathname: '/pulse', search: '', hash: '', state: null, key: 'x' }),
}));
// Passthrough the sheet so its contents are in the static markup without pulling in
// Overlay / portals / matchMedia (this is a node SSR render, no jsdom).
vi.mock('../ui/BottomSheet', () => ({
    BottomSheet: ({ open, title, children }: { open: boolean; title?: string; children: React.ReactNode }) =>
        open ? <div data-sheet title={title}>{children}</div> : null,
}));
// Feedback module drags in the Keycloak auth chain at import; stub it (disabled → no
// "Send feedback" row, which we don't assert).
vi.mock('../feedback/FeedbackWidget', () => ({
    isFeedbackWidgetEnabled: () => false,
    openFeedbackWidget: () => {},
}));

import { BottomNavBar, MobileMoreSheet } from './appLayoutNavigation';

const ALL_PERMS = [
    'pulse.view', 'leads.view', 'jobs.view', 'schedule.view', 'tasks.view',
    'contacts.view', 'payments.view', 'tenant.company.manage',
];

beforeEach(() => {
    authz.permissions = [];
    authz.platformRole = null;
});

describe('BottomNavBar (mobile) — MOBILE-NAV-001', () => {
    it('renders only the four primary workspaces plus More in the bar', () => {
        authz.permissions = ALL_PERMS;
        const html = renderToStaticMarkup(
            <BottomNavBar activeTab="pulse" pulseUnreadCount={0} leadsNewCount={0} openTasksCount={0} logout={() => {}} />,
        );
        for (const label of ['Pulse', 'Leads', 'Jobs', 'Tasks', 'More']) {
            expect(html).toContain(`<span>${label}</span>`);
        }
        // The overflow workspaces stay OUT of the bar — they live in the sheet.
        expect(html).not.toContain('<span>Schedule</span>');
        expect(html).not.toContain('<span>Contacts</span>');
        expect(html).not.toContain('<span>Payments</span>');
    });

    it('permission-filters the primary tabs but always keeps the More gear', () => {
        authz.permissions = ['pulse.view', 'jobs.view']; // no leads / tasks
        const html = renderToStaticMarkup(
            <BottomNavBar activeTab="pulse" pulseUnreadCount={0} leadsNewCount={0} openTasksCount={0} logout={() => {}} />,
        );
        expect(html).toContain('<span>Pulse</span>');
        expect(html).toContain('<span>Jobs</span>');
        expect(html).not.toContain('<span>Leads</span>');
        expect(html).not.toContain('<span>Tasks</span>');
        expect(html).toContain('<span>More</span>');
    });
});

describe('MobileMoreSheet — MOBILE-NAV-001', () => {
    it('lists the overflow workspaces, the settings groups, and Log out', () => {
        authz.permissions = ALL_PERMS;
        const html = renderToStaticMarkup(
            <MobileMoreSheet open onClose={() => {}} logout={() => {}} activeTab="pulse" />,
        );
        // overflow workspaces (moved out of the bar)
        expect(html).toContain('Schedule');
        expect(html).toContain('Contacts');
        expect(html).toContain('Payments');
        // settings section + a known group + the exit
        expect(html).toContain('Settings');
        expect(html).toContain('Business');
        expect(html).toContain('Log out');
    });

    it('renders nothing while closed', () => {
        authz.permissions = ALL_PERMS;
        const html = renderToStaticMarkup(
            <MobileMoreSheet open={false} onClose={() => {}} logout={() => {}} activeTab="pulse" />,
        );
        expect(html).toBe('');
    });
});
