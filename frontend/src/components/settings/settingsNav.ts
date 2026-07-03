/**
 * Settings sub-navigation config (UI-AUDIT-001 W4, variant C — persistent sidebar).
 *
 * Single source of truth for the Settings sidebar: groups → links. Gating fields
 * (`permissions` / `platformRoles`) are copied EXACTLY from the corresponding
 * route's <ProtectedRoute> in App.tsx and follow the same semantics (any-of):
 * a link is shown when the user passes the same check that would let the route
 * render. Keep them in sync when a route's guard changes.
 *
 * Redirect-only routes (/settings/action-required, /settings/email) are NOT
 * listed here. Fullscreen surfaces (api-docs, telephony/*, template editor,
 * workflow builder) live outside the SettingsLayout but Telephony keeps a
 * single entry link — that area has its own sidebar.
 */

export interface SettingsNavLink {
    label: string;
    to: string;
    /** Permission keys (any-of), exactly as in the route's ProtectedRoute. */
    permissions?: string[];
    /** Platform roles for platform-gated routes (Super admin). */
    platformRoles?: string[];
}

export interface SettingsNavGroup {
    title: string;
    links: SettingsNavLink[];
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
    {
        title: 'Company',
        links: [
            { label: 'Company profile', to: '/settings/company', permissions: ['tenant.company.manage'] },
            { label: 'Users', to: '/settings/users', permissions: ['tenant.users.manage'] },
            { label: 'Roles & Access', to: '/settings/roles', permissions: ['tenant.roles.manage'] },
            { label: 'Billing', to: '/settings/billing', permissions: ['tenant.company.manage'] },
            { label: 'Notifications', to: '/settings/actions-notifications', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        title: 'Sales',
        links: [
            { label: 'Lead form', to: '/settings/lead-form', permissions: ['tenant.company.manage'] },
            { label: 'Quick messages', to: '/settings/quick-messages', permissions: ['tenant.company.manage'] },
            { label: 'Price Book', to: '/settings/price-book', permissions: ['price_book.manage'] },
            { label: 'Service territories', to: '/settings/service-territories', permissions: ['tenant.company.manage'] },
            { label: 'Document templates', to: '/settings/document-templates', permissions: ['tenant.integrations.manage'] },
            { label: 'Automation', to: '/settings/automation', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        title: 'Team',
        links: [
            { label: 'Providers', to: '/settings/providers', permissions: ['tenant.company.manage'] },
            { label: 'Technicians', to: '/settings/technicians', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        title: 'Integrations',
        links: [
            { label: 'Integrations', to: '/settings/integrations', permissions: ['tenant.integrations.manage'] },
        ],
    },
    {
        title: 'Telephony',
        links: [
            { label: 'Telephony', to: '/settings/telephony', permissions: ['tenant.telephony.manage'] },
        ],
    },
    {
        title: 'Admin',
        links: [
            { label: 'Super admin', to: '/settings/admin', platformRoles: ['super_admin'] },
        ],
    },
];
