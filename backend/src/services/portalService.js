/**
 * Portal Service
 * PF005 Client Portal MVP — Sprint 6
 *
 * Business logic for portal access, sessions, document viewing,
 * estimate acceptance/decline, payments, and profile management.
 */

const portalQueries = require('../db/portalQueries');
const estimatesQueries = require('../db/estimatesQueries');
const invoicesQueries = require('../db/invoicesQueries');
const paymentsQueries = require('../db/paymentsQueries');
const estimatesService = require('./estimatesService');

// =============================================================================
// Error class
// =============================================================================

class PortalServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'PortalServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// =============================================================================
// Auth
// =============================================================================

/**
 * Request portal access for a contact.
 * Creates a token (24h expiry). MVP: returns raw token directly (no email sent).
 */
async function requestAccess(companyId, contactId, {
    scope = 'full',
    documentType = null,
    documentId = null,
    createdBy = null,
} = {}) {
    // Validate contact exists
    const contact = await portalQueries.getContactById(contactId);
    if (!contact) {
        throw new PortalServiceError('CONTACT_NOT_FOUND', 'Contact not found', 404);
    }
    if (contact.company_id !== companyId) {
        throw new PortalServiceError('CONTACT_NOT_FOUND', 'Contact not found in this company', 404);
    }

    const { rawToken, tokenRecord } = await portalQueries.createAccessToken(companyId, contactId, {
        scope,
        documentType,
        documentId,
        expiresInHours: 24,
        createdBy,
    });

    return {
        rawToken,
        expiresAt: tokenRecord.expires_at,
    };
}

/**
 * Verify a magic-link token and create a session.
 */
async function verifyToken(rawToken, ipAddress, userAgent) {
    const token = await portalQueries.findValidToken(rawToken);
    if (!token) {
        throw new PortalServiceError('INVALID_TOKEN', 'Token is invalid or expired', 401);
    }

    const session = await portalQueries.createSession(token.id, token.contact_id, ipAddress, userAgent);

    await portalQueries.logEvent(session.id, token.contact_id, 'session_started', null, null, {
        ip_address: ipAddress,
    });

    return {
        sessionId: session.id,
        contactId: token.contact_id,
        companyId: token.company_id,
        scope: token.scope,
        expiresAt: token.expires_at,
    };
}

/**
 * Get an active session. Touches last_active_at.
 * Throws UNAUTHORIZED if session is invalid/expired.
 */
async function getSession(sessionId) {
    const session = await portalQueries.getSessionById(sessionId);
    if (!session) {
        throw new PortalServiceError('UNAUTHORIZED', 'Session is invalid or expired', 401);
    }

    await portalQueries.touchSession(sessionId);

    return session;
}

// =============================================================================
// Documents
// =============================================================================

/**
 * List documents accessible in this session.
 */
async function getDocuments(sessionId) {
    const session = await getSession(sessionId);

    const documents = await portalQueries.getContactDocuments(
        session.company_id,
        session.contact_id,
        session.scope,
        session.document_type,
        session.document_id
    );

    await portalQueries.logEvent(session.id, session.contact_id, 'documents_viewed');

    return documents;
}

/**
 * Get a specific document with full details (including items).
 * Validates that the token scope allows access.
 */
async function getDocument(sessionId, documentType, documentId) {
    const session = await getSession(sessionId);

    // Validate scope allows access to this document
    if (session.scope !== 'full') {
        if (session.document_type !== documentType || session.document_id !== documentId) {
            throw new PortalServiceError('FORBIDDEN', 'Access to this document is not allowed by your token scope', 403);
        }
    }

    let document;
    if (documentType === 'estimate') {
        const estimate = await estimatesQueries.getEstimateById(session.company_id, documentId);
        if (!estimate || estimate.contact_id !== session.contact_id) {
            throw new PortalServiceError('NOT_FOUND', 'Document not found', 404);
        }
        const items = await estimatesQueries.getEstimateItems(documentId);
        document = { ...estimate, items };
    } else if (documentType === 'invoice') {
        const invoice = await invoicesQueries.getInvoiceById(session.company_id, documentId);
        if (!invoice || invoice.contact_id !== session.contact_id) {
            throw new PortalServiceError('NOT_FOUND', 'Document not found', 404);
        }
        const items = await invoicesQueries.getInvoiceItems(documentId);
        document = { ...invoice, items };
    } else {
        throw new PortalServiceError('VALIDATION', `Invalid document type: ${documentType}`, 400);
    }

    await portalQueries.logEvent(session.id, session.contact_id, 'document_viewed', documentType, documentId);

    return document;
}

