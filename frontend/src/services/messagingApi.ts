import apiClient from './api';
import type {
    ConversationsResponse,
    MessagesResponse,
    Message,
    Conversation,
    SendMessageRequest,
    StartConversationRequest,
    MediaUrlResponse,
} from '../types/messaging';

export const messagingApi = {
    getConversations: async (cursor?: string, limit = 30, state?: string): Promise<ConversationsResponse> => {
        const params: Record<string, any> = { limit };
        if (cursor) params.cursor = cursor;
        if (state) params.state = state;
        const response = await apiClient.get<ConversationsResponse>('/messaging', { params });
        return response.data;
    },

    getConversation: async (id: string): Promise<Conversation> => {
        const response = await apiClient.get<{ conversation: Conversation }>(`/messaging/${id}`);
        return response.data.conversation;
    },

    getMessages: async (conversationId: string, cursor?: string, limit = 50): Promise<MessagesResponse> => {
        const params: Record<string, any> = { limit };
        if (cursor) params.cursor = cursor;
        const response = await apiClient.get<MessagesResponse>(`/messaging/${conversationId}/messages`, { params });
        return response.data;
    },

    sendMessage: async (conversationId: string, data: SendMessageRequest, file?: File): Promise<Message> => {
        if (file) {
            const formData = new FormData();
            if (data.body) formData.append('body', data.body);
            formData.append('file', file);
            const response = await apiClient.post<{ message: Message }>(
                `/messaging/${conversationId}/messages`,
                formData,
                { headers: { 'Content-Type': 'multipart/form-data' } }
            );
            return response.data.message;
        }
        const response = await apiClient.post<{ message: Message }>(`/messaging/${conversationId}/messages`, data);
        return response.data.message;
    },

    startConversation: async (data: StartConversationRequest): Promise<{ conversation: Conversation; message: Message | null }> => {
        const response = await apiClient.post<{ conversation: Conversation; message: Message | null }>('/messaging/start', data);
        return response.data;
    },

    markRead: async (conversationId: string): Promise<Conversation> => {
        const response = await apiClient.post<{ conversation: Conversation }>(`/messaging/${conversationId}/mark-read`);
        return response.data.conversation;
    },

    getMediaUrl: async (mediaId: string): Promise<MediaUrlResponse> => {
        const response = await apiClient.get<MediaUrlResponse>(`/messaging/media/${mediaId}/temporary-url`);
        return response.data;
    },
};
