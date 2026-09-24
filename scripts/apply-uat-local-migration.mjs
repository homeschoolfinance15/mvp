// Apply only the UAT repair to the existing local test database, atomically.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const file = 'supabase/migrations/20260925100301_uat_feedback_and_updates.sql'
const sql = readFileSync(file, 'utf8')
const result = spawnSync('docker', ['exec', '-i', 'supabase_db_amazing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  input: `begin;\n${sql}\ncommit;\nnotify pgrst, 'reload schema';\n`, encoding: 'utf8', windowsHide: true,
})
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
