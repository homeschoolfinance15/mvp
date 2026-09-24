// Read-only production smoke check: no test users, bookings, payments or emails.
const site = 'https://goamazing.ai'
const page = await fetch(site)
const html = await page.text()
const asset = html.match(/src="([^"]+\.js)"/)?.[1]
if (!asset) throw Error('No frontend entry asset found')
const bundle = await fetch(new URL(asset, site))
const js = await bundle.text()
const result = {
  at: new Date().toISOString(),
  site,
  pageStatus: page.status,
  asset,
  assetStatus: bundle.status,
  latestUpdatePreviewPresent: js.includes('event_update_preview'),
  submittedReviewReadbackButtonPresent: js.includes('Change my feedback'),
  hostManagementControlsPresent: js.includes('set_event_host_management') && js.includes('Can manage this event'),
}
console.log(JSON.stringify(result, null, 2))
if (page.status !== 200 || bundle.status !== 200 || !result.latestUpdatePreviewPresent || result.submittedReviewReadbackButtonPresent) process.exitCode = 1
if (process.argv.includes('--host-permissions') && !result.hostManagementControlsPresent) process.exitCode = 1
