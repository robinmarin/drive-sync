import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Talks to the drivesync daemon without spawning anything for status:
//   - status:  $XDG_RUNTIME_DIR/drivesync/status.json, rewritten atomically by
//              the daemon on every change (watched, plus a slow re-read
//              because an atomic rename can outrun the file watch)
//   - control: $XDG_RUNTIME_DIR/drivesync/control.sock, one JSON line per
//              command, one JSON line back
// Sign-in and starting the service go through the drivesync CLI / systemctl.
Item {
  id: root

  readonly property string runtimeDir: (Quickshell.env("XDG_RUNTIME_DIR") || "/run/user/1000") + "/drivesync"
  readonly property string statusPath: runtimeDir + "/status.json"
  readonly property string socketPath: runtimeDir + "/control.sock"
  readonly property string cli: Quickshell.env("HOME") + "/.local/bin/drivesync"

  property var status: Model.missingStatus()
  property bool alive: false
  readonly property string syncState: Model.effectiveState(status, alive)
  readonly property bool running: syncState !== "missing" && syncState !== "stopped" && syncState !== "signed_out"
  readonly property bool syncingEnabled: running && !status.paused

  // Optimistic pause/resume so the switch throws on click: -1 follows the
  // daemon, 0/1 while a command is in flight.
  property int _desired: -1
  readonly property bool switchOn: _desired === -1 ? syncingEnabled : _desired === 1

  property string lastError: ""
  readonly property bool busy: control.connected || loginProcess.running
  property bool signingIn: loginProcess.running

  signal commandFailed(string message)

  // ---- status -----------------------------------------------------------

  FileView {
    id: statusFile
    path: root.statusPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.applyStatus(text())
    onLoadFailed: root.applyStatus("")
  }

  // Is the pid in the status file still a process? Catches a daemon that
  // died without rewriting its status.
  FileView {
    id: procFile
    path: root.status.pid > 0 ? "/proc/" + root.status.pid + "/stat" : ""
    printErrors: false
    onLoaded: root.alive = true
    onLoadFailed: root.alive = false
    onPathChanged: if (path === "") root.alive = false
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  function refresh() {
    statusFile.reload()
    if (procFile.path !== "") procFile.reload()
  }

  function applyStatus(raw) {
    status = Model.parseStatus(raw)
    if (_desired !== -1 && syncingEnabled === (_desired === 1)) _desired = -1
  }

  // ---- control socket ---------------------------------------------------

  property string _pending: ""

  Socket {
    id: control
    path: root.socketPath
    connected: false
    onConnectedChanged: {
      if (connected && root._pending !== "") {
        write(root._pending)
        flush()
        root._pending = ""
      }
    }
    onError: function(err) {
      root._pending = ""
      root._desired = -1
      root.fail("socket")
    }
    parser: SplitParser {
      onRead: function(line) {
        control.connected = false
        var reply = null
        try { reply = JSON.parse(line) } catch (e) { }
        if (!reply || reply.ok !== true) {
          root._desired = -1
          root.fail(reply && typeof reply.error === "string" ? reply.error.substring(0, 200) : "reply")
        } else {
          root.lastError = ""
        }
        settle.restart()
      }
    }
  }

  // The command times out if the daemon never answers.
  Timer {
    id: commandTimeout
    interval: 5000
    running: control.connected
    onTriggered: {
      control.connected = false
      root._desired = -1
      root.fail("timeout")
    }
  }

  Timer {
    id: settle
    interval: 400
    onTriggered: root.refresh()
  }

  function send(cmd, extra) {
    if (!running || control.connected) return
    lastError = ""
    _pending = Model.command(cmd, extra)
    control.connected = true
  }

  function fail(reason) {
    lastError = reason
    commandFailed(reason)
  }

  function pause() { _desired = 0; send("pause") }
  function resume() { _desired = 1; send("resume") }
  function allowDeletes() { send("resume", { allowDeletes: true }) }
  function syncNow() { send("sync") }
  function toggle() { if (switchOn) pause(); else resume() }

  // ---- service lifecycle --------------------------------------------------

  function startService() {
    Quickshell.execDetached(["systemctl", "--user", "start", "drivesync"])
    settle.restart()
  }

  function signIn() {
    if (loginProcess.running) return
    lastError = ""
    loginProcess.running = true
  }

  Process {
    id: loginProcess
    command: [root.cli, "login"]
    running: false
    stdout: SplitParser { onRead: function(_line) { } }
    stderr: SplitParser { onRead: function(_line) { } }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        Quickshell.execDetached(["systemctl", "--user", "restart", "drivesync"])
        settle.restart()
      } else {
        root.fail("login")
      }
    }
  }

  // ---- opening things -------------------------------------------------------

  function openFolder(path) {
    if (!path) return
    Quickshell.execDetached(["xdg-open", path])
  }

  function revealFile(path) {
    if (!path) return
    Quickshell.execDetached(["uwsm-app", "--", "nautilus", "--select", Model.fileUri(path)])
  }

  function openWeb() {
    Qt.openUrlExternally("https://drive.proton.me/")
  }
}
