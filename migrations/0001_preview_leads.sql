CREATE TABLE IF NOT EXISTS preview_leads (
  business_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'not_requested',
  PRIMARY KEY (business_id, request_id),
  CHECK (business_id = 'biz_test_001'),
  CHECK (notification_status = 'not_requested')
);
