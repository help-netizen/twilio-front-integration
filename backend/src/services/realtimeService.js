/**
 * Realtime Events Service (Server-Sent Events)
 * 
 * Manages SSE connections and broadcasts call updates to connected clients.
 * Clients subscribe via GET /events/calls and receive updates when calls change.
 */

const EventEmitter = require('events');

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
    addClient(req, res) {
        const connectionId = ++this.stats.totalConnections;

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
    broadcast(eventType, data) {
        let sent = 0;
        let failed = 0;

        for (const [connectionId, client] of this.clients.entries()) {
            const success = this.sendEvent(client.res, eventType, data);
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
     * Publish call update event
     */
    publishCallUpdate(call) {
        this.broadcast('call.updated', {
            call_sid: call.twilio_sid,
            status: call.status,
            is_final: call.is_final,
            updated_at: call.updated_at
        });
    }

    /**
     * Publish call created event
     */
    publishCallCreated(call) {
        this.broadcast('call.created', {
            call_sid: call.twilio_sid,
            status: call.status,
            from_number: call.from_number,
            to_number: call.to_number,
            created_at: call.start_time
        });
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
