-- ============================================================================
-- One enum value, and nothing else
--
-- Same reason 20260916000001 is one thing: Postgres will not let a transaction
-- use an enum value that the same transaction added, and the Supabase CLI wraps
-- every migration file in its own transaction. The trigger that writes this
-- notification therefore lives in 20260916000026.
--
-- Strictly, creating a plpgsql function whose body mentions the literal would
-- survive here, because a plpgsql body is not resolved until it runs. It is
-- still split, because the rule that file 1 states — add the type here, add the
-- column or the code that uses it in the next file — is worth more as a rule
-- nobody has to reason about than as a rule with an exception in it.
-- ============================================================================

alter type notification_kind add value if not exists 'event_payments_blocked';
