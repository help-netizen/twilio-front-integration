/**
 * AssemblyAI Streaming Bridge — Real-time STT via WebSocket
 *
 * Connects to AssemblyAI Streaming v3, sends raw mulaw audio chunks,
 * receives Turn events (partial/final transcript segments).
 *
 * Each call can have 1 or 2 sessions (per audio track).
 */
const WebSocket = require('ws');

const AAI_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const CHUNK_FLUSH_MS = 100;        // flush buffered audio every 100ms
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;

class AssemblyAISession {
    /**
     * @param {Object} opts
     * @param {string} opts.apiKey      — AssemblyAI API key
     * @param {string} opts.callSid     — Twilio CallSid for logging
     * @param {string} opts.track       — 'inbound' | 'outbound'
     * @param {Function} opts.onTurn    — callback(turnData) for transcript turns
     * @param {Function} opts.onError   — callback(err) for errors
     * @param {Function} opts.onClose   — callback() when session fully closed
     */
    constructor({ apiKey, callSid, track, onTurn, onError, onClose }) {
        this.apiKey = apiKey;
        this.callSid = callSid;
        this.track = track;
        this.onTurn = onTurn;
        this.onError = onError || (() => { });
        this.onClose = onClose || (() => { });

        this.ws = null;
        this.sessionId = null;
        this.ready = false;
        this.terminated = false;
        this.reconnectAttempts = 0;

        // Audio chunk buffer
        this.buffer = Buffer.alloc(0);
        this.flushTimer = null;

        this._log('Creating session');
    }

    _log(msg, data) {
        const prefix = `[AAI:${this.callSid}:${this.track}]`;
        if (data) {
            console.log(`${prefix} ${msg}`, data);
        } else {
            console.log(`${prefix} ${msg}`);
        }
    }

    /**
     * Open WebSocket connection to AssemblyAI
     */
    connect() {
        if (this.terminated) return;

        const url = `${AAI_WS_BASE}?sample_rate=8000&encoding=pcm_mulaw`;

        this._log(`Connecting to ${url}`);

        this.ws = new WebSocket(url, {
            headers: { 'Authorization': this.apiKey }
        });

        this.ws.on('open', () => {
            this._log('WebSocket connected');
            this.reconnectAttempts = 0;
            this._startFlushTimer();
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                this._handleMessage(msg);
            } catch (e) {
                this._log('Failed to parse message', e.message);
            }
        });

        this.ws.on('error', (err) => {
            this._log('WebSocket error', err.message);
            this.onError(err);
        });

        this.ws.on('close', (code, reason) => {
            this._log(`WebSocket closed: ${code} ${reason}`);
            this._stopFlushTimer();

            if (!this.terminated && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                this.reconnectAttempts++;
                this._log(`Reconnecting (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                setTimeout(() => this.connect(), RECONNECT_DELAY_MS * this.reconnectAttempts);
            } else {
                this.onClose();
            }
        });
    }

    /**
     * Handle incoming AssemblyAI messages
     */
    _handleMessage(msg) {
        switch (msg.type) {
            case 'Begin':
                this.sessionId = msg.id;
                this.ready = true;
                this._log(`Session started: ${this.sessionId}`);
                break;

            case 'Turn':
                this.onTurn({
                    sessionId: this.sessionId,
                    track: this.track,
                    speaker: this.track === 'inbound' ? 'customer' : 'agent',
                    text: msg.transcript || '',
                    isFinal: msg.turn_is_formatted !== undefined ? msg.turn_is_formatted : true,
                    turnOrder: msg.turn_order,
                    startMs: msg.start,
                    endMs: msg.end,
                    words: msg.words || [],
                    receivedAt: new Date().toISOString()
                });
                break;

            case 'Termination':
                this._log('Termination received');
                this.terminated = true;
                this._stopFlushTimer();
                this.onClose();
                break;

            case 'Error':
                this._log('AssemblyAI error', msg);
                this.onError(new Error(msg.error || 'Unknown AssemblyAI error'));
                break;

            default:
                this._log('Unknown message type', msg.type);
        }
    }

    /**
     * Accept raw mulaw audio bytes and buffer them for batched sending
     * @param {Buffer} chunk — raw mulaw audio
     */
    sendAudio(chunk) {
        if (this.terminated || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.buffer = Buffer.concat([this.buffer, chunk]);
    }

    /**
     * Flush the audio buffer to AssemblyAI
     */
    _flush() {
        if (this.buffer.length === 0) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.ready) return;

        try {
            this.ws.send(this.buffer);
            this.buffer = Buffer.alloc(0);
        } catch (e) {
            this._log('Flush error', e.message);
        }
    }

    _startFlushTimer() {
        this._stopFlushTimer();
        this.flushTimer = setInterval(() => this._flush(), CHUNK_FLUSH_MS);
    }

    _stopFlushTimer() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * Gracefully terminate the session
     * Sends Terminate message and waits for Termination response
     */
    async terminate() {
        if (this.terminated) return;
        this._log('Sending Terminate');

        // Flush remaining audio
        this._flush();
        this._stopFlushTimer();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'Terminate' }));
            } catch (e) {
                this._log('Send Terminate error', e.message);
            }

            // Wait up to 5s for Termination
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    this._log('Termination timeout, forcing close');
                    this.terminated = true;
                    if (this.ws) this.ws.close();
                    resolve();
                }, 5000);

                const originalOnClose = this.onClose;
                this.onClose = () => {
                    clearTimeout(timeout);
                    originalOnClose();
                    resolve();
                };
            });
        } else {
            this.terminated = true;
            this.onClose();
        }
    }

    /**
     * Force close without graceful shutdown
     */
    destroy() {
        this.terminated = true;
        this._stopFlushTimer();
        if (this.ws) {
            try { this.ws.close(); } catch (_) { }
            this.ws = null;
        }
    }
}

module.exports = { AssemblyAISession };
