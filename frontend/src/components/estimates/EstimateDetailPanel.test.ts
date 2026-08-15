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

    it('states the status in plain language with its age', () => {
        // "Sent yesterday" is a decision; "sent" is trivia.
        expect(panelRaw).toContain('Draft · not sent');
        expect(panelRaw).toContain('function ago');
        expect(panelRaw).toContain('yesterday');
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
