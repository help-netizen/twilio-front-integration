'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 (regression) — the /api/calls (Pulse unified list) row DTO
 * MUST carry a contactless timeline's denormalized `display_name` + `external_source`
 * through to the client.
 *
 * The chain: getUnifiedTimelinePage denormalizes tl.display_name / tl.external_source
 * (proved by yelpTimelinePulse.db.test) → PulseContactItem labels the row by
 * call.display_name (proved by pulseContactItem.displayName.test). The ONLY link in
 * between is the route's row→DTO map in routes/calls.js. `formatCall()` is
 * call-fields-only, so that map is the sole place these two fields can cross — and it
 * originally did NOT pass them, so every contactless Yelp row reached the client with
 * no name and rendered a BLANK title (the prod bug this guards).
 *
 * KIND: no Express/supertest harness ships here and the map is inline in the handler,
 * so this is a SOURCE-STRUCTURAL guard — the same idiom pulseContactItem.displayName
 * uses for the shipped .tsx. It asserts the passthrough exists; the DB test + FE test
 * cover the value semantics on either side.
 *
 * NAMED SABOTAGE SAB-DTO-DROP-DISPLAYNAME: delete the two passthrough lines from the
 * by-contact DTO → both assertions turn RED (and contactless rows go blank again).
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/callsByContactDisplayName.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../backend/src/routes/calls.js'), 'utf8');

describe('YELP-TL-DEDUP · unified-list DTO carries the contactless label + origin', () => {
    it('passes display_name through from the unified row (c.display_name)', () => {
        expect(SRC).toMatch(/display_name:\s*c\.display_name/);
    });

    it('passes external_source through from the unified row (c.external_source)', () => {
        expect(SRC).toMatch(/external_source:\s*c\.external_source/);
    });
});
