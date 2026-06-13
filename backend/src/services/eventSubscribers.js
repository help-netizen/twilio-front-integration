/**
 * eventSubscribers.js — wires platform subscribers onto the event bus.
 *
 * Called once at boot (src/server.js). Keeping registration in one module
 * makes the dispatch graph discoverable.
 */

const eventBus = require('./eventBus');
const rulesEngine = require('./rulesEngine');

let registered = false;

function registerSubscribers() {
    if (registered) return;
    registered = true;

    // Rules engine reacts to every event (it filters by rule internally).
    eventBus.subscribe('rules-engine', '*', (event) => rulesEngine.onEvent(event));

    // Billing usage metering: count billable events per company.
    eventBus.subscribe('billing-meter', [
        'call.completed', 'sms.outbound', 'agent_task.succeeded',
    ], async (event) => {
        const billingService = require('./billingService');
        await billingService.recordUsageEvent(event).catch(() => {});
    });

    console.log(`[eventBus] ${eventBus._subscribers.length} subscriber(s) registered`);
}

module.exports = { registerSubscribers };
