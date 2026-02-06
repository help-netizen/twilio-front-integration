import axios from 'axios';
import type { Conversation, Message, ConversationsResponse, MessagesResponse } from '../types/models';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json'
    }
});

// Conversations API
export const conversationsApi = {
    // Get all conversations
    getAll: async (): Promise<Conversation[]> => {
        const response = await apiClient.get<ConversationsResponse>('/conversations');
        return response.data.conversations;
    },

    // Get single conversation
    getById: async (id: string): Promise<Conversation> => {
        const response = await apiClient.get<Conversation>(`/conversations/${id}`);
        return response.data;
    },

    // Get messages for a conversation
    getMessages: async (conversationId: string): Promise<Message[]> => {
        const response = await apiClient.get<MessagesResponse>(`/conversations/${conversationId}/messages`);
        return response.data.messages;
    }
};

// Messages API
export const messagesApi = {
    // Get all messages
    getAll: async (): Promise<Message[]> => {
        const response = await apiClient.get<MessagesResponse>('/messages');
        return response.data.messages;
    },

    // Get single message
    getById: async (id: string): Promise<Message> => {
        const response = await apiClient.get<Message>(`/messages/${id}`);
        return response.data;
    }
};

export default apiClient;
