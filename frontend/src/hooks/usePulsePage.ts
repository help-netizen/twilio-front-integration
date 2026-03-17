import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useCallsByContact } from './useConversations';
import { usePulseTimeline } from './usePulseTimeline';
import { messagingApi } from '../services/messagingApi';
import * as contactsApi from '../services/contactsApi';
import { useRealtimeEvents, type SSECallEvent, type SSETranscriptDeltaEvent, type SSETranscriptFinalizedEvent } from './useRealtimeEvents';
import { appendTranscriptDelta, finalizeTranscript } from './useLiveTranscript';
import { authedFetch } from '../services/apiClient';
import { useLeadByPhone } from './useLeadByPhone';
import { callToCallData } from '../components/pulse/pulseHelpers';
import { makePulseLeadActions } from './pulseLeadActions';
import type { Call } from '../types/models';
import type { Lead } from '../types/lead';
import type { ContactLead } from '../types/contact';

export function usePulsePage() {
    const { id } = useParams<{ id: string }>();
    const location = useLocation();
    const isTimelineRoute = location.pathname.startsWith('/pulse/timeline/');
    const timelineId = isTimelineRoute ? parseInt(id || '0') : 0;
    const contactId = isTimelineRoute ? 0 : parseInt(id || '0');

    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => { if (debounceTimer.current) clearTimeout(debounceTimer.current); debounceTimer.current = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300); return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); }; }, [searchQuery]);

    const { data: contactData, isLoading: contactsLoading, refetch: refetchContacts, fetchNextPage, hasNextPage, isFetchingNextPage } = useCallsByContact(debouncedSearch || undefined);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { if (!loadMoreRef.current) return; const obs = new IntersectionObserver(entries => { if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage(); }, { threshold: 0.1 }); obs.observe(loadMoreRef.current); return () => obs.disconnect(); }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    const { data: timelineData, isLoading: timelineLoading, refetch: refetchTimeline } = usePulseTimeline(contactId, timelineId || undefined);

    useRealtimeEvents({
        onCallUpdate: (event: SSECallEvent) => { if (event.parent_call_sid) return; refetchContacts(); if ((contactId && event.contact_id && Number(event.contact_id) === contactId) || (timelineId && event.timeline_id && Number(event.timeline_id) === timelineId)) refetchTimeline(); },
        onCallCreated: () => refetchContacts(),
        onMessageAdded: () => { refetchContacts(); if (contactId || timelineId) refetchTimeline(); },
        onContactRead: () => refetchContacts(),
        onGenericEvent: (et: string) => { if (['thread.action_required', 'thread.handled', 'thread.snoozed', 'thread.unsnoozed', 'thread.assigned', 'timeline.read', 'timeline.unread'].includes(et)) refetchContacts(); },
        onTranscriptDelta: (e: SSETranscriptDeltaEvent) => { appendTranscriptDelta(e.callSid, { text: e.text, speaker: e.speaker, turnOrder: e.turnOrder, isFinal: e.isFinal, receivedAt: e.receivedAt }); },
        onTranscriptFinalized: (e: SSETranscriptFinalizedEvent) => { finalizeTranscript(e.callSid, e.text); if (contactId || timelineId) refetchTimeline(); },
    });

    const filteredCalls = useMemo(() => { const raw = contactData?.conversations || []; const seen = new Map<string, number>(); const deduped: Call[] = []; for (const c of raw) { const p = c.contact?.phone_e164 || c.from_number || ''; const d = p.replace(/\D/g, ''); if (!d) { deduped.push(c); continue; } if (!seen.has(d)) { seen.set(d, deduped.length); deduped.push(c); } } return deduped; }, [contactData?.conversations]);

    const callDataItems = useMemo(() => (timelineData?.calls || []).map(callToCallData), [timelineData?.calls]);
    const messages = timelineData?.messages || [];
    const conversations = timelineData?.conversations || [];
    const contactCalls = timelineData?.calls || [];
    const contact = (timelineData as any)?.contact || contactCalls[0]?.contact;
    const selectedConv = filteredCalls.find((c: Call) => { const tlId = (c as any).timeline_id; return tlId ? Number(tlId) === timelineId : c.contact?.id === contactId; });
    const phone = contact?.phone_e164 || (selectedConv as any)?.tl_phone || contactCalls[0]?.from_number || contactCalls[0]?.to_number || selectedConv?.contact?.phone_e164 || selectedConv?.from_number || conversations[0]?.customer_e164 || '';
    const hasActiveCall = contactCalls.some((c: any) => ['ringing', 'in-progress', 'queued', 'initiated', 'voicemail_recording'].includes(c.status));

    const { lead: fetchedLead, isLoading: leadLoading } = useLeadByPhone(phone || undefined);
    const [leadOverride, setLeadOverride] = useState<Lead | null>(null);
    const [editingLead, setEditingLead] = useState<Lead | null>(null);
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [selectedToPhone, setSelectedToPhone] = useState<string>('');
    const lead = leadOverride || fetchedLead;
    React.useEffect(() => { setLeadOverride(null); setSelectedToPhone(''); }, [phone]);

    const [contactDetail, setContactDetail] = useState<{ contact: any; leads: ContactLead[] } | null>(null);
    const [contactDetailLoading, setContactDetailLoading] = useState(false);
    React.useEffect(() => { if (lead || leadLoading || !contact?.id) { setContactDetail(null); return; } let cancelled = false; setContactDetailLoading(true); contactsApi.getContact(contact.id).then(res => { if (!cancelled) setContactDetail({ contact: res.data.contact, leads: res.data.leads }); }).catch(() => { if (!cancelled) setContactDetail(null); }).finally(() => { if (!cancelled) setContactDetailLoading(false); }); return () => { cancelled = true; }; }, [lead, leadLoading, contact?.id]);

    const secondaryPhone = lead?.SecondPhone || contact?.secondary_phone || '';
    const secondaryPhoneName = lead?.SecondPhoneName || contact?.secondary_phone_name || '';
    const normalizeDigits = (p: string) => (p || '').replace(/\D/g, '');

    const lastUsedPhone = useMemo(() => {
        if (!phone || !secondaryPhone) return phone;
        const mainD = normalizeDigits(phone), secD = normalizeDigits(secondaryPhone);
        if (!secD || mainD === secD) return phone;
        type PE = { phone: string; time: number };
        const events: PE[] = [];
        for (const msg of messages) { const mp = msg.direction === 'inbound' ? msg.from_number : msg.to_number; if (mp) { const d = normalizeDigits(mp); if (d === mainD) events.push({ phone, time: new Date(msg.date_created_remote || msg.created_at).getTime() }); else if (d === secD) events.push({ phone: secondaryPhone, time: new Date(msg.date_created_remote || msg.created_at).getTime() }); } }
        for (const call of contactCalls) { const cp = call.direction?.includes('inbound') ? call.from_number : call.to_number; if (cp) { const d = normalizeDigits(cp), t = new Date(call.started_at || call.created_at).getTime(); if (d === mainD) events.push({ phone, time: t }); else if (d === secD) events.push({ phone: secondaryPhone, time: t }); } }
        if (events.length === 0) return phone;
        events.sort((a, b) => b.time - a.time);
        return events[0].phone;
    }, [phone, secondaryPhone, messages, contactCalls]);

    React.useEffect(() => { if (lastUsedPhone && !selectedToPhone) setSelectedToPhone(lastUsedPhone); }, [lastUsedPhone, selectedToPhone]);

    const actions = makePulseLeadActions(setLeadOverride);
    const handleConvert = (_uuid: string) => { if (lead) setConvertingLead(lead); };
    const handleConvertSuccess = async (updatedLead: Lead) => { await actions.handleConvertSuccess(updatedLead); setConvertingLead(null); };
    const handleDelete = async (uuid: string) => { await actions.handleMarkLost(uuid); };
    const handleUpdateLead = async (updatedLead: Lead) => { setLeadOverride(updatedLead); setEditingLead(null); toast.success('Lead updated'); };

    const derivedProxy = useMemo(() => { if (conversations.length) return conversations[0].proxy_e164 || ''; const fc = contactCalls[0]; if (!fc) return ''; return (fc.direction || '').includes('inbound') ? (fc.to_number || '') : (fc.from_number || ''); }, [conversations, contactCalls]);
    const [fallbackProxy, setFallbackProxy] = useState('');
    useEffect(() => { if (derivedProxy || !phone) return; const API_BASE = import.meta.env.VITE_API_URL || '/api'; authedFetch(`${API_BASE}/pulse/default-proxy`).then(r => r.json()).then(d => { if (d.proxy_e164) setFallbackProxy(d.proxy_e164); }).catch(() => { }); }, [derivedProxy, phone]);
    const proxyPhone = derivedProxy || fallbackProxy;

    const handleSendMessage = async (message: string, files?: File[], targetPhone?: string) => {
        const sendTo = targetPhone || phone;
        const targetConv = conversations.find(c => normalizeDigits(c.customer_e164) === normalizeDigits(sendTo));
        if (targetConv) { await messagingApi.sendMessage(targetConv.id, { body: message }, files?.[0]); }
        else if (sendTo && proxyPhone) { const toE164 = (p: string) => { const d = p.replace(/\D/g, ''); if (d.startsWith('1') && d.length === 11) return `+${d}`; if (d.length === 10) return `+1${d}`; return `+${d}`; }; await messagingApi.startConversation({ customerE164: toE164(sendTo), proxyE164: toE164(proxyPhone), initialMessage: message }); }
        else if (sendTo && !proxyPhone) { toast.error('Cannot send SMS: no proxy phone number available'); return; }
        refetchTimeline();
    };

    const handleAiFormat = async (message: string): Promise<string> => {
        try { const r = await messagingApi.polishText(message); if (r.fallback_used) { toast.warning('AI polish unavailable — original text kept'); return message; } return r.polished_text; }
        catch (err: any) { toast.error(err?.response?.status === 504 || err?.code === 'ECONNABORTED' ? 'AI polish timed out — try again' : 'AI polish failed — try again'); return message; }
    };

    return {
        location, contactId, timelineId, searchQuery, setSearchQuery,
        contactsLoading, filteredCalls, loadMoreRef, isFetchingNextPage,
        timelineLoading, callDataItems, messages, phone, hasActiveCall,
        lead, leadLoading, contact, contactDetail, contactDetailLoading, selectedConv,
        editingLead, setEditingLead, convertingLead, setConvertingLead,
        secondaryPhone, secondaryPhoneName, selectedToPhone, setSelectedToPhone,
        handleUpdateStatus: actions.handleUpdateStatus, handleUpdateSource: actions.handleUpdateSource,
        handleUpdateComments: actions.handleUpdateComments, handleMarkLost: actions.handleMarkLost,
        handleActivate: actions.handleActivate, handleConvert, handleConvertSuccess, handleDelete, handleUpdateLead,
        handleSendMessage, handleAiFormat, refetchContacts, refetchTimeline,
        refreshContactDetail: () => { if (contact?.id) contactsApi.getContact(contact.id).then(res => setContactDetail({ contact: res.data.contact, leads: res.data.leads })).catch(() => { }); },
    };
}
