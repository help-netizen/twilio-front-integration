import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthz } from './useAuthz';
import {
    fetchHydratedInvoice,
    fetchInvoiceEvents,
    fetchInvoicePayments,
    updateHydratedInvoice,
    type HydratedInvoice,
    type InvoiceCreateData,
} from '../services/invoicesApi';

const TERMINAL_STATUSES = new Set<HydratedInvoice['status']>(['void', 'refunded']);
const COLLECTION_PERMISSIONS = [
    'payments.collect_online',
    'payments.collect_keyed',
    'payments.collect_terminal',
    'payments.collect_offline',
] as const;

export interface InvoiceCapabilities {
    canView: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canVoid: boolean;
    canSend: boolean;
    canViewPayments: boolean;
    canCollect: boolean;
    canCollectOnline: boolean;
    canCollectKeyed: boolean;
    canCollectTerminal: boolean;
    canCollectOffline: boolean;
    canVoidPayment: boolean;
    canManagePriceBook: boolean;
}

/** Permission keys are the source of truth; role names never enter this selector. */
export function getInvoiceCapabilities(
    permissions: readonly string[],
    invoice?: Pick<HydratedInvoice, 'status' | 'balance_due'> | null,
): InvoiceCapabilities {
    const granted = new Set(permissions);
    const isTerminal = invoice ? TERMINAL_STATUSES.has(invoice.status) : false;
    const isDraft = invoice?.status === 'draft';
    const hasBalance = invoice ? Number(invoice.balance_due || 0) > 0 : false;
    const canManageInvoice = granted.has('invoices.create');
    const collectionEligible = !!invoice && !isDraft && !isTerminal && hasBalance;
    const canCollectOnline = collectionEligible && granted.has('payments.collect_online');
    const canCollectKeyed = collectionEligible && granted.has('payments.collect_keyed');
    const canCollectTerminal = collectionEligible && granted.has('payments.collect_terminal');
    const canCollectOffline = collectionEligible && granted.has('payments.collect_offline');
    const hasCollectionPermission = COLLECTION_PERMISSIONS.some(key => granted.has(key));
    const canViewPayments = granted.has('invoices.view') && granted.has('payments.view');

    return {
        canView: granted.has('invoices.view'),
        canEdit: canManageInvoice && !!invoice && !isTerminal,
        canDelete: canManageInvoice && !!invoice && isDraft,
        canVoid: canManageInvoice && !!invoice && !isDraft && !isTerminal,
        canSend: granted.has('invoices.send') && !!invoice && !isTerminal,
        canViewPayments,
        canCollect: hasCollectionPermission && collectionEligible,
        canCollectOnline,
        canCollectKeyed,
        canCollectTerminal,
        canCollectOffline,
        canVoidPayment: canViewPayments && granted.has('payments.collect_offline'),
        canManagePriceBook: granted.has('price_book.manage'),
    };
}

export function shouldFetchInvoicePayments(
    invoiceId: number | null | undefined,
    includePayments: boolean,
    permissions: readonly string[],
): boolean {
    return !!invoiceId
        && includePayments
        && permissions.includes('invoices.view')
        && permissions.includes('payments.view');
}

export interface UseInvoiceOptions {
    enabled?: boolean;
    includeEvents?: boolean;
    includePayments?: boolean;
}

/**
 * Single hydrated invoice contract for rebuilt editor/detail surfaces. Payment
 * history is `null` when unauthorized so the UI cannot mislabel a 403 as empty.
 */
export function useInvoice(invoiceId: number | null, options: UseInvoiceOptions = {}) {
    const {
        enabled = true,
        includeEvents = true,
        includePayments = true,
    } = options;
    const { permissions = [] } = useAuthz();
    const queryClient = useQueryClient();
    const invoiceKey = ['invoice', invoiceId] as const;
    const canView = permissions.includes('invoices.view');

    const invoiceQuery = useQuery({
        queryKey: invoiceKey,
        queryFn: () => fetchHydratedInvoice(invoiceId as number),
        enabled: enabled && canView && !!invoiceId,
    });
    const capabilities = getInvoiceCapabilities(permissions, invoiceQuery.data);

    const eventsQuery = useQuery({
        queryKey: ['invoice-events', invoiceId],
        queryFn: () => fetchInvoiceEvents(invoiceId as number),
        enabled: enabled && canView && includeEvents && !!invoiceId,
    });
    const paymentFetchAllowed = enabled && shouldFetchInvoicePayments(
        invoiceId,
        includePayments,
        permissions,
    );
    const paymentsQuery = useQuery({
        queryKey: ['invoice-payments', invoiceId],
        queryFn: () => fetchInvoicePayments(invoiceId as number),
        enabled: paymentFetchAllowed,
    });

    const updateMutation = useMutation({
        mutationFn: async (data: Partial<InvoiceCreateData>) => {
            const current = queryClient.getQueryData<HydratedInvoice>(invoiceKey);
            if (!invoiceId || !current) throw new Error('Load the invoice before saving it.');
            return updateHydratedInvoice(current, data);
        },
        onSuccess: invoice => {
            queryClient.setQueryData(invoiceKey, invoice);
        },
    });

    return {
        invoice: invoiceQuery.data ?? null,
        events: eventsQuery.data ?? [],
        payments: capabilities.canViewPayments ? (paymentsQuery.data ?? []) : null,
        capabilities,
        isLoading: invoiceQuery.isLoading,
        isEventsLoading: eventsQuery.isLoading,
        isPaymentsLoading: paymentFetchAllowed && paymentsQuery.isLoading,
        isSaving: updateMutation.isPending,
        error: invoiceQuery.error,
        eventsError: eventsQuery.error,
        paymentsError: capabilities.canViewPayments ? paymentsQuery.error : null,
        save: updateMutation.mutateAsync,
        refresh: () => queryClient.invalidateQueries({ queryKey: invoiceKey }),
    };
}
