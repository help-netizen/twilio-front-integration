'use strict';

const appRuntimeCatalog = require('./appRuntimeToolCatalog');

const PROMPT_CATALOG_BEGIN = '<BEGIN_TOOL_DOCUMENTATION>';
const PROMPT_CATALOG_END = '<END_TOOL_DOCUMENTATION>';

function documentationError(path) {
    const error = new Error(`APP_RUNTIME_TOOL_DOCUMENTATION_INVALID: ${path}`);
    error.code = 'APP_RUNTIME_TOOL_DOCUMENTATION_INVALID';
    return error;
}

function requireDescription(schema, path) {
    if (typeof schema?.description !== 'string' || !schema.description.trim()) {
        throw documentationError(`${path}.description`);
    }
}

function assertPropertyDescriptions(schema, path) {
    for (const [name, property] of Object.entries(schema?.properties || {})) {
        const propertyPath = `${path}.properties.${name}`;
        requireDescription(property, propertyPath);
        assertPropertyDescriptions(property, propertyPath);
        if (property?.items) {
            requireDescription(property.items, `${propertyPath}.items`);
            assertPropertyDescriptions(property.items, `${propertyPath}.items`);
        }
    }
}

function assertToolDocumentation(tools = appRuntimeCatalog.listTools()) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw documentationError('catalog');
    }
    for (const tool of tools) {
        if (typeof tool?.description !== 'string' || !tool.description.trim()) {
            throw documentationError(`${tool?.name || '(unknown)'}.description`);
        }
        assertPropertyDescriptions(tool.inputSchema, `${tool.name}.inputSchema`);
        requireDescription(tool.outputSchema, `${tool.name}.outputSchema`);
        assertPropertyDescriptions(tool.outputSchema, `${tool.name}.outputSchema`);

        const documentation = tool.documentation;
        if (!documentation
            || !Array.isArray(documentation.responseNotes)
            || documentation.responseNotes.length === 0
            || documentation.responseNotes.some(note => typeof note !== 'string' || !note.trim())) {
            throw documentationError(`${tool.name}.documentation.responseNotes`);
        }
        if (!Array.isArray(documentation.errors)
            || documentation.errors.length === 0
            || documentation.errors.some(error => (
                typeof error?.code !== 'string'
                || !error.code.trim()
                || typeof error?.description !== 'string'
                || !error.description.trim()
            ))) {
            throw documentationError(`${tool.name}.documentation.errors`);
        }
        if (!Array.isArray(documentation.examples)
            || documentation.examples.length < 1
            || documentation.examples.length > 2
            || documentation.examples.some(example => (
                typeof example?.title !== 'string'
                || !example.title.trim()
                || typeof example?.source !== 'string'
                || !example.source.trim()
            ))) {
            throw documentationError(`${tool.name}.documentation.examples`);
        }
    }
    return tools;
}

function promptProjection(tool) {
    return {
        name: tool.name,
        description: tool.description,
        business_permission: tool.businessPermission,
        input_schema: tool.inputSchema,
        output_schema: tool.outputSchema,
        response_notes: tool.documentation.responseNotes,
        errors: tool.documentation.errors,
        examples: tool.documentation.examples,
    };
}

function renderPromptToolDocumentation({ todayIso, tools = appRuntimeCatalog.listTools() } = {}) {
    if (typeof todayIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) {
        throw documentationError('prompt.todayIso');
    }
    const documentedTools = assertToolDocumentation(tools);
    return [
        `Validation runtime input: ctx.input.today is the UTC calendar date "${todayIso}". Use ctx.input.today for requests that mean today; do not hard-code another calendar date.`,
        'ctx.callTool returns the value described by output_schema directly. The internal gateway envelope is not visible to app code.',
        PROMPT_CATALOG_BEGIN,
        JSON.stringify(documentedTools.map(promptProjection), null, 2),
        PROMPT_CATALOG_END,
    ].join('\n');
}

function markdownEscape(value) {
    return String(value)
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ');
}

function typeLabel(schema = {}) {
    const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type || 'any'];
    const types = rawTypes.map(type => {
        if (type !== 'array') return type;
        return `array<${typeLabel(schema.items || {})}>`;
    });
    let label = types.join(' | ');
    if (Array.isArray(schema.enum)) {
        label += ` (${schema.enum.map(value => JSON.stringify(value)).join(', ')})`;
    }
    if (schema.format) label += `, ${schema.format}`;
    return label;
}

function defaultLabel(schema, required) {
    if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
        return `\`${JSON.stringify(schema.default)}\``;
    }
    return required ? 'none' : 'omitted';
}

