import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

// These are number/currency formatters, not dates. The exact ledger means a new
// unzoned toLocaleString call still fails even while this pre-existing numeric
// surface remains valid.
const NUMBER_LOCALE_LEDGER = [
    "components/analytics/GeoPerformanceHeatmap.tsx:return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);",
    "components/apps/AppSchedule.tsx:return value.toLocaleString('en-US');",
    "components/apps/AppViewBlocks.tsx:: value.toLocaleString('en-US')",
    "components/apps/AppViewBlocks.tsx:? `$${Math.round(value).toLocaleString('en-US')}`",
    "components/apps/AppViewBlocks.tsx:if (type === 'number' && typeof value === 'number') return <>{value.toLocaleString('en-US')}</>;",
    "components/documents/TemplateLivePreview.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/estimates/EstimateDetailPanel.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/estimates/EstimateEditorDialog.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/estimates/ItemPresetSearchCombobox.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/invoices/InvoiceCollectPaymentDialog.tsx:return '$' + value.toLocaleString('en-US', {",
    "components/invoices/InvoiceDetailPanel.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/invoices/InvoiceEditorDialog.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/invoices/InvoiceMobileRow.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/invoices/InvoiceRemoveDialog.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/invoices/InvoiceSendDialog.tsx:const body = Math.abs(amount).toLocaleString('en-US', {",
    "components/jobs/JobMobileCard.tsx:return '$' + n.toLocaleString('en-US', {",
    "components/jobs/jobFinanceMath.ts:const amount = Math.abs(normalized).toLocaleString('en-US', {",
    "components/leads/LeadFinancialsTab.tsx:return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    "components/payments/paymentTypes.ts:return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    "components/pulse/FinancialEventListItem.tsx:return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    "components/super-admin/PlatformStatsTab.tsx:{data.total.toLocaleString()}",
    "components/transactions/RefundDialog.tsx:return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    "pages/AnalyticsPage.tsx:return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1);",
    "pages/AnalyticsPage.tsx:return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;",
    "pages/AnalyticsPage.tsx:return `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;",
    "pages/BillingPage.tsx:<AlertTriangle size={12} />+{overUnits.toLocaleString()}{overCost > 0 ? ` · projected ${usd(overCost)} overage` : ''}",
    "pages/BillingPage.tsx:<span style={{ fontSize: 18, fontWeight: 500, color: over ? 'var(--blanc-danger)' : 'var(--blanc-ink-1)' }}>{used.toLocaleString()}</span>",
    "pages/BillingPage.tsx:return '$' + Number(n).toLocaleString(undefined, cents",
    "pages/BillingPage.tsx:{Number(plan.included_units[m]).toLocaleString()} {METRIC_LABELS[m]?.toLowerCase()}",
    "pages/BillingPage.tsx:{cap > 0 && <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>/ {cap.toLocaleString()}</span>}",
    "pages/EstimatesPage.tsx:return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    "pages/InvoicesPage.tsx:return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    "pages/TelephonyTwilioSettingsPage.tsx:if (mins > 0) out.push(`${mins.toLocaleString()} call minutes included`);",
    "pages/TelephonyTwilioSettingsPage.tsx:if (sms > 0) out.push(`${sms.toLocaleString()} text messages included`);",
    "pages/TelephonyTwilioSettingsPage.tsx:return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });",
    "pages/TransactionsPage.tsx:return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
].sort();

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) out.push(full);
    }
    return out;
}

function callEnd(source: string, openParen: number): number {
    let depth = 1;
    let quote = '';
    let escaped = false;
    for (let i = openParen + 1; i < source.length; i += 1) {
        const char = source[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === "'" || char === '"' || char === '`') quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) return i + 1;
    }
    return source.length;
}

function collectUnzonedCalls() {
    const dateCalls: string[] = [];
    const numericCalls: string[] = [];
    for (const file of walk(SRC)) {
        const source = readFileSync(file, 'utf8');
        const pattern = /\.toLocale(Date|Time)?String\s*\(/g;
        for (const match of source.matchAll(pattern)) {
            const start = match.index;
            const end = callEnd(source, start + match[0].lastIndexOf('('));
            const call = source.slice(start, end);
            if (/\btimeZone\s*:/.test(call)) continue;
            const lineStart = source.lastIndexOf('\n', start) + 1;
            const lineEnd = source.indexOf('\n', start);
            const id = `${relative(SRC, file)}:${source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim()}`;
            if (match[1]) dateCalls.push(id);
            else numericCalls.push(id);
        }
    }
    return { dateCalls: dateCalls.sort(), numericCalls: numericCalls.sort() };
}

describe('EMAIL-OCCURRED-AT-001 company-time ratchet', () => {
    const calls = collectUnzonedCalls();

    it('forbids date/time locale formatting without an explicit timezone', () => {
        expect(calls.dateCalls).toEqual([]);
    });

    it('allows only the ledgered numeric toLocaleString calls', () => {
        expect(calls.numericCalls).toEqual(NUMBER_LOCALE_LEDGER);
    });
});
