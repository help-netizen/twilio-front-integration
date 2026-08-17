'use strict';

// Owner-provided production sample, represented without customer or call data.
// Six calls round to 3 started minutes; 87 round to 2 started minutes.
// At $0.25/minute: $48.00 estimated versus $45.34 actual (106% coverage),
// The per-call split here is synthetic and reproduces the AGGREGATE only: this
// fixture yields 43 below / 50 above, while the real sample at $0.25 splits 32/61.
// The owner chose 0.25 over
// the break-even 0.24 to keep the aggregate above cost; a flat rate still
// under-recovers on individual long calls, which is why this path is a fallback.
module.exports = Object.freeze(Array.from({ length: 93 }, (_unused, index) => {
    const billedMinutes = index < 6 ? '3' : '2';
    const durationSeconds = index < 6 ? '121' : '61';
    const estimatedCost = index < 6 ? '0.75' : '0.50';
    let actualCost;
    if (index < 6) actualCost = '0.80';
    else if (index < 43) actualCost = '0.60';
    else if (index < 92) actualCost = '0.37';
    else actualCost = '0.21';
    return Object.freeze({
        fixtureId: `coverage-${String(index + 1).padStart(2, '0')}`,
        durationSeconds,
        billedMinutes,
        estimatedCost,
        actualCost,
    });
}));
