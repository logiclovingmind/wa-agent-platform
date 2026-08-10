-- Sector guardrails are enforced in code, not in the prompt, so the code has to know
-- which sector a client is. A check constraint rather than an enum: adding a sector
-- later is then one migration, not two.
--
-- Investment, insurance, lending and legal are absent on purpose. They are out of
-- scope, and the enforcement for them is refusing the contract.
alter table organizations
  add column sector text not null default 'general';

alter table organizations
  add constraint organizations_sector_check
  check (sector in ('general', 'real_estate', 'healthcare', 'pharmacy'));
