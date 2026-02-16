# Zenbooker Customer Card - Embedded Component

## 🚀 Быстрый старт (2 шага)

### Шаг 1: Компонент уже создан
Файл: `frontend/src/components/ZenbookerCustomerCard.tsx` ✅

### Шаг 2: Используй в ConversationPage

Открой `frontend/src/pages/ConversationPage.tsx` и добавь:

```typescript
// 1. Импортируй компонент (добавь в начало файла)
import ZenbookerCustomerCard from '../components/ZenbookerCustomerCard';

// 2. Вставь компонент в render (после header, перед messages-area)
return (
    <div className="home-page">
        <div className="inbox-sidebar">
            <ConversationList />
        </div>

        <div className="conversation-area">
            <div className="conversation-header">
                {/* existing header code */}
            </div>

            {/* 👇 ВСТАВЬ СЮДА - одна строка! */}
            <ZenbookerCustomerCard 
                phoneNumber={conversation.contact.handle}
                conversationId={conversation.id}
            />

            <div className="messages-area">
                {/* existing messages code */}
            </div>
        </div>
    </div>
);
```

**Готово!** 🎉 

---

## Что происходит автоматически

✅ Автоматически делает API запрос к Zenbooker  
✅ Показывает loading состояние  
✅ Отображает найденного клиента с ссылкой  
✅ Обрабатывает multiple matches  
✅ Скрывается если клиент не найден  
✅ Все стили встроены (inline CSS)  

---

## Полный пример ConversationPage.tsx

```typescript
import React from 'react';
import { useParams } from 'react-router-dom';
import { useConversation, useConversationMessages } from '../hooks/useConversations';
import { ConversationList } from '../components/conversations/ConversationList';
import CallIcon from '../components/CallIcon';
import { createPhoneLink } from '../utils/formatters';
import ZenbookerCustomerCard from '../components/ZenbookerCustomerCard';
import './ConversationPage.css';

export const ConversationPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: conversation, isLoading: conversationLoading } = useConversation(id!);
    const { data: messages, isLoading: messagesLoading } = useConversationMessages(id!);

    if (conversationLoading || messagesLoading) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="loading">Loading...</div>
                </div>
            </div>
        );
    }

    if (!conversation) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="error">Conversation not found</div>
                </div>
            </div>
        );
    }

    return (
        <div className="home-page">
            <div className="inbox-sidebar">
                <ConversationList />
            </div>

            <div className="conversation-area">
                <div className="conversation-header">
                    <div className="header-left">
                        <h2 dangerouslySetInnerHTML={{
                            __html: createPhoneLink(conversation.contact.name || conversation.contact.handle || conversation.external_id)
                        }} />
                        <div className="conversation-stats">
                            {conversation.metadata.total_calls} calls
                        </div>
                    </div>
                </div>

                {/* Zenbooker Card - одна строка! */}
                <ZenbookerCustomerCard 
                    phoneNumber={conversation.contact.handle}
                    conversationId={conversation.id}
                />

                <div className="messages-area">
                    {messages?.map((message) => (
                        <div key={message.id} className="message-card">
                            <div className="message-content">
                                <div className="message-box">
                                    <div className="message-header">
                                        <CallIcon
                                            direction={message.metadata.actual_direction || message.direction}
                                            status={message.call?.status || 'unknown'}
                                            metadata={message.metadata}
                                        />
                                        <div className="message-subject-text">
                                            {message.subject}
                                        </div>
                                    </div>

                                    <div
                                        className="message-body"
                                        dangerouslySetInnerHTML={{ __html: message.body.replace(/\n/g, '<br />') }}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
```

---

## Props (опционально)

```typescript
<ZenbookerCustomerCard 
    phoneNumber="5082904442"    // Phone to search
    email="test@example.com"    // Email to search (optional)
    conversationId="cnv_123"    // Conversation ID for tracking
/>
```

---

## Для Production

Обновите API URL в компоненте:

**Файл:** `frontend/src/components/ZenbookerCustomerCard.tsx`

**Найди строку:**
```typescript
'http://localhost:3017/api/front/zenbooker/customer-lookup',
```

**Замени на:**
```typescript
process.env.VITE_ZENBOOKER_API_URL || 'http://localhost:3017/api/front/zenbooker/customer-lookup',
```

**В `.env`:**
```
VITE_ZENBOOKER_API_URL=https://your-backend.fly.dev/api/front/zenbooker/customer-lookup
```

---

## Готово! 🎉

Компонент полностью самодостаточный:
- ✅ Все стили встроены
- ✅ API логика внутри
- ✅ Не требует дополнительных зависимостей (кроме axios)
- ✅ Одна строка для использования

**Проверь:** http://localhost:5173 → открой любой разговор → карточка появится автоматически!
