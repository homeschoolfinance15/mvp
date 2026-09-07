-- ============================================================================
-- The trust layer
--
-- A member meets someone at an event and learns their profile is wrong. They
-- raise it; the connector who brought that person in reaches out; the person
-- fixes their own profile; the connector closes the report.
--
--   member raises  ──▶  subject's connector sees it
--                            │
--                            ├─ reaches out (holds the subject's email)
--                            │
--                       subject edits their own profile
--                            │
--                       connector resolves or dismisses
--
-- Four rules are load-bearing, and none of them is a matter of taste:
--
--   1. The subject never sees the report and is never notified. A visible
--      accusation invites retaliation and stops people raising anything.
--      The connector's outreach is the only signal the subject gets.
--   2. One open report per reporter per subject, enforced by a partial
--      unique index rather than by the UI, so pile-ons stop at the database.
--   3. Nobody reports themselves.
--   4. A reporter cannot resolve their own report.
--
-- Reporter identity is visible to the connector and the admin. Anonymous
-- accusations in a network this small would be corrosive, and whoever acts
-- on one needs to weigh the source.
-- ============================================================================

create type report_kind   as enum ('correction', 'concern', 'endorsement');
create type report_status as enum ('open', 'resolved', 'dismissed');

create table public.profile_reports (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references public.profiles (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  kind        report_kind not null default 'correction',
  -- Which column is being disputed, when the reporter can say. Free text
  -- rather than an enum: the set of disputable fields will drift, and a
  -- wrong value here costs nothing.
  field       varchar,
  body        text not null,
  status      report_status not null default 'open',
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),

  constraint profile_reports_not_self check (subject_id <> reporter_id),
  constraint profile_reports_body
    check (length(btrim(body)) > 0 and length(body) <= 2000),
  constraint profile_reports_resolution_coherent
    check ((status = 'open') = (resolved_at is null))
);

-- Rule 2. Partial, so a person may raise a fresh report once the last one
-- has been dealt with — but never stack two open ones on the same person.
create unique index profile_reports_one_open
  on public.profile_reports (subject_id, reporter_id)
  where status = 'open';

create index profile_reports_subject_idx  on public.profile_reports (subject_id, status);
create index profile_reports_reporter_idx on public.profile_reports (reporter_id);

-- ---------------------------------------------------------------------------
-- Did I, as a connector, bring this person in?
--
-- Pulled out because both the select policy and the resolve RPC need it, and
-- an inlined exists() in two places is one place to get it wrong.
-- ---------------------------------------------------------------------------

create or replace function public.connects_to(p_profile_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.connector_user_links l
    where l.user_profile_id = p_profile_id
      and l.connector_id = public.my_connector_id()
  );
$$;

comment on function public.connects_to(uuid) is
  'True when the caller is the connector who invited that profile.';

-- ---------------------------------------------------------------------------
-- Resolution goes through an RPC, not an update policy.
--
-- RLS `with check` can gate a row but cannot pin a column, so an update
-- policy permissive enough to let a connector close a report would also let
-- them rewrite its body first. There is no update grant on this table at
-- all; this function is the only way status moves.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_profile_report(
  p_report_id uuid,
  p_status    report_status
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_report public.profile_reports%rowtype;
begin
  if p_status = 'open' then
    raise exception 'A report can be resolved or dismissed, not reopened.';
  end if;

  select * into v_report from public.profile_reports where id = p_report_id for update;
  if not found then
    raise exception 'That report no longer exists.';
  end if;
  if v_report.status <> 'open' then
    raise exception 'That report has already been dealt with.';
  end if;

  -- Rule 4: the person who raised it does not get to close it.
  if v_report.reporter_id = auth.uid() then
    raise exception 'You cannot resolve a report you raised yourself.';
  end if;

  if not (public.is_admin() or public.connects_to(v_report.subject_id)) then
    raise exception 'Only an administrator or the connector who invited this person can resolve this.';
  end if;

  update public.profile_reports
  set status      = p_status,
      resolved_by = auth.uid(),
      resolved_at = now()
  where id = p_report_id;

  return jsonb_build_object('id', p_report_id, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profile_reports enable row level security;

-- Rule 1 lives here: subject_id is conspicuously absent from this policy.
-- The person being reported on cannot read the report, by any path.
create policy profile_reports_select on public.profile_reports for select to authenticated
using (
  reporter_id = auth.uid()
  or public.is_admin()
  or public.connects_to(public.profile_reports.subject_id)
);

create policy profile_reports_insert on public.profile_reports for insert to authenticated
with check (
  public.can_post()
  and reporter_id = auth.uid()
  and status = 'open'
  and resolved_at is null
);

-- Withdrawing what you raised, while it is still open. Once a connector has
-- acted on it, the record stays.
create policy profile_reports_delete on public.profile_reports for delete to authenticated
using (reporter_id = auth.uid() and status = 'open');

-- ---------------------------------------------------------------------------
-- Audit
--
-- The body is withheld from the log for the same reason the subject cannot
-- read the report: an accusation should live in exactly one place, readable
-- by exactly the people who must act on it.
-- ---------------------------------------------------------------------------

create trigger log_profile_reports
  after insert or update or delete on public.profile_reports
  for each row execute function public.log_activity('body');

-- ---------------------------------------------------------------------------
-- Grants — no update, deliberately. Status moves only through the RPC.
-- ---------------------------------------------------------------------------

grant select, insert, delete on public.profile_reports to authenticated;

grant execute on function public.connects_to(uuid)                              to authenticated;
grant execute on function public.resolve_profile_report(uuid, report_status)    to authenticated;
