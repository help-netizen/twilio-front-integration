import { describe, expect, it } from 'vitest';
import appSource from '../App.tsx?raw';
import callListSource from '../components/conversations/ConversationList.tsx?raw';
import audioPlayerSource from '../components/pulse/PulseCallAudioPlayer.tsx?raw';
import conversationPageSource from '../pages/ConversationPage.tsx?raw';
import jobDetailSource from './useJobDetail.ts?raw';
import jobsPageSource from './useJobsPage.ts?raw';
import messagesSource from '../pages/useMessagesRealtime.ts?raw';
import pulseSource from './usePulsePage.ts?raw';
import twilioDeviceSource from './useTwilioDevice.ts?raw';
import groupDetailSource from '../pages/telephony/UserGroupDetailPage.tsx?raw';
import groupsSource from '../pages/telephony/UserGroupsPage.tsx?raw';

describe('PII-free realtime invalidation wiring', () => {
    it('does not mount the retired SSE notification bridge', () => {
        expect(appSource).not.toContain('SSEPushBridge');
    });

    it('refetches Pulse and finalized transcripts without consuming record payloads', () => {
        expect(pulseSource).toContain('onCallUpdate: refreshPulseData');
        expect(pulseSource).toContain('onMessageAdded: refreshPulseData');
        expect(pulseSource).toContain('onTranscriptFinalized: refreshOpenTimeline');
        expect(pulseSource).not.toContain('onTranscriptDelta');
        expect(pulseSource).not.toContain('event.contact_id');
        expect(pulseSource).not.toContain('event.timelineId');
    });

    it('invalidates scoped call queries instead of inserting call DTOs', () => {
        for (const source of [callListSource, conversationPageSource]) {
            expect(source).toContain('invalidateQueries');
            expect(source).not.toContain('setQueryData');
            expect(source).not.toContain('event.call_sid');
            expect(source).not.toContain('event.contact_id');
        }
    });

    it('refetches messages and jobs without reading stripped records', () => {
        expect(messagesSource).toContain('onMessageAdded: refreshMessagesData');
        expect(messagesSource).not.toContain('event.message');
        expect(messagesSource).not.toContain('event.conversation');
        // JOB-NUMBERING-001: refetch by the resolved real id (job?.id ?? jobId), never the
        // SSE event payload — still a PII-free fresh fetch, just not the raw URL param.
        expect(jobDetailSource).toContain('void refreshJob(id)');
        expect(jobDetailSource).not.toContain('event.job');
        expect(jobsPageSource).toContain('void data.resetJobs()');
        expect(jobsPageSource).not.toContain('event.job');
    });

    it('fails the dead call.holding branch closed and refetches agent presence', () => {
        expect(twilioDeviceSource).not.toContain('call.holding');
        expect(twilioDeviceSource).not.toContain('data.from_number');
        expect(groupsSource).toContain('void fetchGroups()');
        expect(groupDetailSource).toContain('void loadGroup()');
        for (const source of [groupsSource, groupDetailSource]) {
            expect(source).not.toContain('data.groupIds');
            expect(source).not.toContain('data.userId');
            expect(source).not.toContain('data.status');
        }
    });

    it('renders only persisted transcript content', () => {
        expect(audioPlayerSource).not.toContain('useLiveTranscript');
        expect(audioPlayerSource).not.toContain('isLiveStreaming');
        expect(audioPlayerSource).toContain('call.transcription');
    });
});
