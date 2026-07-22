#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    buildVapiFinanceTools,
    FINANCE_TOOL_DEFINITIONS,
    VAPI_TOOL_SERVER_URL,
    VAPI_TOOL_SECRET_PLACEHOLDER,
} = require('../backend/src/services/agentSkills/financeToolDefinitions');

const ROOT = path.resolve(__dirname, '..');
const ASSISTANTS = Object.freeze([
    {
        key: 'sara',
        file: 'voice-agent/assistants/lead-qualifier-v2.json',
        env: 'VAPI_INBOUND_ASSISTANT_ID',
        fallbackId: '30e85a87-9d7e-4694-828e-1fea7d10f3ef',
        allowedTools: Object.freeze([
            'identifyCaller', 'checkServiceArea', 'validateAddress', 'checkAvailability',
            'createLead', 'recommendSlots', 'getCustomerOverview', 'getJobStatus',
            'getAppointments', 'getJobHistory', 'getEstimateSummary', 'getInvoiceSummary',
            'rescheduleAppointment', 'cancelAppointment', 'bookOnLead',
        ]),
    },
    {
        key: 'parts',
        file: 'voice-agent/assistants/parts-visit-scheduler.json',
        env: 'VAPI_OUTBOUND_ASSISTANT_ID',
        allowedTools: Object.freeze([
            'recommendSlots', 'confirmPartsVisit', 'getEstimateSummary', 'getInvoiceSummary',
        ]),
    },
    {
        key: 'lead',
        file: 'voice-agent/assistants/outbound-lead-caller.json',
        env: 'VAPI_LEAD_CALL_ASSISTANT_ID',
        allowedTools: Object.freeze([
            'recommendSlots', 'confirmLeadBooking', 'validateAddress',
            'getEstimateSummary', 'getInvoiceSummary',
        ]),
    },
]);
const FINANCE_NAMES = new Set(FINANCE_TOOL_DEFINITIONS.map((definition) => definition.skillName));
const FORBIDDEN_INJECTED_FINANCE_KEYS = [
    'balanceDue',
    'balance_due',
    'invoiceTotal',
    'invoice_total',
    'estimateTotal',
    'estimate_total',
    'amountPaid',
    'amount_paid',
    'invoiceAmount',
    'estimateAmount',
    'totalDue',
];

function readAssistant(entry) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
}

function financeToolsFrom(config) {
    return (config.model?.tools || []).filter((tool) => FINANCE_NAMES.has(tool.function?.name));
}

function projectTools(config, secret = VAPI_TOOL_SECRET_PLACEHOLDER, allowedTools = null) {
    const existing = Array.isArray(config.model?.tools) ? config.model.tools : [];
    const desired = buildVapiFinanceTools({ serverUrl: VAPI_TOOL_SERVER_URL, serverSecret: secret });
    const desiredByName = new Map(desired.map((tool) => [tool.function.name, tool]));
    const projected = [];
    for (const tool of existing) {
        const name = tool.function?.name;
        if (desiredByName.has(name)) {
            projected.push(desiredByName.get(name));
            desiredByName.delete(name);
        } else {
            projected.push(tool);
        }
    }
    projected.push(...desiredByName.values());
    if (!allowedTools) return projected;
    const projectedByName = new Map(projected.map((tool) => [tool.function?.name, tool]));
    return allowedTools.map((name) => projectedByName.get(name)).filter(Boolean);
}

