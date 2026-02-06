-- Twilio Call Viewer Database Schema
-- PostgreSQL 15+

-- Drop existing tables if they exist (for development only)
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;

-- Contacts table (phone numbers)
CREATE TABLE contacts (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR(20) UNIQUE NOT NULL,
  formatted_number VARCHAR(30),
  display_name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Conversations table (grouped calls by contact)
CREATE TABLE conversations (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  external_id VARCHAR(100) UNIQUE NOT NULL, -- phone number used as ID
  subject VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  last_message_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table (individual calls)
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  twilio_sid VARCHAR(100) UNIQUE NOT NULL,
  direction VARCHAR(50) NOT NULL, -- 'inbound', 'outbound-api', 'outbound-dial'
  status VARCHAR(50) NOT NULL,
  from_number VARCHAR(20) NOT NULL,
  to_number VARCHAR(20) NOT NULL,
  duration INTEGER, -- seconds
  price DECIMAL(10, 4),
  price_unit VARCHAR(10),
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  recording_url TEXT,
  parent_call_sid VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_conversations_contact ON conversations(contact_id);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_start_time ON messages(start_time DESC);
CREATE INDEX idx_contacts_phone ON contacts(phone_number);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at columns
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE contacts IS 'Stores unique phone numbers and contact information';
COMMENT ON TABLE conversations IS 'Groups calls by contact/phone number into conversation threads';
COMMENT ON TABLE messages IS 'Individual call records from Twilio, linked to conversations';

COMMENT ON COLUMN conversations.external_id IS 'Phone number used as external identifier for Frontend API';
COMMENT ON COLUMN messages.twilio_sid IS 'Unique Twilio Call SID (CA...)';
COMMENT ON COLUMN messages.parent_call_sid IS 'Links child calls to parent for forwarded/transferred calls';
COMMENT ON COLUMN messages.direction IS 'Call direction: inbound, outbound-api, or outbound-dial';
