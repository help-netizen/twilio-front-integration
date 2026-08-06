'use strict';

const { notifyOnTheWay } = require('./jobOnTheWayService');

async function runTransitionOp(op, context) {
    if (!op) return null;
    if (op === 'notify_on_the_way') {
        return notifyOnTheWay({
            job: context.job,
            companyId: context.companyId,
            etaMinutes: context.etaMinutes,
            activityActor: context.activityActor,
            client: context.client,
        });
    }
    throw Object.assign(new Error(`Unsupported FSM operation: ${op}`), {
        code: 'UNSUPPORTED_FSM_OP',
        httpStatus: 400,
        statusCode: 400,
    });
}

module.exports = { runTransitionOp };