function applyPromptPolicy(entry, config) {
    let prompt = config.model?.messages?.[0]?.content || '';
    if (entry.key === 'sara') {
        prompt = prompt.replace(
            "Since they matched by phone, greet the person identifyCaller returned and don't ask which account they are.",
            "Since they matched by phone, greet the person identifyCaller returned and don't ask which account they are for normal booking flows. FINANCE ONLY: if a finance skill returns subjectAmbiguous because the phone belongs to distinct customers, ask which repair they mean; this is repair clarification, never an identity challenge.",
        );
        prompt = prompt.replace(
            /F\) ESTIMATE \/ INVOICE \/ HISTORY[\s\S]*?\n\nInsurance \/ no-phone identify:/,
            `F) ESTIMATE / INVOICE / HISTORY / "how much was my estimate / what's my balance / what did the tech say?" → being identified by phone is enough; NEVER ask for name, ZIP, street, or a code for finance. Call getEstimateSummary, getInvoiceSummary, or getJobHistory and pass a jobId/leadId/estimateId/invoiceId only when the repair or document is known. If a finance skill returns subjectAmbiguous, ask which REPAIR they mean and retry with that job/lead — do not ask who they are. Read customer-facing item name, quantity, line amount, subtotal, discount, tax, total, paid, and due; at most five items, then offer the written document. A draft estimate is NEVER spoken, even when explicitly requested: say it is still being prepared and the team will follow up. For multiple ready documents, follow the skill's preferred result or brief selection question. Never read internal notes, technician notes, SKU/codes, metadata, or a full address, and NEVER take a card or payment by voice; offer a secure payment link or a teammate.\n\nInsurance / no-phone identify:`,
        );
    }

    if (entry.key === 'parts') {
        if (!prompt.includes('[Finance Questions — on demand]')) {
            prompt = prompt.replace(
                '\n[Style]\n',
                `\n[Finance Questions — on demand]\nIf the customer asks about the repair price, estimate, invoice, or balance, call getEstimateSummary or getInvoiceSummary. The existing job is threaded server-side; phone match is sufficient and you NEVER ask for name, ZIP, street, or a code. If a skill returns subjectAmbiguous, ask which repair they mean and retry; this is repair clarification, not identity verification. Read customer-facing item name, quantity, line amount, subtotal, discount, tax, total, paid, and due; at most five items, then offer the written document. A draft estimate is NEVER spoken, even when explicitly requested: say it is still being prepared and the team will follow up. Never read internal/technician notes, SKU/codes, metadata, or payment data, and never take a card by voice.\n\n[Style]\n`,
            );
        }
        prompt = prompt.replace(
            /- Do NOT quote a repair price[\s\S]*?never take payment by voice\./,
            '- Never use a preloaded or prompt-injected amount. Financial information is fetched only on demand through getEstimateSummary or getInvoiceSummary under the Finance Questions rules. Never take payment by voice.',
        );
    }

    if (entry.key === 'lead') {
        if (!prompt.includes('[Finance Questions — on demand]')) {
            prompt = prompt.replace(
                '\n[Style]\n',
                `\n[Finance Questions — on demand]\nThis request can already have a sent/approved estimate or a real invoice even though it is not a job yet. If the customer asks about price, an estimate, an invoice, or a balance, call getEstimateSummary or getInvoiceSummary; the exact lead is threaded server-side. Phone match is sufficient and you NEVER ask for name, ZIP, street, or a code for finance. If a skill returns subjectAmbiguous, ask which repair they mean and retry; this is repair clarification, not identity verification. Read customer-facing item name, quantity, line amount, subtotal, discount, tax, total, paid, and due; at most five items, then offer the written document. A draft estimate is NEVER spoken, even when explicitly requested: say it is still being prepared and the team will follow up. If no ready document exists, say the team will follow up. Never read internal/technician notes, SKU/codes, metadata, or payment data, and never take a card by voice.\n\n[Style]\n`,
            );
        }
        prompt = prompt.replace(
            '- Do NOT quote a repair price and do NOT collect payment by voice. If they ask about cost, tell them a teammate will go over pricing - you are just getting them scheduled.',
            '- Financial information is handled only through getEstimateSummary or getInvoiceSummary under the Finance Questions rules. Never invent a price and never collect payment by voice.',
        );
    }

    config.model.messages[0].content = prompt;
}

function writeLocal() {
    for (const entry of ASSISTANTS) {
        const config = readAssistant(entry);
        applyPromptPolicy(entry, config);
        config.model.tools = projectTools(config, VAPI_TOOL_SECRET_PLACEHOLDER, entry.allowedTools);
        fs.writeFileSync(path.join(ROOT, entry.file), `${JSON.stringify(config, null, 2)}\n`);
        console.log(`SYNC ${entry.key}: ${entry.file}`);
    }
}

function comparableTool(tool) {
    return {
        type: tool.type,
        server: { url: tool.server?.url },
        function: tool.function,
    };
}

function checkLocal() {
    let failed = false;
    const expected = buildVapiFinanceTools().map(comparableTool);
    for (const entry of ASSISTANTS) {
        const config = readAssistant(entry);
        const toolNames = (config.model?.tools || []).map((tool) => tool.function?.name);
        if (JSON.stringify(toolNames) !== JSON.stringify(entry.allowedTools)) {
            console.error(`FAIL ${entry.key}: tool allowlist drift (${toolNames.join(', ')})`);
            failed = true;
        }
        const actual = financeToolsFrom(config).map(comparableTool);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            console.error(`FAIL SAB-FIN-MCP-PARITY ${entry.key}: finance tools differ from shared projection`);
            failed = true;
        }
        const serialized = JSON.stringify(config);
        const injected = FORBIDDEN_INJECTED_FINANCE_KEYS.filter((key) => serialized.includes(key));
        if (injected.length > 0) {
            console.error(`FAIL SAB-FIN-ONDEMAND ${entry.key}: injected finance keys: ${injected.join(', ')}`);
            failed = true;
        }
        const prompt = config.model?.messages?.[0]?.content || '';
        if (!prompt.includes('getEstimateSummary') || !prompt.includes('getInvoiceSummary')) {
            console.error(`FAIL ${entry.key}: prompt does not route both finance skills`);
            failed = true;
        }
        if (!/draft/i.test(prompt) || !/never|do not|don\'t/i.test(prompt)) {
            console.error(`FAIL SAB-FIN-DRAFT-SILENCE ${entry.key}: prompt lacks draft-silence policy`);
            failed = true;
        }
        if (actual.length === expected.length && !injected.length) {
            console.log(`PASS ${entry.key}: shared finance projection; SAB-FIN-ONDEMAND`);
        }
    }
    if (failed) process.exitCode = 1;
}

