import { authedFetch } from '@/services/apiClient';
import type { Entity, GeminiEntity } from './callTypes';

interface TranscriptionState {
    setTranscriptionText: (text: string | null) => void;
    setEntities: (entities: Entity[]) => void;
    setSentimentScore: (score: number | null) => void;
    setGeminiSummary: (summary: string | null) => void;
    setGeminiEntities: (entities: GeminiEntity[]) => void;
    setGeminiStatus: (status: 'idle' | 'loading' | 'ready' | 'error') => void;
    setIsTranscribing: (v: boolean) => void;
    setTranscribeError: (msg: string | null) => void;
    setActiveGeminiIdx: (idx: number | null) => void;
    geminiLoadedRef: React.MutableRefObject<boolean>;
    mediaLoadedRef: React.MutableRefObject<boolean>;
}

function applyTranscriptData(data: any, state: TranscriptionState) {
    if (data.transcript) state.setTranscriptionText(data.transcript);
    if (data.entities) state.setEntities(data.entities);
    if (data.gemini_summary) { state.setGeminiSummary(data.gemini_summary); state.setGeminiEntities(data.gemini_entities || []); state.setGeminiStatus('ready'); }
    if (data.sentimentScore != null) state.setSentimentScore(data.sentimentScore);
}

export async function resetTranscription(callSid: string, state: TranscriptionState) {
    state.setIsTranscribing(true); state.setTranscribeError(null);
    try {
        await authedFetch(`/api/calls/${callSid}/transcript`, { method: 'DELETE' });
        state.setTranscriptionText(null); state.setEntities([]); state.setSentimentScore(null);
        state.setGeminiSummary(null); state.setGeminiEntities([]); state.setGeminiStatus('idle');
        state.setActiveGeminiIdx(null); state.geminiLoadedRef.current = false; state.mediaLoadedRef.current = false;
        const res = await authedFetch(`/api/calls/${callSid}/transcribe`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        applyTranscriptData(data, state);
    } catch (err: any) { state.setTranscribeError(err.message); }
    finally { state.setIsTranscribing(false); }
}

export async function generateTranscription(callSid: string, state: TranscriptionState) {
    state.setIsTranscribing(true); state.setTranscribeError(null);
    try {
        const res = await authedFetch(`/api/calls/${callSid}/transcribe`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        applyTranscriptData(data, state);
    } catch (err: any) { state.setTranscribeError(err.message); }
    finally { state.setIsTranscribing(false); }
}
