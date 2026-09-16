-- ---------------------------------------------------------------------------
-- 20260916000032_reconcile_pending_payments
--
-- PAYMENTS.md §9. The clock for stripe-reconcile: the sweep that finds orders
-- whose `checkout.session.completed` never arrived and asks Stripe directly
-- what became of them.
--
-- Why this is scheduled rather than left to Stripe's retries: Stripe gives up
-- after three days in live mode, and after a handful of attempts in test mode.
-- Past that the delivery is gone and the order sits `pending` for ever — the
-- attendee paid, holds no ticket, and nobody is told. Every handler is
-- idempotent, so a sweep running *alongside* the retries is harmless: whichever
-- writer arrives first claims the row, and the other one changes nothing.
--
-- Five minutes, not one. The email dispatcher runs every minute because a
-- person is waiting on a message; nobody is waiting on this. A stuck payment
-- has already waited twenty minutes by the time the sweep will look at it, and
-- each order in the batch costs a Stripe API call.
--
-- This file is the same shape as the event-mailer schedule in
-- 20260916000008_event_email_queue.sql, deliberately. Both extensions are
-- absent on a local `supabase start` and on free projects, so the whole thing
-- is wrapped: a project without them logs a notice and migrates cleanly.
--
-- The service role key is read from a database setting rather than written
-- here, because a migration file is in git and a key in git is a key that has
-- been published. Set it once, out of band — the same two settings the mailer
-- already needs, so a project where the mailer is scheduled needs nothing new:
--
--   alter database postgres set app.settings.service_role_key = '...';
--   alter database postgres set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
--
-- Unlike the mailer there is no GitHub Actions fallback. If the schedule
-- cannot be created the sweep does not run, and the position is exactly what
-- §9 described before this existed: recoverable by a human from Stripe's
-- failed-delivery list. That is a worse day, not a lost payment.
--
-- ponytail: the job is unscheduled and rescheduled on every migration run, so
-- this file is safe to re-apply.
-- ---------------------------------------------------------------------------

do $$
declare
  v_url  text := current_setting('app.settings.functions_url', true);
  v_key  text := current_setting('app.settings.service_role_key', true);
  v_http text;
begin
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    raise notice 'stripe-reconcile cron not scheduled: app.settings.functions_url / service_role_key are not set. Stuck payments stay a manual recovery from Stripe''s failed-delivery list.';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- pg_net has lived in `net` and in `extensions` depending on how a project
  -- was created, and a cron job that names the wrong one fails silently into
  -- cron.job_run_details where nobody is looking. Ask the catalogue instead
  -- of guessing.
  select quote_ident(n.nspname) || '.http_post'
    into v_http
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'http_post'
  limit 1;

  if v_http is null then
    raise notice 'stripe-reconcile cron not scheduled: pg_net exposes no http_post on this project.';
    return;
  end if;

  -- Unschedule in a block of its own. There is nothing to remove on a first
  -- run, and letting that error reach the outer handler would roll back the
  -- extensions this block has just created.
  begin
    perform cron.unschedule('stripe-reconcile');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'stripe-reconcile',
    '*/5 * * * *',
    format(
      $job$select %s(
        url     := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body    := '{}'::jsonb
      )$job$,
      v_http,
      v_url || '/stripe-reconcile',
      'Bearer ' || v_key
    )
  );

  raise notice 'stripe-reconcile cron scheduled, every five minutes, via %.', v_http;

exception when others then
  -- The extensions are unavailable on this plan, or this role may not create
  -- them. Neither is a reason to fail a deployment.
  raise notice 'stripe-reconcile cron setup skipped (%): stuck payments stay a manual recovery.', sqlerrm;
end;
$$;
