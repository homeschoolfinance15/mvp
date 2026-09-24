// S14 part 2: pay both sessions while stripe-webhook is DOWN (delivery lost).
import fs from 'node:fs'
import { DIR, sim, sleep, mark, since } from './lib.mjs'
const s = JSON.parse(fs.readFileSync(`${DIR}/state3a.json`, 'utf8'))
const out = {}
for (const k of ['conn', 'plat']) {
  const m = mark()
  const r = await sim('POST', `/_sim/session/${s[k].session}/pay`)
  await sleep(200)
  out[k] = { status: r.status, webhook: r.body?.webhook, log: since(m).filter((l) => l.kind === 'webhook') }
  console.log(k, r.status, JSON.stringify(r.body?.webhook))
}
fs.writeFileSync(`${DIR}/state3b.json`, JSON.stringify(out, null, 2))
