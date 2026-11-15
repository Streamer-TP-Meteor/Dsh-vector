/** Small in-memory event ring so the settings page can show what the plugin did
 *  recently (index runs, service starts, failures) without a log file. */
const MAX_EVENTS = 60
const events = []
let lastPushed = null

export function pushEvent(level, message) {
  const text = String(message ?? '').trim()
  if (!text) return
  // The supervisor and the plugin log both report the same event; keep the last
  // identical line only once so the settings page does not show duplicates.
  const now = Date.now()
  if (lastPushed && lastPushed.text === text && now - lastPushed.at < 1500) return
  lastPushed = { text, at: now }
  events.push({ at: new Date().toISOString(), level: level || 'info', message: text })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

export function recentEvents(limit = 20) {
  return events.slice(-Math.max(1, limit)).reverse()
}
