import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useCallsByContact } from './useConversations';
import { usePulseTimeline } from './usePulseTimeline';
import { messagingApi } from '../services/messagingApi';
import { pulseApi } from '../services/pulseApi';
import * as leadsApi from '../services/leadsApi';
import * as contactsApi from '../services/contactsApi';
import { useRealtimeEvents, type SSECallEvent, type SSETranscriptDeltaEvent, type SSETranscriptFinalizedEvent } from './useRealtimeEvents';
import { appendTranscriptDelta, finalizeTranscript } from './useLiveTranscript';
import { callsApi } from '../services/api';
import { authedFetch } from '../services/apiClient';
import { useLeadByPhone } from './useLeadByPhone';
import { callToCallData } from '../components/pulse/pulseHelpers';
import type { Call } from '../types/models';
import type { Lead } from '../types/lead';
import type { ContactLead } from '../types/contact';

export function usePulsePage() {
    const { id } = useParams<{ id: string }>();
    const location = useLocation();
    const isTimelineRoute = location.pathname.startsWith('/pulse/timeline/');
    const timelineId = isTimelineRoute ? parseInt(id || '0') : 0;
    const contactId = isTimelineRoute ? 0 : parseInt(id || '0');

    // Search with debounce
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
        return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
    }, [searchQuery]);

    // Contact list
    const { data: contactData, isLoading: contactsLoading, refetch: refetchContacts, fetchNextPage, hasNextPage, isFetchingNextPage } = useCallsByContact(debouncedSearch || undefined);

    // Infinite scroll sentinel
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!loadMoreRef.current) return;
        const observer = new IntersectionObserver(
            (entries) => { if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage(); },
            { threshold: 0.1 }
        );
        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    // Timeline data
    const { data: timelineData, isLoading: timelineLoading, refetch: refetchTimeline } = usePulseTimeline(contactId, timelineId || undefined);

    // Real-time updates
    useRealtimeEvents({
        onCallUpdate: (event: SSECallEvent) => {
            if (event.parent_call_sid) return;
            refetchContacts();
            if ((contactId && event.contact_id && Number(event.contact_id) === contactId) ||
                (timelineId && event.timeline_id && Number(event.timeline_id) === timelineId)) {
                refetchTimeline();
            }
        },
        onCallCreated: () => refetchContacts(),
        onMessageAdded: () => { refetchContacts(); if (contactId || timelineId) refetchTimeline(); },
        onContactRead: () => refetchContacts(),
        onGenericEvent: (eventType: string) => {
            if (['thread.action_required', 'thread.handled', 'thread.snoozed', 'thread.unsnoozed', 'thread.assigned', 'timeline.read', 'timeline.unread'].includes(eventType)) refetchContacts();
        },
        onTranscriptDelta: (event: SSETranscriptDeltaEvent) => {
            appendTranscriptDelta(event.callSid, { text: event.text, speaker: event.speaker, turnOrder: event.turnOrder, isFinal: event.isFinal, receivedAt: event.receivedAt });
        },
        onTranscriptFinalized: (event: SSETranscriptFinalizedEvent) => {
            finalizeTranscript(event.callSid, event.text);
            if (contactId || timelineId) refetchTimeline();
        },
    });

    // Deduplicate contacts
    const filteredCalls = useMemo(() => {
        const raw = contactData?.conversations || [];
        const seen = new Map<string, number>();
        const deduped: Call[] = [];
        for (const c of raw) {
            const phone = c.contact?.phone_e164 || c.from_number || '';
            const digits = phone.replace(/\D/g, '');
            if (!digits) { deduped.push(c); continue; }
            if (!seen.has(digits)) { seen.set(digits, deduped.length); deduped.push(c); }
        }
        return deduped;
    }, [contactData?.conversations]);

    // Timeline call data
    const callDataItems = useMemo(() => {
        if (!timelineData?.calls) return [];
        return timelineData.calls.map(callToCallData);
    }, [timelineData?.calls]);

    const messages = timelineData?.messages || [];
    const conversations = timelineData?.conversations || [];
    const contactCalls = timelineData?.calls || [];
    const contact = (timelineData as any)?.contact || contactCalls[0]?.contact;

    const selectedConv = filteredCalls.find((c: Call) => {
        const tlId = (c as any).timeline_id;
        return tlId ? Number(tlId) === timelineId : c.contact?.id === contactId;
    });

    const phone = contact?.phone_e164
        || (selectedConv as any)?.tl_phone
        || contactCalls[0]?.from_number || contactCalls[0]?.to_number
        || selectedConv?.contact?.phone_e164 || selectedConv?.from_number
        || conversations[0]?.customer_e164 || '';

    const hasActiveCall = contactCalls.some((c: any) => ['ringing', 'in-progress', 'queued', 'initiated', 'voicemail_recording'].includes(c.status));

    // Lead management
    const { lead: fetchedLead, isLoading: leadLoading } = useLeadByPhone(phone || undefined);
    const [leadOverride, setLeadOverride] = useState<Lead | null>(null);
    const [editingLead, setEditingLead] = useState<Lead | null>(null);
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [selectedToPhone, setSelectedToPhone] = useState<string>('');
    const lead = leadOverride || fetchedLead;

    React.useEffect(() => { setLeadOverride(null); setSelectedToPhone(''); }, [phone]);

    // Contact detail panel
    const [contactDetail, setContactDetail] = useState<{ contact: any; leads: ContactLead[] } | null>(null);
    const [contactDetailLoading, setContactDetailLoading] = useState(false);

    React.useEffect(() => {
        if (lead || leadLoading || !contact?.id) { setContactDetail(null); return; }
        let cancelled = false;
        setContactDetailLoading(true);
        contactsApi.getContact(contact.id).then(res => {
            if (!cancelled) setContactDetail({ contact: res.data.contact, leads: res.data.leads });
        }).catch(err => {
            console.warn('[PulsePage] Failed to load contact detail:', err);
            if (!cancelled) setContactDetail(null);
        }).finally(() => { if (!cancelled) setContactDetailLoading(false); });
        return () => { cancelled = true; };
    }, [lead, leadLoading, contact?.id]);

    // Secondary phone logic
    const secondaryPhone = lead?.SecondPhone || contact?.secondary_phone || '';
    const secondaryPhoneName = lead?.SecondPhoneName || contact?.secondary_phone_name || '';
    const normalizeDigits = (p: string) => (p || '').replace(/\D/g, '');

    const lastUsedPhone = useMemo(() => {
        if (!phone || !secondaryPhone) return phone;
        const mainDigits = normalizeDigits(phone);
        const secDigits = normalizeDigits(secondaryPhone);
        if (!secDigits || mainDigits === secDigits) return phone;
        type PhoneEvent = { phone: string; time: number };
        const events: PhoneEvent[] = [];
        for (const msg of messages) {
            const msgPhone = msg.direction === 'inbound' ? msg.from_number : msg.to_number;
            if (msgPhone) {
                const d = normalizeDigits(msgPhone);
                if (d === mainDigits) events.push({ phone, time: new Date(msg.date_created_remote || msg.created_at).getTime() });
                else if (d === secDigits) events.push({ phone: secondaryPhone, time: new Date(msg.date_created_remote || msg.created_at).getTime() });
            }
        }
        for (const call of contactCalls) {
            const callPhone = call.direction?.includes('inbound') ? call.from_number : call.to_number;
            if (callPhone) {
                const d = normalizeDigits(callPhone);
                const t = new Date(call.started_at || call.created_at).getTime();
                if (d === mainDigits) events.push({ phone, time: t });
                else if (d === secDigits) events.push({ phone: secondaryPhone, time: t });
            }
        }
        if (events.length === 0) return phone;
        events.sort((a, b) => b.time - a.time);
        return events[0].phone;
    }, [phone, secondaryPhone, messages, contactCalls]);

    React.useEffect(() => { if (lastUsedPhone && !selectedToPhone) setSelectedToPhone(lastUsedPhone); }, [lastUsedPhone, selectedToPhone]);

    // Lead action handlers
    const handleUpdateStatus = async (uuid: string, status: string) => {
        try { await leadsApi.updateLead(uuid, { Status: status } as any); const detail = await leadsApi.getLeadByUUID(uuid); setLeadOverride(detail.data.lead); toast.success('Status updated'); }
        catch { toast.error('Failed to update status'); }
    };
    const handleUpdateSource = async (uuid: string, source: string) => {
        try { await leadsApi.updateLead(uuid, { JobSource: source }); const detail = await leadsApi.getLeadByUUID(uuid); setLeadOverride(detail.data.lead); toast.success('Source updated'); }
        catch { toast.error('Failed to update source'); }
    };
    const handleUpdateComments = async (uuid: string, comments: string) => {
        try { await leadsApi.updateLead(uuid, { Comments: comments }); const detail = await leadsApi.getLeadByUUID(uuid); setLeadOverride(detail.data.lead); toast.success('Comments saved'); }
        catch { toast.error('Failed to save comments'); }
    };
    const handleMarkLost = async (uuid: string) => {
        try { await leadsApi.markLost(uuid); const detail = await leadsApi.getLeadByUUID(uuid); setLeadOverride(detail.data.lead); toast.success('Lead marked as lost'); }
        catch { toast.error('Failed to mark lead as lost'); }
    };
    const handleActivate = async (uuid: string) => {
        try { await leadsApi.activateLead(uuid); const detail = await leadsApi.getLeadByUUID(uuid); setLeadOverride(detail.data.lead); toast.success('Lead activated'); }
        catch { toast.error('Failed to activate lead'); }
    };
    const handleConvert = (_uuid: string) => { if (lead) setConvertingLead(lead); };
    const handleConvertSuccess = async (updatedLead: Lead) => {
        try { const detail = await leadsApi.getLeadByUUID(updatedLead.UUID); setLeadOverride(detail.data.lead); }
        catch { setLeadOverride(updatedLead); }
        setConvertingLead(null);
    };
    const handleDelete = async (uuid: string) => { await handleMarkLost(uuid); };
    const handleUpdateLead = async (updatedLead: Lead) => { setLeadOverride(updatedLead); setEditingLead(null); toast.success('Lead updated'); };

    // Proxy phone for SMS
    const derivedProxy = useMemo(() => {
        if (conversations.length) return conversations[0].proxy_e164 || '';
        const firstCall = contactCalls[0];
        if (!firstCall) return '';
        return (firstCall.direction || '').includes('inbound') ? (firstCall.to_number || '') : (firstCall.from_number || '');
    }, [conversations, contactCalls]);

    const [fallbackProxy, setFallbackProxy] = useState('');
    useEffect(() => {
        if (derivedProxy || !phone) return;
        const API_BASE = import.meta.env.VITE_API_URL || '/api';
        authedFetch(`${API_BASE}/pulse/default-proxy`).then(r => r.json()).then(data => { if (data.proxy_e164) setFallbackProxy(data.proxy_e164); }).catch(() => { });
    }, [derivedProxy, phone]);
    const proxyPhone = derivedProxy || fallbackProxy;

    // SMS handler
    const handleSendMessage = async (message: string, files?: File[], targetPhone?: string) => {
        const sendTo = targetPhone || phone;
        const targetConv = conversations.find(c => normalizeDigits(c.customer_e164) === normalizeDigits(sendTo));
        if (targetConv) {
            await messagingApi.sendMessage(targetConv.id, { body: message }, files?.[0]);
        } else if (sendTo && proxyPhone) {
            const toE164 = (p: string) => { const digits = p.replace(/\D/g, ''); if (digits.startsWith('1') && digits.length === 11) return `+${digits}`; if (digits.length === 10) return `+1${digits}`; return `+${digits}`; };
            await messagingApi.startConversation({ customerE164: toE164(sendTo), proxyE164: toE164(proxyPhone), initialMessage: message });
        } else if (sendTo && !proxyPhone) {
            toast.error('Cannot send SMS: no proxy phone number available'); return;
        }
        refetchTimeline();
    };

    // AI polish
    const handleAiFormat = async (message: string): Promise<string> => {
        try {
            const result = await messagingApi.polishText(message);
            if (result.fallback_used) { toast.warning('AI polish unavailable — original text kept'); return message; }
            return result.polished_text;
        } catch (err: any) {
            const msg = err?.response?.status === 504 || err?.code === 'ECONNABORTED' ? 'AI polish timed out — try again' : 'AI polish failed — try again';
            toast.error(msg); return message;
        }
    };

    return {
        location, contactId, timelineId,
        searchQuery, setSearchQuery,
        contactsLoading, filteredCalls, loadMoreRef, isFetchingNextPage,
        timelineLoading, callDataItems, messages,
        phone, hasActiveCall, lead, leadLoading, contact, contactDetail, contactDetailLoading, selectedConv,
        editingLead, setEditingLead, convertingLead, setConvertingLead,
        secondaryPhone, secondaryPhoneName, selectedToPhone, setSelectedToPhone,
        handleUpdateStatus, handleUpdateSource, handleUpdateComments,
        handleMarkLost, handleActivate, handleConvert, handleConvertSuccess, handleDelete, handleUpdateLead,
        handleSendMessage, handleAiFormat,
        refetchContacts, refetchTimeline,
        // For refreshing contact detail
        refreshContactDetail: () => {
            if (contact?.id) contactsApi.getContact(contact.id).then(res => {
                setContactDetail({ contact: res.data.contact, leads: res.data.leads });
            }).catch(() => { });
        },
    };
}