// =============================================================================
// Estimate Actions
// =============================================================================

/**
 * Accept (approve) an estimate via the portal.
 * Must be an estimate with status sent or viewed.
 */
async function acceptDocument(sessionId, documentType, documentId) {
    if (documentType !== 'estimate') {
        throw new PortalServiceError('VALIDATION', 'Only estimates can be accepted', 400);
    }

    const session = await getSession(sessionId);

    // Validate scope
    if (session.scope !== 'full') {
        if (session.document_type !== documentType || session.document_id !== documentId) {
            throw new PortalServiceError('FORBIDDEN', 'Access to this document is not allowed by your token scope', 403);
        }
    }

    // Verify the estimate belongs to this contact
    const estimate = await estimatesQueries.getEstimateById(session.company_id, documentId);
    if (!estimate || estimate.contact_id !== session.contact_id) {
        throw new PortalServiceError('NOT_FOUND', 'Estimate not found', 404);
    }

    const updated = await estimatesService.approveEstimate(
        session.company_id,
        documentId,
        'client',
        session.contact_id
    );

    await portalQueries.logEvent(session.id, session.contact_id, 'document_accepted', 'estimate', documentId);

    return updated;
}

/**
 * Decline an estimate via the portal.
 */
async function declineDocument(sessionId, documentType, documentId) {
    if (documentType !== 'estimate') {
        throw new PortalServiceError('VALIDATION', 'Only estimates can be declined', 400);
    }

    const session = await getSession(sessionId);

    // Validate scope
    if (session.scope !== 'full') {
        if (session.document_type !== documentType || session.document_id !== documentId) {
            throw new PortalServiceError('FORBIDDEN', 'Access to this document is not allowed by your token scope', 403);
        }
    }

    // Verify the estimate belongs to this contact
    const estimate = await estimatesQueries.getEstimateById(session.company_id, documentId);
    if (!estimate || estimate.contact_id !== session.contact_id) {
        throw new PortalServiceError('NOT_FOUND', 'Estimate not found', 404);
    }

    const updated = await estimatesService.declineEstimate(
        session.company_id,
        documentId,
        'client',
        session.contact_id
    );

    await portalQueries.logEvent(session.id, session.contact_id, 'document_declined', 'estimate', documentId);

    return updated;
}

// =============================================================================
// Payments
// =============================================================================

/**
 * Submit a payment for an invoice.
 * MVP: payment status is always 'completed'.
 */
