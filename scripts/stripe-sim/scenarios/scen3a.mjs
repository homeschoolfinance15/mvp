// S14 part 1: open two checkouts (connector s2 / buyer g2, platform s1 / buyer m4). Run while functions serve is UP.
import fs from 'node:fs'
import { DIR } from './lib.mjs'
import { checkout } from './common.mjs'
const a = await checkout('g2', 's2')
const b = await checkout('m4', 's1')
console.log(a.status, a.body?.session_id, b.status, b.body?.session_id)
fs.writeFileSync(`${DIR}/state3a.json`, JSON.stringify({ conn: { session: a.body.session_id, order: a.body.order_id, stripe: a.stripe }, plat: { session: b.body.session_id, order: b.body.order_id, stripe: b.stripe } }, null, 2))
