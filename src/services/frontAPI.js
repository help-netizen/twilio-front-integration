const axios = require('axios');

/**
 * Front Channel API Client
 * 
 * Handles communication with Front's Channel API for syncing inbound and outbound messages.
 * Uses JWT authentication for all requests.
 */
class FrontChannelAPI {
    constructor(jwtService, options = {}) {
        this.jwtService = jwtService;
        this.baseURL = options.baseURL || 'https://api2.frontapp.com';
        this.timeout = options.timeout || 30000; // 30 seconds
    }

    /**
     * Sync an inbound message to Front (message received by the channel)
     * @param {string} channelId - Front channel ID
     * @param {object} messageData - Message payload
     * @returns {Promise<object>} Response with message_uid
     */
    async syncInboundMessage(channelId, messageData) {
        const token = this.jwtService.generateChannelToken(channelId);

        try {
            const response = await axios.post(
                `${this.baseURL}/channels/${channelId}/inbound_messages`,
                messageData,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: this.timeout
                }
            );

            return response.data;
        } catch (error) {
            this._handleError(error, 'syncInboundMessage');
        }
    }

    /**
     * Sync an outbound message to Front (message sent from the channel)
     * @param {string} channelId - Front channel ID
     * @param {object} messageData - Message payload
     * @returns {Promise<object>} Response with message_uid
     */
    async syncOutboundMessage(channelId, messageData) {
        const token = this.jwtService.generateChannelToken(channelId);

        try {
            const response = await axios.post(
                `${this.baseURL}/channels/${channelId}/outbound_messages`,
                messageData,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: this.timeout
                }
            );

            return response.data;
        } catch (error) {
            this._handleError(error, 'syncOutboundMessage');
        }
    }

    /**
     * Update message status in Front
     * @param {string} channelId - Front channel ID
     * @param {string} externalMessageId - External message ID
     * @param {object} statusData - Status update payload
     * @returns {Promise<object>} Response
     */
    async updateMessageStatus(channelId, externalMessageId, statusData) {
        const token = this.jwtService.generateChannelToken(channelId);

        try {
            const response = await axios.patch(
                `${this.baseURL}/channels/${channelId}/messages/${externalMessageId}`,
                statusData,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: this.timeout
                }
            );

            return response.data;
        } catch (error) {
            this._handleError(error, 'updateMessageStatus');
        }
    }

    /**
     * Handle API errors with detailed logging
     * @private
     */
    _handleError(error, operation) {
        if (error.response) {
            // Front API returned an error response
            const { status, data } = error.response;
            const errorMessage = `Front API error in ${operation}: ${status} - ${JSON.stringify(data)}`;

            console.error(errorMessage);

            const customError = new Error(errorMessage);
            customError.status = status;
            customError.data = data;
            throw customError;
        } else if (error.request) {
            // Request was made but no response received
            const errorMessage = `Front API no response in ${operation}: ${error.message}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        } else {
            // Error in request setup
            const errorMessage = `Front API request error in ${operation}: ${error.message}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
    }
}

module.exports = FrontChannelAPI;
