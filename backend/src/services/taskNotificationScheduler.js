'use strict';

const taskNotificationQueries = require('../db/taskNotificationQueries');
const eventBus = require('./eventBus');

function idempotencyKey(candidate, timezone) {
    return `task.${candidate.boundary}:${candidate.company_id}:${candidate.id}:${timezone}:${candidate.local_due_date}`;
}

function createTaskNotificationScheduler(dependencies = {}) {
    const queries = dependencies.queries || taskNotificationQueries;
    const bus = dependencies.eventBus || eventBus;

    async function tick(tickNow = new Date()) {
        const companies = await queries.listActiveCompanyTimezones();
        let emitted = 0;
        for (const company of companies) {
            const timezone = company.timezone || taskNotificationQueries.DEFAULT_TIMEZONE;
            const candidates = await queries.listTaskBoundaryCandidates(
                company.company_id,
                timezone,
                tickNow
            );
            for (const task of candidates) {
                const eventType = `task.${task.boundary}`;
                const event = await bus.emit(company.company_id, eventType, {
                    task_id: task.id,
                    record_refs: [{ type: 'task', id: task.id }],
                }, {
                    actorType: 'system',
                    aggregateType: 'task',
                    aggregateId: task.id,
                    idempotencyKey: idempotencyKey(task, timezone),
                });
                if (event) emitted++;
            }
        }
        return { companies: companies.length, emitted };
    }

    return { tick };
}

const singleton = createTaskNotificationScheduler();

function registerScheduler(registry) {
    registry.register('task-notifications', tickNow => singleton.tick(tickNow));
}

module.exports = {
    createTaskNotificationScheduler,
    idempotencyKey,
    registerScheduler,
    tick: singleton.tick,
};
