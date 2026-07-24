'use strict';

const crypto = require('crypto');
const fsmService = require('./fsmService');
const contactPropagationService = require('./contactPropagationService');
const estimatesService = require('./estimatesService');
const invoicesService = require('./invoicesService');
const chatgptMcpQueries = require('../db/chatgptMcpQueries');
const { safeResult } = require('./chatgptMcpReadService');
const { CrmServiceError } = require('./crmErrors');
const { toE164 } = require('../utils/phoneUtils');

class ChatgptMcpWriteError extends CrmServiceError {
    constructor(code, message, httpStatus = 400) {
        super(code, message, httpStatus);
        this.name = 'ChatgptMcpWriteError';
    }
}

function requireContext(context, client) {
    if (!context?.companyId || !context?.actorId) {
        throw new ChatgptMcpWriteError('TENANT_CONTEXT_REQUIRED', 'Company and actor context are required.', 403);
    }
    if (!client?.query) {
        throw new ChatgptMcpWriteError('MCP_TRANSACTION_REQUIRED', 'A write transaction is required.', 500);
    }
}

function notFound(entity) {
    throw new ChatgptMcpWriteError('NOT_FOUND', `${entity} not found.`, 404);
}

function validation(message) {
    throw new ChatgptMcpWriteError('VALIDATION_ERROR', message, 400);
}

function text(value) {
    if (value === undefined) return undefined;
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function normalizePhone(value) {
    const normalized = text(value);
    return normalized ? (toE164(normalized) || normalized) : normalized;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
}

function argumentHash(args) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(stableValue(args || {})))
        .digest('hex');
}

function idempotencyKey(context, toolName, hash) {
    return crypto.createHash('sha256')
        .update(`${context.bindingId}:${toolName}:${hash}`)
        .digest('hex');
}

async function claimCreate(context, toolName, args, client) {
    const hash = argumentHash(args);
    const key = idempotencyKey(context, toolName, hash);
    const claimed = await client.query(
        `INSERT INTO mcp_tool_idempotency
            (company_id, agent_user_id, tool_name, idempotency_key, argument_hash, state)
         VALUES ($1, $2, $3, $4, $5, 'claimed')
         ON CONFLICT (company_id, agent_user_id, tool_name, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.companyId, context.actorId, toolName, key, hash]
    );
    if (claimed.rows.length === 1) {
        return { id: claimed.rows[0].id, hash, key, replay: null };
    }
    const existing = await client.query(
        `SELECT id, argument_hash, state, safe_result
         FROM mcp_tool_idempotency
         WHERE company_id = $1
           AND agent_user_id = $2
           AND tool_name = $3
           AND idempotency_key = $4
         FOR UPDATE`,
        [context.companyId, context.actorId, toolName, key]
    );
    const row = existing.rows[0];
    if (!row || row.argument_hash !== hash || row.state !== 'succeeded') {
        throw new ChatgptMcpWriteError(
            'IDEMPOTENCY_CONFLICT',
            'An identical create request is already being processed.',
            409
        );
    }
    return { id: row.id, hash, key, replay: row.safe_result };
}

async function completeCreate(claim, result, client) {
    await client.query(
        `UPDATE mcp_tool_idempotency
         SET state = 'succeeded', safe_result = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [claim.id, JSON.stringify(result)]
    );
}

