'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { stripTimelineHtml } = require('../../backend/src/services/email/emailTimelineHtml');

const TARGET_BYTES = 169088;
const BATCH_SIZE = 20;
const BATCH_BUDGET_MS = 100;
const fixture = fs.readFileSync(
    path.join(__dirname, '../fixtures/email-79436-outlook-desktop.html'),
    'utf8'
);
const paddingWrapper = '<div data-benchmark-padding=""></div>';
const paddingBytes = TARGET_BYTES
    - Buffer.byteLength(fixture, 'utf8')
    - Buffer.byteLength(paddingWrapper, 'utf8');
if (paddingBytes < 0) throw new Error('Benchmark fixture exceeds target size');

const largeHtml = `${fixture}<div data-benchmark-padding="">${'x'.repeat(paddingBytes)}</div>`;
if (Buffer.byteLength(largeHtml, 'utf8') !== TARGET_BYTES) {
    throw new Error('Benchmark fixture is not exactly 169088 bytes');
}

function percentile(values, fraction) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function measure(iterations, fn) {
    const samples = [];
    for (let index = 0; index < iterations; index++) {
        const started = performance.now();
        fn();
        samples.push(performance.now() - started);
    }
    return {
        median: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        max: Math.max(...samples),
    };
}

// Warm parser/JIT state before collecting numbers.
for (let index = 0; index < 5; index++) stripTimelineHtml(largeHtml);

const single = measure(30, () => {
    const output = stripTimelineHtml(largeHtml);
    if (!output || output.includes('OLDER-THREAD-SENTINEL')) {
        throw new Error('Single-message benchmark produced an invalid strip');
    }
});
const batch = measure(15, () => {
    const output = Array.from({ length: BATCH_SIZE }, () => stripTimelineHtml(largeHtml));
    if (output.some(html => !html || html.includes('OLDER-THREAD-SENTINEL'))) {
        throw new Error('Batch benchmark produced an invalid strip');
    }
});

const report = {
    bytes: TARGET_BYTES,
    single_ms: {
        median: Number(single.median.toFixed(3)),
        p95: Number(single.p95.toFixed(3)),
        max: Number(single.max.toFixed(3)),
    },
    batch_20_ms: {
        median: Number(batch.median.toFixed(3)),
        p95: Number(batch.p95.toFixed(3)),
        max: Number(batch.max.toFixed(3)),
    },
    budget_ms: BATCH_BUDGET_MS,
};
console.log(`EMAIL_TIMELINE_HTML_BENCH ${JSON.stringify(report)}`);

if (batch.p95 >= BATCH_BUDGET_MS) {
    console.error(`20-email p95 ${batch.p95.toFixed(3)}ms exceeds ${BATCH_BUDGET_MS}ms budget`);
    process.exitCode = 1;
}
