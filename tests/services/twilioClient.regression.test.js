/**
 * Regression guard for TWC-001.
 *
 * Ensures the four hot-spot files do not re-introduce per-call/per-event
 * Twilio client instantiation, and instead use the shared getTwilioClient().
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const HOTSPOTS = [
    'backend/src/services/reconcileStale.js',
    'backend/src/services/callAvailability.js',
    'backend/src/services/inboxWorker.js',
    'backend/src/routes/phoneSettings.js',
];

describe('TWC-001 regression — no per-call Twilio client construction', () => {
    test.each(HOTSPOTS)('%s uses getTwilioClient(), not twilio(sid, token)', (rel) => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

        // Must NOT contain the leaky pattern
        expect(src).not.toMatch(/twilio\(\s*process\.env\.TWILIO_ACCOUNT_SID/);
        expect(src).not.toMatch(/require\(['"]twilio['"]\)\s*\(\s*process\.env\.TWILIO_ACCOUNT_SID/);

        // Must use the shared getter
        expect(src).toMatch(/getTwilioClient/);
    });
});
