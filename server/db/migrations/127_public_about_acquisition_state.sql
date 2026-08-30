-- Explicit durable state machine for public YouTube About page fallback acquisition.
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS public_about_status TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED',
  ADD COLUMN IF NOT EXISTS public_about_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_about_attempts INT NOT NULL DEFAULT 0;
