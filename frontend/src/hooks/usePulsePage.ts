import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useCallsByContact } from './useConversations';
import { usePulseTimeline } from './usePulseTimeline';
import { messagingApi } from '../services/messagingApi';
import * as contactsApi from '../services/contactsApi';
import { pulseApi } from '../services/pulseApi';
import * as emailApi from '../services/emailApi';
import * as jobsApi from '../services/jobsApi';
import { buildMessageTargets, type MessageTarget } from '../components/pulse/smsFormHelpers';
import { useRealtimeEvents } from './useRealtimeEvents';
import { authedFetch } from '../services/apiClient';
import { useLeadByPhone } from './useLeadByPhone';
import { useLeadByContact } from './useLeadByContact';
import { makePulseLeadActions } from './pulseLeadActions';
import type { Call } from '../types/models';
import type { Lead } from '../types/lead';
import type { ContactLead } from '../types/contact';

export function usePulsePage() {
    const { id } = useParams<{ id: string }>();
    const location = useLocation();
    const isTimelineRoute = location.pathname.startsWith('/pulse/timeline/');
    // TIMELINE/CONTACT-NUMBERING: the :id param may be a numeric id (legacy links) or a
    // durable public_code. A numeric param stays 100% synchronous — no behavior change for
    // existing links; a code is resolved to its id below (brief empty state while resolving).
    const numericParam = id && /^\d+$/.test(id) ? parseInt(id) : null;
    const [codeResolvedId, setCodeResolvedId] = useState<number | null>(null);
    useEffect(() => {
        setCodeResolvedId(null);
        if (!id || numericParam != null) return; // numeric id or empty → nothing to resolve
        let cancelled = false;
        (async () => {
            try {
                const rid = isTimelineRoute
                    ? (await pulseApi.getTimelineByCode(id)).data.id
                    : (await contactsApi.getContactByCode(id)).data.id;
                // node-pg returns BIGINT ids as strings ("4409"); coerce so downstream
                // strict comparisons (selectedConv: Number(tlId) === timelineId) match the
                // numeric-param path exactly — otherwise selectedConv stays undefined and the
                // open timeline's Action Required tasks never render.
                if (!cancelled) setCodeResolvedId(Number(rid));
            } catch { /* unknown/foreign code → leave unresolved (empty state) */ }
        })();
        return () => { cancelled = true; };
    }, [id, isTimelineRoute, numericParam]);
    const effectiveId = numericParam ?? codeResolvedId ?? 0;
    const timelineId = isTimelineRoute ? effectiveId : 0;
    const contactId = isTimelineRoute ? 0 : effectiveId;

    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => { if (debounceTimer.current) clearTimeout(debounceTimer.current); debounceTimer.current = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300); return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); }; }, [searchQuery]);

    const { data: contactData, isLoading: contactsLoading, refetch: refetchContacts, fetchNextPage, hasNextPage, isFetchingNextPage } = useCallsByContact(debouncedSearch || undefined);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { if (!loadMoreRef.current) return; const obs = new IntersectionObserver(entries => { if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage(); }, { threshold: 0.1 }); obs.observe(loadMoreRef.current); return () => obs.disconnect(); }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    const {
        items,
        calls: contactCalls,
        messages,
        emailMessages,
        financialEvents,
        meta,
        isLoading: timelineLoading,
        fetchOlder,
        hasOlder,
        isFetchingOlder,
        refreshNewestPage,
    } = usePulseTimeline(contactId, timelineId || undefined);
    const maskedViewer = meta?.mask_viewer === true;
    const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);

    const refreshOpenTimeline = () => {
        if (contactId || timelineId) void refreshNewestPage();
    };
    const refreshPulseData = () => {
        void refetchContacts();
        refreshOpenTimeline();
    };

    useRealtimeEvents({
        onCallUpdate: refreshPulseData,
        onCallCreated: refreshPulseData,
        onMessageAdded: refreshPulseData,
        onContactRead: refreshPulseData,
        onGenericEvent: (eventType: string) => {
            if ([
                'thread.action_required', 'thread.handled', 'thread.snoozed',
                'thread.unsnoozed', 'thread.assigned', 'timeline.read',
                'timeline.unread', 'contact.unread', 'task.changed',
            ].includes(eventType)) refreshPulseData();
        },
        // Live transcript text is no longer company-broadcast. The finalized
        // invalidation refetches the persisted transcript through scoped REST.
        onTranscriptFinalized: refreshOpenTimeline,
    });

    const filteredCalls = useMemo(() => { const raw = contactData?.conversations || []; const seen = new Map<string, number>(); const deduped: Call[] = []; for (const c of raw) { const p = c.contact?.phone_e164 || c.from_number || ''; const d = p.replace(/\D/g, ''); if (!d) { deduped.push(c); continue; } if (!seen.has(d)) { seen.set(d, deduped.length); deduped.push(c); } } return deduped; }, [contactData?.conversations]);

    const conversations = meta?.conversations || [];
    const contact = meta?.contact || contactCalls[0]?.contact;
    const selectedConv = filteredCalls.find((c: Call) => { const tlId = (c as any).timeline_id; return tlId ? Number(tlId) === timelineId : Number(c.contact?.id) === contactId; });
    const phone = contact?.phone_e164 || (selectedConv as any)?.tl_phone || contactCalls[0]?.from_number || contactCalls[0]?.to_number || selectedConv?.contact?.phone_e164 || selectedConv?.from_number || conversations[0]?.customer_e164 || '';
    const hasActiveCall = contactCalls.some((c: any) => ['ringing', 'in-progress', 'queued', 'initiated', 'voicemail_recording'].includes(c.status));

    const { lead: fetchedLeadByPhone, isLoading: leadPhoneLoading } = useLeadByPhone(phone || undefined);
    const { lead: fetchedLeadByContact, isLoading: leadContactLoading } = useLeadByContact(
        contact?.id,
        !maskedViewer
    );
    const [leadOverride, setLeadOverride] = useState<Lead | null>(null);
    const [editingLead, setEditingLead] = useState<Lead | null>(null);
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [selectedTarget, setSelectedTarget] = useState<MessageTarget | undefined>(undefined);
    // Phone wins when both resolve (normal phone contact → same lead); email-origin has no by-phone result.
    const lead = leadOverride || fetchedLeadByPhone || fetchedLeadByContact;
    // Each query's `enabled` gate means a phone timeline never fires the contact query and vice-versa.
    const leadLoading = leadPhoneLoading || leadContactLoading;
    React.useEffect(() => { setLeadOverride(null); setSelectedTarget(undefined); }, [maskedViewer, phone, contact?.id]);

    // Company Gmail mailbox status — drives whether email targets are selectable or a connect-CTA.
    // Read via the lightweight timeline endpoint (needs only `messages.send`) so a send-only
    // agent sees the real connect state instead of always getting the connect-CTA.
    const { data: mailboxStatus } = useQuery({
        queryKey: ['timeline-mailbox-status'],
        queryFn: () => emailApi.getTimelineMailboxStatus(),
        staleTime: 60000,
    });
    const emailConnected = mailboxStatus?.connected === true;

    const [contactDetail, setContactDetail] = useState<{ contact: any; leads: ContactLead[] } | null>(null);
    const [contactDetailLoading, setContactDetailLoading] = useState(false);
    React.useEffect(() => { if (maskedViewer || lead || leadLoading || !contact?.id) { setContactDetail(null); return; } let cancelled = false; setContactDetailLoading(true); contactsApi.getContact(contact.id).then(res => { if (!cancelled) setContactDetail({ contact: res.data.contact, leads: res.data.leads }); }).catch(() => { if (!cancelled) setContactDetail(null); }).finally(() => { if (!cancelled) setContactDetailLoading(false); }); return () => { cancelled = true; }; }, [maskedViewer, lead, leadLoading, contact?.id]);

    // PULSE-CONTACT-PIN-001: the pinned bar needs the jobs (open count + freshest
    // address) BEFORE the full panel is expanded, so the fetch lives here — one
    // fetch shared by bar and panel instead of the panel's former mount-time fetch.
    const [contactJobs, setContactJobs] = useState<jobsApi.LocalJob[]>([]);
    React.useEffect(() => {
        if (maskedViewer || lead || leadLoading || !contact?.id) { setContactJobs([]); return; }
        let cancelled = false;
        jobsApi.listJobs({ contact_id: contact.id, limit: 50 })
            .then(data => { if (!cancelled) setContactJobs(data.results); })
            .catch(() => { if (!cancelled) setContactJobs([]); });
        return () => { cancelled = true; };
    }, [maskedViewer, lead, leadLoading, contact?.id]);

    const secondaryPhone = maskedViewer ? '' : (lead?.SecondPhone || contact?.secondary_phone || '');
    const secondaryPhoneName = lead?.SecondPhoneName || contact?.secondary_phone_name || '';
    const normalizeDigits = (p: string) => (p || '').replace(/\D/g, '');

    // Contact email addresses (channel 'email'): contact.email + contact_emails, deduped, primary first.
    const contactEmails = useMemo(() => {
        const out: string[] = [];
        const seen = new Set<string>();
        const push = (e?: string | null) => { const v = (e || '').trim(); if (!v) return; const k = v.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(v); };
        const c: any = contact || contactDetail?.contact;
        push(c?.email);
        for (const e of (c?.contact_emails as string[] | undefined) || []) push(e);
        return out;
    }, [contact, contactDetail]);

    // Composer targets: phones (SMS) + emails. Reused by the form and the default-channel logic.
    const messageTargets = useMemo(() => {
        const emailTargets = buildMessageTargets(undefined, undefined, undefined, contactEmails);
        if (!maskedViewer) {
            return buildMessageTargets(phone, secondaryPhone, secondaryPhoneName, contactEmails);
        }
        const smsTargets: MessageTarget[] = (meta?.sms_targets || []).map(target => ({
            channel: 'sms',
            value: target.target_ref,
            label: target.label,
            targetRef: target.target_ref,
            conversationId: target.conversation_id || undefined,
        }));
        return [...smsTargets, ...emailTargets];
    }, [maskedViewer, meta?.sms_targets, phone, secondaryPhone, secondaryPhoneName, contactEmails]);

    // Last inbound *phone* (existing behavior): newest inbound SMS/call → that phone target value.
    const lastUsedPhone = useMemo(() => {
        if (maskedViewer) return '';
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
    }, [maskedViewer, phone, secondaryPhone, messages, contactCalls]);

    // Default target = last inbound channel. If the newest inbound timeline item is an email and
    // its address is a known contact email, preselect that email; otherwise the SMS phone default.
    const defaultTarget = useMemo<MessageTarget | undefined>(() => {
        const phoneTarget = (maskedViewer ? messageTargets.find(t => t.channel === 'sms') : undefined)
            || messageTargets.find(t => t.channel === 'sms' && normalizeDigits(t.value) === normalizeDigits(lastUsedPhone))
            || messageTargets.find(t => t.channel === 'sms');
        // newest inbound email
        let bestEmail: { value: string; time: number } | null = null;
        for (const em of emailMessages as any[]) {
            if (em?.direction !== 'inbound') continue;
            const addr = (em.from_email || '').trim().toLowerCase();
            const match = contactEmails.find(e => e.toLowerCase() === addr);
            if (!match) continue;
            const t = new Date(em.sent_at || 0).getTime();
            if (!bestEmail || t > bestEmail.time) bestEmail = { value: match, time: t };
        }
        // newest inbound SMS/call time (for comparison with email)
        let bestPhoneTime = 0;
        for (const msg of messages) { if (msg.direction === 'inbound') bestPhoneTime = Math.max(bestPhoneTime, new Date(msg.date_created_remote || msg.created_at).getTime()); }
        for (const call of contactCalls) { if ((call.direction || '').includes('inbound')) bestPhoneTime = Math.max(bestPhoneTime, new Date(call.started_at || call.created_at).getTime()); }
        // Only default to email when the mailbox is actually connected (else it can't be sent).
        if (emailConnected && bestEmail && bestEmail.time >= bestPhoneTime) {
            return messageTargets.find(t => t.channel === 'email' && t.value === bestEmail!.value) || phoneTarget;
        }
        return phoneTarget;
    }, [maskedViewer, messageTargets, lastUsedPhone, emailMessages, contactEmails, messages, contactCalls, emailConnected]);

    React.useEffect(() => { if (defaultTarget && !selectedTarget) setSelectedTarget(defaultTarget); }, [defaultTarget, selectedTarget]);

    const actions = makePulseLeadActions(setLeadOverride);
    const handleConvert = (_uuid: string) => { if (lead) setConvertingLead(lead); };
    const handleConvertSuccess = async (updatedLead: Lead) => { await actions.handleConvertSuccess(updatedLead); setConvertingLead(null); };
    const handleDelete = async (uuid: string) => { await actions.handleMarkLost(uuid); };
    const handleUpdateLead = async (updatedLead: Lead) => { setLeadOverride(updatedLead); setEditingLead(null); toast.success('Lead updated'); };

    const derivedProxy = useMemo(() => {
        if (maskedViewer) return '';
        if (conversations.length) return conversations[0].proxy_e164 || '';
        // Find first call with a real phone number (skip client: URIs from WebRTC calls)
        const fc = contactCalls.find(c => {
            const num = (c.direction || '').includes('inbound') ? c.to_number : c.from_number;
            return num && !num.startsWith('client:');
        });
        if (!fc) return '';
        return (fc.direction || '').includes('inbound') ? (fc.to_number || '') : (fc.from_number || '');
    }, [maskedViewer, conversations, contactCalls]);
    const [fallbackProxy, setFallbackProxy] = useState('');
    useEffect(() => { if (derivedProxy || !phone) return; const API_BASE = import.meta.env.VITE_API_URL || '/api'; authedFetch(`${API_BASE}/pulse/default-proxy`).then(r => r.json()).then(d => { if (d.proxy_e164) setFallbackProxy(d.proxy_e164); }).catch(() => { }); }, [derivedProxy, phone]);
    const proxyPhone = derivedProxy || fallbackProxy;

    const handleSendMessage = async (message: string, files?: File[], target?: MessageTarget) => {
        // Email branch (EMAIL-TIMELINE-001 / ET-10): send via the timeline email route.
        if (target?.channel === 'email') {
            const cid = contact?.id || contactId;
            if (!cid) { toast.error('Cannot send email: contact not resolved'); return; }
            try {
                await emailApi.sendTimelineEmail(cid, { body: message, toEmail: target.value });
                await refreshNewestPage();
                setScrollToBottomSignal(s => s + 1);
            } catch (err: any) {
                console.error('[Email] Send failed:', err);
                if (err instanceof emailApi.TimelineEmailError && err.code === 'MAILBOX_NOT_CONNECTED') {
                    toast.error('Google email not connected', { description: 'Connect it in Settings → Email to send.' });
                } else {
                    toast.error(err?.message || 'Failed to send email');
                }
            }
            return;
        }
        // SMS branch (unchanged).
        if (target?.conversationId) {
            try {
                await messagingApi.sendMessage(target.conversationId, { body: message }, files?.[0]);
                await refreshNewestPage();
                setScrollToBottomSignal(s => s + 1);
            } catch (err: any) {
                console.error('[SMS] Send failed:', err);
                toast.error(err?.response?.data?.error || 'Failed to send message');
            }
            return;
        }
        if (target?.targetRef) {
            const cid = contact?.id || contactId;
            if (!cid) { toast.error('Cannot send SMS: contact not resolved'); return; }
            try {
                await messagingApi.startConversation({
                    contactId: cid,
                    targetRef: target.targetRef,
                    initialMessage: message,
                });
                await refreshNewestPage();
                setScrollToBottomSignal(s => s + 1);
            } catch (err: any) {
                console.error('[SMS] Send failed:', err);
                toast.error(err?.response?.data?.error || 'Failed to send message');
            }
            return;
        }
        const sendTo = target?.value || phone;
        try {
            const targetConv = conversations.find(c => normalizeDigits(c.customer_e164 || '') === normalizeDigits(sendTo));
            if (targetConv) { await messagingApi.sendMessage(targetConv.id, { body: message }, files?.[0]); }
            else if (sendTo && proxyPhone) { const toE164 = (p: string) => { const d = p.replace(/\D/g, ''); if (d.startsWith('1') && d.length === 11) return `+${d}`; if (d.length === 10) return `+1${d}`; return `+${d}`; }; await messagingApi.startConversation({ customerE164: toE164(sendTo), proxyE164: toE164(proxyPhone), initialMessage: message }); }
            else if (sendTo && !proxyPhone) { toast.error('Cannot send SMS: no proxy phone number available'); return; }
            await refreshNewestPage();
            setScrollToBottomSignal(s => s + 1);
        } catch (err: any) {
            console.error('[SMS] Send failed:', err);
            toast.error(err?.response?.data?.error || 'Failed to send message');
        }
    };

    const handleAiFormat = async (message: string): Promise<string> => {
        try { const r = await messagingApi.polishText(message); if (r.fallback_used) { toast.warning('AI polish unavailable — original text kept'); return message; } return r.polished_text; }
        catch (err: any) { toast.error(err?.response?.status === 504 || err?.code === 'ECONNABORTED' ? 'AI polish timed out — try again' : 'AI polish failed — try again'); return message; }
    };

    // Leads map from server-side enrichment (phone last-10-digits → Lead)
    const leadsMap = contactData?.leads_map || {};
    const getLeadForPhone = (rawPhone: string | undefined) => {
        if (!rawPhone) return null;
        const d = (rawPhone || '').replace(/\D/g, '');
        const key = d.length >= 10 ? d.slice(-10) : d;
        return leadsMap[key] ?? null;
    };

    return {
        location, contactId, timelineId, searchQuery, setSearchQuery,
        contactsLoading, filteredCalls, loadMoreRef, isFetchingNextPage,
        timelineLoading, items, messages, financialEvents, emailMessages, phone, hasActiveCall,
        hasOlder, isFetchingOlder, fetchOlder, scrollToBottomSignal, refreshNewestPage,
        lead, leadLoading, contact, contactDetail, contactDetailLoading, contactJobs, selectedConv,
        editingLead, setEditingLead, convertingLead, setConvertingLead,
        secondaryPhone, secondaryPhoneName, contactEmails, emailConnected, selectedTarget, setSelectedTarget,
        maskedViewer, hasSmsTarget: messageTargets.some(target => target.channel === 'sms'),
        messageTargets,
        handleUpdateStatus: actions.handleUpdateStatus, handleUpdateSource: actions.handleUpdateSource,
        handleUpdateComments: actions.handleUpdateComments, handleMarkLost: actions.handleMarkLost,
        handleActivate: actions.handleActivate, handleConvert, handleConvertSuccess, handleDelete, handleUpdateLead,
        handleSendMessage, handleAiFormat, refetchContacts, refetchTimeline: refreshNewestPage,
        getLeadForPhone,
        refreshContactDetail: () => {
            if (maskedViewer || !contact?.id) return;
            contactsApi.getContact(contact.id).then(res => setContactDetail({ contact: res.data.contact, leads: res.data.leads })).catch(() => { });
            jobsApi.listJobs({ contact_id: contact.id, limit: 50 }).then(data => setContactJobs(data.results)).catch(() => { });
        },
    };
}
