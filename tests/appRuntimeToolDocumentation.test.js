'use strict';

const fs = require('node:fs');
const path = require('node:path');
const appRuntimeCatalog = require('../backend/src/services/appRuntimeToolCatalog');
const {
    PROMPT_CATALOG_BEGIN,
    PROMPT_CATALOG_END,
    assertToolDocumentation,
    renderPromptToolDocumentation,
    renderAppToolsMarkdown,
} = require('../backend/src/services/appRuntimeToolDocumentation');
const { buildPrompt } = require('../backend/src/services/appBuilderService');

const DOC_PATH = path.resolve(__dirname, '../docs/specs/APP-TOOLS-001.md');
const TODAY = '2026-08-01';

function collectProperties(schema, prefix = '') {
    const properties = [];
    for (const [name, property] of Object.entries(schema?.properties || {})) {
        const pathName = prefix ? `${prefix}.${name}` : name;
        properties.push([pathName, property]);
        properties.push(...collectProperties(property, pathName));
        if (property?.items) {
            properties.push(...collectProperties(property.items, `${pathName}[]`));
        }
    }
    return properties;
}

describe('APP-TOOLS-001 generated tool documentation gates', () => {
    beforeAll(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    test('1: every parameter and response field in every runtime tool is documented', () => {
        const tools = appRuntimeCatalog.listTools();
        expect(tools.map(tool => tool.name)).toEqual([
            'svc.list_jobs',
            'svc.get_job',
            'svc.list_tasks',
            'svc.create_task',
            'svc.list_estimates',
            'svc.get_estimate',
            'svc.add_note',
            'svc.list_leads',
            'svc.get_lead',
            'svc.list_invoices',
            'svc.list_payments',
        ]);
        for (const tool of tools) {
            const parameters = collectProperties(tool.inputSchema);
            expect(parameters.length).toBeGreaterThan(0);
            for (const [name, schema] of parameters) {
                expect({ tool: tool.name, parameter: name, description: schema.description })
                    .toEqual(expect.objectContaining({ description: expect.stringMatching(/\S/) }));
            }
            expect(tool.outputSchema).toMatchObject({
                type: 'object',
                description: expect.stringMatching(/\S/),
            });
            for (const [name, schema] of collectProperties(tool.outputSchema)) {
                expect({ tool: tool.name, field: name, description: schema.description })
                    .toEqual(expect.objectContaining({ description: expect.stringMatching(/\S/) }));
            }
        }
        expect(() => assertToolDocumentation(tools)).not.toThrow();
        const createTask = tools.find(tool => tool.name === 'svc.create_task');
        expect(createTask).toMatchObject({
            kind: 'write',
            businessPermission: 'tasks.create',
            description: expect.stringMatching(/visible to people/i),
        });
        expect(createTask.description).toMatch(/deduplicated/i);
        expect(createTask.description).toMatch(/at most 3 write calls/i);
        const addNote = tools.find(tool => tool.name === 'svc.add_note');
        expect(addNote).toMatchObject({
            kind: 'write',
            description: expect.stringMatching(/24 hours/i),
        });
        expect(addNote.documentation.responseNotes.join(' ')).toMatch(/shared write calls/i);
        const listLeads = tools.find(tool => tool.name === 'svc.list_leads');
        expect(listLeads.outputSchema.properties.results.items.properties)
            .not.toHaveProperty('phone');
        expect(listLeads.outputSchema.properties.results.items.properties)
            .not.toHaveProperty('email');
        expect(tools.find(tool => tool.name === 'svc.get_lead').outputSchema.properties)
            .toEqual(expect.objectContaining({ phone: expect.any(Object), email: expect.any(Object) }));
    });

    test('2: APP-TOOLS-001.md is the exact deterministic catalog rendering', () => {
        expect(fs.readFileSync(DOC_PATH, 'utf8')).toBe(renderAppToolsMarkdown());
    });

    test('3: builder prompt embeds the rendered catalog and has no handwritten response/date duplicates', () => {
        const rendered = renderPromptToolDocumentation({ todayIso: TODAY });
        const prompt = buildPrompt({ history: [], current_source: null });

        expect(prompt).toContain(rendered);
        expect(prompt.match(new RegExp(PROMPT_CATALOG_BEGIN, 'g'))).toHaveLength(1);
        expect(prompt.match(new RegExp(PROMPT_CATALOG_END, 'g'))).toHaveLength(1);
        expect(prompt).toContain('"output_schema"');
        expect(prompt).toContain('"kind": "write"');
        expect(prompt).toContain('Task rows are under `tasks`, not `results`.');
        expect(prompt).not.toContain('every list tool answers');
        expect(prompt).not.toContain('Date filters take a plain');
        expect(prompt).not.toContain('<BEGIN_TOOL_CATALOG_DATA>');
    });

    test('4: the documentation validator rejects a sabotaged parameter description', () => {
        const sabotaged = appRuntimeCatalog.listTools();
        delete sabotaged[0].inputSchema.properties.status.description;
        expect(() => assertToolDocumentation(sabotaged)).toThrow(
            'APP_RUNTIME_TOOL_DOCUMENTATION_INVALID: svc.list_jobs.inputSchema.properties.status.description'
        );
    });
});
