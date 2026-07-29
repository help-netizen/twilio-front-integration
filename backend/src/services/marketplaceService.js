const db = require('../db/connection');
const marketplaceQueries = require('../db/marketplaceQueries');
const emailQueries = require('../db/emailQueries');
const integrationsService = require('./integrationsService');
const provisioningService = require('./marketplaceProvisioningService');
const emailMailboxService = require('./emailMailboxService');
const telephonyTenantService = require('./telephonyTenantService');
const stripePaymentsQueries = require('../db/stripePaymentsQueries');
const territoryRadiusQueries = require('../db/territoryRadiusQueries');
const rateMeQueries = require('../db/rateMeQueries');
const { RELY_UNIT_TYPES, RELY_BRANDS } = require('./relyLeadsCatalog');
const { parseZipList, resolveRelySettings } = require('./relyLeadFilterService');
const outboundCallSettingsService = require('./outboundCallSettingsService');
const inspectorSettingsService = require('./inspectorSettingsService');
const chatgptMcpIdentityService = require('./chatgptMcpIdentityService');
const {
    DEFAULT_INSTRUCTION,
    MAX_INSTRUCTION_CHARS,
    effectiveInstruction,
} = require('./aiEstimateService');
const googleAdsConnectionService = require('./googleAdsConnectionService');
const DEFAULT_REPORT_INSTRUCTION = `APPLIANCE TECHNICIAN REPORT AND ESTIMATE INSTRUCTIONS
Use the information I provide to prepare a complete professional appliance technician report and repair estimate.
General Rules

1. Write the entire report in English.
2. Do not ask unnecessary follow-up questions. If information is missing, write "Not provided" or "Unable to determine."
3. Do not invent test results, damage, prices, part numbers, warranties, delivery times, or service fees.
4. Correct grammar and translate any Russian notes into professional technical English.
5. Clearly explain:
   * What the customer reported
   * What the technician found
   * What must be replaced or serviced
   * What caused the malfunction
6. Use the exact labor and parts prices provided.
7. Calculate all subtotals and the Grand Total accurately to the cent.
8. Do not round totals unless specifically requested.
9. Do not add taxes, delivery charges, markup, refrigerant, supplies, or additional parts unless they were provided.
10. Do not add a service call fee statement unless the service call fee was specifically provided.
11. Do not mention a warranty unless warranty terms were specifically provided.
12. Do not claim that a part is OEM unless the supplied information confirms it.
13. Do not add offers, SMS versions, CSV suggestions, follow-up questions, or commentary after the report.

Appliance Age
Use the brand, model, and serial number to determine the manufacturing date and appliance age only when the date code can be interpreted reliably.
Priority:

1. Use the manufacturing date or age provided by the technician.
2. Otherwise, determine the age from the brand, model, and serial number when reliable.
3. If the date cannot be verified, write:

Age
Unable to determine reliably from the information provided.
Never guess the manufacturing year.
STANDARD REPORT FORMAT
Technician Report
Make
[Brand]
Appliance Type
[Refrigerator, Dishwasher, Washer, Dryer, Range, Ice Machine, Commercial Refrigerator, etc.]
Model
[Model number]
Serial
[Serial number]
Manufactured
[Month and year, when known]
Age
[Approximate age]
Failure Issue:
Write a clear description of the customer's complaint in one or two sentences.
Examples:

* Refrigerator is not cooling properly.
* Dishwasher does not circulate water during the wash cycle.
* Dryer does not heat.
* Oven displays an error code and does not ignite.

Findings:
Write a detailed professional diagnosis in two to five paragraphs when necessary.
Include:

* The failed component
* The actual condition found
* Relevant diagnostic results
* Whether related components were tested and found operational
* How the failure affects appliance operation
* Any visible corrosion, contamination, overheating, leakage, obstruction, physical damage, or previous improper repair
* Multiple separate issues when applicable

Do not state that components were tested unless the technician provided that information or it logically follows from the supplied diagnostic notes.
Needs:
List the repair work required.
Example:

* Replace circulation pump
* Replace damaged wiring
* Perform internal cleaning and maintenance
* Verify proper water circulation
* Test the complete wash cycle after repair

Part numbers should normally be listed only in the estimate breakdown and "Parts to Order" section, not in the Needs section.
Cause:
Explain the actual or most reasonably supported cause of the malfunction.
Examples:

* Internal electrical failure of the control board
* Mechanical wear of the motor bearings
* Restricted airflow caused by lint accumulation
* Refrigerant loss caused by a sealed-system leak
* Excessive ice buildup caused by a defrost control failure
* Corrosion caused by age, moisture, and prolonged use
* Physical damage caused by improper installation
* Overloading that placed excessive stress on the drive system

Do not present an uncertain cause as confirmed. Use wording such as "likely caused by" or "consistent with" when the cause is not fully confirmed.
STANDARD ESTIMATE FORMAT
Estimate
Use a detailed opening sentence that explains exactly what the customer receives and why the work is needed.
Do not put part numbers in this opening paragraph.
Example:
The total cost for your dishwasher repair, which includes replacement of the failed circulation pump, restoration of proper water flow through the spray arms, installation of the required components, and complete operational testing, is estimated at $366.45.
The opening sentence should describe:

* The principal component replacement
* Related maintenance or cleaning
* Restoration of the failed function
* Final testing and verification

Breakdown
Materials:
• $[price] – [Part name] ([part number])
• $[price] – [Part name] ([part number])
Materials Total: $[total]
Labor:
• $[price] – [Detailed description of labor]
Labor Total: $[total]
Include this line when there is more than one labor item.
Grand Total:
$[exact total]
Parts to Order

* [Part name] — [part number]
* [Part name] — [part number]

Do not include part numbers in the Failure Issue, estimate opening sentence, or customer-facing repair summary. Keep them in the Materials breakdown and Parts to Order section.
PREMIUM ESTIMATE DESCRIPTION
For expensive, luxury, commercial, or complicated repairs, use a more detailed opening sentence.
Example:
The total cost for your dishwasher repair, which includes replacement of the failed electronic control assembly, professional disassembly and reassembly of the appliance, restoration of proper heating and circulation performance, cleaning and maintenance of the internal wash system, and complete functional testing after installation, is estimated at $1,409.01.
COMPRESSOR AND SEALED-SYSTEM REPAIR FORMAT
Use this format when the repair includes a compressor, refrigerant leak, filter drier, TXV, evaporator, capillary tube, brazing, evacuation, or refrigerant recharge.
Technician Report
Failure Issue:
Refrigerator is not cooling properly.
Findings:
Explain the actual sealed-system condition, such as:

* Compressor does not start
* Compressor runs but does not create suction or discharge pressure
* Compressor is internally shorted
* Compressor overheats and shuts down
* Evaporator remains warm and dry
* Refrigerant pressure is low
* Refrigerant leak is present
* Filter drier or TXV is restricted
* Moisture or contamination is present in the sealed system

State which other components were confirmed operational only when that information was provided.
Needs:
Depending on the repair, include:

* Replace compressor
* Replace filter drier
* Replace TXV or capillary tube
* Repair refrigerant leak
* Perform brazing or welding
* Flush sealed system
* Pressure test with nitrogen
* Evacuate system to a deep vacuum
* Recharge with the correct refrigerant
* Verify operating pressures and cooling performance

Cause:
Examples:

* Internal mechanical compressor failure
* Electrical short inside the compressor
* Refrigerant loss caused by a sealed-system leak
* Restricted refrigerant flow caused by a clogged filter drier or TXV
* Compressor overheating caused by restricted condenser airflow
* Moisture contamination inside the sealed system

Sealed-System Estimate
The total cost for your refrigerator repair, which includes compressor replacement and full sealed-system service, is estimated at $[total].
Here's the breakdown of the total cost:
Materials:
• $[price] – Compressor ([part number])
• $[price] – Filter Drier ([part number])
• $[price] – Refrigerant
• $[price] – Nitrogen, brazing materials, and sealed-system supplies
Materials Total: $[total]
Labor:
• $[price] – Compressor and filter drier replacement, including removal, installation, and brazing
• $[price] – Sealed-system service, including pressure testing, evacuation, vacuum, refrigerant recharge, and operational testing
Labor Total: $[total]
Grand Total:
$[exact total]
Only include materials that were actually provided. Do not invent refrigerant or supply costs.
MULTIPLE REPAIR OPTIONS
When there are two repair choices, separate them clearly.
Example:
Option 1 – Maintenance Only
Explain what will be cleaned or serviced.
Clearly state:

* Whether the repair is temporary
* Whether no warranty is provided
* Whether long-term operation is not guaranteed

Total Cost:
$[amount]
Option 2 – Recommended Component Replacement
Provide the full materials and labor breakdown.
Grand Total:
$[amount]
Include a short recommendation explaining which option is the more reliable repair.
MULTIPLE SEPARATE ISSUES
When the appliance has two unrelated problems, create separate sections:
Failure Issue #1
Findings
Needs
Cause
Failure Issue #2
Findings
Needs
Cause
Then provide either:

* Estimate #1 and Estimate #2 with a Combined Grand Total, or
* One combined estimate when the customer provided only one total.

Do not mix unrelated repairs into one unclear labor description.
OPTIONAL MAINTENANCE
Optional services must be shown separately and must not be included in the primary repair total unless the customer requests a combined total.
Example:
Optional Preventive Maintenance
Service Includes:

* Condenser coil cleaning
* Internal lint removal
* Drain system cleaning
* Descaling and sanitizing
* Airflow inspection
* Operational testing

Additional Cost:
$210.00
Total With Optional Maintenance:
$[combined total]
COMPLETED SERVICE / NO PARTS REQUIRED
When the problem was fixed during the visit:
Service Outcome
Explain what was found, what was corrected, and confirm that the unit was tested.
Example:
Inspection found that the drain hose was incorrectly positioned, restricting water flow. The hose was repositioned and secured during the visit. The dishwasher was tested and is now draining properly.
Service Performed:

* Corrected drain hose alignment
* Tested drain operation
* Verified normal operation

Total Due:
$[labor/service amount]
Do not list parts when none are required.
EXTERNAL PROBLEM / APPLIANCE OPERATING CORRECTLY
When the appliance is not defective:
Clearly state that no appliance malfunction was found.
Examples:

* Insufficient voltage from the wall outlet
* Low household water pressure
* Faulty external shutoff valve
* Restricted building drain
* Improper vent installation

Recommend the correct licensed professional, such as:

* Licensed electrician
* Licensed plumber
* HVAC contractor

Do not create an appliance repair estimate unless repair work was performed.
NO-WARRANTY REPAIR
When the manufacturer-required repair cannot be fully completed:
Include a prominent notice:
Important Notice:
This repair is provided without warranty because the complete manufacturer-recommended repair cannot be performed. The unavailable or discontinued component may allow the original condition to return.
Repeat this at the end:
Warranty: No warranty is provided for this repair.
DISCOUNTS
Show discounts after the subtotal.
Example:
Subtotal: $703.47
Customer Discount (10%): –$70.35
Grand Total:
$633.12
Calculate percentage discounts to the nearest cent.
Do not apply a discount unless specifically requested.
FINAL CALCULATION CHECK
Before producing the report:

1. Add all part prices.
2. Add all labor items.
3. Subtract any stated discount.
4. Confirm the opening estimate total matches the Grand Total.
5. Confirm all cents are preserved.
6. Confirm quantities are included when more than one identical part is required.
7. Confirm no part number or price was accidentally changed.
8. Confirm optional services are not included in the main total unless requested.
9. Confirm the report does not contain conflicting totals.
10. Confirm the report contains no invented details.`;

