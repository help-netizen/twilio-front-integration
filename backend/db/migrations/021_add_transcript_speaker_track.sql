-- 021: Add speaker and track columns for dual-channel realtime transcription
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker VARCHAR(30);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS track VARCHAR(20);

COMMENT ON COLUMN transcripts.speaker IS 'customer or agent — identifies who is speaking';
COMMENT ON COLUMN transcripts.track IS 'inbound or outbound — Twilio media track';
