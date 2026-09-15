CREATE TABLE IF NOT EXISTS preview_notification_state (
  business_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 1,
  first_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  message_ref TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (business_id, request_id),
  FOREIGN KEY (business_id, request_id)
    REFERENCES preview_leads (business_id, request_id),
  CHECK (business_id = 'biz_test_001'),
  CHECK (status IN ('pending', 'sent', 'unconfirmed')),
  CHECK (attempt_count = 1)
);

