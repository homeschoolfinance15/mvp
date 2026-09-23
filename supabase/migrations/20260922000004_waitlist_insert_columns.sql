-- The public waitlist form may write applicant fields and nothing else.
--
-- waitlist_insert checks nothing (with check (true)) and anon had INSERT on
-- every column, so a visitor could post assigned_at, assigned_connector_id,
-- declined_at, ack_sent_at or a created_at in 2099: fake an assignment, hide
-- their row's Assign and Decline buttons, suppress the acknowledgement email,
-- or pin themselves to the top of the admin list. Those columns are written
-- by admin functions and the waitlist-email function, which run as owner or
-- service role and are unaffected by this.
--
-- Column grants rather than a longer WITH CHECK: a column added later is
-- closed to the public until somebody decides it belongs to the applicant.

revoke insert on public.waitlist_entries from anon, authenticated;

grant insert (
  full_name, email, linkedin_url, phone, home_city, travel_preference,
  age_range, gathering_preference, travels_often, travel_destinations,
  current_focus, desired_outcomes, conversation_topics, outside_work_interests,
  strongest_skills, current_focus_details, desired_outcomes_details,
  current_project, background, room_contribution, current_conversation_need,
  curation_notes, taxonomy_version
) on public.waitlist_entries to anon, authenticated;
