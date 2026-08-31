-- Allow NULL values in channels.country to represent unknown/unresolved creator country attribution.
ALTER TABLE channels ALTER COLUMN country DROP NOT NULL;
