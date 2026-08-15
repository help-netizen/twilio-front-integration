import { describe, expect, it } from 'vitest';
import editorRaw from './EstimateEditorDialog.tsx?raw';
import itemDialogRaw from './EstimateItemDialog.tsx?raw';
import summaryDialogRaw from './EstimateSummaryDialog.tsx?raw';
import pageRaw from '../../pages/EstimatesPage.tsx?raw';

/**
 * ESTIMATE-REDESIGN-001 P3 — one sheet per job.
 *
 * The estimate editor and the detail panel each carried their own copy of the
 * line-item form and of the summary editor. The inventory found the copies had
 * already drifted — different titles, different validation — which is what
 * duplication does long before anyone notices. These keep them collapsed.
 */
describe('one item sheet, one summary editor', () => {
    it('the editor uses the shared item sheet instead of its own', () => {
        expect(editorRaw).toContain("from './EstimateItemDialog'");
        expect(editorRaw).toContain('<EstimateItemDialog');
        // The tell-tales of the old inline copy.
        expect(editorRaw).not.toContain('Add custom item');
        expect(editorRaw).not.toContain('id="item-title"');
    });

    it('the editor uses the shared summary editor instead of its own', () => {
        expect(editorRaw).toContain("from './EstimateSummaryDialog'");
        expect(editorRaw).toContain('<EstimateSummaryDialog');
        // It also stops keeping a second copy of the same string.
        expect(editorRaw).not.toContain('summaryDraft');
        // The mobile/desktop choice belongs to the shared component, once.
        expect(summaryDialogRaw).toContain('if (isMobile)');
        expect(editorRaw).not.toContain('summaryDialogOpen && isMobile');
    });

    it('keeps the report editor exactly as it ships — owner decision', () => {
        // "Describe the job" is the one screen we were told not to redesign.
        expect(editorRaw).toContain('FullScreenTextEditor');
    });

    it('passes taxable as a real boolean', () => {
        // The backend normalizer only accepts `true`; the string "true" silently
        // becomes false, which would quietly zero the tax on an estimate.
        expect(editorRaw).toContain('taxable: !!draft.taxable');
        expect(itemDialogRaw).toContain('taxable: boolean');
    });

    it('keeps a line item’s identity when it is edited', () => {
        // The sheet does not carry the row key, so the orchestrator must put it
        // back — otherwise editing a row silently replaces it with a new one.
        expect(editorRaw).toContain('{ ...nextItem, key: item.key }');
    });
});

describe('editing from a list row can no longer eat the line items', () => {
    it('hydrates the estimate before the editor opens', () => {
        // A list row carries no items. The editor read that as "there are none"
        // and saved a full replacement over the real ones.
        expect(pageRaw).toContain('if (estimate.items) return;');
        expect(pageRaw).toContain('fetchEstimate');
    });

    it('and survives a failed hydration without destroying anything', () => {
        // The backend now treats an absent `items` key as "leave them alone",
        // so a failed fetch degrades to a limited editor, not to data loss.
        expect(pageRaw).toContain('catch {');
    });
});