async function findOrCreateContact(companyId, input, client) {
    if (input.contact_id != null) {
        const owned = await client.query(
            `SELECT id, full_name, first_name, last_name, phone_e164, email
             FROM contacts
             WHERE id = $1 AND company_id = $2
             FOR SHARE`,
            [input.contact_id, companyId]
        );
        if (owned.rows.length !== 1) notFound('Contact');
        await contactPropagationService.propagateContactDetails(
            companyId,
            owned.rows[0].id,
            { phone: input.phone, email: input.email },
            {
                client,
                source: 'chatgpt_mcp',
                logPrefix: '[ChatGPT MCP]',
                relinkHistory: false,
                logEvents: false,
                redactEmail: true,
            }
        );
        return owned.rows[0];
    }

    const firstName = text(input.first_name);
    const lastName = text(input.last_name);
    const phone = normalizePhone(input.phone);
    const email = text(input.email)?.toLowerCase() || null;
    if (!firstName || !lastName) validation('first_name and last_name are required to create a Contact.');
    if (!phone && !email) validation('phone, email, or contact_id is required.');

    const params = [companyId, firstName.toLowerCase(), lastName.toLowerCase()];
    const identityPredicates = [];
    if (phone) {
        params.push(phone.replace(/\D/g, '').slice(-10));
        identityPredicates.push(
            `RIGHT(REGEXP_REPLACE(COALESCE(c.phone_e164, ''), '[^0-9]', '', 'g'), 10) = $${params.length}`
        );
        identityPredicates.push(
            `RIGHT(REGEXP_REPLACE(COALESCE(c.secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $${params.length}`
        );
    }
    if (email) {
        params.push(email);
        identityPredicates.push(`LOWER(COALESCE(c.email, '')) = $${params.length}`);
        identityPredicates.push(
            `EXISTS (
                SELECT 1
                FROM contact_emails ce
                JOIN contacts ce_contact
                  ON ce_contact.id = ce.contact_id
                 AND ce_contact.company_id = c.company_id
                WHERE ce.contact_id = c.id
                  AND ce_contact.company_id = $1
                  AND ce.email_normalized = $${params.length}
            )`
        );
    }
    const candidates = await client.query(
        `SELECT c.id, c.full_name, c.first_name, c.last_name, c.phone_e164, c.email
         FROM contacts c
         WHERE c.company_id = $1
           AND LOWER(BTRIM(COALESCE(c.first_name, ''))) = $2
           AND LOWER(BTRIM(COALESCE(c.last_name, ''))) = $3
           AND (${identityPredicates.join(' OR ')})
         ORDER BY c.updated_at DESC, c.id DESC
         FOR SHARE OF c`,
        params
    );
    if (candidates.rows.length > 1) {
        throw new ChatgptMcpWriteError(
            'CONTACT_AMBIGUOUS',
            'Multiple matching Contacts require human selection.',
            409
        );
    }
    if (candidates.rows.length === 1) {
        const contact = candidates.rows[0];
        await contactPropagationService.propagateContactDetails(
            companyId,
            contact.id,
            { phone, email },
            {
                client,
                source: 'chatgpt_mcp',
                logPrefix: '[ChatGPT MCP]',
                relinkHistory: false,
                logEvents: false,
                redactEmail: true,
            }
        );
        return contact;
    }

    const created = await client.query(
        `INSERT INTO contacts
            (company_id, full_name, first_name, last_name, phone_e164, email)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, first_name, last_name, phone_e164, email`,
        [companyId, `${firstName} ${lastName}`, firstName, lastName, phone, email]
    );
    if (email) {
        await client.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             SELECT c.id, $3, $3, true
             FROM contacts c
             WHERE c.id = $1 AND c.company_id = $2
             ON CONFLICT (contact_id, email_normalized) DO NOTHING`,
            [created.rows[0].id, companyId, email]
        );
    }
    return created.rows[0];
}

async function nextLeadUuid(client) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = crypto.randomBytes(5).toString('hex').slice(0, 6).toUpperCase();
        const exists = await client.query('SELECT 1 FROM leads WHERE uuid = $1', [candidate]);
        if (exists.rows.length === 0) return candidate;
    }
    throw new ChatgptMcpWriteError('UUID_GENERATION_FAILED', 'Could not allocate a Lead identifier.', 500);
}

function noteObject(textValue, actorId) {
    const noteText = text(textValue);
    if (!noteText) return null;
    return {
        id: crypto.randomUUID(),
        text: noteText,
        created: new Date().toISOString(),
        created_by: actorId,
        author: 'ChatGPT AI Dispatcher',
    };
}

async function createLead(context, args, client) {
    const contact = await findOrCreateContact(context.companyId, {
        contact_id: args.contact_id,
        first_name: args.first_name,
        last_name: args.last_name,
        phone: args.phone,
        email: args.email,
    }, client);
    const uuid = await nextLeadUuid(client);
    const note = noteObject(args.note, context.actorId);
    const inserted = await client.query(
        `INSERT INTO leads
            (company_id, uuid, first_name, last_name, company, phone, email,
             job_source, lead_notes, comments, address, unit, city, state,
             postal_code, job_type, contact_id, structured_notes)
         VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
         RETURNING id, uuid, serial_id, status, contact_id`,
        [
            context.companyId,
            uuid,
            text(args.first_name),
            text(args.last_name),
            text(args.company_name),
            normalizePhone(args.phone),
            text(args.email)?.toLowerCase() || null,
            text(args.source),
            text(args.description),
            text(args.comments),
            text(args.address),
            text(args.unit),
            text(args.city),
            text(args.state),
            text(args.postal_code),
            text(args.job_type),
            contact.id,
            JSON.stringify(note ? [note] : []),
        ]
    );
    return {
        lead_id: inserted.rows[0].id,
        lead_uuid: inserted.rows[0].uuid,
        serial_id: inserted.rows[0].serial_id,
        status: inserted.rows[0].status,
        contact_id: inserted.rows[0].contact_id,
    };
}

const LEAD_UPDATE_COLUMNS = Object.freeze({
    first_name: 'first_name',
    last_name: 'last_name',
    company_name: 'company',
    phone: 'phone',
    email: 'email',
    source: 'job_source',
    description: 'lead_notes',
    comments: 'comments',
    address: 'address',
    unit: 'unit',
    city: 'city',
    state: 'state',
    postal_code: 'postal_code',
    job_type: 'job_type',
    contact_id: 'contact_id',
});

async function updateLead(context, args, client) {
    const current = await client.query(
        `SELECT id, uuid, contact_id, first_name, last_name, phone, email
         FROM leads
         WHERE uuid = $1 AND company_id = $2
         FOR UPDATE`,
        [args.lead_uuid, context.companyId]
    );
    if (current.rows.length !== 1) notFound('Lead');
    if (args.contact_id !== undefined) {
        await findOrCreateContact(context.companyId, { contact_id: args.contact_id }, client);
    }
    const updates = [];
    const values = [];
    for (const [field, column] of Object.entries(LEAD_UPDATE_COLUMNS)) {
        if (args[field] === undefined) continue;
        values.push(field === 'phone'
            ? normalizePhone(args[field])
            : (field === 'email' ? text(args[field])?.toLowerCase() || null : text(args[field])));
        updates.push(`${column} = $${values.length}`);
    }
    if (updates.length === 0) validation('At least one editable Lead field is required.');
    values.push(args.lead_uuid, context.companyId);
    const updated = await client.query(
        `UPDATE leads
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE uuid = $${values.length - 1} AND company_id = $${values.length}
         RETURNING id, uuid, status, contact_id`,
        values
    );
    if (updated.rows.length !== 1) notFound('Lead');
    const contactId = updated.rows[0].contact_id;
    if (contactId && (args.phone !== undefined || args.email !== undefined)) {
        await contactPropagationService.propagateContactDetails(
            context.companyId,
            contactId,
            { phone: args.phone, email: args.email },
            {
                client,
                source: 'chatgpt_mcp_lead_update',
                logPrefix: '[ChatGPT MCP]',
                relinkHistory: false,
                logEvents: false,
                redactEmail: true,
            }
        );
    }
    return {
        lead_id: updated.rows[0].id,
        lead_uuid: updated.rows[0].uuid,
        status: updated.rows[0].status,
        contact_id: updated.rows[0].contact_id,
    };
}

async function transitionEntity(context, {
    table,
    keyColumn,
    keyValue,
    statusColumn,
    machineKey,
    entityName,
    action,
}, client) {
    const current = await client.query(
        `SELECT id, ${statusColumn} AS current_status
         FROM ${table}
         WHERE ${keyColumn} = $1 AND company_id = $2
         FOR UPDATE`,
        [keyValue, context.companyId]
    );
    if (current.rows.length !== 1) notFound(entityName);
    const available = await fsmService.getAvailableActions(
        context.companyId,
        machineKey,
        current.rows[0].current_status,
        ['dispatcher']
    );
    if (available.fallback) {
        throw new ChatgptMcpWriteError(
            'FSM_WORKFLOW_UNAVAILABLE',
            `${entityName} workflow is not published.`,
            409
        );
    }
    const selected = (available.actions || []).find((candidate) => candidate.event === action);
    if (!selected) {
        throw new ChatgptMcpWriteError(
            'FSM_TRANSITION_DENIED',
            'The requested dispatcher action is not available.',
            403
        );
    }
    const resolved = await fsmService.resolveTransition(
        context.companyId,
        machineKey,
        current.rows[0].current_status,
        action
    );
    if (resolved.valid !== true || !resolved.targetState) {
        throw new ChatgptMcpWriteError(
            'FSM_TRANSITION_DENIED',
            resolved.error || 'The requested dispatcher action is not available.',
            403
        );
    }
    const changed = await client.query(
        `UPDATE ${table}
         SET ${statusColumn} = $1, updated_at = NOW()
         WHERE ${keyColumn} = $2 AND company_id = $3
         RETURNING id, ${keyColumn} AS entity_key, ${statusColumn} AS status`,
        [resolved.targetState, keyValue, context.companyId]
    );
    if (changed.rows.length !== 1) notFound(entityName);
    return {
        id: changed.rows[0].id,
        entity_key: changed.rows[0].entity_key,
        status: changed.rows[0].status,
        action,
    };
}

async function transitionLead(context, args, client) {
    return transitionEntity(context, {
        table: 'leads',
        keyColumn: 'uuid',
        keyValue: args.lead_uuid,
        statusColumn: 'status',
        machineKey: 'lead',
        entityName: 'Lead',
        action: args.action,
    }, client);
}

function nameParts(fullName) {
    const normalized = text(fullName) || '';
    const [firstName, ...rest] = normalized.split(/\s+/);
    return { first_name: firstName || null, last_name: rest.join(' ') || null };
}

async function createJob(context, args, client) {
    const parts = nameParts(args.customer_name);
    const contact = await findOrCreateContact(context.companyId, {
        contact_id: args.contact_id,
        ...parts,
        phone: args.customer_phone,
        email: args.customer_email,
    }, client);
    const note = noteObject(args.note, context.actorId);
    const inserted = await client.query(
        `INSERT INTO jobs
            (company_id, contact_id, blanc_status, zb_status, service_name,
             description, start_date, end_date, customer_name, customer_phone,
             customer_email, address, city, territory, job_source, notes, zb_raw)
         VALUES
            ($1,$2,'Submitted','scheduled',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'{}'::jsonb)
         RETURNING id, blanc_status, contact_id`,
        [
            context.companyId,
            contact.id,
            text(args.service_name),
            text(args.description),
            text(args.start_date),
            text(args.end_date),
            text(args.customer_name) || contact.full_name,
            normalizePhone(args.customer_phone) || contact.phone_e164,
            text(args.customer_email)?.toLowerCase() || contact.email,
            text(args.address),
            text(args.city),
            text(args.territory),
            text(args.job_source),
            JSON.stringify(note ? [note] : []),
        ]
    );
    return {
        job_id: inserted.rows[0].id,
        status: inserted.rows[0].blanc_status,
        contact_id: inserted.rows[0].contact_id,
    };
}

const JOB_UPDATE_COLUMNS = Object.freeze({
    contact_id: 'contact_id',
    customer_name: 'customer_name',
    customer_phone: 'customer_phone',
    customer_email: 'customer_email',
    service_name: 'service_name',
    description: 'description',
    start_date: 'start_date',
    end_date: 'end_date',
    address: 'address',
    city: 'city',
    territory: 'territory',
    job_source: 'job_source',
});

async function updateJob(context, args, client) {
    const current = await client.query(
        `SELECT id, contact_id
         FROM jobs
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [args.job_id, context.companyId]
    );
    if (current.rows.length !== 1) notFound('Job');
    if (args.contact_id !== undefined) {
        await findOrCreateContact(context.companyId, { contact_id: args.contact_id }, client);
    }
    const updates = [];
    const values = [];
    for (const [field, column] of Object.entries(JOB_UPDATE_COLUMNS)) {
        if (args[field] === undefined) continue;
        values.push(field === 'customer_phone'
            ? normalizePhone(args[field])
            : (field === 'customer_email' ? text(args[field])?.toLowerCase() || null : text(args[field])));
        updates.push(`${column} = $${values.length}`);
    }
    if (updates.length === 0) validation('At least one editable Job field is required.');
    values.push(args.job_id, context.companyId);
    const updated = await client.query(
        `UPDATE jobs
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${values.length - 1} AND company_id = $${values.length}
         RETURNING id, blanc_status, contact_id`,
        values
    );
    if (updated.rows.length !== 1) notFound('Job');
    if (updated.rows[0].contact_id
        && (args.customer_phone !== undefined || args.customer_email !== undefined)) {
        await contactPropagationService.propagateContactDetails(
            context.companyId,
            updated.rows[0].contact_id,
            { phone: args.customer_phone, email: args.customer_email },
            {
                client,
                source: 'chatgpt_mcp_job_update',
                logPrefix: '[ChatGPT MCP]',
                relinkHistory: false,
                logEvents: false,
                redactEmail: true,
            }
        );
    }
    return {
        job_id: updated.rows[0].id,
        status: updated.rows[0].blanc_status,
        contact_id: updated.rows[0].contact_id,
    };
}

