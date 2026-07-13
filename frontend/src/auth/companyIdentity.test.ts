/**
 * OB-6 / SOFTPHONE-DROP-001 regression (MANDATORY).
 *
 * fetchAuthzContext runs on every token refresh (BUG-22b's refreshOnResume made
 * that frequent). It used to `setCompany(data.company)` with a fresh object each
 * time; any `[company]`-keyed effect (AppLayout's softphone-groups loader) then
 * re-ran, briefly flipping softphone enabled=false → useTwilioDevice destroyed
 * the Twilio Device MID-CALL (dropped calls) and the deviceReady flip re-popped
 * the "Good morning" modal every 2-3 minutes.
 *
 * Fix: keep the SAME company object reference when the id is unchanged. This test
 * pins that reducer so a `[company]` effect stays stable across token refreshes.
 */
import { describe, expect, it } from 'vitest';
import { nextCompany } from './companyIdentity'; // the REAL reducer AuthProvider uses

describe('company identity stability (OB-6)', () => {
    const A1 = { id: 'co-1', name: 'Boston Masters', timezone: 'America/New_York' };
    const A2 = { id: 'co-1', name: 'Boston Masters', timezone: 'America/New_York' }; // same id, fresh object (a re-fetch)

    it('keeps the SAME reference when the id is unchanged (token refresh no-op)', () => {
        const result = nextCompany(A1, A2);
        expect(result).toBe(A1);            // reference identity preserved → no [company] effect re-run
    });

    it('adopts the new object when the id changes (real company switch)', () => {
        const B = { id: 'co-2', name: 'Other Co', timezone: 'America/Chicago' };
        expect(nextCompany(A1, B)).toBe(B);
    });

    it('adopts the incoming object on first load (prev null)', () => {
        expect(nextCompany(null, A1)).toBe(A1);
    });

    it('clears to null when the server returns no company', () => {
        expect(nextCompany(A1, null)).toBeNull();
    });

    it('is stable across many consecutive refreshes with the same id', () => {
        let ref = nextCompany(null, A1);
        for (let i = 0; i < 20; i++) {
            const refetched = { id: 'co-1', name: 'Boston Masters', timezone: 'America/New_York' };
            const next = nextCompany(ref, refetched);
            expect(next).toBe(ref);          // never changes identity → Device never re-inits
            ref = next;
        }
    });
});
