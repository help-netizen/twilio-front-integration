/**
 * PUBLIC-BARE-001 (extends ALB-101): route prefixes that render BARE — no app
 * chrome at all (header nav, Log out, bottom bar, softphone, feedback FAB,
 * warm-up dialog, banners).
 *
 * Two families:
 *  - auth pages (/signup, /onboarding) — pre-app surfaces;
 *  - PUBLIC CUSTOMER LINKS (/r/ rate page, /e/ estimate view, /pay/ invoice
 *    payment + thanks) — these are opened by the company's CUSTOMERS from
 *    emails/SMS. Internal CRM chrome must NEVER appear there, only the document.
 *
 * Every prefix ends with a separator (or is a full segment), so internal routes
 * that merely share the first letters — /email, /estimates, /payments — never
 * match.
 */
export const BARE_ROUTE_PREFIXES = ['/signup', '/onboarding', '/r/', '/e/', '/pay/'] as const;

export function isBareRoute(pathname: string): boolean {
    return BARE_ROUTE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}