async function transitionJob(context, args, client) {
    return transitionEntity(context, {
        table: 'jobs',
        keyColumn: 'id',
        keyValue: args.job_id,
        statusColumn: 'blanc_status',
        machineKey: 'job',
        entityName: 'Job',
        action: args.action,
    }, client);
}

async function addNote(context, args, client) {
    const note = noteObject(args.text, context.actorId);
    if (!note) validation('text is required.');
    let table;
    let keyColumn;
    let keyValue;
    let notesColumn;
    if (args.parent_type === 'job') {
        table = 'jobs';
        keyColumn = 'id';
        keyValue = Number(args.parent_id);
        notesColumn = 'notes';
    } else if (args.parent_type === 'lead') {
        table = 'leads';
        keyColumn = 'uuid';
        keyValue = args.parent_id;
        notesColumn = 'structured_notes';
    } else if (args.parent_type === 'contact') {
        table = 'contacts';
        keyColumn = 'id';
        keyValue = Number(args.parent_id);
        notesColumn = 'structured_notes';
    } else {
        validation('parent_type must be job, lead, or contact.');
    }
    if ((keyColumn === 'id' && !Number.isSafeInteger(keyValue)) || !keyValue) {
        validation('parent_id is invalid.');
    }
    const locked = await client.query(
        `SELECT id, COALESCE(${notesColumn}, '[]'::jsonb) AS notes
         FROM ${table}
         WHERE ${keyColumn} = $1 AND company_id = $2
         FOR UPDATE`,
        [keyValue, context.companyId]
    );
    if (locked.rows.length !== 1) notFound(
        args.parent_type.charAt(0).toUpperCase() + args.parent_type.slice(1)
    );
    const notes = [...locked.rows[0].notes, note];
    const updated = await client.query(
        `UPDATE ${table}
         SET ${notesColumn} = $1::jsonb, updated_at = NOW()
         WHERE ${keyColumn} = $2 AND company_id = $3
         RETURNING id`,
        [JSON.stringify(notes), keyValue, context.companyId]
    );
    if (updated.rows.length !== 1) notFound(args.parent_type);
    return {
        parent_type: args.parent_type,
        parent_id: String(args.parent_id),
        note,
    };
}

