/**
 * OB-6 / SOFTPHONE-DROP-001: identity-stable company reducer.
 *
 * fetchAuthzContext runs on every token refresh (BUG-22b's refreshOnResume made
 * that frequent). Returning a fresh company object each time re-triggered every
 * `[company]`-keyed effect — including AppLayout's softphone-groups loader, which
 * briefly set enabled=false → useTwilioDevice destroyed the Twilio Device MID-CALL
 * (dropped calls) and the deviceReady flip re-popped the "Good morning" modal.
 *
 * Keep the SAME reference when the company id is unchanged.
 */
export type CompanyLike = { id: string;[k: string]: unknown } | null;

export function nextCompany(prev: CompanyLike, incoming: CompanyLike): CompanyLike {
    return (prev && incoming && prev.id === incoming.id) ? prev : (incoming ?? null);
}
