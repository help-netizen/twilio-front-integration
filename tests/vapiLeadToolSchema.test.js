'use strict';

const sara = require('../voice-agent/assistants/lead-qualifier-v2.json');
const mcpRegistry = require('../backend/src/services/agentSkillsMcpRegistry');

function tool(name) {
    return sara.model.tools.find((entry) => entry.function?.name === name)?.function;
}

test('createLead provider schema stays reduced to the dispatcher-critical 11 properties', () => {
    const createLead = tool('createLead');
    expect(createLead.parameters.required).toEqual(['firstName', 'lastName', 'phone']);
    expect(Object.keys(createLead.parameters.properties).sort()).toEqual([
        'apt',
        'chosenSlot',
        'city',
        'firstName',
        'lastName',
        'phone',
        'problemDescription',
        'state',
        'street',
        'unitType',
        'zip',
    ]);
    expect(Buffer.byteLength(JSON.stringify(createLead), 'utf8')).toBeLessThan(1500);
});

test('disqualification/escalation is a separate three-field voice-only action', () => {
    const disposition = tool('recordLeadDisposition');
    expect(disposition.parameters.required).toEqual(['disqualified']);
    expect(Object.keys(disposition.parameters.properties).sort()).toEqual([
        'disqualReason',
        'disqualified',
        'escalationRequested',
    ]);
    expect(disposition.parameters.properties.disqualReason.enum).toEqual([
        'out_of_area',
        'unsupported_appliance',
    ]);
    expect(mcpRegistry.listTools().some((entry) => (
        entry.skill === 'recordLeadDisposition' || entry.name === 'recordLeadDisposition'
    ))).toBe(false);
});

test('Sara prompt uses the separated action and never asks the model to echo server address facts', () => {
    const prompt = sara.model.messages[0].content;
    expect(prompt).toContain(
        'recordLeadDisposition with disqualified true and disqualReason "unsupported_appliance"',
    );
    expect(prompt).toContain(
        'recordLeadDisposition with disqualified true and disqualReason "out_of_area"',
    );
    expect(prompt).toContain(
        'recordLeadDisposition with disqualified false and escalationRequested true',
    );
    expect(prompt).not.toContain('createLead with disqualified true');
    expect(prompt).toContain('never pass addressValidated, lat, or lng yourself');
});
