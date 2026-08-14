import { describe, expect, it } from 'vitest';
import panelRaw from './PaymentDetailPanel.tsx?raw';
import identityRaw from './PaymentIdentity.tsx?raw';
import jobSectionsRaw from './PaymentJobSections.tsx?raw';
import jobInfoRaw from '../jobs/JobInfoSections.tsx?raw';

/**
 * The payment card is meant to BE the job card minus Finance — not a lookalike.
 * These assert the reuse itself, because a copy would pass any visual test right
 * up until the day call masking or the note composer changed on one side only.
 */
describe('payment card parity with the job card', () => {
    it('renders the job card’s own sections rather than reimplementing them', () => {
        expect(panelRaw).toContain("from '../jobs/JobInfoSections'");
        expect(panelRaw).toContain("from '../jobs/JobDescription'");
        expect(panelRaw).toContain("from '../shared/NotesHistoryTabs'");
        // Flat here, framed on the job card — one prop, one component.
        expect(panelRaw).toContain('variant="flat"');
    });

    it('writes notes and tasks onto the job, so they are the job’s own', () => {
        expect(panelRaw).toContain('entityType="job"');
        expect(panelRaw).toContain('entityId={job.id}');
    });

    it('carries no Finance section — the payment is the money on this screen', () => {
        expect(panelRaw).not.toContain('JobFinancialsTab');
    });

    it('colours Due by the job card’s rule, not a new one', () => {
        // amber owed · green credit · plain ink settled
        expect(identityRaw).toContain("due > 0");
        expect(identityRaw).toContain('var(--blanc-warning)');
        expect(identityRaw).toContain('var(--blanc-success)');
    });

    it('titles the job in one line and puts status and tags beneath it', () => {
        // "Job #389493 · COD Service" is one heading, not a label plus a value.
        expect(jobSectionsRaw).toContain('`Job #${jobNumber}`');
        expect(jobSectionsRaw).toContain('` · ${service}`');
        // The lead source is deliberately absent: on a payment it answers a
        // question nobody is asking here.
        expect(jobSectionsRaw).not.toContain('job_source');
        expect(jobSectionsRaw).toContain('{status &&');
        expect(jobSectionsRaw).toContain('tags.map');
    });

    it('survives a payment with no job behind it', () => {
        // Imported rows can lack a local job; the card must still open.
        expect(panelRaw).toContain('not linked to a job');
        expect(panelRaw).toContain('job ? (');
    });

    it('shows belonging without spending width on a rail', () => {
        // A phone cannot afford a 16px gutter down the whole card, so the
        // secondary headings carry an icon and their rows shift in behind them.
        expect(panelRaw).not.toContain('border-l');
        expect(jobInfoRaw).toContain("paddingLeft: '23px'");
        expect(jobInfoRaw).toContain('<CalendarClock size={icon.size}');
        expect(jobInfoRaw).toContain('<User size={icon.size}');
        expect(jobInfoRaw).toContain('<MapPin size={icon.size}');
    });

    it('keeps secondary headings lighter than the section titles', () => {
        expect(jobInfoRaw).toContain("fontSize: '15px', fontWeight: 500");
    });

    it('labels Status and Tags like every other row', () => {
        expect(jobSectionsRaw).toContain('>Status<');
        expect(jobSectionsRaw).toContain('>Tags<');
        expect(jobSectionsRaw.match(/w-\[58px\]/g)?.length).toBeGreaterThanOrEqual(2);
    });
});
