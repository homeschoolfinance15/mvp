// Stripe keys saved from Admin → Payments: encrypted in Vault, write-only to
// browsers, admin-only, logged by name, readable by the payment functions alone.
import { rpc, signIn, SERVICE, ANON, URL, psql } from './lib.mjs'
import { F } from './common.mjs'
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' — ' + JSON.stringify(detail)}`) }
const admin = await signIn(F.people.admin.email)
const member = await signIn(F.people.m1.email)
const KEY = 'sk_test_' + 'A1b2C3d4E5f6G7h8J9k0vaultcheck'

let r = await rpc(admin, 'set_stripe_setting', { p_name: 'STRIPE_SECRET_KEY', p_value: 'pk_test_notasecret123456' })
check('a publishable key is refused with a plain instruction', r.status >= 400 && /starts sk_live_/.test(JSON.stringify(r.body)), r)
r = await rpc(member, 'set_stripe_setting', { p_name: 'STRIPE_SECRET_KEY', p_value: KEY })
check('a member cannot set a key', r.status >= 400, r)
r = await rpc(ANON, 'set_stripe_setting', { p_name: 'STRIPE_SECRET_KEY', p_value: KEY })
check('anonymous cannot set a key', r.status >= 400, r)
r = await rpc(admin, 'set_stripe_setting', { p_name: 'STRIPE_SECRET_KEY', p_value: '  ' + KEY + '  ' })
check('an admin can set a key (whitespace trimmed)', r.status < 300, r)
const stored = psql(`select secret from vault.secrets where name='STRIPE_SECRET_KEY'`)
check('stored encrypted: the raw vault row is not the key', stored.length > 0 && !stored.includes(KEY) && !stored.includes('vaultcheck'), stored.slice(0, 40))
r = await rpc(admin, 'stripe_settings_status')
const row = (r.body || []).find((x) => x.name === 'STRIPE_SECRET_KEY')
check('admin status shows set + last 4 only, never the key', row?.is_set === true && row.last4 === 'heck' && !JSON.stringify(r.body).includes(KEY), r.body)
r = await rpc(member, 'stripe_settings_status')
check('a member cannot read the status', r.status >= 400, r.status)
r = await rpc(admin, 'stripe_secrets')
check('an admin cannot read the plaintext', r.status >= 400 && !JSON.stringify(r.body).includes(KEY), r.status)
r = await rpc(member, 'stripe_secrets')
check('a member cannot read the plaintext', r.status >= 400, r.status)
r = await fetch(`${URL}/rest/v1/decrypted_secrets?select=*`, { headers: { apikey: ANON, Authorization: `Bearer ${admin}`, 'Accept-Profile': 'vault' } })
check('the vault schema is not reachable over the API', r.status >= 400 && !(await r.text()).includes(KEY), r.status)
r = await rpc(SERVICE, 'stripe_secrets')
check('the service role (edge functions) reads the plaintext', (r.body || []).some((x) => x.name === 'STRIPE_SECRET_KEY' && x.value === KEY), r.status)
const log = psql(`select action || ' ' || (detail->>'name') || ' ' || (detail::text like '%vaultcheck%') from activity_log where entity='stripe_settings' order by id desc limit 1`)
check('the change is logged by name, without the value', log === 'stripe_key_set STRIPE_SECRET_KEY false', log)
r = await rpc(admin, 'set_stripe_setting', { p_name: 'STRIPE_SECRET_KEY', p_value: null })
check('clearing removes it', r.status < 300 && psql(`select count(*) from vault.secrets where name='STRIPE_SECRET_KEY'`) === '0', r)
console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : `${results.filter((x) => !x).length} FAILED`)
