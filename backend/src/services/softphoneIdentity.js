function encodeIdentityPart(value) {
    return Buffer.from(String(value), 'utf8').toString('base64url');
}

function decodeIdentityPart(value) {
    return Buffer.from(String(value), 'base64url').toString('utf8');
}

function buildSoftphoneIdentity(companyId, userId) {
    if (!companyId || !userId) {
        throw new Error('Softphone identity requires companyId and userId');
    }
    return `user_${encodeIdentityPart(companyId)}_${encodeIdentityPart(userId)}`;
}

function parseSoftphoneIdentity(value) {
    const raw = String(value || '').replace(/^client:/, '');
    const match = raw.match(/^user_([^_]+)_([^_]+)$/);
    if (!match) return null;

    try {
        return {
            identity: raw,
            companyId: decodeIdentityPart(match[1]),
            userId: decodeIdentityPart(match[2]),
        };
    } catch {
        return null;
    }
}

module.exports = {
    buildSoftphoneIdentity,
    parseSoftphoneIdentity,
};
