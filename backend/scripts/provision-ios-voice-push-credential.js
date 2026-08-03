#!/usr/bin/env node
/**
 * SOFTPHONE-NATIVE-001: create/update the APN Push Credential on the same
 * master/subaccount that mints the target company's Voice tokens.
 *
 * Usage:
 *   node backend/scripts/provision-ios-voice-push-credential.js \
 *     --company <uuid> --cert <voip-cert.pem> --key <private-key.pem> [--sandbox]
 *   node backend/scripts/provision-ios-voice-push-credential.js \
 *     --master --cert <voip-cert.pem> --key <private-key.pem> [--sandbox]
 *
 * The default is production APNs (Sandbox=false). Certificate/private-key
 * contents are sent to Twilio but never printed or persisted by Albusto.
 */

const fs = require('fs/promises');
const telephonyTenantService = require('../src/services/telephonyTenantService');

function parseArgs(argv) {
    const args = { sandbox: false, master: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--sandbox') args.sandbox = true;
        else if (argv[i] === '--master') args.master = true;
        else if (argv[i] === '--company') args.companyId = argv[++i];
        else if (argv[i] === '--cert') args.certPath = argv[++i];
        else if (argv[i] === '--key') args.keyPath = argv[++i];
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    if (args.master === Boolean(args.companyId)) {
        throw new Error('Specify exactly one of --master or --company <uuid>');
    }
    if (!args.certPath || !args.keyPath) {
        throw new Error('--cert and --key PEM paths are required');
    }
    return args;
}

function validatePem(certificate, privateKey) {
    if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----')) {
        throw new Error('Certificate file does not contain a PEM certificate');
    }
    if (!privateKey.includes('-----BEGIN') || !privateKey.includes('PRIVATE KEY-----')) {
        throw new Error('Private-key file does not contain a PEM private key');
    }
}

function isTwilioNotFound(error) {
    return error?.status === 404 || error?.statusCode === 404 || error?.code === 20404;
}

async function provisionIosPushCredential({ companyId, certificate, privateKey, sandbox = false }) {
    const tenant = await telephonyTenantService.getClientForCompany(companyId);
    const existingSid = await telephonyTenantService.getIosPushCredentialSid(companyId);
    const attributes = {
        friendlyName: `Albusto Voice iOS ${sandbox ? 'Sandbox' : 'Production'}`,
        certificate,
        privateKey,
        sandbox,
    };

    let credential;
    if (existingSid) {
        try {
            credential = await tenant.client.chat.v2.credentials(existingSid).update(attributes);
        } catch (error) {
            if (!isTwilioNotFound(error)) throw error;
        }
    }
    if (!credential) {
        credential = await tenant.client.chat.v2.credentials.create({ type: 'apn', ...attributes });
    }
    await telephonyTenantService.setIosPushCredentialSid(companyId, credential.sid);
    return credential.sid;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const companyId = args.master
        ? telephonyTenantService.DEFAULT_COMPANY_ID
        : args.companyId;
    const [certificate, privateKey] = await Promise.all([
        fs.readFile(args.certPath, 'utf8'),
        fs.readFile(args.keyPath, 'utf8'),
    ]);
    validatePem(certificate, privateKey);
    const sid = await provisionIosPushCredential({
        companyId,
        certificate,
        privateKey,
        sandbox: args.sandbox,
    });
    console.log(sid);
}

if (require.main === module) {
    const db = require('../src/db/connection');
    main()
        .catch(error => {
            // Do not print provider error messages: they may echo request data.
            console.error('iOS Voice Push Credential provisioning failed:', error?.code || error?.name || 'UNKNOWN');
            process.exitCode = 1;
        })
        .finally(() => db.pool.end().catch(() => {}));
}

module.exports = {
    parseArgs,
    validatePem,
    provisionIosPushCredential,
};
