-- SFS SMS consent evidence is separate from demo lead and notification records.
CREATE TABLE IF NOT EXISTS sms_consent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  consent_status TEXT NOT NULL CHECK (consent_status IN ('opted_in', 'opted_out', 'help')),
  consent_version TEXT NOT NULL,
  source_page TEXT NOT NULL,
  capture_context TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  twilio_message_sid TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS sms_consent_events_phone_id
  ON sms_consent_events (phone, id DESC);

CREATE TABLE IF NOT EXISTS sms_consent_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
