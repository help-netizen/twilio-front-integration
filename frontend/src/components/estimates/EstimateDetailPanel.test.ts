import { describe, expect, it } from 'vitest';
import panelRaw from './EstimateDetailPanel.tsx?raw';

/**
 * ESTIMATE-REDESIGN-001 — the detail card.
 *
 * These assert the decisions, not the pixels: the ones that were argued for and
 * would quietly rot back if someone re-added a menu "to tidy things up".
 */
describe('estimate detail — the decisions', () => {
    it('has no kebab: an action you cannot see is not simpler, only slower', () => {
        expect(panelRaw).not.toContain('DropdownMenu');
        expect(panelRaw).not.toContain('MoreHorizontal');
    });

    it('offers Create invoice beside the primary at every live status', () => {
        // The customer says yes in the kitchen, out loud. Recording that used to
        // cost three taps and two status changes, so dispatchers stopped using
        // the combined path entirely.
        expect(panelRaw).toContain('const invoiceAction');
        expect(panelRaw).toContain("testid: 'estimate-create-invoice'");
        // …and when an invoice exists it OPENS it. Never a second one.
        expect(panelRaw).toContain("testid: 'estimate-open-invoice'");
        expect(panelRaw).toContain('estimate.invoice_id');
    });

    it('withholds the shortcut only from a declined estimate', () => {
        // They said no. If they changed their mind the estimate is revived
        // deliberately — that is the one place an extra step is worth paying.
        expect(panelRaw).toContain('!live || declined ? null');
    });

    it('warns at the tap on Edit, not with a caption that lives forever', () => {
        // Editing an answered estimate resets it to draft and clears the
        // customer's answer. Rare action, constant readers: the warning belongs
        // to the moment, not to the card.
        expect(panelRaw).toContain('confirmEditOpen');
        expect(panelRaw).toContain("estimate.status === 'draft'");
        expect(panelRaw).toContain('Edit anyway');
        expect(panelRaw).not.toContain('Editing returns this to Draft');
    });

    it('states the status through the ONE shared vocabulary', () => {
        // The words themselves live in EstimateStatusPill and are asserted there.
        // What matters here is that the card does not grow a second copy of them:
        // the list and the detail must not tell the same story differently.
        expect(panelRaw).toContain("from './EstimateStatusPill'");
        expect(panelRaw).toContain('<StatusPill estimate={estimate} />');
        expect(panelRaw).not.toContain('const STATUS_TONE');
    });

    it('writes history as events rather than as a log', () => {
        expect(panelRaw).toContain('EVENT_SENTENCE');
        expect(panelRaw).toContain('The customer opened it');
        // An unmapped event degrades to its own words instead of vanishing.
        expect(panelRaw).toContain('function describeEvent');
    });

    it('keeps the identity to the amount, one context line and the status', () => {
        expect(panelRaw).toContain('data-testid="estimate-total"');
        expect(panelRaw).toContain('text-[32px]');
        // Contact and job are ONE grey line, not a section with an icon — a
        // section would fairly invite the question of why the job has none.
        expect(panelRaw).not.toContain('>Contact<');
    });

    it('uses the level-two type, not hand-written sizes', () => {
        // 32 is the hero. Everything else comes from .blanc-l2 / the section
        // heading, so the card cannot drift into a font sampler again.
        const sizes = [...panelRaw.matchAll(/text-\[(\d+)px\]/g)].map(m => m[1]);
        expect(new Set(sizes)).toEqual(new Set(['32', '15']));
        expect(panelRaw).toContain('blanc-l2');
    });
});

/**
 * P5 — the last two places the card asked the user for things it should know.
 */
describe('linking a job, and the dialog that was never reachable', () => {
    it('searches for the job instead of demanding its database id', () => {
        // `window.prompt('Enter Job ID to link:')` asked for a number nobody
        // knows. People know "the Feldman one on Florida Street".
        expect(panelRaw).not.toContain("prompt('Enter Job ID");
        expect(panelRaw).toContain('<LinkJobPicker');
    });

    it('no longer mounts a preview dialog nothing can open', () => {
        // The instance existed, with its own state, and no code path set it true.
        expect(panelRaw).not.toContain('EstimatePreviewDialog');
        expect(panelRaw).not.toContain('previewOpen');
    });
});
