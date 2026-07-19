import { describe, expect, it } from 'vitest';
import {
    hasNotes,
    isOpenJob,
    isOpenLead,
    openLeadsJobsCount,
    pickBarAddress,
} from './contactBarHelpers';
import panelSource from './PulseContactPanel.tsx?raw';
import pageSource from '../../pages/PulsePage.tsx?raw';
import plaqueSource from '../pulse/ActionRequiredPlaque.tsx?raw';

describe('PULSE-CONTACT-PIN-001 — open count (owner: OPEN records only)', () => {
    it('counts open leads and open jobs through the shared predicates', () => {
        const leads = [
            { status: 'New' }, { status: 'Lost' }, { status: 'Converted' }, { status: 'Working' },
        ];
        const jobs = [
            { blanc_status: 'Submitted', zb_canceled: false },
            { blanc_status: 'Job is Done', zb_canceled: false },
            { blanc_status: 'Canceled', zb_canceled: false },
            { blanc_status: 'Waiting for parts', zb_canceled: true }, // ZB-cancelled wins
            { blanc_status: 'Waiting for parts', zb_canceled: false },
        ];
        expect(leads.filter(isOpenLead)).toHaveLength(2);
        expect(jobs.filter(isOpenJob)).toHaveLength(2);
        expect(openLeadsJobsCount(leads, jobs)).toBe(4);
        expect(openLeadsJobsCount(null, undefined)).toBe(0);
    });

    it('treats unknown custom job statuses as open (per-company FSM)', () => {
        expect(isOpenJob({ blanc_status: 'Custom mid-flow status', zb_canceled: false })).toBe(true);
    });

    it('the expanded panel filters BOTH lists through the same predicates', () => {
        // The bar shows a count; the panel shows the list. Same predicate imports or
        // the two drift — this is the invariant behind the owner's "open only" choice.
        expect(panelSource).toContain("import { isOpenLead, isOpenJob } from './contactBarHelpers'");
        expect(panelSource).toContain('leads.filter(isOpenLead)');
        expect(panelSource).toContain('jobs.filter(isOpenJob)');
        expect(panelSource).not.toContain("!['Lost', 'Converted'].includes");
    });

    it('the Only Open toggle defaults ON so the list matches the bar count', () => {
        expect(panelSource).toContain('useState(true);\n');
        expect(panelSource).toMatch(/onlyOpenLeads, setOnlyOpenLeads\] = useState\(true\)/);
    });
});

describe('PULSE-CONTACT-PIN-001 — bar address (owner: freshest job, then fallbacks)', () => {
    const contact = {
        company_name: 'Rodriguez Property Group',
        addresses: [
            { line1: '1 Old Rd', city: 'Quincy', state: 'MA', postal_code: '02169' },
            { line1: '714 Westfield Ave', city: 'Brooklyn', state: 'NY', postal_code: '11215', is_default_address_for_customer: true },
        ],
    };

    it('prefers the freshest job with an address', () => {
        const jobs = [
            { address: '9 Stale St, Lowell, MA', city: 'Lowell', start_date: '2026-06-01', blanc_status: 'Submitted', zb_canceled: false },
            { address: '5 Fresh Ave, Boston, MA 02134', city: 'Boston', start_date: '2026-07-15', blanc_status: 'Submitted', zb_canceled: false },
        ];
        expect(pickBarAddress(jobs, contact)).toEqual({ street: null, cityLine: '5 Fresh Ave, Boston, MA 02134' });
    });

    it('falls back to the contact default address, structured for degradation', () => {
        expect(pickBarAddress([], contact)).toEqual({ street: '714 Westfield Ave', cityLine: 'Brooklyn, NY 11215' });
    });

    it('falls back to the company name, then to nothing', () => {
        expect(pickBarAddress([], { company_name: 'Patel Holdings', addresses: [] }))
            .toEqual({ street: null, cityLine: 'Patel Holdings' });
        expect(pickBarAddress([], { company_name: '', addresses: [] })).toBeNull();
        expect(pickBarAddress(undefined, null)).toBeNull();
    });

    it('ignores jobs with no address at all', () => {
        const jobs = [{ address: '', city: '', start_date: '2026-07-18', blanc_status: 'Submitted', zb_canceled: false }];
        expect(pickBarAddress(jobs, contact)?.cityLine).toBe('Brooklyn, NY 11215');
    });
});

describe('PULSE-CONTACT-PIN-001 — notes presence', () => {
    it('whitespace-only notes do not count', () => {
        expect(hasNotes({ notes: '  \n ' })).toBe(false);
        expect(hasNotes({ notes: 'Gate code 1957' })).toBe(true);
        expect(hasNotes(null)).toBe(false);
    });
});

describe('PULSE-CONTACT-PIN-001 — sticky stack wiring', () => {
    it('one sticky wrapper owns both the AR plaque and the bar', () => {
        // Two sibling sticky elements would both pin to top:0 and overlap; the page
        // must wrap them in .pulse-sticky-stack and the plaque must NOT self-stick.
        expect(pageSource).toContain('className="pulse-sticky-stack"');
        expect(plaqueSource).not.toContain('pulse-ar-sticky');
    });

    it('the full card opens as an overlay panel, never in the scroll flow', () => {
        expect(pageSource).toContain('<DialogContent variant="panel">');
        // The in-flow contact card is gone from the timeline column.
        expect(pageSource).not.toMatch(/pulse-accent-top[^\n]*blanc-success/);
    });
});
