-- A confirmed trading decision is authoritative. Stale classification jobs,
-- composition policies, enrichment passes, and review projections all write
-- through ordinary channel upserts; none may silently downgrade a creator the
-- system already confirmed.
--
-- The only supported downgrade path is an audited review action. Those actions
-- run in a transaction that sets `app.force_review_rescan='on'` before their
-- direct channel update, mirroring the existing human-rejection guard.
CREATE OR REPLACE FUNCTION protect_trading_confirmation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.trading_status = 'TRADING_CONFIRMED'
     AND NEW.trading_status <> 'TRADING_CONFIRMED'
     AND COALESCE(current_setting('app.force_review_rescan', true), '') <> 'on' THEN
    RAISE EXCEPTION 'confirmed trading channel requires an audited review rescan'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS channels_protect_trading_confirmation ON channels;
CREATE TRIGGER channels_protect_trading_confirmation
  BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION protect_trading_confirmation();

COMMENT ON FUNCTION protect_trading_confirmation() IS
  'Rejects non-audited downgrades of TRADING_CONFIRMED. Escape only with transaction-local app.force_review_rescan=on from the review workflow.';
