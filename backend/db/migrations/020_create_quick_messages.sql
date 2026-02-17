-- Quick Messages table
-- Stores reusable SMS message templates per company
CREATE TABLE IF NOT EXISTS quick_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quick_messages_company ON quick_messages(company_id, sort_order);

-- Seed default quick messages for Boston Masters (default company)
INSERT INTO quick_messages (company_id, title, content, sort_order) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Follow-up', 'Hi! Just following up on our previous conversation. Let me know if you have any questions.', 0),
    ('00000000-0000-0000-0000-000000000001', 'Thank You', 'Thank you for your time today! Looking forward to speaking with you again soon.', 1),
    ('00000000-0000-0000-0000-000000000001', 'Schedule Meeting', 'Would you be available for a quick call this week? Let me know what time works best for you.', 2),
    ('00000000-0000-0000-0000-000000000001', 'Send Info', 'As promised, here''s the information we discussed. Feel free to reach out if you need anything else.', 3)
ON CONFLICT DO NOTHING;
