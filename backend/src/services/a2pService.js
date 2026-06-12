/**
 * A2P 10DLC Service — ALB-107 phase 2 (ISV flow).
 *
 * Registers a tenant subaccount for US A2P messaging:
 *   1. TrustHub secondary customer profile (business identity)
 *   2. A2P messaging trust product
 *   3. Brand registration (Low-Volume Standard by default)
 *   4. Tenant Messaging Service (numbers pooled)
 *   5. US A2P campaign on the messaging service
 *
 * Status flows asynchronously on Twilio's side (brand vetting: minutes-days);
 * `refreshStatus` polls and advances the local state machine.
 *
 * Twilio-published policy SIDs (stable constants from the ISV onboarding docs):
 *   - Secondary Customer Profile policy: RNdfbf3fae0e1107f8aded0e7cead80bf5
 *   - A2P Messaging Profile policy:      RNb0d4771c2c98518d916a3d4cd70a8f8b
 */

const db = require('../db/connection');
const auditService = require('./auditService');
const telephonyTenantService = require('./telephonyTenantService');

const SECONDARY_PROFILE_POLICY = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';
const A2P_PROFILE_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';

const ISV_NOTIFY_EMAIL = () => process.env.A2P_NOTIFICATIONS_EMAIL || 'help@bostonmasters.com';

function webhookBase() {
    return process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
}

