'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 — TC-09: the Pulse list-item name fallback uses
 * display_name (arch §E3 / PulseContactItem.tsx).
 *
 * NOTE ON KIND: this project ships NO frontend test harness (no vitest / jest-dom /
 * @testing-library, no frontend/node_modules), so a full React render of
 * PulseContactItem is not runnable here. This substitutes the load-bearing checks
 * that a render test would assert: (1) the fallback-chain LOGIC — display_name wins
 * over the phone when company/lead/contact are absent — proven against a faithful
 * replica of the exact expression; and (2) a SOURCE-STRUCTURAL guard that the real
 * component's chain contains `display_name` positioned BEFORE the phone fallback.
 *
 * NAMED SABOTAGE SAB-LABEL-FROM-CONTACT: omit `call.display_name` from the chain
 * (ship `company || leadName || contactName || formatPhoneNumber(displayPhone)`).
 * → the structural guard (2) turns RED (no display_name before the phone), and the
 * logic replica (1) would degrade the label to the phone instead of 'Kim L.'.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/pulseContactItem.displayName.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const fs = require('fs');
const path = require('path');

// Faithful replica of the shipped fallback expression (PulseContactItem.tsx):
//   isAnon ? 'Anonymous'
//          : (company || leadName || contactName || call.display_name || formatPhoneNumber(displayPhone))
function primaryLabel({ isAnon, company, leadName, contactName, display_name, phone }) {
    const formatPhoneNumber = (p) => (p ? `☎ ${p}` : ''); // stand-in; only its POSITION matters
    return isAnon
        ? 'Anonymous'
        : (company || leadName || contactName || display_name || formatPhoneNumber(phone));
}

describe('TC-09 · name fallback uses display_name', () => {
    it('contactless Yelp row (no company/lead/contact, no phone) labels by display_name', () => {
        const label = primaryLabel({
            isAnon: false, company: null, leadName: null, contactName: null,
            display_name: 'Kim L.', phone: null,
        });
        expect(label).toBe('Kim L.');
    });

    it('display_name is only a fallback — a real company/lead/contact still wins', () => {
        expect(primaryLabel({ isAnon: false, company: 'ABC Homes', display_name: 'Kim L.' })).toBe('ABC Homes');
        expect(primaryLabel({ isAnon: false, leadName: 'Jane Doe', display_name: 'Kim L.' })).toBe('Jane Doe');
        expect(primaryLabel({ isAnon: false, contactName: 'Bob R.', display_name: 'Kim L.' })).toBe('Bob R.');
    });

    it('without display_name a phone-less contactless row degrades (the bug this fixes)', () => {
        const label = primaryLabel({ isAnon: false, phone: null }); // no display_name
        expect(label).toBe(''); // empty — exactly why the fallback is needed
    });

    // SOURCE-STRUCTURAL guard — the shipped component must place display_name in the
    // chain BEFORE the phone fallback (SAB-LABEL-FROM-CONTACT reversal → RED).
    it('PulseContactItem.tsx chains display_name before formatPhoneNumber(displayPhone)', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../frontend/src/components/pulse/PulseContactItem.tsx'), 'utf8');
        const chain = src.replace(/\s+/g, ' ');
        const dnIdx = chain.indexOf('.display_name');
        const phoneIdx = chain.indexOf('formatPhoneNumber(displayPhone)');
        expect(dnIdx).toBeGreaterThan(-1);
        expect(phoneIdx).toBeGreaterThan(-1);
        expect(dnIdx).toBeLessThan(phoneIdx); // display_name comes first in the || chain
    });
});
