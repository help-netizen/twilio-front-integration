/**
 * SoftPhoneContext — allows any component to open the SoftPhone dialer
 * with a pre-filled phone number and optional contact name.
 *
 * Also shares the active call's contact info so the header button
 * can display the name in minimized state.
 */

import React, { createContext, useContext, useCallback, useState } from 'react';

interface SoftPhoneRequest {
    phone: string;
    contactName?: string;
}

interface SoftPhoneContextType {
    /** Open the SoftPhone with a pre-filled number */
    openDialer: (phone: string, contactName?: string) => void;
    /** Pending request from click-to-call — consumed by SoftPhone widget */
    pendingRequest: SoftPhoneRequest | null;
    /** Clear the pending request after SoftPhone has consumed it */
    clearPending: () => void;
    /** Active call contact name (set by SoftPhoneWidget when call starts) */
    activeCallContact: string | null;
    /** Set the active call contact name */
    setActiveCallContact: (name: string | null) => void;
}

const SoftPhoneContext = createContext<SoftPhoneContextType>({
    openDialer: () => { },
    pendingRequest: null,
    clearPending: () => { },
    activeCallContact: null,
    setActiveCallContact: () => { },
});

export const useSoftPhone = () => useContext(SoftPhoneContext);

export const SoftPhoneProvider: React.FC<{
    children: React.ReactNode;
    onOpenRequested: () => void;
}> = ({ children, onOpenRequested }) => {
    const [pendingRequest, setPendingRequest] = useState<SoftPhoneRequest | null>(null);
    const [activeCallContact, setActiveCallContact] = useState<string | null>(null);

    const openDialer = useCallback((phone: string, contactName?: string) => {
        setPendingRequest({ phone, contactName });
        onOpenRequested();
    }, [onOpenRequested]);

    const clearPending = useCallback(() => {
        setPendingRequest(null);
    }, []);

    return (
        <SoftPhoneContext.Provider value={{
            openDialer, pendingRequest, clearPending,
            activeCallContact, setActiveCallContact,
        }}>
            {children}
        </SoftPhoneContext.Provider>
    );
};