const FINANCIAL_OPERATION_FIELDS = new Set([
    'items_add',
    'items_update',
    'item_ids_remove',
]);

function financialBasePatch(args, idField) {
    return Object.fromEntries(
        Object.entries(args).filter(([key]) => (
            key !== idField && !FINANCIAL_OPERATION_FIELDS.has(key)
        ))
    );
}

function hasOwnFields(value) {
    return Object.keys(value).length > 0;
}

async function createEstimate(context, args, client) {
    return estimatesService.createEstimate(
        context.companyId,
        context.actorId,
        args,
        client
    );
}

async function updateEstimate(context, args, client) {
    const patch = financialBasePatch(args, 'estimate_id');
    const hasOperations = (
        (args.items_add?.length || 0)
        + (args.items_update?.length || 0)
        + (args.item_ids_remove?.length || 0)
    ) > 0;
    if (!hasOwnFields(patch) && !hasOperations) {
        validation('At least one Estimate field or item operation is required.');
    }
    if (hasOwnFields(patch)) {
        await estimatesService.updateEstimate(
            context.companyId,
            context.actorId,
            args.estimate_id,
            patch,
            client
        );
    }
    if (args.items_add?.length) {
        await estimatesService.addItems(
            context.companyId,
            args.estimate_id,
            context.actorId,
            args.items_add,
            client
        );
    }
    for (const item of args.items_update || []) {
        const { item_id: itemId, ...itemPatch } = item;
        if (!hasOwnFields(itemPatch)) validation('Each items_update entry requires a field to edit.');
        await estimatesService.updateItem(
            context.companyId,
            args.estimate_id,
            context.actorId,
            itemId,
            itemPatch,
            client
        );
    }
    for (const itemId of args.item_ids_remove || []) {
        await estimatesService.removeItem(
            context.companyId,
            args.estimate_id,
            context.actorId,
            itemId,
            client
        );
    }
    return estimatesService.getEstimate(context.companyId, args.estimate_id, client);
}