async function submitPayment(sessionId, { invoiceId, amount, paymentMethod }) {
    const session = await getSession(sessionId);

    if (!invoiceId) {
        throw new PortalServiceError('VALIDATION', 'invoice_id is required', 400);
    }
    if (!amount || parseFloat(amount) <= 0) {
        throw new PortalServiceError('VALIDATION', 'amount must be greater than 0', 400);
    }
    if (!paymentMethod) {
        throw new PortalServiceError('VALIDATION', 'payment_method is required', 400);
    }

    // Validate scope allows access
    if (session.scope !== 'full') {
        if (session.document_type !== 'invoice' || session.document_id !== invoiceId) {
            throw new PortalServiceError('FORBIDDEN', 'Access to this invoice is not allowed by your token scope', 403);
        }
    }

    // Verify invoice belongs to this contact
    const invoice = await invoicesQueries.getInvoiceById(session.company_id, invoiceId);
    if (!invoice || invoice.contact_id !== session.contact_id) {
        throw new PortalServiceError('NOT_FOUND', 'Invoice not found', 404);
    }

    // Create payment transaction via paymentsQueries
    const tx = await paymentsQueries.createTransaction(session.company_id, {
        contact_id: session.contact_id,
        invoice_id: invoiceId,
        transaction_type: 'payment',
        payment_method: paymentMethod,
        status: 'completed',
        amount: parseFloat(amount),
        memo: 'Portal payment',
        processed_at: new Date().toISOString(),
        recorded_by: null,
    });

    // Update invoice amount_paid
    try {
        await invoicesQueries.recordPayment(invoiceId, session.company_id, parseFloat(amount));
    } catch (err) {
        console.warn(`[PortalService] Could not update invoice ${invoiceId} amount_paid:`, err.message);
    }

    await portalQueries.logEvent(session.id, session.contact_id, 'payment_submitted', 'invoice', invoiceId, {
        amount: parseFloat(amount),
        payment_method: paymentMethod,
        transaction_id: tx.id,
    });

    return tx;
}

/**
 * Get payment history for the contact in this session.
 */
async function getPaymentHistory(sessionId) {
    const session = await getSession(sessionId);

    const history = await portalQueries.getContactPaymentHistory(session.company_id, session.contact_id);

    await portalQueries.logEvent(session.id, session.contact_id, 'payment_history_viewed');

    return history;
}

// =============================================================================
// Bookings
// =============================================================================

/**
 * Get bookings (jobs) for the contact in this session.
 */
async function getBookings(sessionId) {
    const session = await getSession(sessionId);

    const bookings = await portalQueries.getContactBookings(session.company_id, session.contact_id);

    await portalQueries.logEvent(session.id, session.contact_id, 'bookings_viewed');

    return bookings;
}

// =============================================================================
// Profile
// =============================================================================

/**
 * Get contact profile for this session.
 */
async function getProfile(sessionId) {
    const session = await getSession(sessionId);

    const contact = await portalQueries.getContactById(session.contact_id);

    await portalQueries.logEvent(session.id, session.contact_id, 'profile_viewed');

    return contact;
}

/**
 * Update contact basic info.
 */
async function updateProfile(sessionId, { name, email, phone }) {
    const session = await getSession(sessionId);

    const updated = await portalQueries.updateContactProfile(session.contact_id, { name, email, phone });

    await portalQueries.logEvent(session.id, session.contact_id, 'profile_updated', null, null, {
        fields: Object.keys({ name, email, phone }).filter(k => ({ name, email, phone })[k] !== undefined),
    });

    return updated;
}

// =============================================================================
// Portal Link Generation (internal, for CRM users)
// =============================================================================

/**
 * Generate a portal link. Creates a token and returns the full URL.
 */
async function generatePortalLink(companyId, contactId, {
    scope = 'full',
    documentType = null,
    documentId = null,
    createdBy = null,
} = {}) {
    const contact = await portalQueries.getContactById(contactId);
    if (!contact) {
        throw new PortalServiceError('CONTACT_NOT_FOUND', 'Contact not found', 404);
    }
    if (contact.company_id !== companyId) {
        throw new PortalServiceError('CONTACT_NOT_FOUND', 'Contact not found in this company', 404);
    }

    const { rawToken, tokenRecord } = await portalQueries.createAccessToken(companyId, contactId, {
        scope,
        documentType,
        documentId,
        expiresInHours: 24,
        createdBy,
    });

    const baseUrl = process.env.PORTAL_BASE_URL || 'https://portal.example.com';
    const portalUrl = `${baseUrl}/verify?token=${rawToken}`;

    return {
        url: portalUrl,
        token: rawToken,
        expiresAt: tokenRecord.expires_at,
    };
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    PortalServiceError,
    requestAccess,
    verifyToken,
    getSession,
    getDocuments,
    getDocument,
    acceptDocument,
    declineDocument,
    submitPayment,
    getPaymentHistory,
    getBookings,
    getProfile,
    updateProfile,
    generatePortalLink,
};
