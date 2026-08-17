import { describe, expect, it } from 'vitest';
import panelRaw from './EstimateDetailPanel.tsx?raw';

/**
 * ESTIMATE-REDESIGN-001 — the detail card.
 *
 * These assert the decisions, not the pixels: the ones that were argued for and
 * would quietly rot back if someone re-added a menu "to tidy things up".
 */
describe('estimate detail — the decisions', () => {
    it('puts at most two actions on the screen (owner, 2026-08-16)', () => {
        // The first draft showed all six at once. Six visible actions is its own
        // kind of slow: nothing is louder than anything else, and the two ways to
        // lose a proposal sit in the same breath as the primary. Everything past
        // the second lives behind the menu — so there are exactly two buttons
        // rendered from the matrix, and the rest is `menuActions`.
        expect(panelRaw).toContain('const primaryAction');
        expect(panelRaw).toContain('const secondaryAction');
        expect(panelRaw).toContain('const menuActions');
        expect(panelRaw).not.toContain('quietActions');
        // A third rendered <Button> from the matrix would be a third action.
        expect(panelRaw.match(/\{primaryAction && \(/g) || []).toHaveLength(1);
        expect(panelRaw.match(/\{secondaryAction && \(/g) || []).toHaveLength(1);
    });

    it('keeps the menu reachable and named where there is room for a name', () => {
        // The trigger sits at the right end of the action row (owner,
        // 2026-08-16). On a phone it is a circle — a label there would come out
        // of the two buttons beside it — so the name is carried by aria-label
        // and shown on desktop, where the row has the width for it.
        expect(panelRaw).toContain('DropdownMenu');
        expect(panelRaw).toContain('aria-label="More actions"');
        expect(panelRaw).toContain('hidden md:inline">More</span>');
        expect(panelRaw).toContain("data-testid=\"estimate-more\"");
    });

    it('keeps the destructive pair set apart inside the menu', () => {
        expect(panelRaw).toContain('DropdownMenuSeparator');
        expect(panelRaw).toContain("testid: 'estimate-decline', danger: true");
        expect(panelRaw).toContain("testid: 'estimate-archive', danger: true");
    });

    it('never makes a second invoice — it opens the one that exists', () => {
        expect(panelRaw).toContain('const invoiceAction');
        expect(panelRaw).toContain("testid: 'estimate-create-invoice'");
        expect(panelRaw).toContain("testid: 'estimate-open-invoice'");
        expect(panelRaw).toContain('estimate.invoice_id');
    });

    it('gives the second slot to the invoice on a draft and to Resend while waiting', () => {
        // Owner 2026-08-16: whatever the invoice card decides applies here where
        // it applies. There, a draft's second button became Collect payment —
        // the customer says yes on the spot. An estimate's equivalent of taking
        // the money is turning it into an invoice, so that takes the slot and
        // Edit drops to the menu. Once the estimate is out, Resend takes over.
        expect(panelRaw).toContain('waiting ? resendAction');
        expect(panelRaw).toContain(': invoiceAction;');
        expect(panelRaw).toContain('approved || declined ? null');
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

    it('carries exactly one hand-written size — the hero', () => {
        // The payment card is the base (TYPE-CANON-001): 32 for the one number
        // the screen exists for, .blanc-section-heading for the card's name, and
        // .blanc-l2 / -quiet / -heading for everything below it. Nothing else may
        // name a size, or the card drifts back into a font sampler.
        // Back to one: the buttons' 15px moved into the shared Button's `action`
        // size (2026-08-17), so the card names no size but the hero's.
        const sizes = [...panelRaw.matchAll(/text-\[(\d+)px\]/g)].map(m => m[1]);
        expect(new Set(sizes)).toEqual(new Set(['32']));
        expect(panelRaw).toContain('size="action"');
        expect(panelRaw).toContain('blanc-section-heading');
        expect(panelRaw).toContain('blanc-l2-heading');
        expect(panelRaw).not.toContain('blanc-eyebrow');
        // Weight and colour ride the classes: a `font-semibold` or a colour
        // utility on the same element loses to .blanc-l2, silently.
        expect(panelRaw).not.toMatch(/className="[^"]*blanc-l2[^"]*font-(semibold|bold)/);
        expect(panelRaw).not.toMatch(/className="[^"]*blanc-l2[^"]*text-\[var\(--blanc-ink/);
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
