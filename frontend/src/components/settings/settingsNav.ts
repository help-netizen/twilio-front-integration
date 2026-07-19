/**
 * SETTINGS-IA-001 — one navigation model for every Settings entry point.
 *
 * Permission/platform-role gates mirror App.tsx <ProtectedRoute> guards and use
 * the same any-of semantics. Keep the two in sync when a leaf guard changes.
 */

export type SettingsGroupId =
    | 'business'
    | 'scheduling'
    | 'jobs'
    | 'phone-ai'
    | 'billing-payments'
    | 'apps-integrations'
    | 'team-access'
    | 'alerts-notifications'
    | 'billing'
    | 'platform-administration';

export interface SettingsNavLocation {
    pathname: string;
    search?: string;
}

export interface SettingsNavMatch {
    pathname: string;
    /** Default false: the pathname and its descendants match. */
    exact?: boolean;
    /** Every listed query value must match. */
    search?: Record<string, string>;
    /** Listed query keys may be absent and still match their configured value. */
    allowMissingSearch?: string[];
    /** Match when a key is absent or has a value outside this known-value set. */
    fallbackForSearch?: Record<string, readonly string[]>;
}

export interface SettingsNavLink {
    id: string;
    label: string;
    to: string;
    /** Permission keys (any-of), exactly as in the route's ProtectedRoute. */
    permissions?: readonly string[];
    /** Platform roles for platform-gated routes. */
    platformRoles?: readonly string[];
    /** Overrides default matching when several subsections share one pathname. */
    matches?: readonly SettingsNavMatch[];
    /** Clickable destinations owned by this subsection rather than the top-level Settings list. */
    inSectionLinks?: readonly SettingsNavLink[];
}

export interface SettingsNavGroup {
    id: SettingsGroupId;
    title: string;
    landingPath: string;
    kind: 'tenant' | 'platform';
    links: readonly SettingsNavLink[];
}

export interface SettingsNavAccess {
    permissions?: readonly string[];
    platformRole?: string | null;
}

export const SETTINGS_GROUP_PATHS: Record<SettingsGroupId, string> = {
    business: '/settings/business',
    scheduling: '/settings/scheduling',
    jobs: '/settings/jobs',
    'phone-ai': '/settings/phone-ai',
    'billing-payments': '/settings/billing-payments',
    'apps-integrations': '/settings/apps-integrations',
    'team-access': '/settings/team-access',
    'alerts-notifications': '/settings/alerts-notifications',
    billing: '/settings/billing-group',
    'platform-administration': '/settings/platform-administration',
};

export const PHONE_SYSTEM_LINKS = [
    { id: 'phone-user-groups', label: 'User Groups', to: '/settings/telephony/user-groups', permissions: ['tenant.telephony.manage'] },
    { id: 'phone-numbers', label: 'Phone Numbers', to: '/settings/telephony/phone-numbers', permissions: ['tenant.telephony.manage'] },
    { id: 'phone-audio-library', label: 'Audio Library', to: '/settings/telephony/audio-library', permissions: ['tenant.telephony.manage'] },
    { id: 'phone-blacklist', label: 'Blacklist', to: '/settings/telephony/blacklist', permissions: ['tenant.telephony.manage'] },
    { id: 'phone-provider-settings', label: 'Provider Settings', to: '/settings/telephony/provider-settings', permissions: ['tenant.telephony.manage'] },
    { id: 'phone-routing-logs', label: 'Routing Logs', to: '/settings/telephony/routing-logs', permissions: ['tenant.telephony.manage'] },
    { id: 'phone-dashboard', label: 'Live Operations', to: '/settings/telephony/dashboard', permissions: ['tenant.telephony.manage'] },
] as const satisfies readonly SettingsNavLink[];

