-- ORG-13. What Stripe actually kept, read off the charge's balance transaction.
-- Net receipts were gross less the booking fee, which is wrong twice: the
-- booking fee stays with the receiver, and Stripe's processing fee was never
-- known to us at all. Null means not yet read, never zero.
--
-- The fee is in the balance currency, which is not always the order's: a EUR
-- sale settling into a GBP balance is charged its fee in GBP. So it carries
-- its own currency, and a screen only nets a fee off an order in the same one.

alter table public.event_orders
  add column if not exists stripe_fee_cents    integer check (stripe_fee_cents >= 0),
  add column if not exists stripe_fee_currency text;

comment on column public.event_orders.stripe_fee_cents is
  'ORG-13. Stripe''s processing fee from the charge''s balance transaction, in stripe_fee_currency. Null until read. Not returned on a refund.';
