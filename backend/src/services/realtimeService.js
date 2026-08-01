/**
 * Realtime Events Service (Server-Sent Events)
 * 
 * Manages SSE connections and broadcasts call updates to connected clients.
 * Clients subscribe via GET /events/calls and receive updates when calls change.
 */

const EventEmitter = require('events');
const { projectRealtimePayload } = require('./realtimePayloadPolicy');

class RealtimeService extends EventEmitter {
    constructor() {
        super();
        this.clients = new Map(); // connectionId -> response object
        this.lastEventId = 0;
        this.keepAliveInterval = null;

        // Statistics
        this.stats = {
            connections: 0,
            totalConnections: 0,
            eventsSent: 0,
            errors: 0
        };

        // Start keepalive heartbeat
        this.startKeepAlive();
    }

    /**
     * Add SSE client connection
     */
    addClient(req, res, { maskViewer = false } = {}) {
        const connectionId = ++this.stats.totalConnections;
        const companyId = req.companyFilter?.company_id || null;
        if (!companyId) {
            throw new Error('SSE company context required');
        }

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no' // Disable nginx buffering
        });

        // Send initial connection event
        this.sendEvent(res, 'connected', { connectionId, timestamp: new Date() });

        // Store client
        this.clients.set(connectionId, {
            res,
            companyId,
            maskViewer: maskViewer === true,
            connectedAt: new Date(),
            lastEventAt: new Date(),
            ip: req.ip || req.connection.remoteAddress
        });

        this.stats.connections = this.clients.size;

        console.log(`[SSE] Client ${connectionId} connected (${this.stats.connections} total)`);

        // Handle client disconnect
        req.on('close', () => {
            this.removeClient(connectionId);
        });

        return connectionId;
    }

    /**
     * Remove client connection
     */
    removeClient(connectionId) {
        const client = this.clients.get(connectionId);
        if (client) {
            try {
                client.res.end();
            } catch (e) {
                // Client already disconnected
            }
            this.clients.delete(connectionId);
            this.stats.connections = this.clients.size;
            console.log(`[SSE] Client ${connectionId} disconnected (${this.stats.connections} remaining)`);
        }
    }

    /**
     * Send event to specific client
     */
    sendEvent(res, eventType, data) {
        try {
            const eventId = ++this.lastEventId;
            const payload = JSON.stringify(data);

            res.write(`id: ${eventId}\n`);
            res.write(`event: ${eventType}\n`);
            res.write(`data: ${payload}\n\n`);

            this.stats.eventsSent++;
            return true;
        } catch (error) {
            console.error('[SSE] Error sending event:', error);
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Broadcast event to all connected clients
     */
    broadcast(eventType, data, explicitCompanyId = null) {
        let sent = 0;
        let failed = 0;
        const companyId = explicitCompanyId
            || data?.company_id
            || data?.companyId
            || data?.call?.company_id
            || data?.message?.company_id
            || data?.conversation?.company_id
            || data?.job?.company_id
            || data?.task?.company_id
            || null;

        // Fail closed: an unscoped tenant event must never fall back to a
        // process-wide fan-out. Producers should pass the company explicitly or
        // include it in the payload/entity used to publish the event.
        if (!companyId) {
            console.warn(`[SSE] Dropped unscoped ${eventType} event`);
            return { sent, failed };
        }

        const projectedData = projectRealtimePayload(eventType, companyId, data);
        if (!projectedData) {
            console.warn(`[SSE] Dropped non-allowlisted ${eventType} event`);
            return { sent, failed };
        }

        for (const [connectionId, client] of this.clients.entries()) {
            if (String(client.companyId) !== String(companyId)) continue;
            const success = this.sendEvent(client.res, eventType, projectedData);
            if (success) {
                client.lastEventAt = new Date();
                sent++;
            } else {
                this.removeClient(connectionId);
                failed++;
            }
        }

        if (sent > 0 || failed > 0) {
            console.log(`[SSE] Broadcast ${eventType}: ${sent} sent, ${failed} failed`);
        }

        return { sent, failed };
    }

    /**
     * Publish a call cache invalidation.
     */
    publishCallUpdate(data) {
        const eventType = data.eventType || 'call.updated';
        const companyId = data.company_id || data.companyId || null;
        this.broadcast(eventType, {
            company_id: companyId,
        }, companyId);
    }

    /**
     * Publish a call cache invalidation.
     */
    publishCallCreated(call) {
        this.broadcast('call.created', {
            company_id: call.company_id || call.companyId || null,
        }, call.company_id || call.companyId || null);
    }

    // ─── Messaging SSE events ───

    /**
     * Broadcast a message cache invalidation.
     */
    publishMessageAdded(message, conversation, timelineId) {
        const companyId = message?.company_id || conversation?.company_id || null;
        this.broadcast('message.added', {
            company_id: companyId,
        }, companyId);
    }

    /**
     * Broadcast a message cache invalidation.
     */
    publishMessageDelivery(messageSid, status, errorCode, companyId = null) {
        this.broadcast('message.delivery', {
            company_id: companyId,
        }, companyId);
    }

    /**
     * Broadcast a conversation cache invalidation.
     */
    publishConversationUpdate(conversation) {
        this.broadcast('conversation.updated', {
            company_id: conversation?.company_id || null,
        }, conversation?.company_id || null);
    }

    // ─── Jobs SSE events ───

    /**
     * Broadcast a job cache invalidation.
     */
    publishJobUpdate(job) {
        this.broadcast('job.updated', {
            company_id: job?.company_id || null,
        }, job?.company_id || null);
    }

    /**
     * Send keepalive ping to all clients
     */
    sendKeepAlive() {
        for (const [connectionId, client] of this.clients.entries()) {
            try {
                client.res.write(': keepalive\n\n');
            } catch (error) {
                console.warn(`[SSE] Keepalive failed for client ${connectionId}, removing`);
                this.removeClient(connectionId);
            }
        }
    }

    /**
     * Start keepalive heartbeat
     */
    startKeepAlive() {
        // Send keepalive every 30 seconds
        this.keepAliveInterval = setInterval(() => {
            if (this.clients.size > 0) {
                this.sendKeepAlive();
            }
        }, 30000);
    }

    /**
     * Stop keepalive heartbeat
     */
    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    /**
     * Get service statistics
     */
    getStats() {
        return {
            ...this.stats,
            uptime: process.uptime(),
            clients: Array.from(this.clients.entries()).map(([id, client]) => ({
                id,
                connectedAt: client.connectedAt,
                lastEventAt: client.lastEventAt,
                ip: client.ip
            }))
        };
    }

    /**
     * Shutdown service
     */
    shutdown() {
        console.log('[SSE] Shutting down...');
        this.stopKeepAlive();

        // Close all connections
        for (const [connectionId, client] of this.clients.entries()) {
            this.sendEvent(client.res, 'shutdown', { message: 'Server shutting down' });
            this.removeClient(connectionId);
        }
    }
}

// Singleton instance
const realtimeService = new RealtimeService();

module.exports = realtimeService;