class MarketplaceServiceError extends Error {
    constructor(message, code, httpStatus = 400) {
        super(message);
        this.name = 'MarketplaceServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// SLOT-ENGINE-001 Phase 2: app_key gate for the Smart Slot Engine integration.
const SMART_SLOT_ENGINE_APP_KEY = 'smart-slot-engine';

// REPAIR-ADVISOR-001: app_key gate for the AI Repair Advisor integration.
// Gate-only (provisioning_mode='none', seed 161) — like smart-slot-engine it
// resolves through the GENERIC marketplace_installations status='connected' path;
// NO isAppConnected special-case (only google-email/telephony-twilio are special).
const AI_REPAIR_ADVISOR_APP_KEY = 'ai-repair-advisor';
const REPORT_TO_ESTIMATE_APP_KEY = 'report-to-estimate';
const CHATGPT_CRM_MCP_APP_KEY = 'chatgpt-crm-mcp';

async function requireChatgptTenantAdmin(companyId, actorId, client) {
    try {
        return await chatgptMcpIdentityService.requireTenantAdmin(companyId, actorId, client);
    } catch (err) {
        if (err instanceof chatgptMcpIdentityService.ChatgptMcpIdentityError) {
            throw new MarketplaceServiceError(err.message, err.code, err.httpStatus);
        }
        throw err;
    }
}

// SEND-DOC-001 §4.3: the Google Email marketplace app (seeded with
// provisioning_mode='none' and NO install row) derives its connected state from
// the REAL Gmail mailbox, not a marketplace_installations row. Special-cased in
// listApps + isAppConnected; all other apps are untouched.
const GOOGLE_EMAIL_APP_KEY = 'google-email';
const GOOGLE_ADS_APP_KEY = 'google-ads';

const SETTINGS_ENABLED_APP_KEYS = new Set([
    'rely-leads',
    'rate-me',
    'outbound-parts-caller',
    'inspector',
    'chatgpt-crm-mcp',
]);
const RATE_ME_PUBLIC_HOST = String(
    process.env.RATE_ME_PUBLIC_HOST || 'rate.albusto.com'
).trim().toLowerCase().replace(/\.+$/, '');

/**
 * Mailbox-derived connected boolean for the Google Email app.
 * Connected ⇔ a Gmail mailbox exists AND its status is 'connected'. Any other
 * status (reconnect_required / sync_error / disconnected) or no mailbox ⇒ false.
 */
async function isGoogleEmailMailboxConnected(companyId) {
    const mailbox = await emailMailboxService.getMailboxStatus(companyId);
    return Boolean(mailbox) && mailbox.provider === 'gmail' && mailbox.status === 'connected';
}

/**
 * Build the SYNTHETIC installation overlay for the Google Email app from the real
 * mailbox. No marketplace_installations row is created or read. Mirrors the
 * installation shape the app-list path returns for other apps (mapAppRow) so the
 * frontend needs no special handling, plus exposes external_installation_id (the
 * connected email) per SEND-DOC-001. Returns null when no mailbox exists.
 */
async function buildGoogleEmailInstallationOverlay(companyId) {
    const mailbox = await emailMailboxService.getMailboxStatus(companyId);
    if (!mailbox) return null;
    const connected = mailbox.provider === 'gmail' && mailbox.status === 'connected';
    return {
        id: null,
        status: connected ? 'connected' : 'disconnected',
        installed_at: connected ? mailbox.created_at || null : null,
        disconnected_at: null,
        provisioning_error: null,
        last_used_at: connected ? mailbox.last_synced_at || null : null,
        external_installation_id: connected ? mailbox.email_address || null : null,
    };
}

async function buildGoogleAdsInstallationOverlay(companyId) {
    const connection = await googleAdsConnectionService
        .getMarketplaceConnectionState(companyId);
    if (!connection) return null;
    const connected = connection.status === 'connected';
    return {
        id: null,
        status: connected ? 'connected' : 'disconnected',
        installed_at: connected ? connection.created_at : null,
        disconnected_at: null,
        provisioning_error: null,
        last_used_at: connected ? connection.last_synced_at : null,
        external_installation_id: null,
    };
}

// ONBTEL-001 §2.2: the Telephony — Twilio marketplace app (seeded with
// provisioning_mode='none', metadata.derived_connection=true and NO install row
// EVER) derives its connected state from company_telephony via
// telephonyTenantService. Special-cased in listApps + isAppConnected; installApp
// rejects ANY derived_connection app before an installation row is created.
const TELEPHONY_TWILIO_APP_KEY = 'telephony-twilio';

/**
 * Build the SYNTHETIC installation overlay for the Telephony — Twilio app from
 * the company's real telephony state (ONBTEL-001 §2.2). No
 * marketplace_installations row is created or read. Not connected (no
 * company_telephony row, or an autonomous-mode row with a NULL subaccount SID)
 * ⇒ null, so the tile shows Available/Configure. The Twilio subaccount SID is
 * NEVER exposed in any field. getTelephonyState errors bubble up, exactly like
 * the google-email overlay.
 */
async function buildTelephonyTwilioInstallationOverlay(companyId) {
    const state = await telephonyTenantService.getTelephonyState(companyId);
    if (!state.connected) return null;
    return {
        id: null,
        status: 'connected',
        installed_at: state.connected_at ?? null,
        disconnected_at: null,
        provisioning_error: null,
        last_used_at: null,
        external_installation_id: null,
    };
}

// STRIPE-TILE: Stripe Payments derives its connected state from the real
// stripe_connected_accounts row, not accumulated marketplace installation rows.
const STRIPE_PAYMENTS_APP_KEY = 'stripe-payments';

async function isStripePaymentsConnected(companyId) {
    try {
        const account = await stripePaymentsQueries.getAccountByCompany(companyId);
        return Boolean(account) && account.status !== 'disconnected';
    } catch {
        return false;
    }
}

async function buildStripePaymentsInstallationOverlay(companyId) {
    try {
        const account = await stripePaymentsQueries.getAccountByCompany(companyId);
        if (!account || account.status === 'disconnected') return null;
        return {
            id: null,
            status: 'connected',
            installed_at: account.created_at ?? null,
            disconnected_at: null,
            provisioning_error: null,
            last_used_at: account.updated_at ?? null,
            external_installation_id: null,
        };
    } catch {
        return null;
    }
}

/**
 * Whether the given marketplace app is connected (gate-only check) for a company.
 * True iff the app is published AND an active installation exists with status 'connected'.
 */
async function isAppConnected(companyId, appKey) {
    // SEND-DOC-001 §5.10: google-email connected-state comes from the mailbox, not
    // an install row — the mail-secretary gate resolves from truth.
    if (appKey === GOOGLE_EMAIL_APP_KEY) {
        return isGoogleEmailMailboxConnected(companyId);
    }
    if (appKey === GOOGLE_ADS_APP_KEY) {
        const connection = await googleAdsConnectionService
            .getMarketplaceConnectionState(companyId);
        return connection?.status === 'connected';
    }
    // ONBTEL-001 §2.2: telephony-twilio connected-state comes from
    // company_telephony (telephonyTenantService), never an install row — the
    // same derived pattern as google-email above.
    if (appKey === TELEPHONY_TWILIO_APP_KEY) {
        const state = await telephonyTenantService.getTelephonyState(companyId);
        return state.connected === true;
    }
    if (appKey === STRIPE_PAYMENTS_APP_KEY) {
        return isStripePaymentsConnected(companyId);
    }
    const app = await marketplaceQueries.getPublishedAppByKey(appKey);
    if (!app) return false;
    const installation = await marketplaceQueries.findActiveInstallation(companyId, app.id);
    return Boolean(installation) && installation.status === 'connected';
}

function toScopeArray(scopes) {
    if (Array.isArray(scopes)) return scopes.map(String);
    if (typeof scopes === 'string') {
        try {
            const parsed = JSON.parse(scopes);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function toMetadataObject(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
    if (typeof metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

function accessSummary(app) {
    const metadata = toMetadataObject(app.metadata || app.app_metadata);
    if (Array.isArray(metadata.access_summary)) return metadata.access_summary;

    const labels = {
        full_access: 'Full tenant API access',
        'leads:read': 'Read leads',
        'leads:create': 'Create leads',
        'leads:update': 'Update leads',
        'contacts:read': 'Read contacts',
        'contacts:create': 'Create contacts',
        'contacts:update': 'Update contacts',
        'jobs:read': 'Read jobs',
        'jobs:create': 'Create jobs',
        'jobs:update': 'Update jobs',
        'calls:read': 'Read call metadata',
        'calls.transcripts:read': 'Read call transcripts',
        'email:read': 'Read email',
        'email:send': 'Send email',
        'tasks:read': 'Read tasks',
        'tasks:create': 'Create tasks',
        'tasks:update': 'Update tasks',
        'notes:read': 'Read notes',
        'notes:create': 'Create notes',
        'analytics:read': 'Read analytics',
    };

    return toScopeArray(app.requested_scopes).map(scope => labels[scope] || scope);
}

async function validateInstallPrerequisites(app, companyId) {
    const metadata = toMetadataObject(app.metadata || app.app_metadata);
    if (!metadata.requires_connected_gmail) return;

    const mailbox = await emailQueries.getMailboxByCompany(companyId);
    if (!mailbox || mailbox.provider !== 'gmail' || mailbox.status !== 'connected') {
        throw new MarketplaceServiceError(
            'Mail Secretary requires a connected Gmail mailbox. Connect Gmail in Settings > Email, then install this module.',
            'GMAIL_REQUIRED',
            409
        );
    }
}

function mapAppRow(row) {
    const installation = row.installation_id ? {
        id: row.installation_id,
        status: row.installation_status,
        installed_at: row.installed_at,
        disconnected_at: row.disconnected_at,
        provisioning_error: row.provisioning_error,
        last_used_at: row.last_used_at,
    } : null;

    return {
        id: row.id,
        app_key: row.app_key,
        name: row.name,
        provider_name: row.provider_name,
        category: row.category,
        app_type: row.app_type,
        short_description: row.short_description,
        long_description: row.long_description,
        logo_url: row.logo_url,
        docs_url: row.docs_url,
        support_email: row.support_email,
        privacy_url: row.privacy_url,
        requested_scopes: toScopeArray(row.requested_scopes),
        access_summary: accessSummary(row),
        provisioning_mode: row.provisioning_mode,
        status: row.status,
        metadata: row.metadata || {},
        avg_rating: row.avg_rating == null ? null : Number(row.avg_rating),
        rating_count: Number(row.rating_count || 0),
        installation,
    };
}

function mapInstallationRow(row) {
    return {
        id: row.id,
        app_key: row.app_key,
        app_name: row.app_name,
        provider_name: row.provider_name,
        category: row.category,
        status: row.status,
        requested_scopes: toScopeArray(row.requested_scopes),
        installed_at: row.installed_at,
        disconnected_at: row.disconnected_at,
        provisioning_error: row.provisioning_error,
        external_installation_id: row.external_installation_id,
        key_id: row.key_id,
        revoked_at: row.revoked_at,
        last_used_at: row.last_used_at,
    };
}

function sanitizeProvisioningError(err) {
    return provisioningService.sanitizeErrorMessage(err?.message || 'Provisioning failed');
}

async function listApps(companyId) {
    const rows = await marketplaceQueries.listPublishedAppsWithInstallation(companyId);
    const apps = rows.map(mapAppRow);

    // SEND-DOC-001 §4.3: overlay the google-email app's installation with a
    // synthetic one derived from the real Gmail mailbox. This OVERRIDES any
    // install-row state mapAppRow produced (a stale row never wins). All other
    // apps are returned exactly as mapAppRow built them.
    const googleEmail = apps.find(app => app.app_key === GOOGLE_EMAIL_APP_KEY);
    if (googleEmail) {
        googleEmail.installation = await buildGoogleEmailInstallationOverlay(companyId);
    }

    const googleAds = apps.find(app => app.app_key === GOOGLE_ADS_APP_KEY);
    if (googleAds) {
        googleAds.installation = await buildGoogleAdsInstallationOverlay(companyId);
    }

    // ONBTEL-001 §2.2: same derived-overlay pattern for telephony-twilio — the
    // installation is synthesized from company_telephony (no install row is ever
    // created for this app; a stale row never wins). getTelephonyState errors
    // bubble, exactly like the google-email overlay above.
    const telephonyTwilio = apps.find(app => app.app_key === TELEPHONY_TWILIO_APP_KEY);
    if (telephonyTwilio) {
        telephonyTwilio.installation = await buildTelephonyTwilioInstallationOverlay(companyId);
    }

    const stripe = apps.find(app => app.app_key === STRIPE_PAYMENTS_APP_KEY);
    if (stripe) {
        stripe.installation = await buildStripePaymentsInstallationOverlay(companyId);
    }

    return apps;
}

async function listInstallations(companyId, includeInactive = false) {
    const rows = await marketplaceQueries.listInstallations(companyId, includeInactive);
    return rows.map(mapInstallationRow);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSettings(message) {
    throw new MarketplaceServiceError(message, 'INVALID_SETTINGS', 400);
}

function storedInstruction(metadata, key = 'instruction_text') {
    const value = toMetadataObject(metadata)[key];
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_INSTRUCTION_CHARS) return null;
    return normalized;
}

function effectiveReportInstruction(value) {
    if (typeof value !== 'string') return DEFAULT_REPORT_INSTRUCTION;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_INSTRUCTION_CHARS) {
        return DEFAULT_REPORT_INSTRUCTION;
    }
    return normalized;
}

function validateReportToEstimateInstruction(body) {
    if (!isPlainObject(body)) {
        throw new MarketplaceServiceError(
            'Settings must be an object.',
            'INVALID_INSTRUCTION',
            400
        );
    }

    const keys = ['instruction_text', 'report_instruction_text'];
    const providedKeys = keys.filter(key => Object.prototype.hasOwnProperty.call(body, key));
    if (providedKeys.length === 0) {
        throw new MarketplaceServiceError(
            'At least one instruction must be provided.',
            'INVALID_INSTRUCTION',
            400
        );
    }

    const instructions = {};
    for (const key of providedKeys) {
        if (typeof body[key] !== 'string') {
            throw new MarketplaceServiceError(
                `${key} must be a string.`,
                'INVALID_INSTRUCTION',
                400
            );
        }
        const value = body[key].trim();
        if (!value) {
            throw new MarketplaceServiceError(
                `${key} cannot be empty.`,
                'INVALID_INSTRUCTION',
                400
            );
        }
        if (value.length > MAX_INSTRUCTION_CHARS) {
            throw new MarketplaceServiceError(
                `${key} must be ${MAX_INSTRUCTION_CHARS} characters or fewer.`,
                'INVALID_INSTRUCTION',
                400
            );
        }
        instructions[key] = value;
    }
    return instructions;
}

async function resolveReportToEstimateState(companyId) {
    const app = await marketplaceQueries.getPublishedAppByKey(REPORT_TO_ESTIMATE_APP_KEY);
    if (!app) {
        throw new MarketplaceServiceError(
            'Marketplace app not found.',
            'APP_NOT_FOUND',
            404
        );
    }
    const installation = await marketplaceQueries.findLatestInstallation(companyId, app.id);
    return { app, installation };
}

function buildReportToEstimateSettings(installation) {
    return {
        app_key: REPORT_TO_ESTIMATE_APP_KEY,
        enabled: installation?.status === 'connected',
        installation_id: installation?.id || null,
        instruction_text: effectiveInstruction(storedInstruction(installation?.metadata)),
        report_instruction_text: effectiveReportInstruction(
            storedInstruction(installation?.metadata, 'report_instruction_text')
        ),
    };
}

async function getReportToEstimateSettings(companyId) {
    const { installation } = await resolveReportToEstimateState(companyId);
    return buildReportToEstimateSettings(installation);
}

async function getReportToEstimateInstruction(companyId) {
    const app = await marketplaceQueries.getPublishedAppByKey(REPORT_TO_ESTIMATE_APP_KEY);
    if (!app) return DEFAULT_INSTRUCTION;
    const installation = await marketplaceQueries.findActiveInstallation(companyId, app.id);
    return effectiveInstruction(storedInstruction(installation?.metadata));
}

async function getReportPolishInstruction(companyId) {
    const app = await marketplaceQueries.getPublishedAppByKey(REPORT_TO_ESTIMATE_APP_KEY);
    if (!app) return DEFAULT_REPORT_INSTRUCTION;
    const installation = await marketplaceQueries.findActiveInstallation(companyId, app.id);
    return effectiveReportInstruction(
        storedInstruction(installation?.metadata, 'report_instruction_text')
    );
}

async function updateReportToEstimateInstruction(
    companyId,
    actorId,
    body,
    { requestId = null } = {}
) {
    const { app, installation } = await resolveReportToEstimateState(companyId);
    if (!installation) {
        throw new MarketplaceServiceError(
            'Marketplace app is not installed.',
            'APP_NOT_INSTALLED',
            404
        );
    }
    const instructions = validateReportToEstimateInstruction(body);
    const updated = await marketplaceQueries.setInstallationInstructions(
        companyId,
        installation.id,
        REPORT_TO_ESTIMATE_APP_KEY,
        instructions
    );
    if (!updated) {
        throw new MarketplaceServiceError(
            'Marketplace app is not installed.',
            'APP_NOT_INSTALLED',
            404
        );
    }
    const payload = { app_key: REPORT_TO_ESTIMATE_APP_KEY };
    if (instructions.instruction_text) {
        payload.instruction_length = instructions.instruction_text.length;
    }
    if (instructions.report_instruction_text) {
        payload.report_instruction_length = instructions.report_instruction_text.length;
    }
    await marketplaceQueries.writeEvent({
        companyId,
        installationId: updated.id,
        appId: app.id,
        actorId: actorId || null,
        eventType: 'settings_updated',
        requestId,
        payload,
    });
    return buildReportToEstimateSettings(updated);
}

function canonicalizeSettingsCatalog(values, catalog, code, label) {
    if (!Array.isArray(values)) invalidSettings(`${label} must be an array.`);

    return values.map((value) => {
        if (typeof value !== 'string') {
            throw new MarketplaceServiceError(`${label} contains an unsupported value.`, code, 400);
        }
        const normalized = value.trim().toLowerCase();
        const canonical = catalog.find((entry) => entry.toLowerCase() === normalized);
        if (!canonical) {
            throw new MarketplaceServiceError(
                `${label} contains an unsupported value: ${value}.`,
                code,
                400
            );
        }
        return canonical;
    });
}

function validateRelySettingsInput(body) {
    if (!isPlainObject(body)) invalidSettings('Settings must be an object.');

    const zoneInput = body.zone === undefined ? {} : body.zone;
    if (!isPlainObject(zoneInput)) invalidSettings('Zone must be an object.');

    const mode = zoneInput.mode === undefined ? 'company' : zoneInput.mode;
    if (!['company', 'custom'].includes(mode)) {
        throw new MarketplaceServiceError(
            'Zone mode must be either company or custom.',
            'INVALID_ZONE_MODE',
            400
        );
    }

    const zipInput = zoneInput.custom_zips === undefined ? [] : zoneInput.custom_zips;
    if (typeof zipInput !== 'string'
        && (!Array.isArray(zipInput) || zipInput.some((value) => typeof value !== 'string'))) {
        invalidSettings('Custom ZIP codes must be a string or an array of strings.');
    }
    const { zips, invalid } = parseZipList(zipInput);
    if (invalid.length > 0) {
        throw new MarketplaceServiceError(
            `Invalid ZIP codes: ${invalid.slice(0, 10).join(', ')}.`,
            'INVALID_ZIPS',
            400
        );
    }
    if (zips.length > 500) {
        throw new MarketplaceServiceError(
            'Custom ZIP list cannot contain more than 500 ZIP codes.',
            'ZIP_LIST_TOO_LARGE',
            400
        );
    }

    const unitTypes = canonicalizeSettingsCatalog(
        body.unit_types === undefined ? [] : body.unit_types,
        RELY_UNIT_TYPES,
        'INVALID_UNIT_TYPES',
        'Unit types'
    );
    const brands = canonicalizeSettingsCatalog(
        body.brands === undefined ? [] : body.brands,
        RELY_BRANDS,
        'INVALID_BRANDS',
        'Brands'
    );

    return {
        zone: { mode, custom_zips: zips },
        unit_types: unitTypes,
        brands,
    };
}

function validateRateMeSettingsInput(body) {
    const validateHttpsUrl = (rawUrl, label, code) => {
        if (rawUrl === null || rawUrl === undefined) return null;
        const message = `${label} must be a valid HTTPS URL no longer than 500 characters.`;
        if (typeof rawUrl !== 'string') {
            throw new MarketplaceServiceError(message, code, 400);
        }

        const normalizedUrl = rawUrl.trim();
        if (!normalizedUrl) return null;

        let parsed;
        try {
            parsed = new URL(normalizedUrl);
        } catch {
            parsed = null;
        }
        if (!normalizedUrl.startsWith('https://')
            || !parsed
            || parsed.protocol !== 'https:'
            || normalizedUrl.length > 500) {
            throw new MarketplaceServiceError(message, code, 400);
        }

        return normalizedUrl;
    };

    const google_review_url = validateHttpsUrl(
        body?.google_review_url,
        'Google review URL',
        'INVALID_GOOGLE_REVIEW_URL'
    );
    const booking_url = validateHttpsUrl(
        body?.booking_url,
        'Booking URL',
        'INVALID_BOOKING_URL'
    );

    return { google_review_url, booking_url };
}

function validateAgentCallingWindowInput(body) {
    const mode = body?.calling_window_mode == null ? null : body.calling_window_mode;
    if (mode !== null && mode !== 'custom') {
        throw new MarketplaceServiceError(
            'Calling window must use the company schedule or a custom schedule.',
            'INVALID_CALLING_WINDOW_MODE',
            400
        );
    }
    if (mode === 'custom' && !outboundCallSettingsService.isUsableCustomWindow(
        body?.custom_start_time,
        body?.custom_end_time,
        body?.calling_window_work_days
    )) {
        throw new MarketplaceServiceError(
            'Custom calling window requires at least one day and a valid start time before its end time.',
            'INVALID_CALLING_WINDOW',
            400
        );
    }
    return {
        calling_window_mode: mode,
        custom_start_time: mode === 'custom' ? body.custom_start_time : null,
        custom_end_time: mode === 'custom' ? body.custom_end_time : null,
        calling_window_work_days: mode === 'custom'
            ? [...new Set(body.calling_window_work_days)].sort((a, b) => a - b)
            : null,
    };
}

async function resolveSettingsInstallation(companyId, appKey) {
    if (!SETTINGS_ENABLED_APP_KEYS.has(appKey)) {
        throw new MarketplaceServiceError(
            'Settings are not supported for this marketplace app.',
            'SETTINGS_NOT_SUPPORTED',
            404
        );
    }

    const app = await marketplaceQueries.getPublishedAppByKey(appKey);
    if (!app) {
        throw new MarketplaceServiceError('Marketplace app not found.', 'APP_NOT_FOUND', 404);
    }

    const installation = await marketplaceQueries.findActiveInstallation(companyId, app.id);
    if (!installation || installation.status !== 'connected') {
        throw new MarketplaceServiceError(
            'Marketplace app is not installed.',
            'APP_NOT_INSTALLED',
            404
        );
    }

    return { app, installation };
}

async function getTerritorySummary(companyId) {
    const territorySettings = await territoryRadiusQueries.getSettings(companyId);
    const activeMode = territorySettings?.active_mode === 'radius' ? 'radius' : 'list';
    const hasData = activeMode === 'radius'
        ? (await territoryRadiusQueries.listRadii(companyId)).length > 0
        : Number(await territoryRadiusQueries.countListZips(companyId)) > 0;

    return { active_mode: activeMode, has_data: hasData };
}

async function buildRelySettingsResponse(companyId, appKey, installation, metadata) {
    return {
        app_key: appKey,
        installation_id: installation.id,
        settings: resolveRelySettings(metadata),
        catalogs: {
            unit_types: RELY_UNIT_TYPES,
            brands: RELY_BRANDS,
        },
        territory: await getTerritorySummary(companyId),
    };
}

async function buildRateMeSettingsResponse(companyId, appKey, installation, metadata) {
    return {
        app_key: 'rate-me',
        installation_id: installation.id,
        settings: {
            google_review_url: metadata?.settings?.google_review_url || null,
            booking_url: metadata?.settings?.booking_url || null,
        },
        domain: await rateMeQueries.getDomainByCompany(companyId),
        public_host: RATE_ME_PUBLIC_HOST,
    };
}

async function buildOutboundPartsSettingsResponse(
    companyId,
    appKey,
    installation,
    _metadata,
    savedSettings = null
) {
    return {
        app_key: appKey,
        installation_id: installation.id,
        settings: savedSettings || await outboundCallSettingsService.get(companyId),
    };
}

function relyEventPayload(validated) {
    return {
        app_key: 'rely-leads',
        zone_mode: validated.zone.mode,
        custom_zip_count: validated.zone.custom_zips.length,
        unit_type_count: validated.unit_types.length,
        brand_count: validated.brands.length,
    };
}

const SETTINGS_HANDLERS = {
    'rely-leads': {
        validate: validateRelySettingsInput,
        buildResponse: buildRelySettingsResponse,
        buildEventPayload: relyEventPayload,
    },
    'rate-me': {
        validate: validateRateMeSettingsInput,
        buildResponse: buildRateMeSettingsResponse,
        buildEventPayload: (validated) => ({
            app_key: 'rate-me',
            has_google_review_url: Boolean(validated.google_review_url),
            has_booking_url: Boolean(validated.booking_url),
        }),
    },
    'outbound-parts-caller': {
        validate: validateAgentCallingWindowInput,
        buildResponse: buildOutboundPartsSettingsResponse,
        save: (companyId, validated) => outboundCallSettingsService.saveCallingWindow(
            companyId,
            validated
        ),
        buildEventPayload: (validated) => ({
            app_key: 'outbound-parts-caller',
            calling_window_mode: validated.calling_window_mode || 'company',
            work_day_count: validated.calling_window_work_days?.length || 0,
        }),
    },
    inspector: {
        validate: (body, companyId) => inspectorSettingsService.validateInput(companyId, body),
        buildResponse: inspectorSettingsService.buildResponse,
        save: (companyId, validated, actorId) => inspectorSettingsService.save(
            companyId,
            validated,
            actorId
        ),
        buildEventPayload: inspectorSettingsService.buildEventPayload,
    },
    // CHATGPT-CRM-MCP-001: read-only settings surface. Consent mutations never
    // go through PUT; AVATARS-001 Phase C replaces this company-wide response
    // with the signed-in owner's per-avatar settings endpoint.
    'chatgpt-crm-mcp': {
        validate: () => {
            throw new MarketplaceServiceError(
                'ChatGPT connector settings are read-only; use the write-consent endpoints.',
                'SETTINGS_READ_ONLY',
                405
            );
        },
        buildResponse: async (companyId, appKey) => ({
            app_key: appKey,
            settings: await chatgptMcpIdentityService.getWriteConsent(companyId),
        }),
        buildEventPayload: () => ({ app_key: 'chatgpt-crm-mcp' }),
    },
};

async function getAppSettings(companyId, appKey) {
    const { installation } = await resolveSettingsInstallation(companyId, appKey);
    return SETTINGS_HANDLERS[appKey].buildResponse(
        companyId,
        appKey,
        installation,
        installation.metadata
    );
}

async function updateAppSettings(
    companyId,
    actorId,
    appKey,
    body,
    { requestId = null } = {}
) {
    const { app, installation } = await resolveSettingsInstallation(companyId, appKey);
    const handler = SETTINGS_HANDLERS[appKey];
    let validated;
    try {
        validated = await handler.validate(body, companyId);
    } catch (error) {
        if (error instanceof inspectorSettingsService.InspectorSettingsError) {
            throw new MarketplaceServiceError(error.message, error.code, error.httpStatus);
        }
        throw error;
    }
    if (handler.save) {
        const savedSettings = await handler.save(companyId, validated, actorId);
        await marketplaceQueries.writeEvent({
            companyId,
            installationId: installation.id,
            appId: app.id,
            actorId: actorId || null,
            eventType: 'settings_updated',
            requestId,
            payload: handler.buildEventPayload(validated),
        });
        return handler.buildResponse(
            companyId,
            appKey,
            installation,
            installation.metadata,
            savedSettings
        );
    }
    const storedSettings = {
        ...validated,
        updated_at: new Date().toISOString(),
        updated_by: actorId || null,
    };

    const updated = await marketplaceQueries.setInstallationSettings(
        companyId,
        installation.id,
        storedSettings
    );
    await marketplaceQueries.writeEvent({
        companyId,
        installationId: installation.id,
        appId: app.id,
        actorId: actorId || null,
        eventType: 'settings_updated',
        requestId,
        payload: handler.buildEventPayload(validated),
    });

    const metadata = updated?.metadata || { settings: storedSettings };
    return handler.buildResponse(
        companyId,
        appKey,
        updated || installation,
        metadata
    );
}

async function createCredentialForInstallation({ app, companyId, installationId, client }) {
    return integrationsService.createIntegration(
        `Marketplace: ${app.name}`,
        toScopeArray(app.requested_scopes),
        null,
        companyId,
        {
            client,
            marketplaceAppId: app.id,
            marketplaceInstallationId: installationId,
        }
    );
}

async function writeCredentialRevokedEvent({ companyId, installationId, appId, apiIntegrationId, actorId, requestId, reason }, client) {
    if (!apiIntegrationId) return;
    await marketplaceQueries.writeEvent({
        companyId,
        installationId,
        appId,
        apiIntegrationId,
        actorId,
        eventType: 'credential_revoked',
        requestId,
        payload: { reason },
    }, client);
}

async function installApp(companyId, actorId, appKey, { requestId = null, req = null } = {}) {
    let app;
    let installation;
    let credential;

    await marketplaceQueries.ensureMarketplaceSchema();

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        app = await marketplaceQueries.getPublishedAppByKey(appKey, client);
        if (!app) {
            throw new MarketplaceServiceError('Marketplace app not found.', 'APP_NOT_FOUND', 404);
        }
        if (app.app_key === CHATGPT_CRM_MCP_APP_KEY) {
            await requireChatgptTenantAdmin(companyId, actorId, client);
        }

        const active = await marketplaceQueries.findActiveInstallation(companyId, app.id, client);
        if (active) {
            throw new MarketplaceServiceError('App is already installed for this company.', 'APP_ALREADY_INSTALLED', 409);
        }
        let installationMetadata = {};
        if (app.app_key === REPORT_TO_ESTIMATE_APP_KEY) {
            const previous = await marketplaceQueries.findLatestInstallation(
                companyId,
                app.id,
                client
            );
            const previousInstruction = storedInstruction(previous?.metadata);
            const previousReportInstruction = storedInstruction(
                previous?.metadata,
                'report_instruction_text'
            );
            if (previousInstruction) {
                installationMetadata.instruction_text = previousInstruction;
            }
            if (previousReportInstruction) {
                installationMetadata.report_instruction_text = previousReportInstruction;
            }
        }

        // ONBTEL-001 §2.2 fail-safe: apps whose connected-state is DERIVED from
        // their own domain (metadata.derived_connection === true, e.g.
        // telephony-twilio) are never installed through the marketplace — their
        // setup page owns the connect flow. Data-driven (no app_key hardcode),
        // rejected BEFORE any installation row is created.
        const appMetadata = toMetadataObject(app.metadata || app.app_metadata);
        if (appMetadata.derived_connection === true) {
            throw new MarketplaceServiceError(
                'This app is configured from its setup page.',
                'DERIVED_CONNECTION_APP',
                409
            );
        }

        await validateInstallPrerequisites(app, companyId);

        installation = await marketplaceQueries.createInstallation({
            companyId,
            appId: app.id,
            actorId,
            status: 'provisioning_failed',
            metadata: installationMetadata,
        }, client);

        if (app.provisioning_mode !== 'none') {
            credential = await createCredentialForInstallation({
                app,
                companyId,
                installationId: installation.id,
                client,
            });

            installation = await marketplaceQueries.updateInstallationCredential(
                companyId,
                installation.id,
                credential.id,
                client
            );
        }

        await marketplaceQueries.writeEvent({
            companyId,
            installationId: installation.id,
            appId: app.id,
            apiIntegrationId: credential?.id || null,
            actorId,
            eventType: 'connect_requested',
            requestId,
            payload: { app_key: app.app_key, scopes: toScopeArray(app.requested_scopes), provisioning_mode: app.provisioning_mode },
        }, client);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        if (err instanceof MarketplaceServiceError) throw err;
        if (err.code === '23505') {
            throw new MarketplaceServiceError('App is already installed for this company.', 'APP_ALREADY_INSTALLED', 409);
        }
        throw err;
    } finally {
        client.release();
    }

    if (app.provisioning_mode === 'push_credentials') {
        try {
            const provisioned = await provisioningService.pushCredentials({
                app,
                installation,
                credential,
                companyId,
                requestId,
                req,
            });

            const doneClient = await db.pool.connect();
            try {
                await doneClient.query('BEGIN');
                installation = await marketplaceQueries.markInstallationConnected({
                    companyId,
                    installationId: installation.id,
                    externalInstallationId: provisioned.external_installation_id,
                }, doneClient);
                await marketplaceQueries.writeEvent({
                    companyId,
                    installationId: installation.id,
                    appId: app.id,
                    apiIntegrationId: credential.id,
                    actorId,
                    eventType: 'connected',
                    requestId,
                    payload: { external_installation_id: provisioned.external_installation_id || null },
                }, doneClient);
                await doneClient.query('COMMIT');
            } catch (err) {
                await doneClient.query('ROLLBACK');
                throw err;
            } finally {
                doneClient.release();
            }
        } catch (err) {
            const message = sanitizeProvisioningError(err);
            const failClient = await db.pool.connect();
            try {
                await failClient.query('BEGIN');
                const revoked = await marketplaceQueries.revokeCredentialById(credential.id, companyId, failClient);
                if (revoked) {
                    await writeCredentialRevokedEvent({
                        companyId,
                        installationId: installation.id,
                        appId: app.id,
                        apiIntegrationId: credential.id,
                        actorId,
                        requestId,
                        reason: 'provisioning_failed',
                    }, failClient);
                }
                installation = await marketplaceQueries.markProvisioningFailed({
                    companyId,
                    installationId: installation.id,
                    error: message,
                }, failClient);
                await marketplaceQueries.writeEvent({
                    companyId,
                    installationId: installation.id,
                    appId: app.id,
                    apiIntegrationId: credential.id,
                    actorId,
                    eventType: 'provisioning_failed',
                    requestId,
                    payload: { error: message },
                }, failClient);
                await failClient.query('COMMIT');
            } catch (failErr) {
                await failClient.query('ROLLBACK');
                throw failErr;
            } finally {
                failClient.release();
            }
            throw new MarketplaceServiceError(message, 'PROVISIONING_FAILED', 502);
        }
    } else {
        const doneClient = await db.pool.connect();
        try {
            await doneClient.query('BEGIN');
            installation = await marketplaceQueries.markInstallationConnected({
                companyId,
                installationId: installation.id,
            }, doneClient);
            if (app.app_key === CHATGPT_CRM_MCP_APP_KEY) {
                await chatgptMcpIdentityService.enableCompanyInstallation({
                    companyId,
                    installationId: installation.id,
                    actorId,
                }, doneClient);
                await chatgptMcpIdentityService.provisionAvatar({
                    companyId,
                    installationId: installation.id,
                    ownerUserId: actorId,
                    actorId,
                }, doneClient);
            }
            await marketplaceQueries.writeEvent({
                companyId,
                installationId: installation.id,
                appId: app.id,
                apiIntegrationId: credential?.id || null,
                actorId,
                eventType: 'connected',
                requestId,
                payload: { provisioning_mode: app.provisioning_mode },
            }, doneClient);
            await doneClient.query('COMMIT');
        } catch (err) {
            await doneClient.query('ROLLBACK');
            throw err;
        } finally {
            doneClient.release();
        }
    }

    return mapInstallationRow({
        ...installation,
        app_key: app.app_key,
        app_name: app.name,
        provider_name: app.provider_name,
        category: app.category,
        requested_scopes: app.requested_scopes,
        key_id: credential?.key_id,
        revoked_at: null,
        last_used_at: null,
    });
}

async function disconnectInstallation(companyId, actorId, installationId, { requestId = null } = {}) {
    await marketplaceQueries.ensureMarketplaceSchema();

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const installation = await marketplaceQueries.getInstallationById(companyId, installationId, client);
        if (!installation) {
            throw new MarketplaceServiceError('Installation not found.', 'INSTALLATION_NOT_FOUND', 404);
        }
        if (installation.app_key === CHATGPT_CRM_MCP_APP_KEY) {
            await requireChatgptTenantAdmin(companyId, actorId, client);
        }
        if (!['connected', 'provisioning_failed'].includes(installation.status)) {
            throw new MarketplaceServiceError('Installation is not active.', 'INSTALLATION_NOT_ACTIVE', 409);
        }

        const otherActive = await marketplaceQueries.countOtherActiveInstallationsOnCredential(
            companyId,
            installation.api_integration_id,
            installationId,
            client
        );
        let revoked = null;
        if (otherActive === 0) {
            revoked = await marketplaceQueries.revokeCredentialById(installation.api_integration_id, companyId, client);
        }
        if (revoked) {
            await writeCredentialRevokedEvent({
                companyId,
                installationId,
                appId: installation.app_id,
                apiIntegrationId: installation.api_integration_id,
                actorId,
                requestId,
                reason: 'disconnect',
            }, client);
        }
        if (installation.app_key === CHATGPT_CRM_MCP_APP_KEY) {
            await chatgptMcpIdentityService.revokeInstallation({
                companyId,
                installationId,
                actorId,
            }, client);
        }
        const updated = await marketplaceQueries.markDisconnected({
            companyId,
            installationId,
            actorId,
            status: !installation.api_integration_id || revoked || otherActive > 0 ? 'disconnected' : 'revoked',
        }, client);

        await marketplaceQueries.writeEvent({
            companyId,
            installationId,
            appId: installation.app_id,
            apiIntegrationId: installation.api_integration_id,
            actorId,
            eventType: 'disconnected',
            requestId,
            payload: { credential_revoked: Boolean(revoked), credential_shared: otherActive > 0 },
        }, client);

        await client.query('COMMIT');
        return {
            id: updated.id,
            status: updated.status,
            disconnected_at: updated.disconnected_at,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function setChatgptMcpWrites(companyId, actorId, enabled, { requestId = null } = {}) {
    if (!companyId) {
        throw new MarketplaceServiceError('Company context is required.', 'TENANT_CONTEXT_REQUIRED', 403);
    }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        let result;
        try {
            result = await chatgptMcpIdentityService.setWriteConsent({
                companyId,
                actorId,
                enabled: Boolean(enabled),
            }, client);
        } catch (err) {
            if (err instanceof chatgptMcpIdentityService.ChatgptMcpIdentityError) {
                throw new MarketplaceServiceError(err.message, err.code, err.httpStatus);
            }
            throw err;
        }
        const app = await marketplaceQueries.getPublishedAppByKey(CHATGPT_CRM_MCP_APP_KEY, client);
        await marketplaceQueries.writeEvent({
            companyId,
            installationId: result.installation_id,
            appId: app?.id || null,
            actorId,
            eventType: enabled ? 'mcp_writes_enabled' : 'mcp_writes_disabled',
            requestId,
            payload: { grant_version: result.grant_version },
        }, client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function setChatgptMcpSends(companyId, actorId, enabled, { requestId = null } = {}) {
    if (!companyId) {
        throw new MarketplaceServiceError('Company context is required.', 'TENANT_CONTEXT_REQUIRED', 403);
    }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        let result;
        try {
            result = await chatgptMcpIdentityService.setSendConsent({
                companyId,
                actorId,
                enabled: Boolean(enabled),
            }, client);
        } catch (err) {
            if (err instanceof chatgptMcpIdentityService.ChatgptMcpIdentityError) {
                throw new MarketplaceServiceError(err.message, err.code, err.httpStatus);
            }
            throw err;
        }
        const app = await marketplaceQueries.getPublishedAppByKey(CHATGPT_CRM_MCP_APP_KEY, client);
        await marketplaceQueries.writeEvent({
            companyId,
            installationId: result.installation_id,
            appId: app?.id || null,
            actorId,
            eventType: enabled ? 'mcp_sends_enabled' : 'mcp_sends_disabled',
            requestId,
            payload: { grant_version: result.grant_version },
        }, client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function retryProvisioning(companyId, actorId, installationId, { requestId = null, req = null } = {}) {
    await marketplaceQueries.ensureMarketplaceSchema();

    const current = await marketplaceQueries.getInstallationById(companyId, installationId);
    if (!current) {
        throw new MarketplaceServiceError('Installation not found.', 'INSTALLATION_NOT_FOUND', 404);
    }
    if (current.status !== 'provisioning_failed' || current.provisioning_mode !== 'push_credentials') {
        throw new MarketplaceServiceError('Installation is not retryable.', 'INSTALLATION_NOT_RETRYABLE', 409);
    }

    const app = await marketplaceQueries.getPublishedAppByKey(current.app_key);
    if (!app) {
        throw new MarketplaceServiceError('Marketplace app not found.', 'APP_NOT_FOUND', 404);
    }

    let credential;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const revoked = await marketplaceQueries.revokeCredentialById(current.api_integration_id, companyId, client);
        if (revoked) {
            await writeCredentialRevokedEvent({
                companyId,
                installationId,
                appId: app.id,
                apiIntegrationId: current.api_integration_id,
                actorId,
                requestId,
                reason: 'retry_provisioning',
            }, client);
        }
        credential = await createCredentialForInstallation({
            app,
            companyId,
            installationId,
            client,
        });
        await marketplaceQueries.updateInstallationCredential(companyId, installationId, credential.id, client);
        await marketplaceQueries.writeEvent({
            companyId,
            installationId,
            appId: app.id,
            apiIntegrationId: credential.id,
            actorId,
            eventType: 'retry_requested',
            requestId,
            payload: { app_key: app.app_key },
        }, client);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    try {
        const provisioned = await provisioningService.pushCredentials({
            app,
            installation: { id: installationId },
            credential,
            companyId,
            requestId,
            req,
        });
        const doneClient = await db.pool.connect();
        try {
            await doneClient.query('BEGIN');
            const updated = await marketplaceQueries.markInstallationConnected({
                companyId,
                installationId,
                externalInstallationId: provisioned.external_installation_id,
            }, doneClient);
            await marketplaceQueries.writeEvent({
                companyId,
                installationId,
                appId: app.id,
                apiIntegrationId: credential.id,
                actorId,
                eventType: 'connected',
                requestId,
                payload: { external_installation_id: provisioned.external_installation_id || null },
            }, doneClient);
            await doneClient.query('COMMIT');
            return mapInstallationRow({
                ...updated,
                app_key: app.app_key,
                app_name: app.name,
                provider_name: app.provider_name,
                category: app.category,
                requested_scopes: app.requested_scopes,
                key_id: credential.key_id,
                revoked_at: null,
                last_used_at: null,
            });
        } catch (err) {
            await doneClient.query('ROLLBACK');
            throw err;
        } finally {
            doneClient.release();
        }
    } catch (err) {
        const message = sanitizeProvisioningError(err);
        const failClient = await db.pool.connect();
        try {
            await failClient.query('BEGIN');
            const revoked = await marketplaceQueries.revokeCredentialById(credential.id, companyId, failClient);
            if (revoked) {
                await writeCredentialRevokedEvent({
                    companyId,
                    installationId,
                    appId: app.id,
                    apiIntegrationId: credential.id,
                    actorId,
                    requestId,
                    reason: 'provisioning_failed',
                }, failClient);
            }
            await marketplaceQueries.markProvisioningFailed({ companyId, installationId, error: message }, failClient);
            await marketplaceQueries.writeEvent({
                companyId,
                installationId,
                appId: app.id,
                apiIntegrationId: credential.id,
                actorId,
                eventType: 'provisioning_failed',
                requestId,
                payload: { error: message },
            }, failClient);
            await failClient.query('COMMIT');
        } catch (failErr) {
            await failClient.query('ROLLBACK');
            throw failErr;
        } finally {
            failClient.release();
        }
        throw new MarketplaceServiceError(message, 'PROVISIONING_FAILED', 502);
    }
}

module.exports = {
    MarketplaceServiceError,
    DEFAULT_REPORT_INSTRUCTION,
    SMART_SLOT_ENGINE_APP_KEY,
    AI_REPAIR_ADVISOR_APP_KEY,
    REPORT_TO_ESTIMATE_APP_KEY,
    CHATGPT_CRM_MCP_APP_KEY,
    SETTINGS_ENABLED_APP_KEYS,
    isAppConnected,
    listApps,
    listInstallations,
    installApp,
    disconnectInstallation,
    setChatgptMcpWrites,
    setChatgptMcpSends,
    retryProvisioning,
    validateRelySettingsInput,
    validateRateMeSettingsInput,
    validateAgentCallingWindowInput,
    validateReportToEstimateInstruction,
    effectiveReportInstruction,
    getAppSettings,
    updateAppSettings,
    getReportToEstimateSettings,
    getReportToEstimateInstruction,
    getReportPolishInstruction,
    updateReportToEstimateInstruction,
    resolveRelySettings,
    _toScopeArray: toScopeArray,
    _accessSummary: accessSummary,
};
