import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalJob } from '../../services/jobsApi';
import { JobMobileCard, jobPaymentDisplay } from './JobMobileCard';

function job(overrides: Partial<LocalJob> = {}): LocalJob {
    return {
        id: 7,
        serial_id: 7,
        service_name: 'Refrigerator repair',
        assigned_techs: [],
        amount_paid: null,
        balance_due: null,
        invoice_status: null,
        invoice_total: null,
        ...overrides,
    } as LocalJob;
}

describe('jobPaymentDisplay signed credit', () => {
    it('renders the backend signed rollup as Credit with U+2212 and two decimals', () => {
        const creditJob = job({ amount_paid: '95.00', balance_due: '-95.00' });

        expect(jobPaymentDisplay(creditJob)).toEqual({
            text: 'Credit · −$95.00',
            tone: 'paid',
        });

        const markup = renderToStaticMarkup(
            <JobMobileCard job={creditJob} canViewFinance onClick={vi.fn()} />,
        );
        expect(markup).toContain('Credit · −$95.00');
    });

    it('preserves the no-local-finance Zenbooker fallback', () => {
        expect(jobPaymentDisplay(job({
            balance_due: null,
            invoice_status: 'partial',
            invoice_total: '70.50',
        }))).toEqual({ text: 'Partial · $70.50', tone: 'partial' });
    });

    it('renders a backend ZB paid-only rollup as Paid, never Credit', () => {
        const zbPaidJob = job({ amount_paid: '95.00', balance_due: '0.00' });

        expect(jobPaymentDisplay(zbPaidJob)).toEqual({
            text: 'Paid · $95',
            tone: 'paid',
        });

        const markup = renderToStaticMarkup(
            <JobMobileCard job={zbPaidJob} canViewFinance onClick={vi.fn()} />,
        );
        expect(markup).toContain('Paid · $95');
        expect(markup).not.toContain('Credit');
    });
});
