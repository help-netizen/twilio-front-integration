'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'src');

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/**
 * Files that DECLARE the canonical keys as data — label maps, event/notification
 * catalogs, payload policy — rather than wiring them at a call site.
 *
 * They are excluded so the catalog test below cannot pass vacuously:
 * `services/eventService.js` alone lists all nine keys as labels, so scanning it
 * would satisfy every assertion even if nothing ever logged the action.
 */
const DECLARATION_ONLY = new Set([
    'services/eventService.js',
    'services/eventCatalog.js',
    'services/appEventCatalog.js',
    'services/notificationEventCatalog.js',
    'services/realtimePayloadPolicy.js',
    'services/eventBus.js',
]);

/**
 * Every .js under backend/src except the declaration registries above.
 *
 * Deliberately a TREE WALK, not a hardcoded file list: the wiring moves between
 * files as handlers get extracted into services, and a fixed list silently goes
 * stale. It already did — FSM-JOB-ACTIONS-001 moved the ETA notify out of
 * `routes/jobs.js` into `services/jobOnTheWayService.js`, and this test failed on
 * `job.eta_notified` even though the action was still logged.
 */
function wiringSources() {
    const chunks = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.js')) continue;
            const rel = path.relative(ROOT, full).split(path.sep).join('/');
            if (DECLARATION_ONLY.has(rel)) continue;
            chunks.push(fs.readFileSync(full, 'utf8'));
        }
    })(ROOT);
    return chunks.join('\n');
}

const CANONICAL_JOB_ACTIONS = [
    'job.created',
    'job.updated',
    'job.status_changed',
    'job.rescheduled',
    'job.assigned',
    'job.unassigned',
    'job.eta_notified',
    'job.rating_link_created',
    'job.rating_link_sent',
];

test('the Phase 3 Job action catalog is wired with exact canonical keys', () => {
    const sources = wiringSources();

    for (const action of CANONICAL_JOB_ACTIONS) {
        expect(sources).toContain(`'${action}'`);
    }
});

test('the catalog scan can fail — declaration registries are excluded', () => {
    const sources = wiringSources();

    // A key nothing wires must NOT be found: proves the scan discriminates.
    expect(sources).not.toContain("'job.never_wired_sentinel'");

    // The label catalog is genuinely excluded from the scan (its label text is
    // absent), so a key present ONLY there would fail the test above.
    expect(read('services/eventService.js')).toContain("'job.eta_notified'");
    expect(sources).not.toContain('Arrival estimate sent.');
});

test('Job human activity actors never use a Keycloak sub', () => {
    for (const file of [
        'routes/jobs.js',
        'routes/schedule.js',
        'routes/fsm.js',
        'routes/leads.js',
    ]) {
        const source = read(file);
        const activityCalls = source
            .split('\n')
            .filter(line => /jobUserActor|userActor\(/.test(line))
            .join('\n');
        expect(activityCalls).not.toContain('sub');
    }
});
