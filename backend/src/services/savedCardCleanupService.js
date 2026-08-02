'use strict';

const provider = require('./stripeConnectProvider');
const savedCardsQueries = require('../db/stripeSavedCardsQueries');

const BATCH_SIZE = 100;

async function cleanupExpiredSavedCards(companyId) {
    const cards = await savedCardsQueries.listExpiredCards(companyId, BATCH_SIZE);
    let detached = 0;
    let failed = 0;
    for (const card of cards) {
        try {
            await provider.detachPaymentMethod(
                card.stripe_account_id,
                card.stripe_payment_method_id
            );
            await savedCardsQueries.deleteExpiredCard(companyId, card.id);
            detached += 1;
        } catch (error) {
            if (error.stripeCode === 'resource_missing') {
                await savedCardsQueries.deleteExpiredCard(companyId, card.id);
                detached += 1;
                continue;
            }
            // Leave the tenant-owned row intact. The SQL TTL predicates already
            // make it unchargeable, and the next six-hour pass will retry detach.
            failed += 1;
        }
    }
    return { company_id: companyId, scanned: cards.length, detached, failed };
}

async function cleanupAllExpiredSavedCards() {
    const companyIds = await savedCardsQueries.listExpiredCompanyIds(BATCH_SIZE);
    const results = [];
    for (const companyId of companyIds) {
        results.push(await cleanupExpiredSavedCards(companyId));
    }
    return results;
}

module.exports = { cleanupExpiredSavedCards, cleanupAllExpiredSavedCards, BATCH_SIZE };