function liveId(entry) {
    return process.env[entry.env] || entry.fallbackId || '';
}

async function vapiRequest(pathname, options = {}) {
    const apiKey = process.env.VAPI_API_KEY;
    if (!apiKey) throw new Error('VAPI_API_KEY is required');
    const response = await fetch(`https://api.vapi.ai${pathname}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });
    if (!response.ok) throw new Error(`VAPI ${options.method || 'GET'} ${pathname} returned HTTP ${response.status}`);
    return response.json();
}

function liveMatches(entry, live, desired) {
    const expectedTools = buildVapiFinanceTools().map(comparableTool);
    const actualTools = financeToolsFrom(live).map(comparableTool);
    const toolNames = (live.model?.tools || []).map((tool) => tool.function?.name);
    const promptMatches = live.model?.messages?.[0]?.content === desired.model?.messages?.[0]?.content;
    return {
        tools: JSON.stringify(actualTools) === JSON.stringify(expectedTools)
            && JSON.stringify(toolNames) === JSON.stringify(entry.allowedTools),
        prompt: promptMatches,
    };
}

function patchModel(entry, live, desired, secret) {
    const liveTools = Array.isArray(live.model?.tools) ? live.model.tools : [];
    const liveNames = new Set(liveTools.map((tool) => tool.function?.name));
    const fallbackTools = (desired.model?.tools || [])
        .filter((tool) => !liveNames.has(tool.function?.name));
    const toolSource = {
        ...live,
        model: { ...live.model, tools: [...liveTools, ...fallbackTools] },
    };
    const projected = {
        ...live,
        model: {
            ...live.model,
            tools: projectTools(toolSource, secret, entry.allowedTools).map((tool) => ({
                ...tool,
                ...(tool.server ? { server: { ...tool.server, secret } } : {}),
            })),
            messages: [
                {
                    ...(live.model?.messages?.[0] || {}),
                    ...(desired.model?.messages?.[0] || {}),
                },
                ...(live.model?.messages || []).slice(1),
            ],
        },
    };
    return { model: projected.model };
}

async function syncLive(apply) {
    if (!process.env.VAPI_API_KEY) throw new Error('VAPI_API_KEY is required');
    const secret = process.env.VAPI_TOOLS_SECRET;
    if (apply && !secret) throw new Error('VAPI_TOOLS_SECRET is required for --live-apply');
    const targets = ASSISTANTS.map((entry) => ({ entry, id: liveId(entry) }));
    const missing = targets.filter(({ id }) => !id);
    if (missing.length > 0) {
        throw new Error(`${missing.map(({ entry }) => entry.env).join(', ')} required before any live change`);
    }
    for (const { entry, id } of targets) {
        const desired = readAssistant(entry);
        const before = await vapiRequest(`/assistant/${id}`);
        const drift = liveMatches(entry, before, desired);
        console.log(`GET ${entry.key}: tools=${drift.tools ? 'match' : 'drift'} prompt=${drift.prompt ? 'match' : 'drift'}`);
        if (!apply) {
            if (!drift.tools || !drift.prompt) process.exitCode = 1;
            continue;
        }
        await vapiRequest(`/assistant/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(patchModel(entry, before, desired, secret)),
        });
        const after = await vapiRequest(`/assistant/${id}`);
        const verified = liveMatches(entry, after, desired);
        if (!verified.tools || !verified.prompt) {
            throw new Error(`GET-after-PATCH verification failed for ${entry.key}`);
        }
        console.log(`PATCH ${entry.key}: verified by GET`);
    }
}

async function main() {
    const command = process.argv[2];
    if (command === '--write') return writeLocal();
    if (command === '--check') return checkLocal();
    if (command === '--live-check') return syncLive(false);
    if (command === '--live-apply') return syncLive(true);
    throw new Error('Usage: sync-vapi-finance-tools.js --write|--check|--live-check|--live-apply');
}

main().catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exitCode = 1;
});