async function createInvoice(context, args, client) {
    return invoicesService.createInvoice(
        context.companyId,
        context.actorId,
        args,
        client
    );
}

async function updateInvoice(context, args, client) {
    const patch = financialBasePatch(args, 'invoice_id');
    const hasOperations = (
        (args.items_add?.length || 0)
        + (args.items_update?.length || 0)
        + (args.item_ids_remove?.length || 0)
    ) > 0;
    if (!hasOwnFields(patch) && !hasOperations) {
        validation('At least one Invoice field or item operation is required.');
    }
    if (hasOwnFields(patch)) {
        await invoicesService.updateInvoice(
            context.companyId,
            context.actorId,
            args.invoice_id,
            patch,
            client
        );
    }
    if (args.items_add?.length) {
        await invoicesService.addItems(
            context.companyId,
            args.invoice_id,
            context.actorId,
            args.items_add,
            client
        );
    }
    for (const item of args.items_update || []) {
        const { item_id: itemId, ...itemPatch } = item;
        if (!hasOwnFields(itemPatch)) validation('Each items_update entry requires a field to edit.');
        await invoicesService.updateItem(
            context.companyId,
            args.invoice_id,
            context.actorId,
            itemId,
            itemPatch,
            client
        );
    }
    for (const itemId of args.item_ids_remove || []) {
        await invoicesService.removeItem(
            context.companyId,
            args.invoice_id,
            context.actorId,
            itemId,
            client
        );
    }
    return invoicesService.getInvoice(context.companyId, args.invoice_id, client);
}

