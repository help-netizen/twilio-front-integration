const PAYMENT_METHOD_LABELS: Record<string, string> = {
    credit_card: 'Credit Card',
    ach: 'ACH',
    check: 'Check',
    cash: 'Cash',
    other: 'Other',
    zenbooker_sync: 'Zenbooker',
    zb_card: 'Zenbooker · Card',
    zb_check: 'Zenbooker · Check',
    zb_cash: 'Zenbooker · Cash',
    zb_ach: 'Zenbooker · ACH',
    zb_venmo: 'Zenbooker · Venmo',
    zb_zelle: 'Zenbooker · Zelle',
    zb_other: 'Zenbooker · Other',
};

export function paymentMethodLabel(method: string | null | undefined): string {
    const key = String(method || '').trim().toLowerCase();
    if (!key) return 'Other';
    return PAYMENT_METHOD_LABELS[key]
        || key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

