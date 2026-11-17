// Pure helpers for the drivesync bar widget. No QML imports, so the same file
// is loaded by the panel and by the Bun tests (src/shellPlugin.test.ts).
//
// The status file is written by the drivesync daemon, but the panel still
// treats it as untrusted input: every field is type-checked, strings are
// length-capped and lists are size-capped before anything is displayed.

var MAX_TEXT = 300
var MAX_PATH = 1024
var MAX_RECENT = 30
var MAX_ERRORS = 5

var STATES = {
  starting: true, idle: true, syncing: true, paused: true, error: true,
  offline: true, signed_out: true, stopped: true
}

// Glyphs from the Nerd Font Material Design set (nf-md-*).
var GLYPH = {
  idle: "\u{F0160}",        // cloud_check
  syncing: "\u{F063F}",     // cloud_sync
  starting: "\u{F063F}",
  paused: "\u{F0163}",      // cloud_outline
  error: "\u{F09E0}",       // cloud_alert
  offline: "\u{F0164}",     // cloud_off_outline
  signed_out: "\u{F0A39}",  // cloud_question
  stopped: "\u{F0164}",
  missing: "\u{F0164}"
}

var ACTION_GLYPH = {
  upload: "\u{F0167}",       // cloud_upload
  download: "\u{F0162}",     // cloud_download
  mkdirRemote: "\u{F0257}",  // folder_plus
  mkdirLocal: "\u{F0257}",
  trashRemote: "\u{F0A7A}",  // trash_can_outline
  trashLocal: "\u{F0A7A}",
  conflict: "\u{F05D6}",     // alert_circle_outline
  reconcile: "\u{F012C}",    // check
  record: "\u{F012C}"
}

function str(value, max) {
  if (typeof value !== "string") return ""
  var s = value.replace(/[\u0000-\u001f\u007f]/g, " ")
  return s.length > max ? s.substring(0, max - 1) + "…" : s
}

function time(value) {
  if (typeof value !== "string") return 0
  var ms = Date.parse(value)
  return isFinite(ms) ? ms : 0
}

function count(value) {
  var n = Number(value)
  return isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function missingStatus() {
  return {
    state: "missing", message: "", paused: false, localRoot: "", remoteRoot: "",
    lastSyncAt: 0, pending: 0, current: null, recent: [], errors: [],
    blockedDeletes: 0, pid: 0
  }
}

function parseStatus(raw) {
  var parsed
  try {
    parsed = JSON.parse(String(raw || ""))
  } catch (e) {
    return missingStatus()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return missingStatus()

  var out = missingStatus()
  out.state = STATES[parsed.state] === true ? parsed.state : "missing"
  out.message = str(parsed.message, MAX_TEXT)
  out.paused = parsed.paused === true
  out.localRoot = str(parsed.localRoot, MAX_PATH)
  out.remoteRoot = str(parsed.remoteRoot, MAX_PATH)
  out.lastSyncAt = time(parsed.lastSyncAt)
  out.pending = count(parsed.pending)
  out.blockedDeletes = count(parsed.blockedDeletes)
  out.pid = count(parsed.pid)

  var cur = parsed.current
  if (cur && typeof cur === "object" && typeof cur.action === "string" && typeof cur.path === "string") {
    out.current = { action: str(cur.action, 40), path: str(cur.path, MAX_PATH) }
  }

  var recent = Array.isArray(parsed.recent) ? parsed.recent : []
  for (var i = 0; i < recent.length && out.recent.length < MAX_RECENT; i++) {
    var r = recent[i]
    if (!r || typeof r.action !== "string" || typeof r.path !== "string") continue
    out.recent.push({ time: time(r.time), action: str(r.action, 40), path: str(r.path, MAX_PATH) })
  }

  var errors = Array.isArray(parsed.errors) ? parsed.errors : []
  for (var j = 0; j < errors.length && out.errors.length < MAX_ERRORS; j++) {
    var e = errors[j]
    if (!e || typeof e.message !== "string") continue
    out.errors.push({ time: time(e.time), path: str(e.path, MAX_PATH), message: str(e.message, MAX_TEXT) })
  }
  return out
}

// The state the widget shows: a status file left behind by a daemon that has
// since died reads as "stopped", whatever it last said.
function effectiveState(status, alive) {
  if (!status || status.state === "missing") return "missing"
  if (status.state === "stopped" || status.state === "signed_out") return status.state
  return alive ? status.state : "stopped"
}

function glyph(state) {
  return GLYPH[state] || GLYPH.missing
}

function actionGlyph(action) {
  return ACTION_GLYPH[action] || "\u{F09EE}" // file_document_outline
}

function baseName(path) {
  var parts = String(path || "").split("/")
  return parts[parts.length - 1] || String(path || "")
}

function parentDir(path) {
  var s = String(path || "")
  var i = s.lastIndexOf("/")
  return i > 0 ? s.substring(0, i) : ""
}

function joinPath(root, rel) {
  if (!root) return ""
  if (!rel) return root
  return root.replace(/\/+$/, "") + "/" + String(rel).replace(/^\/+/, "")
}

// Keys into the i18n catalog; the panel resolves them so a language switch
// re-renders.
function stateKey(state) {
  return "state." + (GLYPH[state] ? state : "missing")
}

function actionKey(action) {
  return ACTION_GLYPH[action] ? "action." + action : "action.other"
}

// Coarse relative time: returns [catalog key, number].
function relativeParts(ms, nowMs) {
  if (!ms) return ["time.never", 0]
  var diff = Math.max(0, Math.floor((nowMs - ms) / 1000))
  if (diff < 60) return ["time.justNow", 0]
  var minutes = Math.floor(diff / 60)
  if (minutes < 60) return ["time.minutesAgo", minutes]
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return ["time.hoursAgo", hours]
  return ["time.daysAgo", Math.floor(hours / 24)]
}

function command(cmd, extra) {
  var obj = { cmd: cmd }
  if (extra) for (var k in extra) obj[k] = extra[k]
  return JSON.stringify(obj) + "\n"
}

function fileUri(path) {
  var parts = String(path || "").split("/")
  for (var i = 0; i < parts.length; i++) parts[i] = encodeURIComponent(parts[i])
  return "file://" + parts.join("/")
}

if (typeof module !== "undefined") {
  module.exports = {
    parseStatus: parseStatus,
    missingStatus: missingStatus,
    effectiveState: effectiveState,
    glyph: glyph,
    actionGlyph: actionGlyph,
    baseName: baseName,
    parentDir: parentDir,
    joinPath: joinPath,
    stateKey: stateKey,
    actionKey: actionKey,
    relativeParts: relativeParts,
    command: command,
    fileUri: fileUri
  }
}
