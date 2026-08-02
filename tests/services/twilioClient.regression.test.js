/**
 * Regression guard for TWC-001 (updated for TWILIO-TENANT-FIX-001).
 *
 * Original invariant: hot-spot files must not re-introduce per-call/per-event
 * Twilio client instantiation (`twilio(process.env.TWILIO_ACCOUNT_SID, ...)`).
 *
 * TWILIO-TENANT-FIX-001 deliberately replaced the single shared client with
 * per-company clients (`telephonyTenantService.getClientForCompany`) so that
 * subaccount tenants use their own credentials. The guard therefore now
 * asserts: no raw construction, and clients come from an approved seam —
 * the tenant service (per-company) or the shared getTwilioClient() where a
 * master-only surface legitimately remains (phoneSettings).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const HOTSPOTS = [
    // file, approved client seam(s) it must use
    ['backend/src/services/reconcileStale.js', /getClientForCompany/],
    ['backend/src/services/callAvailability.js', /getClientForCompany/],
    ['backend/src/services/inboxWorker.js', /telephonyTenantService/],
    ['backend/src/routes/phoneSettings.js', /getTwilioClient|getClientForCompany/],
];

describe('TWC-001 regression — no per-call Twilio client construction', () => {
    test.each(HOTSPOTS)('%s uses an approved client seam, not twilio(sid, token)', (rel, seam) => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

        // Must NOT contain the leaky pattern
        expect(src).not.toMatch(/twilio\(\s*process\.env\.TWILIO_ACCOUNT_SID/);
        expect(src).not.toMatch(/require\(['"]twilio['"]\)\s*\(\s*process\.env\.TWILIO_ACCOUNT_SID/);

        // Must obtain clients through an approved seam (tenant-aware since
        // TWILIO-TENANT-FIX-001; master-only getTwilioClient where legitimate).
        expect(src).toMatch(seam);
    });
});
