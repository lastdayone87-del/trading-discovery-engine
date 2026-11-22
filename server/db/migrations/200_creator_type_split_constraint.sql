-- Split the legacy MARKET_INSTITUTION creator type into the trading-platform
-- and non-trading institution categories used by the current taxonomy.
ALTER TABLE creator_type_adjudications
  DROP CONSTRAINT IF EXISTS creator_type_adjudications_creator_type_check;

ALTER TABLE creator_type_adjudications
  ADD CONSTRAINT creator_type_adjudications_creator_type_check
  CHECK (creator_type IN (
    'ACTIVE_TRADING_CREATOR','TRADING_EDUCATOR','INVESTING_EDUCATOR','FINANCIAL_NEWS','PERSONAL_FINANCE',
    'TRADING_PLATFORM_OR_FIRM','BANK_OR_NON_TRADING_INSTITUTION','MARKET_INSTITUTION','CORPORATE_BRAND',
    'GAMING_CREATOR','ENTERTAINMENT_CREATOR','TRADING_ADJACENT','INCIDENTAL_TRADING_CONTENT',
    'HYPE_OR_PROMOTION','UNRELATED_OTHER','INSUFFICIENT_EVIDENCE','IDENTITY_DISPUTED'
  ));
