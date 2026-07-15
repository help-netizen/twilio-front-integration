import {
    useEffect,
    useRef,
    useState,
    type ChangeEvent,
    type FormEvent,
} from 'react';
import { CheckCircle2, MessageCircle, Paperclip, Send, X } from 'lucide-react';
import { useAuth } from '../../auth/AuthProvider';
import { authedFetch } from '../../services/apiClient';
import { FloatingField } from '../ui/floating-field';
import { useHasOpenOverlay } from '../ui/OverlayStack';
import './FeedbackWidget.css';

export type FeedbackBotPhase = 'greeting' | 'chatting' | 'escalated';

export interface FeedbackBotMessage {
    sender: 'bot' | 'user';
    text: string;
}

export interface FeedbackBotState {
    phase: FeedbackBotPhase;
    messages: FeedbackBotMessage[];
}

interface FeedbackSubmissionInput {
    email: string;
    message: string;
    files: readonly File[];
}

type FeedbackRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AssistantChatTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface AssistantChatInput {
    history: readonly AssistantChatTurn[];
    message: string;
    session_key: string;
}

export type FeedbackSubmitResult =
    | { ok: true }
    | { ok: false; error: string };

export type AssistantChatResult =
    | { ok: true; reply: string; escalate: boolean }
    | { ok: false };

export const FEEDBACK_ESCALATION_MESSAGE = "Okay — leave your details below and we'll get back to you";
export const FEEDBACK_SUCCESS_MESSAGE = 'Thanks — we got it';
export const FEEDBACK_NETWORK_ERROR = "Couldn't send — try again";
export const FEEDBACK_OPEN_EVENT = 'albusto:open-feedback';
export const ASSISTANT_FALLBACK_MESSAGE = "I couldn't reach the assistant — let me hand you to a person.";

export function openFeedbackWidget() {
    window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN_EVENT));
}

const FEEDBACK_GREETING = "Hi! Tell me what's happening, and I'll help get your feedback to the right person.";
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
]);
const FILE_ACCEPT = 'application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain,.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createInitialFeedbackBotState(): FeedbackBotState {
    return {
        phase: 'greeting',
        messages: [{ sender: 'bot', text: FEEDBACK_GREETING }],
    };
}

export function escalateFeedbackBot(state: FeedbackBotState): FeedbackBotState {
    if (state.phase === 'escalated') return state;
    return {
        ...state,
        phase: 'escalated',
        messages: [
            ...state.messages,
            { sender: 'bot', text: FEEDBACK_ESCALATION_MESSAGE },
        ],
    };
}

export function getFeedbackEmail(user: { email?: string | null } | null | undefined): string {
    return user?.email?.trim() ?? '';
}

export function isFeedbackWidgetEnabled(value: string | undefined): boolean {
    return value !== 'false';
}

export function validateFeedbackFiles(files: readonly Pick<File, 'size' | 'type'>[]): string | null {
    if (files.length > MAX_FILES) return `You can attach up to ${MAX_FILES} files`;
    for (const file of files) {
        if (!ALLOWED_MIME_TYPES.has(file.type)) {
            return 'Files must be PDF, PNG, JPG, GIF, WEBP, or TXT';
        }
        if (!Number.isFinite(file.size) || file.size > MAX_FILE_SIZE) {
            return 'Each file must be 10 MB or smaller';
        }
    }
    return null;
}

export function validateFeedbackSubmission(input: FeedbackSubmissionInput): string | null {
    if (!EMAIL_RE.test(input.email.trim())) return 'Enter a valid email address';
    if (!input.message.trim()) return 'Tell us what happened';
    return validateFeedbackFiles(input.files);
}

export async function submitFeedback(
    input: FeedbackSubmissionInput,
    request: FeedbackRequest = authedFetch,
): Promise<FeedbackSubmitResult> {
    const validationError = validateFeedbackSubmission(input);
    if (validationError) return { ok: false, error: validationError };

    const body = new FormData();
    body.append('email', input.email.trim());
    body.append('message', input.message.trim());
    input.files.forEach(file => body.append('files', file));

    try {
        const response = await request('/api/feedback', { method: 'POST', body });
        if (response.ok) return { ok: true };

        if (response.status === 422) {
            try {
                const payload = await response.json() as { error?: unknown };
                if (typeof payload.error === 'string' && payload.error) {
                    return { ok: false, error: payload.error };
                }
            } catch {
                // Fall through to the stable client-facing error.
            }
        }
        return { ok: false, error: FEEDBACK_NETWORK_ERROR };
    } catch {
        return { ok: false, error: FEEDBACK_NETWORK_ERROR };
    }
}

