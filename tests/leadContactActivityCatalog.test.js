'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'src');

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('the Phase 4 Lead action catalog is wired with exact canonical keys', () => {
    const sources = [
        'services/leadsService.js',
        'services/chatgptMcpWriteService.js',
    ].map(read).join('\n');
    for (const action of [
        'lead.created',
        'lead.updated',
        'lead.status_changed',
        'lead.lost',
        'lead.reactivated',
        'lead.assigned',
        'lead.unassigned',
        'lead.converted',
    ]) {
        expect(sources).toContain(`'${action}'`);
    }
});

test('the Phase 4 Contact action catalog is wired with exact canonical keys', () => {
    const sources = [
        'services/contactDedupeService.js',
        'services/chatgptMcpWriteService.js',
        'services/portalService.js',
        'routes/contacts.js',
    ].map(read).join('\n');
    for (const action of [
        'contact.created',
        'contact.updated',
        'contact.merged',
        'contact.phone_moved',
        'contact.email_moved',
        'contact.address_set',
        'contact.portal_profile_updated',
    ]) {
        expect(sources).toContain(`'${action}'`);
    }
});

test('Phase 4 does not wire system enrichment into human activity', () => {
    expect(read('services/contactPropagationService.js')).not.toContain('logLeadContactActivity');
});

test('human Phase 4 activity actor construction never uses Keycloak sub', () => {
    for (const file of ['routes/leads.js', 'routes/contacts.js']) {
        const activityActorLines = read(file)
            .split('\n')
            .filter(line => /activityActor|userActor\(/.test(line))
            .join('\n');
        expect(activityActorLines).not.toContain('sub');
        expect(activityActorLines).toContain('crmUser');
    }
});
