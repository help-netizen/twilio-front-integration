import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import panelRaw from './PaymentDetailPanel.tsx?raw';
import identityRaw from './PaymentIdentity.tsx?raw';
import jobSectionsRaw from './PaymentJobSections.tsx?raw';
import jobInfoRaw from '../jobs/JobInfoSections.tsx?raw';
import levelTwoRaw from '../../styles/levelTwo.ts?raw';

// Read from disk rather than importing: vitest stubs the CSS pipeline, so a
// `?raw` import of a stylesheet comes back empty and every assertion on it
// would pass vacuously.
const designSystemRaw = readFileSync(new URL('../../styles/design-system.css', import.meta.url), 'utf8');

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
        // Neither a rail nor an indent: the icon and the lighter weight carry it,
        // and every pixel of width stays with the data.
        expect(jobInfoRaw).not.toContain("paddingLeft: '23px'");
        expect(jobInfoRaw).toContain('<CalendarClock size={icon.size}');
        expect(jobInfoRaw).toContain('<User size={icon.size}');
        expect(jobInfoRaw).toContain('<MapPin size={icon.size}');
    });

    it('labels Status and Tags like every other row', () => {
        expect(jobSectionsRaw).toContain('>Status<');
        expect(jobSectionsRaw).toContain('>Tags<');
        expect(jobSectionsRaw.match(/rowLabel/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('renders Provider once — the job carries its own', () => {
        // JobTechnicianControl inside JobInfoSections already shows Provider and
        // can reassign it; a second read-only copy under it was the same block
        // printed twice.
        expect(jobSectionsRaw).toContain('if (job) return null;');
    });
});

/**
 * Level two — everything under a section heading is ONE type: same family, same
 * size, same weight, for the field group's heading, its labels and its values.
 * Grey names a thing, black answers it, and semantic colour (an owed balance, a
 * failed status) is the only other signal allowed.
 *
 * This is the rule the card kept losing: each round of polish added half a step
 * — 11.5, 12.5, 13.5 — until eleven sizes were doing the work colour does.
 */
describe('one type below the section heading', () => {
    it('defines the type in exactly one place, and the CSS agrees with it', () => {
        const cssSize = designSystemRaw.match(/\.blanc-l2\s*\{[^}]*font-size:\s*(\d+)px/)?.[1];
        const cssWeight = designSystemRaw.match(/\.blanc-l2\s*\{[^}]*font-weight:\s*(\d+)/)?.[1];
        expect(cssSize).toBe('15');
        expect(cssWeight).toBe('500');
        // The style-prop twin must not drift from the class.
        expect(levelTwoRaw).toContain(`fontSize: '${cssSize}px'`);
        expect(levelTwoRaw).toContain(`fontWeight: ${cssWeight}`);
        // Quiet is a colour, nothing else — the moment it carries a size or a
        // weight the whole rule is gone.
        const quiet = levelTwoRaw.match(/LEVEL_TWO_QUIET[\s\S]*?\}/)?.[0] ?? '';
        expect(quiet).toContain('--blanc-ink-3');
        expect(quiet).not.toMatch(/fontSize|fontWeight/);
    });

    it('spends no size of its own — only the payment amount is set large', () => {
        // 32px is the hero (the sum this record IS) and 20px is the section
        // heading, which lives in .blanc-section-heading, not here. Anything
        // else is a size that crept back in.
        for (const source of [identityRaw, jobSectionsRaw, panelRaw]) {
            for (const match of source.matchAll(/text-\[([0-9.]+)px\]/g)) {
                expect(match[1]).toBe('32');
            }
        }
    });

    it('makes a heading out of weight and colour, never a size', () => {
        // Contact / Schedule / Location / Provider are black and bold at the
        // size of the rows they introduce.
        const heading = levelTwoRaw.match(/LEVEL_TWO_HEADING[\s\S]*?\n\};/)?.[0] ?? '';
        expect(heading).toContain('--blanc-ink-1');
        expect(heading).toContain('fontWeight: 600');
        expect(heading).not.toContain('fontSize');
        // Its CSS twin says the same and adds no size either.
        const cssHeading = designSystemRaw.match(/\.blanc-l2-heading\s*\{[^}]*\}/)?.[0] ?? '';
        expect(cssHeading).toContain('font-weight: 600');
        expect(cssHeading).not.toContain('font-size');
    });

    it('has exactly two weights below the heading — 500 and 600', () => {
        // Anything heavier is a third level nobody asked for; Tailwind's
        // font-semibold/font-bold would be that third level by the back door.
        expect(jobSectionsRaw).not.toMatch(/font-(semibold|bold)/);
        // In PaymentIdentity the one exception is the amount itself, which is
        // the 32px hero and not level two at all.
        expect(identityRaw.match(/font-semibold/g)?.length).toBe(1);
        expect(identityRaw).not.toContain('font-bold');
    });

    it('keeps Total / Paid / Due on one line — three numbers to compare', () => {
        // Stacked they read as a list to work through. Emphasis comes from the
        // 600 the headings already use plus Due's colour, so the row costs the
        // scale nothing.
        expect(identityRaw).toContain('flex flex-wrap gap-x-7');
        expect(identityRaw).toContain('...LEVEL_TWO_HEADING, color: color');
    });

    it('separates flat groups with space, never a line', () => {
        // The framed job card keeps its dashes; flat has no frame for a line to
        // belong to, so a rule there would be the only edge on the page.
        const flatGap = jobInfoRaw.match(/if \(!hasNext\) return \{\};[\s\S]*?\};/)?.[0] ?? '';
        expect(flatGap).toContain('? { marginBottom: 18 }');
        expect(flatGap.split('dashed').length - 1).toBe(1);  // card variant only
    });
});
