-- ============================================================================
-- A phone number, required
--
-- "when signing up in addition to the linkedin make sure they put in a phone
-- number (the linkedin stays optional) the phone number should be required."
--
-- The column has existed since 20260907000015; nothing ever asked for it. Both
-- forms now do, and this is the half that holds when the browser is not
-- involved — a required attribute is a hint to a form, not a rule about data.
--
-- NOT VALID on purpose: the 31 applications already on the list were taken
-- before anybody was asked for a number, and rejecting them retroactively
-- would mean deleting real people's applications to satisfy a constraint
-- added afterwards. New and updated rows are checked; the existing ones are
-- left as the record of what was actually collected.
-- ============================================================================

alter table public.waitlist_entries
  add constraint waitlist_phone_present
  check (phone is not null and btrim(phone) <> '')
  not valid;

comment on constraint waitlist_phone_present on public.waitlist_entries is
  'Every application taken since 8 Sep 2026 carries a phone number. NOT VALID: earlier rows predate the question.';
