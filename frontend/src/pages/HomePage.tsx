import React from 'react';
import { ConversationList } from '../components/conversations/ConversationList';
import { Phone } from 'lucide-react';

export const HomePage: React.FC = () => {
    return (
        <div className="flex h-full overflow-hidden">
            <div className="w-[360px] shrink-0 border-r flex flex-col bg-background">
                <ConversationList />
            </div>

            <div className="flex-1 flex flex-col bg-background">
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                        <Phone className="size-12 mx-auto mb-3 opacity-20" />
                        <p className="text-lg mb-2">Select a conversation</p>
                        <p className="text-sm text-muted-foreground">
                            Choose a conversation from the list to view call history
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};
