/**
 * queries.js — Re-export Facade
 *
 * RF006: This file is now a backward-compatible facade that delegates to
 * feature-specific query modules. All existing consumers continue to work
 * unchanged via `require('../db/queries')`.
 *
 * New code should import directly from the feature module:
 *   const { upsertCall } = require('../db/callsQueries');
 *   const { findOrCreateTimeline } = require('../db/timelinesQueries');
 */

const callsQueries = require('./callsQueries');
const contactsQueries = require('./contactsQueries');
const timelinesQueries = require('./timelinesQueries');
const webhookSyncQueries = require('./webhookSyncQueries');

module.exports = {
    // ── Contacts ──────────────────────────────────────────────────────
    findContactByPhone: contactsQueries.findContactByPhone,
    createContact: contactsQueries.createContact,
    findOrCreateContact: contactsQueries.findOrCreateContact,
    findContactByPhoneOrSecondary: contactsQueries.findContactByPhoneOrSecondary,
    markContactUnread: contactsQueries.markContactUnread,
    markContactRead: contactsQueries.markContactRead,

    // ── Timelines ────────────────────────────────────────────────────
    markTimelineUnread: timelinesQueries.markTimelineUnread,
    markTimelineRead: timelinesQueries.markTimelineRead,
    findOrCreateTimeline: timelinesQueries.findOrCreateTimeline,
    getCallsByTimeline: timelinesQueries.getCallsByTimeline,
    getTimelinesWithCallsCount: timelinesQueries.getTimelinesWithCallsCount,

    // ── Action Required + Tasks ──────────────────────────────────────
    setActionRequired: timelinesQueries.setActionRequired,
    markThreadHandled: timelinesQueries.markThreadHandled,
    snoozeThread: timelinesQueries.snoozeThread,
    unsnoozeExpiredThreads: timelinesQueries.unsnoozeExpiredThreads,
    assignThread: timelinesQueries.assignThread,
    createTask: timelinesQueries.createTask,
    getOpenTaskByThread: timelinesQueries.getOpenTaskByThread,

    // ── Calls ────────────────────────────────────────────────────────
    upsertCall: callsQueries.upsertCall,
    getCallByCallSid: callsQueries.getCallByCallSid,
    getCalls: callsQueries.getCalls,
    getCallsByContact: callsQueries.getCallsByContact,
    getContactsWithCallsCount: callsQueries.getContactsWithCallsCount,
    getCallsByContactId: callsQueries.getCallsByContactId,
    getActiveCalls: callsQueries.getActiveCalls,
    getNonFinalCalls: callsQueries.getNonFinalCalls,

    // ── Recordings ───────────────────────────────────────────────────
    upsertRecording: callsQueries.upsertRecording,
    getRecordingsByCallSid: callsQueries.getRecordingsByCallSid,

    // ── Transcripts ──────────────────────────────────────────────────
    upsertTranscript: callsQueries.upsertTranscript,
    getTranscriptsByCallSid: callsQueries.getTranscriptsByCallSid,

    // ── Call events ──────────────────────────────────────────────────
    appendCallEvent: callsQueries.appendCallEvent,
    getCallEvents: callsQueries.getCallEvents,

    // ── Webhook inbox ────────────────────────────────────────────────
    insertInboxEvent: webhookSyncQueries.insertInboxEvent,
    claimInboxEvents: webhookSyncQueries.claimInboxEvents,
    markInboxProcessed: webhookSyncQueries.markInboxProcessed,
    markInboxFailed: webhookSyncQueries.markInboxFailed,

    // ── Sync state ───────────────────────────────────────────────────
    getSyncState: webhookSyncQueries.getSyncState,
    upsertSyncState: webhookSyncQueries.upsertSyncState,

    // ── Aggregation ──────────────────────────────────────────────────
    getCallMedia: callsQueries.getCallMedia,
    getSyncHealth: webhookSyncQueries.getSyncHealth,
};
