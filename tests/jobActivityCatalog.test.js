'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'src');

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('the Phase 3 Job action catalog is wired with exact canonical keys', () => {
    const sources = [
        'services/jobsService.js',
        'services/scheduleService.js',
        'services/leadsService.js',
        'services/chatgptMcpWriteService.js',
        'routes/jobs.js',
    ].map(read).join('\n');
    const expected = [
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

    for (const action of expected) {
        expect(sources).toContain(`'${action}'`);
    }
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
