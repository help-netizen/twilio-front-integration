'use strict';

// One eligibility set feeds both halves of the tokenless safety path: the SIP
// address Twilio dials and the assistant Vapi asks us to select. Do not add a
// predicate to only one caller; that creates a leg that rings but cannot answer.
function eligibleResourcePredicate(resourceAlias = 'resource', connectionAlias = 'connection') {
    return `${resourceAlias}.company_id = $1
       AND ${resourceAlias}.is_active = true
       AND NULLIF(BTRIM(${resourceAlias}.sip_uri), '') IS NOT NULL
       AND ${connectionAlias}.company_id = ${resourceAlias}.company_id
       AND ${connectionAlias}.id = ${resourceAlias}.provider_connection_id
       AND ${connectionAlias}.provider = 'vapi'
       AND ${connectionAlias}.status = 'active'`;
}

function preferredResourceOrder(resourceAlias = 'resource') {
    return `CASE
                WHEN ${resourceAlias}.purpose = 'inbound_call'
                 AND ${resourceAlias}.environment = 'prod' THEN 0
                ELSE 1
            END,
            ${resourceAlias}.created_at DESC,
            ${resourceAlias}.id`;
}

module.exports = {
    eligibleResourcePredicate,
    preferredResourceOrder,
};
