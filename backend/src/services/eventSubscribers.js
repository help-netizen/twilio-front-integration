/**
 * eventSubscribers.js — wires platform subscribers onto the event bus.
 *
 * Called once at boot (src/server.js). Keeping registration in one module
 * makes the dispatch graph discoverable.
 */

const eventBus = require('./eventBus');
const rulesEngine = require('./rulesEngine');
const notificationDispatcher = require('./notificationDispatcher');

let registered = false;

function registerSubscribers() {
    if (registered) return;
    registered = true;

    // Rules engine reacts to every event (it filters by rule internally).
    eventBus.subscribe('rules-engine', '*', (event) => rulesEngine.onEvent(event));

    // NOTIF-REWORK-001: typed, allowlisted events are resolved to live,
    // record-scoped recipients before either push transport is invoked.
    notificationDispatcher.register(eventBus);

    // APP-DATA-001 Phase F: after the producer transaction commits, project
    // closed-catalog events into the durable per-installation outbox. There is
    // still a documented best-effort gap between commit and this in-process
    // subscriber; once inserted, retries are durable.
    require('./appEventSubscriber').register(eventBus);

    // Billing usage metering: count billable events per company.
    eventBus.subscribe('billing-meter', [
        'call.completed', 'sms.outbound', 'agent_task.succeeded',
    ], async (event) => {
        const billingService = require('./billingService');
        await billingService.recordUsageEvent(event).catch(() => {});
    });

    // AI Repair Advisor (REPAIR-ADVISOR-001): on a human-path job.created, offload a
    // detached, best-effort KB diagnostics run. The handler MUST return immediately —
    // dispatchToSubscribers awaits subscribers sequentially, so awaiting the ~30s RAG
    // round-trip here would stall siblings (rules-engine/billing-meter) for the whole
    // company. Lazy require avoids boot-order cycles (mirrors billing-meter above).
    eventBus.subscribe('kb-diagnostics', 'job.created', (event) => {
        const companyId = event.company_id;
        const jobId = event.payload && event.payload.id;
        if (!jobId || !companyId) return;
        const kbDiagnosticsService = require('./kbDiagnosticsService');
        setImmediate(() => {
            kbDiagnosticsService.runForJob({ jobId, companyId })
                .catch((err) => console.warn('[kb-diagnostics] runForJob failed:', err && err.message));
        });
    });

    // Outbound Lead Caller (OUTBOUND-LEAD-CALL-001): on lead.created, run the
    // eligibility gauntlet and enqueue the first call attempt. Handler returns
    // immediately (setImmediate) — dispatchToSubscribers awaits sequentially.
    eventBus.subscribe('outbound-lead-caller', 'lead.created', (event) => {
        const companyId = event.company_id;
        const leadId = event.payload && event.payload.id;
        if (!leadId || !companyId) return;
        const outboundLeadCallService = require('./outboundLeadCallService');
        setImmediate(() => {
            outboundLeadCallService.onLeadCreated({ leadId, companyId })
                .catch((err) => console.warn('[outbound-lead-caller] onLeadCreated failed:', err && err.message));
        });
    });

    // OUTBOUND-CALL-CANCEL-001: conversationsService emits this ONLY for an
    // inbound customer-authored message, after sms_messages persistence. Keep
    // phone data out of the shared event and reload it through the tenant-owned
    // message/conversation relationship.
    eventBus.subscribe('outbound-call-cancel-on-sms', 'sms.inbound', async (event) => {
        const companyId = event.company_id;
        const messageId = event.payload && event.payload.message_id;
        if (!companyId || !messageId) return;
        const db = require('../db/connection');
        const { rows } = await db.query(
            `SELECT sc.customer_e164
             FROM sms_messages sm
             JOIN sms_conversations sc
               ON sc.id = sm.conversation_id
              AND sc.company_id = sm.company_id
             WHERE sm.company_id = $1
               AND sm.id = $2
               AND sm.direction = 'inbound'
             LIMIT 1`,
            [companyId, messageId]
        );
        const rawPhone = rows[0]?.customer_e164;
        if (!rawPhone) return;
        const cancellationService = require('./outboundCallCancellationService');
        await cancellationService.cancel({
            companyId,
            rawPhone,
            cause: cancellationService.CAUSES.INBOUND_SMS,
        });
    });

    console.log(`[eventBus] ${eventBus._subscribers.length} subscriber(s) registered`);
}

module.exports = { registerSubscribers };
