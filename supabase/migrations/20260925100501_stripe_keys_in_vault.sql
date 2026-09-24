-- Stripe keys set from the admin Payments page, kept encrypted in Supabase
-- Vault. Before this they could only be set with `supabase secrets set`.
--
-- Encrypted at rest: vault.secrets holds ciphertext; the key that decrypts it
-- is held by Supabase outside the database. Plaintext exists only in
-- vault.decrypted_secrets, which no API role can read, and in the one
-- service-role function below that the payment edge functions call.
--
-- Write-only from a browser: an admin can set or clear a value and read back
-- whether it is set, its last four characters and when it changed. Nothing an
-- authenticated user can call returns a key.
--
-- A value saved here wins over the function environment; unset, the functions
-- fall back to the environment secret, so an existing setup keeps working.

-- The three values, by the names the functions already use.
create or replace function public.stripe_setting_ok(p_name text, p_value text)
returns boolean
language sql immutable
as $$
  select case p_name
    when 'STRIPE_SECRET_KEY'        then p_value ~ '^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$'
    when 'STRIPE_WEBHOOK_SECRET'    then p_value ~ '^whsec_[A-Za-z0-9+/=]{10,}$'
    when 'STRIPE_CONNECT_CLIENT_ID' then p_value ~ '^ca_[A-Za-z0-9]{10,}$'
    else false
  end
$$;

-- Admins set a value (or clear it with null). Logged, without the value.
create or replace function public.set_stripe_setting(p_name text, p_value text)
returns void
language plpgsql security definer set search_path = public, vault
as $$
declare
  v_id uuid;
  v_value text := nullif(btrim(p_value), '');
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change the Stripe keys.';
  end if;
  if p_name not in ('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID') then
    raise exception 'That is not a Stripe setting this page manages.';
  end if;
  if v_value is not null and not public.stripe_setting_ok(p_name, v_value) then
    raise exception '%', case p_name
      when 'STRIPE_SECRET_KEY'        then 'A secret key starts sk_live_, sk_test_, rk_live_ or rk_test_. Copy it again from Stripe → Developers → API keys.'
      when 'STRIPE_WEBHOOK_SECRET'    then 'A webhook signing secret starts whsec_. Copy it again from Stripe → Developers → Webhooks → your endpoint.'
      else 'A Connect client id starts ca_. Copy it again from Stripe → Settings → Connect.'
    end;
  end if;

  select id into v_id from vault.secrets where name = p_name;
  if v_value is null then
    delete from vault.secrets where name = p_name;
  elsif v_id is null then
    perform vault.create_secret(v_value, p_name, 'Set from the admin Payments page');
  else
    perform vault.update_secret(v_id, v_value, p_name, 'Set from the admin Payments page');
  end if;

  insert into public.activity_log (actor_id, action, entity, detail)
  values (auth.uid(), case when v_value is null then 'stripe_key_cleared' else 'stripe_key_set' end,
          'stripe_settings', jsonb_build_object('name', p_name));
end;
$$;

revoke all on function public.set_stripe_setting(text, text) from public, anon;
grant execute on function public.set_stripe_setting(text, text) to authenticated;

-- What the admin page may know: set or not, the last four characters, when.
create or replace function public.stripe_settings_status()
returns table (name text, is_set boolean, last4 text, updated_at timestamptz)
language plpgsql security definer set search_path = public, vault
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can see the Stripe keys.';
  end if;
  return query
    select n.name,
           d.decrypted_secret is not null,
           right(d.decrypted_secret, 4),
           d.updated_at
      from unnest(array['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID']) as n(name)
      left join vault.decrypted_secrets d on d.name = n.name;
end;
$$;

revoke all on function public.stripe_settings_status() from public, anon;
grant execute on function public.stripe_settings_status() to authenticated;

-- The payment edge functions, and nothing else, read the plaintext.
create or replace function public.stripe_secrets()
returns table (name text, value text)
language sql security definer set search_path = vault
as $$
  select name, decrypted_secret
    from vault.decrypted_secrets
   where name in ('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID')
$$;

revoke all on function public.stripe_secrets() from public, anon, authenticated;
grant execute on function public.stripe_secrets() to service_role;