function renderInputTable(tool) {
    const required = new Set(tool.inputSchema.required || []);
    const rows = Object.entries(tool.inputSchema.properties || {}).map(([name, schema]) => (
        `| \`${name}\` | ${required.has(name) ? 'yes' : 'no'} | ${markdownEscape(typeLabel(schema))} | ${defaultLabel(schema, required.has(name))} | ${markdownEscape(schema.description)} |`
    ));
    return [
        '| Parameter | Required | Type / values | Default | Meaning |',
        '|---|:---:|---|---|---|',
        ...rows,
    ].join('\n');
}

function flattenOutputFields(schema, prefix = '') {
    const rows = [];
    for (const [name, property] of Object.entries(schema?.properties || {})) {
        const path = prefix ? `${prefix}.${name}` : name;
        rows.push({ path, schema: property });
        if (property?.properties) {
            rows.push(...flattenOutputFields(property, path));
        }
        if (property?.items?.properties) {
            rows.push(...flattenOutputFields(property.items, `${path}[]`));
        }
    }
    return rows;
}

function renderOutputTable(tool) {
    const rows = flattenOutputFields(tool.outputSchema).map(({ path, schema }) => (
        `| \`${path}\` | ${markdownEscape(typeLabel(schema))} | ${markdownEscape(schema.description)} |`
    ));
    return [
        tool.outputSchema.description,
        '',
        '| Field | Type / values | Meaning |',
        '|---|---|---|',
        ...rows,
    ].join('\n');
}

function renderErrors(tool) {
    return [
        '| Code | Meaning |',
        '|---|---|',
        ...tool.documentation.errors.map(error => (
            `| \`${error.code}\` | ${markdownEscape(error.description)} |`
        )),
    ].join('\n');
}

function renderExamples(tool) {
    return tool.documentation.examples.map(example => [
        `**${example.title}**`,
        '',
        '```js',
        example.source,
        '```',
    ].join('\n')).join('\n\n');
}

function renderToolMarkdown(tool) {
    return [
        `## \`${tool.name}\``,
        '',
        tool.description,
        '',
        `Required live permission: \`${tool.businessPermission}\`.`,
        '',
        '### Parameters',
        '',
        renderInputTable(tool),
        '',
        '### Response',
        '',
        renderOutputTable(tool),
        '',
        ...tool.documentation.responseNotes.flatMap(note => [`- ${note}`, '']),
        '### Errors',
        '',
        renderErrors(tool),
        '',
        '### Example',
        '',
        renderExamples(tool),
    ].join('\n');
}

function renderAppToolsMarkdown({ tools = appRuntimeCatalog.listTools() } = {}) {
    const documentedTools = assertToolDocumentation(tools);
    const toolNames = documentedTools.map(tool => `\`${tool.name}\``).join(', ');
    return [
        '<!-- GENERATED FILE — run `npm run gen:app-tools-doc` after changing the runtime catalog. -->',
        '',
        '# APP-TOOLS-001 — App Studio tools (MCP + gateway API)',
        '',
        `This reference is generated from the same ${documentedTools.length} read-only descriptors used by Albusto App Studio and the service CRM MCP registry.`,
        '',
        `Exactly ${documentedTools.length} tools are available: ${toolNames}.`,
        '',
        '## Availability and transport',
        '',
        '- App code calls `await ctx.callTool(name, args)`. It has no `fetch`, general HTTP API, network access, filesystem, dependencies, or arbitrary egress from the isolate.',
        '- The internal gateway transport returns `{"ok":true,"data":<tool output>,"request_id":"..."}`. `ctx.callTool` unwraps it and returns only `<tool output>`.',
        '- MCP `tools/list` exposes the same input and output schemas; a successful MCP call places the documented tool output in `structuredContent`.',
        '- No write, send, message-delivery, trigger, scheduler, Contact, Call, payment, invoice, or external-egress tool is available to App Studio.',
        '- Live company, role, provider, Task-content, consent, masking, audit, rate, and run-call controls can narrow every call.',
        '',
        'Arguments are JSON objects. Unknown parameters are rejected. Dates use the exact `YYYY-MM-DD` calendar form described by each parameter; timestamps in responses use ISO 8601.',
        '',
        ...documentedTools.flatMap(tool => [renderToolMarkdown(tool), '']),
    ].join('\n').trimEnd() + '\n';
}

module.exports = {
    PROMPT_CATALOG_BEGIN,
    PROMPT_CATALOG_END,
    assertToolDocumentation,
    renderPromptToolDocumentation,
    renderAppToolsMarkdown,
};
