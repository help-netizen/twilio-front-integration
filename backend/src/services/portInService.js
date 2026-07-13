/**
 * Twilio Port-In Service — TELEPHONY-WIZARD-UX-001 (T2).
 *
 * Porting is a master-account API even when the destination is a tenant
 * subaccount. Requests are inserted locally before the money-adjacent Twilio
 * create call so the partial unique index is the concurrency/idempotency guard.
 */

const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db/connection');
const telephonyTenantService = require('./telephonyTenantService');
const { getTwilioClient } = require('./twilioClient');

const TERMINAL_STATUSES = new Set(['completed', 'canceled', 'failed']);

// Spec §4.2 originally used lowercase /documents. The architect approved the
// current Twilio Documents API contract, whose resource path has a capital D.
const DOCUMENT_UPLOAD_URL = 'https://numbers-upload.twilio.com/v1/Documents';

function serviceError(message, httpStatus, code) {
    const err = new Error(message);
    err.httpStatus = httpStatus;
    err.code = code;
    return err;
}

function normalizeStatus(rawStatus) {
    const normalized = String(rawStatus || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');

    const statusMap = {
        submitted: 'submitted',
        pending: 'pending',
        in_progress: 'pending',
        in_review: 'in_review',
        waiting_for_signature: 'action_required',
        action_required: 'action_required',
        completed: 'completed',
        canceled: 'canceled',
        cancelled: 'canceled',
        expired: 'failed',
        failed: 'failed',
    };
    return statusMap[normalized] || 'pending';
}

function rawRemoteStatus(portIn) {
    return portIn?.portInRequestStatus
        || portIn?.phoneNumbers?.[0]?.portInPhoneNumberStatus
        || null;
}

function publicRequest(row) {
    return {
        id: row.id,
        phone_number: row.phone_number,
        customer_name: row.customer_name || null,
        status: row.status,
        twilio_status: row.twilio_status || null,
        signature_request_url: row.signature_request_url || null,
        target_port_in_date: row.target_port_in_date || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function selectColumns() {
    return `id, company_id, phone_number, status, twilio_port_in_sid,
            twilio_status, signature_request_url, target_port_in_date,
            losing_carrier_info->>'customerName' AS customer_name,
            created_at, updated_at`;
}

async function targetAccountSid(companyId) {
    const state = await telephonyTenantService.getTelephonyState(companyId);
    if (!state.connected) {
        throw serviceError('Telephony is not connected for this company', 409, 'TELEPHONY_NOT_CONNECTED');
    }
    const sid = state.mode === 'master'
        ? process.env.TWILIO_ACCOUNT_SID
        : state.subaccount_sid;
    if (!sid) {
        throw serviceError('Twilio target account is not configured', 500, 'TWILIO_NOT_CONFIGURED');
    }
    return sid;
}

async function checkPortability(companyId, phoneNumber) {
    const targetSid = await targetAccountSid(companyId);
    try {
        const result = await getTwilioClient().numbers.v1
            .portingPortabilities(phoneNumber)
            .fetch({ targetAccountSid: targetSid });
        return {
            portable: result.portable === true,
            number_type: result.numberType || null,
            reason: result.notPortableReason || null,
            pin_and_account_number_required: result.pinAndAccountNumberRequired === true,
        };
    } catch (err) {
        throw serviceError('Could not check whether this number can be transferred', 502, 'PORTABILITY_CHECK_FAILED');
    }
}

function safeFilename(name) {
    return String(name || 'utility-bill')
        .split(/[\\/]/)
        .pop()
        .replace(/[\r\n"]/g, '_')
        .slice(0, 180) || 'utility-bill';
}

function multipartBody(file) {
    const boundary = `----AlbustoPortIn${crypto.randomBytes(12).toString('hex')}`;
    const filename = safeFilename(file.originalname);
    const chunks = [
        Buffer.from(
            `--${boundary}\r\n`
            + 'Content-Disposition: form-data; name="document_type"\r\n\r\n'
            + 'utility_bill\r\n'
            + `--${boundary}\r\n`
            + 'Content-Disposition: form-data; name="friendly_name"\r\n\r\n'
            + `${filename}\r\n`
            + `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="File"; filename="${filename}"\r\n`
            + `Content-Type: ${file.mimetype}\r\n\r\n`
        ),
        file.buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    return { boundary, body: Buffer.concat(chunks) };
}

async function uploadUtilityBill(file) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        throw serviceError('Twilio document upload is not configured', 500, 'TWILIO_NOT_CONFIGURED');
    }

    const { boundary, body } = multipartBody(file);
    let response;
    try {
        response = await fetch(DOCUMENT_UPLOAD_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body,
        });
    } catch (_) {
        throw serviceError('Could not upload the utility bill to Twilio', 502, 'DOCUMENT_UPLOAD_FAILED');
    }

    if (!response.ok) {
        throw serviceError('Could not upload the utility bill to Twilio', 502, 'DOCUMENT_UPLOAD_FAILED');
    }

    let document;
    try {
        document = await response.json();
    } catch (_) {
        throw serviceError('Twilio returned an invalid document response', 502, 'DOCUMENT_UPLOAD_FAILED');
    }
    if (!document?.sid || !document.mime_type) {
        throw serviceError('Twilio did not accept the utility bill', 502, 'DOCUMENT_UPLOAD_FAILED');
    }
    return document.sid;
}

function losingCarrierInformation(input) {
    const info = {
        customerName: input.customer_name,
        customerType: input.customer_type,
        authorizedRepresentative: input.authorized_representative,
        authorizedRepresentativeEmail: input.authorized_representative_email,
        address: {
            street: input.address_street,
            city: input.address_city,
            state: input.address_state,
            zip: input.address_zip,
            country: input.address_country,
        },
    };
    if (input.address_street2) info.address.street2 = input.address_street2;
    if (input.account_number) info.accountNumber = input.account_number;
    if (input.account_telephone_number) {
        info.accountTelephoneNumber = input.account_telephone_number;
    }
    return info;
}

async function insertSubmittedRequest(companyId, input, info, actorId) {
    try {
        const { rows } = await db.query(
            `INSERT INTO port_in_requests
                (company_id, phone_number, status, losing_carrier_info,
                 account_number, pin, account_telephone_number,
                 target_port_in_date, created_by)
             VALUES ($1, $2, 'submitted', $3::jsonb, $4, $5, $6, $7, $8)
             RETURNING ${selectColumns()}`,
            [
                companyId,
                input.phone_number,
                JSON.stringify(info),
                input.account_number || null,
                input.pin || null,
                input.account_telephone_number || null,
                input.target_port_in_date || null,
                actorId || null,
            ]
        );
        return rows[0];
    } catch (err) {
        if (err.code === '23505') {
            throw serviceError(
                'An active transfer request already exists for this number',
                409,
                'PORT_ALREADY_REQUESTED'
            );
        }
        throw err;
    }
}

function safeFailureNote(err) {
    return `${err?.code || ''} ${err?.message || 'Twilio request failed'}`
        .trim()
        .slice(0, 500);
}

async function updateFailure(companyId, requestId, status, twilioStatus, err) {
    await db.query(
        `UPDATE port_in_requests
         SET status = $3, twilio_status = $4, notes = $5, updated_at = now()
         WHERE id = $1 AND company_id = $2`,
        [requestId, companyId, status, twilioStatus, safeFailureNote(err)]
    );
}

function isPortingUnavailable(err) {
    const status = Number(err?.status);
    return Number(err?.code) === 20403 || status === 403 || status === 404;
}

async function createPortIn(companyId, input, file, { actorId } = {}) {
    const portability = await checkPortability(companyId, input.phone_number);
    if (!portability.portable) {
        const suffix = portability.reason ? `: ${portability.reason}` : '';
        throw serviceError(`This number cannot be transferred${suffix}`, 422, 'NOT_PORTABLE');
    }

    const targetSid = await targetAccountSid(companyId);
    const info = losingCarrierInformation(input);
    const submitted = await insertSubmittedRequest(companyId, input, info, actorId);

    let documentSid;
    try {
        documentSid = await uploadUtilityBill(file);
        await db.query(
            `UPDATE port_in_requests
             SET documents = $3::jsonb, updated_at = now()
             WHERE id = $1 AND company_id = $2`,
            [submitted.id, companyId, JSON.stringify([documentSid])]
        );
    } catch (err) {
        await updateFailure(companyId, submitted.id, 'failed', 'document_upload_failed', err);
        throw err;
    }

    const phoneNumber = { phoneNumber: input.phone_number };
    if (input.pin) phoneNumber.pin = input.pin;
    const createModel = {
        accountSid: targetSid,
        documents: [documentSid],
        phoneNumbers: [phoneNumber],
        losingCarrierInformation: info,
    };
    if (input.target_port_in_date) {
        createModel.targetPortInDate = input.target_port_in_date;
    }

    let created;
    try {
        created = await getTwilioClient().numbers.v1.portingPortIns.create({
            numbersV1PortingPortInCreate: createModel,
        });
    } catch (err) {
        if (isPortingUnavailable(err)) {
            await updateFailure(
                companyId,
                submitted.id,
                'action_required',
                'PORTING_UNAVAILABLE',
                err
            );
            throw serviceError(
                "Number transfers aren't automated for this account yet",
                502,
                'PORTING_UNAVAILABLE'
            );
        }
        await updateFailure(companyId, submitted.id, 'failed', 'create_failed', err);
        throw serviceError('Twilio could not start the number transfer', 502, 'PORT_IN_CREATE_FAILED');
    }

    if (!created?.portInRequestSid) {
        const invalidResponse = new Error('Twilio create response did not include a Port-In SID');
        await updateFailure(companyId, submitted.id, 'failed', 'create_failed', invalidResponse);
        throw serviceError('Twilio could not start the number transfer', 502, 'PORT_IN_CREATE_FAILED');
    }

    const remoteStatus = rawRemoteStatus(created);
    const { rows } = await db.query(
        `UPDATE port_in_requests
         SET status = $3,
             twilio_port_in_sid = $4,
             twilio_status = $5,
             signature_request_url = $6,
             notes = NULL,
             updated_at = now()
         WHERE id = $1 AND company_id = $2
         RETURNING ${selectColumns()}`,
        [
            submitted.id,
            companyId,
            normalizeStatus(remoteStatus),
            created.portInRequestSid,
            remoteStatus,
            created.signatureRequestUrl || null,
        ]
    );
    return publicRequest(rows[0]);
}

async function findRequest(companyId, requestId) {
    const { rows } = await db.query(
        `SELECT ${selectColumns()}
         FROM port_in_requests
         WHERE id = $1 AND company_id = $2`,
        [requestId, companyId]
    );
    return rows[0] || null;
}

async function refreshRequest(companyId, request) {
    if (!request.twilio_port_in_sid) return request;
    let remote;
    try {
        remote = await getTwilioClient().numbers.v1
            .portingPortIns(request.twilio_port_in_sid)
            .fetch();
    } catch (_) {
        throw serviceError('Twilio transfer status is temporarily unavailable', 502, 'PORT_IN_REFRESH_FAILED');
    }

    const remoteStatus = rawRemoteStatus(remote);
    const { rows } = await db.query(
        `UPDATE port_in_requests
         SET status = $3,
             twilio_status = $4,
             signature_request_url = COALESCE($5, signature_request_url),
             updated_at = now()
         WHERE id = $1 AND company_id = $2
         RETURNING ${selectColumns()}`,
        [
            request.id,
            companyId,
            normalizeStatus(remoteStatus),
            remoteStatus,
            remote.signatureRequestUrl || null,
        ]
    );
    return rows[0] || request;
}

async function listPortIns(companyId) {
    const { rows } = await db.query(
        `SELECT ${selectColumns()}
         FROM port_in_requests
         WHERE company_id = $1
         ORDER BY created_at DESC`,
        [companyId]
    );

    const refreshed = [];
    for (const request of rows) {
        if (!TERMINAL_STATUSES.has(request.status) && request.twilio_port_in_sid) {
            try {
                refreshed.push(await refreshRequest(companyId, request));
                continue;
            } catch (err) {
                console.warn(`[PortIn] status refresh failed (${request.id}):`, err.message);
            }
        }
        refreshed.push(request);
    }
    return refreshed.map(publicRequest);
}

async function getPortIn(companyId, requestId) {
    let request = await findRequest(companyId, requestId);
    if (!request) {
        throw serviceError('Transfer request not found', 404, 'NOT_FOUND');
    }
    if (request.twilio_port_in_sid) {
        try {
            request = await refreshRequest(companyId, request);
        } catch (err) {
            console.warn(`[PortIn] status refresh failed (${request.id}):`, err.message);
        }
    }
    return publicRequest(request);
}

async function cancelPortIn(companyId, requestId) {
    const request = await findRequest(companyId, requestId);
    if (!request) {
        throw serviceError('Transfer request not found', 404, 'NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(request.status)) {
        throw serviceError('This transfer can no longer be canceled', 409, 'NOT_CANCELABLE');
    }

    if (request.twilio_port_in_sid) {
        try {
            const removed = await getTwilioClient().numbers.v1
                .portingPortIns(request.twilio_port_in_sid)
                .remove();
            if (removed === false) {
                throw serviceError('Twilio did not cancel the transfer', 502, 'PORT_IN_CANCEL_FAILED');
            }
        } catch (err) {
            if (Number(err.status) !== 404) {
                if (err.httpStatus) throw err;
                throw serviceError('Twilio could not cancel the transfer', 502, 'PORT_IN_CANCEL_FAILED');
            }
        }
    }

    const { rows } = await db.query(
        `UPDATE port_in_requests
         SET status = 'canceled', twilio_status = 'canceled', updated_at = now()
         WHERE id = $1 AND company_id = $2
         RETURNING ${selectColumns()}`,
        [requestId, companyId]
    );
    return publicRequest(rows[0]);
}

module.exports = {
    checkPortability,
    createPortIn,
    listPortIns,
    getPortIn,
    cancelPortIn,
    normalizeStatus,
};
