/**
 * PULSE-CONTACT-PIN-001 (OB-12) — shared predicates for the pinned contact bar.
 *
 * The bar's "Leads & Jobs N" counts OPEN records only (owner decision 2026-07-19),
 * and the expanded panel's "Only Open" toggle must agree with it — both sides import
 * THESE predicates so the count and the list cannot drift apart.
 */
import type { Contact, ContactAddress, ContactLead } from '../../types/contact';
import type { LocalJob } from '../../services/jobsApi';

/** Lead terminal statuses — mirrors the panel's historical inline filter. */
export const LEAD_TERMINAL_STATUSES = ['Lost', 'Converted'] as const;

/**
 * Job terminal statuses. The job FSM is per-company (DB-driven), so this is the
 * canonical company-0001 vocabulary; unknown custom statuses count as open, which
 * errs on the side of showing work rather than hiding it.
 */
export const JOB_TERMINAL_STATUSES = ['Job is Done', 'Canceled'] as const;

export function isOpenLead(lead: Pick<ContactLead, 'status'>): boolean {
    return !LEAD_TERMINAL_STATUSES.includes(lead.status as (typeof LEAD_TERMINAL_STATUSES)[number]);
}

export function isOpenJob(job: Pick<LocalJob, 'blanc_status' | 'zb_canceled'>): boolean {
    if (job.zb_canceled) return false;
    return !JOB_TERMINAL_STATUSES.includes(job.blanc_status as (typeof JOB_TERMINAL_STATUSES)[number]);
}

export function openLeadsJobsCount(
    leads: readonly Pick<ContactLead, 'status'>[] | null | undefined,
    jobs: readonly Pick<LocalJob, 'blanc_status' | 'zb_canceled'>[] | null | undefined,
): number {
    return (leads ?? []).filter(isOpenLead).length + (jobs ?? []).filter(isOpenJob).length;
}

export interface BarAddress {
    /** Street part; drops first as the bar narrows. */
    street: string | null;
    /** "City, ST 02134" — survives longest; never null when the line renders. */
    cityLine: string;
}

function contactAddressToBar(addr: ContactAddress): BarAddress | null {
    const cityBits = [addr.city, [addr.state, addr.postal_code].filter(Boolean).join(' ')]
        .filter(part => part && String(part).trim());
    if (cityBits.length === 0 && !addr.line1 && !addr.formatted) return null;
    if (cityBits.length === 0) {
        // Nothing structured beyond a street/formatted string — show it as the city
        // line so the single available fact still renders.
        return { street: null, cityLine: (addr.line1 || addr.formatted || '').trim() };
    }
    return { street: (addr.line1 || '').trim() || null, cityLine: cityBits.join(', ') };
}

/**
 * The bar's second line = the address of the FRESHEST job (owner decision:
 * "адрес свежей работы или лида"; leads carry no address in this model, so jobs
 * are the entity that can win). Fallbacks, in order: the contact's default
 * address → first contact address → company name → nothing.
 *
 * Job addresses arrive as one formatted string, so they render whole on the city
 * line (no street/city split to degrade through) — splitting a free-form string
 * is guesswork we deliberately avoid.
 */
export function pickBarAddress(
    jobs: readonly Pick<LocalJob, 'address' | 'city' | 'start_date' | 'blanc_status' | 'zb_canceled'>[] | null | undefined,
    contact: Pick<Contact, 'addresses' | 'company_name'> | null | undefined,
): BarAddress | null {
    const dated = (jobs ?? [])
        .filter(j => (j.address && j.address.trim()) || (j.city && j.city.trim()))
        .map(j => ({ j, t: j.start_date ? new Date(j.start_date).getTime() : 0 }))
        .sort((a, b) => b.t - a.t);
    const freshest = dated[0]?.j;
    if (freshest) {
        const line = (freshest.address || '').trim() || (freshest.city || '').trim();
        if (line) return { street: null, cityLine: line };
    }

    const addresses = contact?.addresses ?? [];
    const preferred = addresses.find(a => a.is_default_address_for_customer) ?? addresses[0];
    if (preferred) {
        const bar = contactAddressToBar(preferred);
        if (bar) return bar;
    }

    const company = (contact?.company_name || '').trim();
    if (company) return { street: null, cityLine: company };
    return null;
}

export function hasNotes(contact: Pick<Contact, 'notes'> | null | undefined): boolean {
    return !!contact?.notes?.trim();
}
