import { describe, expect, it } from 'vitest';
import pageRaw from './EstimatesPage.tsx?raw';
import pillRaw from '../components/estimates/EstimateStatusPill.tsx?raw';

/**
 * ESTIMATE-REDESIGN-001 P4 — the list, and the seam that misaddressed proposals.
 */
describe('estimates list', () => {
    it('sends from the estimate you opened, and from nowhere else', () => {
        // The page used to host its own send dialog fed by the ROW's id and by
        // `selectedEstimate`'s recipient. Two different estimates could supply
        // the two halves — one customer's proposal addressed to another's inbox.
        expect(pageRaw).not.toContain('EstimateSendDialog');
        expect(pageRaw).not.toContain('sendEstimateId');
    });

    it('can create an estimate at all', () => {
        // The page mounted an editor with no way to open it for a new record:
        // the one screen about estimates could not make one.
        expect(pageRaw).toContain('data-testid="estimate-new"');
        expect(pageRaw).toContain('handleCreateEstimate');
    });

    it('renders rows rather than a seven-column table', () => {
        expect(pageRaw).not.toContain('<table');
        expect(pageRaw).toContain('data-testid="estimates-list"');
        expect(pageRaw).toContain('estimate-row-');
        // Opening the row IS the action; there is no per-row menu to hunt in.
        expect(pageRaw).not.toContain('DropdownMenu');
    });

    it('uses the one status vocabulary, not a second copy', () => {
        expect(pageRaw).toContain("from '../components/estimates/EstimateStatusPill'");
        expect(pageRaw).not.toContain('STATUS_VARIANT');
    });
});

describe('status speaks plainly, in one place', () => {
    it('carries the age, because that is the reason to act', () => {
        expect(pillRaw).toContain('Draft · not sent');
        expect(pillRaw).toContain('yesterday');
        // Past a week the age stops helping and goes quiet.
        expect(pillRaw).toContain('days <= 7');
    });

    it('dates "Opened" by when the CUSTOMER opened it', () => {
        // `updated_at` moves for reasons that have nothing to do with them.
        expect(pillRaw).toContain('estimate.viewed_at || estimate.updated_at');
    });
});
