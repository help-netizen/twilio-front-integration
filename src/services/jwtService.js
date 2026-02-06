const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * JWT Service for generating Front Channel API authentication tokens
 * 
 * Front Channel API requires JWT Bearer tokens with specific claims:
 * - iss: App UID
 * - jti: Random unique identifier
 * - sub: Channel ID
 * - exp: Expiration timestamp
 */
class JWTService {
  constructor(appUid, appSecret) {
    if (!appUid || !appSecret) {
      throw new Error('JWTService requires appUid and appSecret');
    }
    this.appUid = appUid;
    this.appSecret = appSecret;
  }

  /**
   * Generate a JWT token for authenticating requests to Front Channel API
   * @param {string} channelId - Front channel ID (e.g., "cha_123abc")
   * @param {number} expiresIn - Token expiration in seconds (default: 300s = 5 min)
   * @returns {string} JWT token
   */
  generateChannelToken(channelId, expiresIn = 300) {
    if (!channelId) {
      throw new Error('channelId is required');
    }

    const now = Math.floor(Date.now() / 1000);
    
    const payload = {
      iss: this.appUid,                           // Issuer: Front App UID
      jti: crypto.randomBytes(16).toString('hex'), // JWT ID: Random unique ID
      sub: channelId,                              // Subject: Channel ID
      exp: now + expiresIn                         // Expiration time
    };

    const token = jwt.sign(payload, this.appSecret, {
      algorithm: 'HS256'
    });

    return token;
  }

  /**
   * Verify a JWT token (useful for testing)
   * @param {string} token - JWT token to verify
   * @returns {object} Decoded payload
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, this.appSecret, {
        algorithms: ['HS256']
      });
    } catch (error) {
      throw new Error(`Invalid token: ${error.message}`);
    }
  }
}

module.exports = JWTService;
