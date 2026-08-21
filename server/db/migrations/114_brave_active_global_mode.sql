-- Provider 2 activation vocabulary: explicit globally active mode.
-- This migration changes only the provider registry mode constraint; it does not
-- activate Brave. Activation remains an explicit operator/control-plane action.
DO $$
BEGIN
  ALTER TABLE discovery_provider_registry DROP CONSTRAINT IF EXISTS discovery_provider_registry_mode_check;
  ALTER TABLE discovery_provider_registry ADD CONSTRAINT discovery_provider_registry_mode_check
    CHECK (mode IN ('SHADOW', 'CANARY', 'ACTIVE', 'ACTIVE_GLOBAL', 'PAUSED', 'RETIRED'));
END $$;
