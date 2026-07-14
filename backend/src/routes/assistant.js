/**
 * CRM-expert assistant — ASSISTANT-BOT-001 A3.
 * Mounted at /api/assistant behind authenticate + requireCompanyAccess.
 */
'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');
const assistantService = require('../services/assistantService');
const db = require('../db/connection');

const router = express.Router();

const MAX_HISTORY_TURNS = 12;
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TEXT_CHARS = 4000;
const MAX_HISTORY_TOTAL_CHARS = 24000;
const MAX_SESSION_KEY_CHARS = 128;
const SESSION_KEY_RE = /^[A-Za-z0-9_-]+$/;

function validateBody(body) {
    if (!body || !Array.isArray(body.history)) return null;
    if (body.history.length > MAX_HISTORY_TURNS) return null;
    if (typeof body.message !== 'string') return null;

    const message = body.message.trim();
    if (!message || message.length > MAX_MESSAGE_CHARS) return null;

    let totalHistoryChars = 0;
    const history = [];
    for (const item of body.history) {
        if (!item || typeof item !== 'object') return null;
        if (item.role !== 'user' && item.role !== 'assistant') return null;
        if (typeof item.text !== 'string') return null;
        const text = item.text.trim();
        if (!text || text.length > MAX_HISTORY_TEXT_CHARS) return null;
        totalHistoryChars += text.length;
        if (totalHistoryChars > MAX_HISTORY_TOTAL_CHARS) return null;
        history.push({ role: item.role, text });
    }

    let sessionKey = null;
    if (body.session_key !== undefined) {
        if (typeof body.session_key !== 'string') return null;
        sessionKey = body.session_key.trim();
        if (!sessionKey || sessionKey.length > MAX_SESSION_KEY_CHARS
            || !SESSION_KEY_RE.test(sessionKey)) return null;
    }

    return {
        history,
        message,
        sessionKey: sessionKey || randomUUID(),
    };
}

async function writeTranscript({ sessionKey, message, result, telemetry }) {
    const toolsUsed = JSON.stringify([]);
    const tokenUsage = JSON.stringify(telemetry?.token_usage || {});
    await db.query(
        `WITH next_turn AS (
            SELECT COALESCE(MAX(turn_index) + 1, 0)::integer AS user_turn_index
            FROM assistant_transcripts
            WHERE session_key = $1
         )
         INSERT INTO assistant_transcripts
            (session_key, turn_index, role, text, tools_used, model, latency_ms, token_usage)
         SELECT $1, user_turn_index, 'user', $2, $3::jsonb, NULL, NULL, '{}'::jsonb
         FROM next_turn
         UNION ALL
         SELECT $1, user_turn_index + 1, 'assistant', $4, $3::jsonb, $5, $6, $7::jsonb
         FROM next_turn
         ON CONFLICT (session_key, turn_index) DO NOTHING`,
        [
            sessionKey,
            message,
            toolsUsed,
            result.reply,
            telemetry?.model || null,
            telemetry?.latency_ms ?? null,
            tokenUsage,
        ]
    );
}

router.post('/chat', async (req, res) => {
    const input = validateBody(req.body);
    if (!input) {
        return res.status(400).json({ error: 'Invalid assistant chat request' });
    }

    const companyId = req.companyFilter?.company_id;
    if (!companyId) {
        return res.status(403).json({ error: 'Company access required' });
    }

    try {
        const result = await assistantService.chat({
            companyId,
            history: input.history,
            message: input.message,
        });
        const telemetry = assistantService.consumeChatTelemetry(result);

        res.status(200).json(result);
        setImmediate(() => {
            writeTranscript({
                sessionKey: input.sessionKey,
                message: input.message,
                result,
                telemetry,
            }).catch(err => {
                console.warn('[AssistantRoute] Best-effort transcript write failed:', err.message);
            });
        });
        return undefined;
    } catch (err) {
        if (err?.status === 429) {
            return res.status(429).json({
                reply: "I've reached the assistant limit for now. Please try again shortly or send this to our support team.",
                escalate: true,
            });
        }
        console.error('[AssistantRoute] Chat failed:', err.message);
        return res.status(503).json({
            reply: "I'm unable to answer right now. Let me hand this to a person.",
            escalate: true,
        });
    }
});

module.exports = router;