export async function submitAssistantChat(
    input: AssistantChatInput,
    request: FeedbackRequest = authedFetch,
): Promise<AssistantChatResult> {
    try {
        const response = await request('/api/assistant/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                history: input.history.slice(-12),
                message: input.message,
                session_key: input.session_key,
            }),
        });
        if (!response.ok) return { ok: false };

        const payload = await response.json() as { reply?: unknown; escalate?: unknown };
        if (typeof payload.reply !== 'string' || typeof payload.escalate !== 'boolean') {
            return { ok: false };
        }
        return { ok: true, reply: payload.reply, escalate: payload.escalate };
    } catch {
        return { ok: false };
    }
}

export function FeedbackWidget() {
    const { user } = useAuth();
    // Hide the floating button while any dialog / panel / sheet is open, so it never
    // paints over an overlay's footer actions (e.g. a wizard's "Create job" button).
    const overlayOpen = useHasOpenOverlay();
    const [open, setOpen] = useState(false);
    const [botState, setBotState] = useState<FeedbackBotState>(createInitialFeedbackBotState);
    const [chatInput, setChatInput] = useState('');
    const [thinking, setThinking] = useState(false);
    const [email, setEmail] = useState(() => getFeedbackEmail(user));
    const [emailTouched, setEmailTouched] = useState(false);
    const [message, setMessage] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [formError, setFormError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const sessionKeyRef = useRef<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleOpen = () => {
            if (!sessionKeyRef.current) sessionKeyRef.current = crypto.randomUUID();
            setOpen(true);
        };
        window.addEventListener(FEEDBACK_OPEN_EVENT, handleOpen);
        return () => window.removeEventListener(FEEDBACK_OPEN_EVENT, handleOpen);
    }, []);

    useEffect(() => {
        if (!emailTouched) setEmail(getFeedbackEmail(user));
    }, [emailTouched, user]);

    useEffect(() => {
        if (open) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [botState.messages, open, submitted, thinking]);

    const handleChatSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const userMessage = chatInput.trim();
        if (!userMessage || thinking) return;

        const history = botState.messages.slice(-12).map<AssistantChatTurn>(item => ({
            role: item.sender === 'user' ? 'user' : 'assistant',
            text: item.text,
        }));
        const sessionKey = sessionKeyRef.current ?? crypto.randomUUID();
        sessionKeyRef.current = sessionKey;

        setBotState(state => ({
            ...state,
            phase: 'chatting',
            messages: [...state.messages, { sender: 'user', text: userMessage }],
        }));
        setChatInput('');
        setThinking(true);

        const result = await submitAssistantChat({ history, message: userMessage, session_key: sessionKey });
        setBotState(state => {
            if (!result.ok) {
                return {
                    ...state,
                    phase: 'escalated',
                    messages: [...state.messages, { sender: 'bot', text: ASSISTANT_FALLBACK_MESSAGE }],
                };
            }
            return {
                ...state,
                phase: result.escalate ? 'escalated' : state.phase,
                messages: [...state.messages, { sender: 'bot', text: result.reply }],
            };
        });
        setThinking(false);
    };

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(event.target.files ?? []);
        const error = validateFeedbackFiles(selectedFiles);
        if (error) {
            setFiles([]);
            setFormError(error);
            event.target.value = '';
            return;
        }
        setFiles(selectedFiles);
        setFormError(null);
    };

    const handleFeedbackSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (sending) return;

        setSending(true);
        setFormError(null);
        const result = await submitFeedback({ email, message, files });
        setSending(false);
        if (!result.ok) {
            setFormError(result.error);
            return;
        }
        setSubmitted(true);
    };

    return (
        <div className="feedback-widget">
            {open && (
                <section className="feedback-panel" role="dialog" aria-label="Share feedback">
                    <header className="feedback-panel__header">
                        <div>
                            <p className="feedback-panel__eyebrow">Product feedback</p>
                            <h2>How can we help?</h2>
                        </div>
                        <button
                            type="button"
                            className="feedback-panel__close"
                            onClick={() => {
                                sessionKeyRef.current = null;
                                setOpen(false);
                            }}
                            aria-label="Close feedback"
                        >
                            <X size={19} />
                        </button>
                    </header>

                    <div className="feedback-panel__messages" aria-live="polite">
                        {botState.messages.map((item, index) => (
                            <div
                                className={`feedback-message feedback-message--${item.sender}`}
                                key={`${item.sender}-${index}`}
                            >
                                {item.text}
                            </div>
                        ))}
                        {thinking && (
                            <div className="feedback-message feedback-message--bot">
                                Thinking…
                            </div>
                        )}

                        {botState.phase === 'escalated' && !submitted && (
                            <form className="feedback-form" onSubmit={handleFeedbackSubmit} noValidate>
                                <FloatingField
                                    id="feedback-email"
                                    name="email"
                                    type="email"
                                    inputMode="email"
                                    label="Email"
                                    value={email}
                                    onChange={event => {
                                        setEmailTouched(true);
                                        setEmail(event.target.value);
                                        setFormError(null);
                                    }}
                                    disabled={sending}
                                />
                                <FloatingField
                                    id="feedback-message"
                                    name="message"
                                    textarea
                                    rows={4}
                                    label="What happened?"
                                    value={message}
                                    onChange={event => {
                                        setMessage(event.target.value);
                                        setFormError(null);
                                    }}
                                    disabled={sending}
                                />
                                <label className="feedback-file-field" htmlFor="feedback-files">
                                    <span><Paperclip size={15} /> Attach files (optional)</span>
                                    <input
                                        id="feedback-files"
                                        name="files"
                                        type="file"
                                        multiple
                                        accept={FILE_ACCEPT}
                                        onChange={handleFileChange}
                                        disabled={sending}
                                    />
                                </label>
                                {files.length > 0 && (
                                    <p className="feedback-file-summary">
                                        {files.length} {files.length === 1 ? 'file' : 'files'} ready to send
                                    </p>
                                )}
                                {formError && <p className="feedback-form__error" role="alert">{formError}</p>}
                                <button
                                    type="submit"
                                    className="feedback-form__send"
                                    disabled={sending || !message.trim()}
                                >
                                    {sending ? 'Sending…' : <><Send size={16} /> Send</>}
                                </button>
                            </form>
                        )}

                        {submitted && (
                            <div className="feedback-success" role="status">
                                <CheckCircle2 size={22} />
                                <div>
                                    <strong>{FEEDBACK_SUCCESS_MESSAGE}</strong>
                                    <span>Thank you for helping us make Albusto better.</span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {botState.phase !== 'escalated' && (
                        <div className="feedback-panel__conversation-actions">
                            <button
                                type="button"
                                className="feedback-human-button"
                                onClick={() => setBotState(escalateFeedbackBot)}
                            >
                                Talk to a human
                            </button>
                            <form className="feedback-composer" onSubmit={handleChatSubmit}>
                                <textarea
                                    rows={1}
                                    value={chatInput}
                                    onChange={event => setChatInput(event.target.value)}
                                    onKeyDown={event => {
                                        if (event.key === 'Enter' && !event.shiftKey) {
                                            event.preventDefault();
                                            event.currentTarget.form?.requestSubmit();
                                        }
                                    }}
                                    placeholder="Write a message…"
                                    aria-label="Message"
                                    disabled={thinking}
                                />
                                <button
                                    type="submit"
                                    disabled={thinking || !chatInput.trim()}
                                    aria-label="Send message"
                                >
                                    <Send size={17} />
                                </button>
                            </form>
                        </div>
                    )}
                </section>
            )}

            {!(overlayOpen && !open) && (
                <button
                    type="button"
                    className="feedback-fab"
                    onClick={() => {
                        if (open) {
                            sessionKeyRef.current = null;
                            setOpen(false);
                            return;
                        }
                        sessionKeyRef.current = crypto.randomUUID();
                        setOpen(true);
                    }}
                    aria-label={open ? 'Close feedback' : 'Open feedback'}
                    aria-expanded={open}
                >
                    {open ? <X size={23} /> : <MessageCircle size={23} />}
                </button>
            )}
        </div>
    );
}