async function getRegistration(companyId) {
    const { rows } = await db.query(
        `SELECT * FROM company_a2p_registrations WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

function validateBusinessInfo(b = {}) {
    const required = ['legal_name', 'ein', 'address_street', 'address_city', 'address_state',
        'address_zip', 'website', 'contact_first_name', 'contact_last_name', 'contact_email', 'contact_phone'];
    const missing = required.filter(k => !String(b[k] || '').trim());
    if (missing.length) {
        const err = new Error(`Missing business fields: ${missing.join(', ')}`);
        err.httpStatus = 422; err.code = 'VALIDATION_ERROR';
        throw err;
    }
    if (!/^\d{2}-?\d{7}$/.test(String(b.ein).trim())) {
        const err = new Error('EIN must be 9 digits (XX-XXXXXXX)');
        err.httpStatus = 422; err.code = 'VALIDATION_ERROR';
        throw err;
    }
}

/**
 * Step 1-3: submit business identity, trust products and brand.
 * Idempotent per company — re-running resumes from stored SIDs.
 */
async function startRegistration(companyId, businessInfo, { actorId } = {}) {
    validateBusinessInfo(businessInfo);
    const { client, accountSid, mode } = await telephonyTenantService.getClientForCompany(companyId);
    if (mode !== 'subaccount') {
        const err = new Error('A2P registration runs on tenant subaccounts only');
        err.httpStatus = 409; err.code = 'TELEPHONY_NOT_CONNECTED';
        throw err;
    }

    await db.query(
        `INSERT INTO company_a2p_registrations (company_id, business_info, status)
         VALUES ($1, $2::jsonb, 'not_started')
         ON CONFLICT (company_id) DO UPDATE SET business_info = $2::jsonb, updated_at = now()`,
        [companyId, JSON.stringify(businessInfo)]
    );
    let reg = await getRegistration(companyId);
    const b = businessInfo;

    try {
        // ── 1. Secondary customer profile bundle ────────────────────────────
        let customerProfileSid = reg.trusthub_profile_sid;
        if (!customerProfileSid) {
            const profile = await client.trusthub.v1.customerProfiles.create({
                friendlyName: `${b.legal_name} — Albusto`,
                email: ISV_NOTIFY_EMAIL(),
                policySid: SECONDARY_PROFILE_POLICY,
            });
            customerProfileSid = profile.sid;

            const businessEndUser = await client.trusthub.v1.endUsers.create({
                attributes: {
                    business_name: b.legal_name,
                    business_identity: 'direct_customer',
                    business_type: b.business_type || 'Limited Liability Corporation',
                    business_industry: b.industry || 'PROFESSIONAL_SERVICES',
                    business_registration_identifier: 'EIN',
                    business_registration_number: String(b.ein).replace('-', ''),
                    business_regions_of_operation: 'USA_AND_CANADA',
                    website_url: b.website,
                },
                friendlyName: `${b.legal_name} business info`,
                type: 'customer_profile_business_information',
            });

            const repEndUser = await client.trusthub.v1.endUsers.create({
                attributes: {
                    first_name: b.contact_first_name,
                    last_name: b.contact_last_name,
                    email: b.contact_email,
                    phone_number: b.contact_phone,
                    business_title: b.contact_title || 'Owner',
                    job_position: 'CEO',
                },
                friendlyName: `${b.legal_name} rep`,
                type: 'authorized_representative_1',
            });

            const address = await client.addresses.create({
                customerName: b.legal_name,
                street: b.address_street,
                city: b.address_city,
                region: b.address_state,
                postalCode: b.address_zip,
                isoCountry: 'US',
            });
            const supportingDoc = await client.trusthub.v1.supportingDocuments.create({
                attributes: { address_sids: address.sid },
                friendlyName: `${b.legal_name} address`,
                type: 'customer_profile_address',
            });

            for (const objectSid of [businessEndUser.sid, repEndUser.sid, supportingDoc.sid]) {
                await client.trusthub.v1.customerProfiles(customerProfileSid)
                    .customerProfilesEntityAssignments.create({ objectSid });
            }
            await client.trusthub.v1.customerProfiles(customerProfileSid)
                .customerProfilesEvaluations.create({ policySid: SECONDARY_PROFILE_POLICY });
            await client.trusthub.v1.customerProfiles(customerProfileSid)
                .update({ status: 'pending-review' });
        }

        // ── 2. A2P messaging trust product ──────────────────────────────────
        let a2pProfileSid = reg.a2p_profile_sid;
        if (!a2pProfileSid) {
            const trustProduct = await client.trusthub.v1.trustProducts.create({
                friendlyName: `${b.legal_name} — A2P`,
                email: ISV_NOTIFY_EMAIL(),
                policySid: A2P_PROFILE_POLICY,
            });
            a2pProfileSid = trustProduct.sid;

            const a2pEndUser = await client.trusthub.v1.endUsers.create({
                attributes: { company_type: b.company_type || 'private' },
                friendlyName: `${b.legal_name} a2p info`,
                type: 'us_a2p_messaging_profile_information',
            });
            await client.trusthub.v1.trustProducts(a2pProfileSid)
                .trustProductsEntityAssignments.create({ objectSid: a2pEndUser.sid });
            await client.trusthub.v1.trustProducts(a2pProfileSid)
                .trustProductsEntityAssignments.create({ objectSid: customerProfileSid });
            await client.trusthub.v1.trustProducts(a2pProfileSid)
                .trustProductsEvaluations.create({ policySid: A2P_PROFILE_POLICY });
            await client.trusthub.v1.trustProducts(a2pProfileSid)
                .update({ status: 'pending-review' });
        }

        // ── 3. Brand registration (Low-Volume Standard: no manual vetting) ──
        let brandSid = reg.brand_sid;
        let brandStatus = reg.brand_status;
        if (!brandSid) {
            const brand = await client.messaging.v1.brandRegistrations.create({
                customerProfileBundleSid: customerProfileSid,
                a2PProfileBundleSid: a2pProfileSid,
                skipAutomaticSecVet: true, // low-volume standard
            });
            brandSid = brand.sid;
            brandStatus = brand.status;
        }

        await db.query(
            `UPDATE company_a2p_registrations SET
                trusthub_profile_sid = $2, a2p_profile_sid = $3,
                brand_sid = $4, brand_status = $5,
                status = 'brand_pending', last_error = NULL,
                submitted_at = COALESCE(submitted_at, now()), updated_at = now()
             WHERE company_id = $1`,
            [companyId, customerProfileSid, a2pProfileSid, brandSid, brandStatus]
        );

        auditService.log({
            actor_id: actorId, action: 'telephony.a2p_submitted',
            target_type: 'company', target_id: companyId, company_id: companyId,
            details: { brand_sid: brandSid, account_sid: accountSid },
        }).catch(() => {});

        return getRegistration(companyId);
    } catch (err) {
        await db.query(
            `UPDATE company_a2p_registrations SET last_error = $2, updated_at = now() WHERE company_id = $1`,
            [companyId, `${err.code || ''} ${err.message}`.trim().slice(0, 500)]
        );
        throw err;
    }
}

/** Ensure the tenant Messaging Service exists and pools all tenant numbers. */
async function ensureMessagingService(companyId) {
    const { client } = await telephonyTenantService.getClientForCompany(companyId);
    const reg = await getRegistration(companyId);
    let mgSid = reg?.messaging_service_sid;

    if (!mgSid) {
        const service = await client.messaging.v1.services.create({
            friendlyName: 'Albusto Messaging',
            inboundRequestUrl: `${webhookBase()}/webhooks/twilio/conversations/post`,
            inboundMethod: 'POST',
            usecase: 'mixed',
        });
        mgSid = service.sid;
        await db.query(
            `UPDATE company_a2p_registrations SET messaging_service_sid = $2, updated_at = now() WHERE company_id = $1`,
            [companyId, mgSid]
        );
        await db.query(
            `UPDATE company_telephony SET messaging_service_sid = $2, updated_at = now() WHERE company_id = $1`,
            [companyId, mgSid]
        );
    }

    // Pool every tenant number into the service (idempotent: 409s ignored)
    const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });
    for (const n of numbers) {
        try {
            await client.messaging.v1.services(mgSid).phoneNumbers.create({ phoneNumberSid: n.sid });
        } catch (err) {
            if (err.status !== 409 && err.code !== 21712) {
                console.warn(`[A2P] pool number ${n.phoneNumber} failed:`, err.message);
            }
        }
    }
    return mgSid;
}

/** Step 4-5: create the US A2P campaign once the brand is approved. */
async function createCampaign(companyId, campaign = {}, { actorId } = {}) {
    const reg = await getRegistration(companyId);
    if (!reg?.brand_sid) {
        const err = new Error('Submit business registration first'); err.httpStatus = 409; throw err;
    }
    const { client } = await telephonyTenantService.getClientForCompany(companyId);
    const mgSid = await ensureMessagingService(companyId);

    const usecase = campaign.usecase || 'MIXED';
    const created = await client.messaging.v1.services(mgSid).usAppToPerson.create({
        brandRegistrationSid: reg.brand_sid,
        description: campaign.description
            || 'Field service customer notifications: appointment confirmations, technician updates and replies to customer-initiated conversations.',
        messageFlow: campaign.message_flow
            || 'Customers opt in verbally or via the booking form when scheduling service; every SMS includes opt-out instructions (reply STOP).',
        messageSamples: campaign.message_samples?.length ? campaign.message_samples : [
            'Hi {{name}}, this is a confirmation of your appliance repair appointment on {{date}} between {{window}}. Reply STOP to opt out.',
            'Your technician {{tech}} is on the way and will arrive in about {{eta}} minutes.',
        ],
        usAppToPersonUsecase: usecase,
        hasEmbeddedLinks: campaign.has_links ?? true,
        hasEmbeddedPhone: campaign.has_phone ?? true,
        subscriberOptIn: true,
        optInMessage: campaign.opt_in_message
            || 'You are now subscribed to service updates from {{company}}. Reply STOP to unsubscribe, HELP for help.',
        optInKeywords: ['START'],
        optOutKeywords: ['STOP'],
        helpKeywords: ['HELP'],
    });

    await db.query(
        `UPDATE company_a2p_registrations SET
            campaign_sid = $2, campaign_status = $3, status = 'campaign_pending', updated_at = now()
         WHERE company_id = $1`,
        [companyId, created.sid, created.campaignStatus || 'PENDING']
    );

    auditService.log({
        actor_id: actorId, action: 'telephony.a2p_campaign_submitted',
        target_type: 'company', target_id: companyId, company_id: companyId,
        details: { campaign_sid: created.sid, messaging_service_sid: mgSid, usecase },
    }).catch(() => {});

    return getRegistration(companyId);
}

/** Poll Twilio for brand/campaign status and advance the state machine. */
async function refreshStatus(companyId) {
    const reg = await getRegistration(companyId);
    if (!reg || reg.status === 'not_started') return reg;
    const { client } = await telephonyTenantService.getClientForCompany(companyId);

    let { brand_status, campaign_status, status } = reg;

    if (reg.brand_sid) {
        try {
            const brand = await client.messaging.v1.brandRegistrations(reg.brand_sid).fetch();
            brand_status = brand.status; // PENDING | APPROVED | FAILED
            if (brand_status === 'FAILED') status = 'brand_failed';
            else if (brand_status === 'APPROVED' && !reg.campaign_sid) status = 'brand_pending';
        } catch (err) { console.warn('[A2P] brand fetch failed:', err.message); }
    }
    if (reg.campaign_sid && reg.messaging_service_sid) {
        try {
            const c = await client.messaging.v1.services(reg.messaging_service_sid)
                .usAppToPerson(reg.campaign_sid).fetch();
            campaign_status = c.campaignStatus; // IN_PROGRESS | VERIFIED | FAILED
            if (campaign_status === 'VERIFIED') status = 'approved';
            else if (campaign_status === 'FAILED') status = 'campaign_failed';
        } catch (err) { console.warn('[A2P] campaign fetch failed:', err.message); }
    }

    await db.query(
        `UPDATE company_a2p_registrations SET
            brand_status = $2, campaign_status = $3, status = $4,
            approved_at = CASE WHEN $4 = 'approved' THEN COALESCE(approved_at, now()) ELSE approved_at END,
            updated_at = now()
         WHERE company_id = $1`,
        [companyId, brand_status, campaign_status, status]
    );
    return getRegistration(companyId);
}

module.exports = {
    getRegistration,
    startRegistration,
    ensureMessagingService,
    createCampaign,
    refreshStatus,
    validateBusinessInfo,
};