export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
    {
        id: 'business',
        title: 'Business',
        landingPath: SETTINGS_GROUP_PATHS.business,
        kind: 'tenant',
        links: [
            { id: 'business-profile', label: 'Business profile', to: '/settings/company', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        id: 'scheduling',
        title: 'Scheduling & service areas',
        landingPath: SETTINGS_GROUP_PATHS.scheduling,
        kind: 'tenant',
        links: [
            {
                id: 'company-schedule', label: 'Company schedule', to: '/settings/scheduling/company-schedule',
                permissions: ['schedule.dispatch', 'tenant.company.manage'],
            },
            { id: 'service-areas', label: 'Service areas', to: '/settings/service-territories', permissions: ['tenant.company.manage'] },
            { id: 'technicians', label: 'Technicians', to: '/settings/technicians', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        id: 'jobs',
        title: 'Jobs and Leads',
        landingPath: SETTINGS_GROUP_PATHS.jobs,
        kind: 'tenant',
        links: [
            {
                id: 'job-setup', label: 'Job setup', to: '/settings/lead-form?tab=settings', permissions: ['tenant.company.manage'],
                matches: [{ pathname: '/settings/lead-form', exact: true, search: { tab: 'settings' }, allowMissingSearch: ['tab'] }],
            },
            {
                id: 'job-workflows', label: 'Workflows', to: '/settings/lead-form?tab=workflows', permissions: ['tenant.company.manage'],
                matches: [
                    { pathname: '/settings/lead-form', exact: true, search: { tab: 'workflows' } },
                    { pathname: '/settings/workflows' },
                ],
            },
            { id: 'automations', label: 'Automations', to: '/settings/automation', permissions: ['tenant.company.manage'] },
            // Job list columns intentionally NOT here: column choice is edited in
            // context on the Jobs page (owner decision), not in Settings.
        ],
    },
    {
        id: 'phone-ai',
        title: 'Communication and AI',
        landingPath: SETTINGS_GROUP_PATHS['phone-ai'],
        kind: 'tenant',
        links: [
            {
                id: 'phone-system', label: 'Phone system', to: '/settings/telephony',
                permissions: ['tenant.telephony.manage'], inSectionLinks: PHONE_SYSTEM_LINKS,
            },
            { id: 'phone-setup', label: 'Phone setup', to: '/settings/integrations/telephony-twilio', permissions: ['tenant.integrations.manage'] },
            { id: 'ai-phone-agent', label: 'AI phone agent', to: '/settings/integrations/vapi-ai', permissions: ['tenant.integrations.manage'] },
            { id: 'email-assistant', label: 'Email assistant', to: '/settings/integrations/mail-secretary', permissions: ['tenant.integrations.manage'] },
            { id: 'outbound-lead-caller', label: 'Outbound lead caller', to: '/settings/integrations/outbound-lead-caller', permissions: ['tenant.integrations.manage'] },
            { id: 'message-templates', label: 'Message templates', to: '/settings/quick-messages', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        id: 'billing-payments',
        title: 'Payments',
        landingPath: SETTINGS_GROUP_PATHS['billing-payments'],
        kind: 'tenant',
        links: [
            // Albusto's own subscription lives in the separate "Billing" group at
            // the end of the menu — money we take from customers and money we pay
            // Albusto are deliberately not mixed (owner decision).
            { id: 'customer-payments', label: 'Customer payments', to: '/settings/integrations/stripe-payments', permissions: ['tenant.integrations.manage'] },
            { id: 'bank-transfer-details', label: 'Bank transfer details', to: '/settings/billing/bank-transfer-details', permissions: ['tenant.company.manage'] },
            { id: 'price-book', label: 'Price book', to: '/settings/price-book', permissions: ['price_book.manage'] },
            { id: 'document-templates', label: 'Document templates', to: '/settings/document-templates', permissions: ['tenant.integrations.manage'] },
        ],
    },
    {
        id: 'apps-integrations',
        title: 'Apps & integrations',
        landingPath: SETTINGS_GROUP_PATHS['apps-integrations'],
        kind: 'tenant',
        links: [
            {
                id: 'marketplace', label: 'Marketplace', to: '/settings/integrations?tab=marketplace', permissions: ['tenant.integrations.manage'],
                matches: [{
                    pathname: '/settings/integrations',
                    exact: true,
                    search: { tab: 'marketplace' },
                    fallbackForSearch: { tab: ['marketplace', 'api-keys', 'zenbooker'] },
                }],
            },
            {
                id: 'zenbooker', label: 'Zenbooker', to: '/settings/integrations?tab=zenbooker', permissions: ['tenant.integrations.manage'],
                matches: [{ pathname: '/settings/integrations', exact: true, search: { tab: 'zenbooker' } }],
            },
            { id: 'google-email', label: 'Google Email', to: '/settings/integrations/google-email', permissions: ['tenant.integrations.manage'] },
            {
                id: 'api-access', label: 'API access', to: '/settings/integrations?tab=api-keys', permissions: ['tenant.integrations.manage'],
                matches: [
                    { pathname: '/settings/integrations', exact: true, search: { tab: 'api-keys' } },
                    { pathname: '/settings/api-docs', exact: true },
                ],
            },
        ],
    },
    {
        id: 'team-access',
        title: 'Team & access',
        landingPath: SETTINGS_GROUP_PATHS['team-access'],
        kind: 'tenant',
        links: [
            { id: 'users', label: 'Users', to: '/settings/users', permissions: ['tenant.users.manage'] },
            { id: 'roles-permissions', label: 'Roles & permissions', to: '/settings/roles', permissions: ['tenant.roles.manage'] },
        ],
    },
    {
        id: 'alerts-notifications',
        title: 'Alerts & notifications',
        landingPath: SETTINGS_GROUP_PATHS['alerts-notifications'],
        kind: 'tenant',
        links: [
            { id: 'alerts-notifications', label: 'Alerts & notifications', to: '/settings/actions-notifications', permissions: ['tenant.company.manage'] },
        ],
    },
    {
        // What the company pays Albusto — deliberately last and separate from the
        // money it collects from its own customers ("Payments").
        id: 'billing',
        title: 'Billing',
        landingPath: SETTINGS_GROUP_PATHS.billing,
        kind: 'tenant',
        links: [
            {
                id: 'plan-usage', label: 'Albusto plan & usage', to: '/settings/billing', permissions: ['tenant.company.manage'],
                matches: [{ pathname: '/settings/billing', exact: true }],
            },
        ],
    },
    {
        id: 'platform-administration',
        title: 'Platform administration',
        landingPath: SETTINGS_GROUP_PATHS['platform-administration'],
        kind: 'platform',
        links: [
            { id: 'super-admin', label: 'Super admin', to: '/settings/admin', platformRoles: ['super_admin'] },
        ],
    },
];

export function canAccessSettingsLink(link: SettingsNavLink, access: SettingsNavAccess): boolean {
    const checks: boolean[] = [];
    if (link.permissions?.length) {
        checks.push(link.permissions.some(permission => access.permissions?.includes(permission) ?? false));
    }
    if (link.platformRoles?.length) {
        checks.push(link.platformRoles.includes(access.platformRole ?? ''));
    }
    return checks.length === 0 || checks.some(Boolean);
}

export function getVisibleSettingsGroups(
    access: SettingsNavAccess,
    groups: readonly SettingsNavGroup[] = SETTINGS_NAV,
): SettingsNavGroup[] {
    return groups
        .map(group => ({ ...group, links: group.links.filter(link => canAccessSettingsLink(link, access)) }))
        .filter(group => group.links.length > 0);
}

function targetFromLink(link: SettingsNavLink): SettingsNavMatch[] {
    if (link.matches) return [...link.matches];
    const [pathname, rawSearch = ''] = link.to.split('?');
    const params = new URLSearchParams(rawSearch);
    const search = Object.fromEntries(params.entries());
    return [{ pathname, search: Object.keys(search).length ? search : undefined }];
}

function targetMatches(target: SettingsNavMatch, location: SettingsNavLocation): boolean {
    const pathMatches = target.exact
        ? location.pathname === target.pathname
        : location.pathname === target.pathname || location.pathname.startsWith(`${target.pathname}/`);
    if (!pathMatches) return false;

    const actual = new URLSearchParams(location.search ?? '');
    return Object.entries(target.search ?? {}).every(([key, expected]) => {
        const value = actual.get(key);
        const knownValues = target.fallbackForSearch?.[key];
        const isFallback = !!knownValues && (value === null || !knownValues.includes(value));
        return value === expected || isFallback || (value === null && target.allowMissingSearch?.includes(key));
    });
}

export function isSettingsNavLinkActive(link: SettingsNavLink, location: SettingsNavLocation): boolean {
    return targetFromLink(link).some(target => targetMatches(target, location));
}

export function findActiveSettingsGroup(
    groups: readonly SettingsNavGroup[],
    location: SettingsNavLocation,
): SettingsNavGroup | undefined {
    return groups.find(group => (
        location.pathname === group.landingPath
        || group.links.some(link => isSettingsNavLinkActive(link, location))
    ));
}

export function resolveSettingsLanding(
    access: SettingsNavAccess,
    groupId?: SettingsGroupId,
    groups: readonly SettingsNavGroup[] = SETTINGS_NAV,
): string {
    const visible = getVisibleSettingsGroups(access, groups);
    const requested = groupId ? visible.find(group => group.id === groupId) : undefined;
    return requested?.links[0]?.to ?? visible[0]?.links[0]?.to ?? '/pulse';
}