async function convertEstimateToInvoice(context, args, client) {
    let converted;
    try {
        converted = await estimatesService.convertToInvoice(
            context.companyId,
            context.actorId,
            args.estimate_id,
            client
        );
    } catch (err) {
        if (err?.name === 'EstimatesServiceError') {
            throw new CrmServiceError(
                err.code || 'ESTIMATE_CONVERSION_FAILED',
                err.message,
                err.httpStatus || 400
            );
        }
        throw err;
    }

    // Reuse the exact company-scoped svc.get_invoice query and sanitizer so
    // conversion never exposes a broader Invoice shape than the read tool.
    const invoice = await chatgptMcpQueries.getInvoice(
        context.companyId,
        converted.id,
        client
    );
    if (!invoice) notFound('Invoice');
    return {
        ...safeResult(invoice),
        already_converted: converted.already_converted === true,
    };
}

const DOCUMENT_SEND_CONFIG = Object.freeze({
    estimate: Object.freeze({
        table: 'estimates',
        idField: 'estimate_id',
        service: estimatesService,
        serviceMethod: 'sendEstimate',
    }),
    invoice: Object.freeze({
        table: 'invoices',
        idField: 'invoice_id',
        service: invoicesService,
        serviceMethod: 'sendInvoice',
    }),
});

/**
 * Resolve an outbound document recipient only from the document's owned Contact.
 * No caller-supplied address participates. The document and Contact are both
 * share-locked in the executor transaction, and the contact-email subquery
 * repeats company ownership before selecting the primary address.
 */
