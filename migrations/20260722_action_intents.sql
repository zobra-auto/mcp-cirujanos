BEGIN;

CREATE TABLE IF NOT EXISTS booking_action_intents (
  id uuid PRIMARY KEY,
  conversation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','cancel')),
  payload jsonb NOT NULL,
  source_message_id text NOT NULL,
  confirmed_message_id text,
  status text NOT NULL CHECK (status IN (
    'awaiting_patient','ready_for_review','committing','completed',
    'cancelled','expired','failed'
  )),
  expires_at timestamptz NOT NULL,
  review_id bigint,
  reviewer text,
  event_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_action_intents_one_open
  ON booking_action_intents (conversation_id, kind)
  WHERE status IN ('awaiting_patient','ready_for_review','committing');

CREATE INDEX IF NOT EXISTS booking_action_intents_expiry
  ON booking_action_intents (status, expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON booking_action_intents TO cirujanos_app;

ALTER TABLE review_queue
  ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS resolution_action text,
  ADD COLUMN IF NOT EXISTS final_response text,
  ADD COLUMN IF NOT EXISTS resolution_reason text,
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS action_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resume_http_status integer;

ALTER TABLE correcciones
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'sent';

COMMIT;