async function resolveDocumentRecipient(context, documentType, documentId, channel, client) {
    const config = DOCUMENT_SEND_CONFIG[documentType];
    const document = await client.query(
        `SELECT id, contact_id
         FROM ${config.table}
         WHERE id = $1 AND company_id = $2
         FOR SHARE`,
        [documentId, context.companyId]
    );
    if (document.rows.length !== 1) notFound(
        documentType === 'estimate' ? 'Estimate' : 'Invoice'
    );
    if (!document.rows[0].contact_id) {
        throw new ChatgptMcpWriteError(
            'NO_RECIPIENT',
            `The ${documentType} has no linked Contact recipient.`,
            422
        );
    }

    const contact = await client.query(
        `SELECT c.id,
                NULLIF(BTRIM(c.phone_e164), '') AS primary_phone,
                COALESCE(
                    (
                        SELECT NULLIF(BTRIM(ce.email), '')
                        FROM contact_emails ce
                        JOIN contacts ce_contact
                          ON ce_contact.id = ce.contact_id
                         AND ce_contact.company_id = $2
                        WHERE ce.contact_id = c.id
                          AND ce_contact.company_id = c.company_id
                          AND ce.is_primary = true
                          AND NULLIF(BTRIM(ce.email), '') IS NOT NULL
                        ORDER BY ce.is_primary DESC, ce.created_at ASC, ce.id ASC
                        LIMIT 1
                    ),
                    NULLIF(BTRIM(c.email), '')
                ) AS primary_email
         FROM contacts c
         WHERE c.id = $1 AND c.company_id = $2
         FOR SHARE`,
        [document.rows[0].contact_id, context.companyId]
    );
    const recipient = channel === 'email'
        ? contact.rows[0]?.primary_email
        : contact.rows[0]?.primary_phone;
    if (!recipient) {
        throw new ChatgptMcpWriteError(
            'NO_RECIPIENT',
            `The linked Contact has no ${channel === 'email' ? 'email address' : 'phone number'}.`,
            422
        );
    }
    return recipient;
}

function normalizeDocumentSendError(err) {
    if (err?.name === 'EstimatesServiceError' || err?.name === 'InvoicesServiceError') {
        return new CrmServiceError(
            err.code || 'DOCUMENT_SEND_FAILED',
            err.message,
            err.httpStatus || 400
        );
    }
    return err;
}

async function sendDocument(context, args, client, documentType) {
    const config = DOCUMENT_SEND_CONFIG[documentType];
    const documentId = args[config.idField];
    const recipient = await resolveDocumentRecipient(
        context,
        documentType,
        documentId,
        args.channel,
        client
    );
    let sent;
    try {
        sent = await config.service[config.serviceMethod](
            context.companyId,
            context.actorId,
            documentId,
            {
                channel: args.channel,
                recipient,
                message: args.message,
                ...(documentType === 'invoice'
                    ? { includePaymentLink: args.include_payment_link !== false }
                    : {}),
                userEmail: context.actorEmail,
                noteActor: {
                    id: context.actorId,
                    name: 'ChatGPT AI Dispatcher',
                },
            },
            client
        );
    } catch (err) {
        throw normalizeDocumentSendError(err);
    }
    return {
        sent: true,
        [config.idField]: sent?.id ?? documentId,
        status: sent?.status || 'sent',
        channel: args.channel,
        recipient_source: 'linked_contact',
        ...(documentType === 'invoice'
            ? { include_payment_link: args.include_payment_link !== false }
            : {}),
    };
}

async function sendEstimate(context, args, client) {
    return sendDocument(context, args, client, 'estimate');
}

async function sendInvoice(context, args, client) {
    return sendDocument(context, args, client, 'invoice');
}

const HANDLERS = Object.freeze({
    createLead,
    updateLead,
    transitionLead,
    createJob,
    updateJob,
    transitionJob,
    addNote,
    createEstimate,
    updateEstimate,
    createInvoice,
    updateInvoice,
    convertEstimateToInvoice,
    sendEstimate,
    sendInvoice,
});
const IDEMPOTENT_HANDLERS = new Set([
    'createLead',
    'createJob',
    'createEstimate',
    'createInvoice',
    'convertEstimateToInvoice',
    'sendEstimate',
    'sendInvoice',
]);

async function execute(handler, toolName, context, args, client) {
    requireContext(context, client);
    const operation = HANDLERS[handler];
    if (!operation) {
        throw new ChatgptMcpWriteError('UNSUPPORTED_TOOL', 'Unsupported write handler.', 404);
    }
    if (!IDEMPOTENT_HANDLERS.has(handler)) return operation(context, args, client);

    const claim = await claimCreate(context, toolName, args, client);
    if (claim.replay !== null) {
        return handler === 'convertEstimateToInvoice'
            ? { ...claim.replay, already_converted: true }
            : claim.replay;
    }
    const result = await operation(context, args, client);
    await completeCreate(claim, result, client);
    return result;
}

module.exports = {
    ChatgptMcpWriteError,
    argumentHash,
    execute,
};
