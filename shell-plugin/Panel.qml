import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Bar icon + panel for the drivesync daemon. All daemon-provided text (paths,
// messages) is rendered with Text.PlainText.
Panel {
  id: panelRoot
  moduleName: "drivesync.panel"
  ipcTarget: "drivesync.panel"
  manageIpc: false

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  readonly property Item panelFlick: panel.loadedContent ? panel.loadedContent.panelFlick : null
  readonly property Item recentColumn: panel.loadedContent ? panel.loadedContent.recentColumn : null

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var status: drive.status
  readonly property string syncState: drive.syncState
  readonly property bool hasProblem: syncState === "error" || status.blockedDeletes > 0
  readonly property bool quiet: syncState === "paused" || syncState === "stopped" || syncState === "missing"
    || syncState === "offline" || syncState === "signed_out"

  // Ticks so relative times ("2m ago") stay current while the panel is open.
  property double now: Date.now()
  property int recentIndex: 0
  property bool cursorActive: false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function rel(ms) {
    var parts = Model.relativeParts(ms, panelRoot.now)
    var text = strings.t(parts[0])
    return text.indexOf("%1") >= 0 ? text.arg(Commons.I18n.formatNumber(parts[1])) : text
  }

  function heroMeta() {
    if (syncState === "syncing" && status.current) {
      return strings.t(Model.actionKey(status.current.action) + ".now").arg(Model.baseName(status.current.path))
    }
    if (syncState === "paused" && status.blockedDeletes > 0) {
      return strings.tn("state.pausedDeletes", status.blockedDeletes).arg(Commons.I18n.formatNumber(status.blockedDeletes))
    }
    return strings.t(Model.stateKey(syncState))
  }

  function tooltip() {
    var line = strings.t("title") + " · " + heroMeta()
    return syncState === "idle" && status.lastSyncAt ? line + " · " + rel(status.lastSyncAt) : line
  }

  function failureText(reason) {
    if (reason === "socket" || reason === "timeout") return strings.t("error.socket")
    if (reason === "login") return strings.t("error.login")
    if (reason === "reply") return strings.t("error.reply")
    return reason
  }

  function moveCursor(dy) {
    var n = status.recent.length
    if (n === 0) return
    if (!cursorActive) { cursorActive = true; return }
    recentIndex = Math.max(0, Math.min(n - 1, recentIndex + dy))
    scrollIntoView()
  }

  function scrollIntoView() {
    if (!panelFlick || !recentColumn || recentIndex >= recentColumn.children.length) return
    var item = recentColumn.children[recentIndex]
    Qt.callLater(function() {
      if (!item || !panelFlick) return
      var y = item.mapToItem(panelFlick.contentItem, 0, 0).y
      var margin = Style.space(6)
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (y < panelFlick.contentY + margin) panelFlick.contentY = Math.max(0, y - margin)
      else if (y + item.height > panelFlick.contentY + panelFlick.height - margin)
        panelFlick.contentY = Math.min(maxY, y + item.height + margin - panelFlick.height)
    })
  }

  function reveal(entry) {
    if (!entry || entry.action === "trashRemote" || entry.action === "trashLocal") return
    var abs = Model.joinPath(status.localRoot, entry.path)
    if (entry.action === "mkdirLocal" || entry.action === "mkdirRemote") drive.openFolder(abs)
    else drive.revealFile(abs)
  }

  onOpenedChanged: if (opened) {
    now = Date.now()
    cursorActive = false
    recentIndex = 0
    if (panelFlick) panelFlick.contentY = 0
    drive.refresh()
    Qt.callLater(function() { if (panel.loadedContent) panel.loadedContent.forceActiveFocus() })
  }

  Service { id: drive }

  Timer {
    interval: 30000
    repeat: true
    running: panelRoot.opened
    onTriggered: panelRoot.now = Date.now()
  }

  ShellIpc {
    target: panelRoot.ipcTarget
    function open(): void { panelRoot.open() }
    function close(): void { panelRoot.close() }
    function toggle(): void { panelRoot.toggle() }
    function status(): string { return panelRoot.syncState }
    function pause(): string { drive.pause(); return "ok" }
    function resume(): string { drive.resume(); return "ok" }
    function syncNow(): string { drive.syncNow(); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: panelRoot.bar
    text: Model.glyph(panelRoot.syncState)
    active: panelRoot.hasProblem
    dimmed: panelRoot.quiet && !panelRoot.hasProblem
    tooltipText: panelRoot.opened ? "" : panelRoot.tooltip()
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) drive.toggle()
      else if (buttonCode === Qt.RightButton) drive.openFolder(panelRoot.status.localRoot)
      else panelRoot.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: panelRoot
    bar: panelRoot.bar
    open: panelRoot.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(560))

    content: PanelKeyCatcher {
      property alias panelFlick: panelFlick
      property alias recentColumn: recentColumn
      implicitHeight: column.implicitHeight
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { panelRoot.moveCursor(dy) }
      onActivateRequested: if (panelRoot.cursorActive) panelRoot.reveal(panelRoot.status.recent[panelRoot.recentIndex])
      onCloseRequested: panelRoot.close()
      onTabRequested: function(direction) { panelRoot.switchPanel(direction) }
      onTextKey: function(t) {
        var k = t.toLowerCase()
        if (k === "p") drive.toggle()
        else if (k === "s") drive.syncNow()
        else if (k === "o") drive.openFolder(panelRoot.status.localRoot)
        else if (k === "w") drive.openWeb()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            id: hero
            width: parent.width
            title: strings.t("title")
            meta: panelRoot.heroMeta()
            foreground: panelRoot.foreground
            fontFamily: panelRoot.fontFamily
            iconOpacity: panelRoot.quiet ? 0.5 : 1.0
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: Model.glyph(panelRoot.syncState)
                color: panelRoot.hasProblem ? panelRoot.urgent : panelRoot.foreground
                font.family: panelRoot.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            trailingControl: Component {
              ToggleSwitch {
                id: syncSwitch
                visible: drive.running
                checked: drive.switchOn
                busy: drive.busy
                foreground: panelRoot.foreground
                onToggled: drive.toggle()

                PanelToolTip {
                  visible: syncSwitch.containsMouse
                  text: drive.switchOn ? strings.t("pause") : strings.t("resume")
                  fontFamily: panelRoot.fontFamily
                }
              }
            }
          }

          // Command failures and the daemon's own error message.
          Text {
            textFormat: Text.PlainText
            visible: text !== ""
            width: parent.width
            text: drive.lastError !== "" ? panelRoot.failureText(drive.lastError)
              : (panelRoot.syncState === "error" || panelRoot.syncState === "offline" ? panelRoot.status.message : "")
            color: panelRoot.urgent
            font.family: panelRoot.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // Mass-deletion guard: explain and offer the explicit override.
          ActionRow {
            visible: panelRoot.status.blockedDeletes > 0
            width: parent.width
            glyph: "\u{F0A7A}"
            title: strings.tn("deletes.title", panelRoot.status.blockedDeletes).arg(Commons.I18n.formatNumber(panelRoot.status.blockedDeletes))
            detail: strings.t("deletes.detail")
            actionGlyph: "\u{F012C}"
            actionTip: strings.t("deletes.allow")
            onActivated: drive.allowDeletes()
          }

          ActionRow {
            visible: panelRoot.syncState === "signed_out"
            width: parent.width
            glyph: "\u{F0342}"
            title: drive.signingIn ? strings.t("signIn.waiting") : strings.t("signIn.title")
            detail: strings.t("disclaimer")
            actionGlyph: "\u{F0342}"
            actionTip: strings.t("signIn.title")
            onActivated: drive.signIn()
          }

          ActionRow {
            visible: panelRoot.syncState === "stopped" || panelRoot.syncState === "missing"
            width: parent.width
            glyph: "\u{F0164}"
            title: strings.t("start.title")
            detail: strings.t("start.detail")
            actionGlyph: "\u{F040A}"
            actionTip: strings.t("start.title")
            onActivated: drive.startService()
          }

          Column {
            visible: panelRoot.status.localRoot !== ""
            width: parent.width
            spacing: Style.spacing.labelGap
            InfoPair { label: strings.t("info.folder"); value: panelRoot.status.localRoot }
            InfoPair { label: strings.t("info.drive"); value: panelRoot.status.remoteRoot }
            InfoPair { label: strings.t("info.lastSync"); value: panelRoot.rel(panelRoot.status.lastSyncAt) }
            InfoPair {
              visible: panelRoot.status.pending > 0
              label: strings.t("info.pending")
              value: Commons.I18n.formatNumber(panelRoot.status.pending)
            }
          }

          Row {
            spacing: Style.space(6)
            anchors.horizontalCenter: parent.horizontalCenter
            PanelActionButton {
              iconText: "\u{F0770}"
              tooltipText: strings.t("openFolder")
              foreground: panelRoot.foreground
              fontFamily: panelRoot.fontFamily
              bordered: true
              enabled: panelRoot.status.localRoot !== ""
              onClicked: drive.openFolder(panelRoot.status.localRoot)
            }
            PanelActionButton {
              iconText: "\u{F04E6}"
              tooltipText: strings.t("syncNow")
              foreground: panelRoot.foreground
              fontFamily: panelRoot.fontFamily
              bordered: true
              enabled: drive.running && !drive.busy
              onClicked: drive.syncNow()
            }
            PanelActionButton {
              iconText: "\u{F059F}"
              tooltipText: strings.t("openWeb")
              foreground: panelRoot.foreground
              fontFamily: panelRoot.fontFamily
              bordered: true
              onClicked: drive.openWeb()
            }
          }

          PanelSeparator { foreground: panelRoot.foreground }

          PanelSectionHeader {
            text: strings.t("recent")
            foreground: panelRoot.foreground
            fontFamily: panelRoot.fontFamily
          }

          Text {
            textFormat: Text.PlainText
            visible: panelRoot.status.recent.length === 0
            width: parent.width
            text: strings.t("recent.empty")
            color: panelRoot.dim
            font.family: panelRoot.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          Column {
            id: recentColumn
            visible: panelRoot.status.recent.length > 0
            width: parent.width
            spacing: Style.space(4)
            Repeater {
              model: panelRoot.status.recent
              RecentRow {
                required property var modelData
                required property int index
                width: recentColumn.width
                entry: modelData
                rowIndex: index
              }
            }
          }

          Column {
            visible: panelRoot.status.errors.length > 0
            width: parent.width
            spacing: Style.space(4)
            PanelSectionHeader {
              text: strings.t("errors")
              foreground: panelRoot.foreground
              fontFamily: panelRoot.fontFamily
            }
            Repeater {
              model: panelRoot.status.errors
              Text {
                required property var modelData
                textFormat: Text.PlainText
                width: parent.width
                text: (modelData.path ? modelData.path + ": " : "") + modelData.message
                color: panelRoot.urgent
                font.family: panelRoot.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
                maximumLineCount: 3
                elide: Text.ElideRight
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: strings.t("disclaimer")
            color: panelRoot.dim
            font.family: panelRoot.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }
    }
  }

  component RecentRow: CursorSurface {
    id: row
    property var entry: null
    property int rowIndex: 0
    readonly property bool openable: entry && entry.action !== "trashRemote" && entry.action !== "trashLocal"

    hasCursor: panelRoot.cursorActive && panelRoot.recentIndex === rowIndex
    foreground: panelRoot.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: row.openable ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: { panelRoot.cursorActive = true; panelRoot.recentIndex = row.rowIndex }
      onClicked: panelRoot.reveal(row.entry)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: Model.actionGlyph(row.entry ? row.entry.action : "")
        color: row.entry && row.entry.action === "conflict" ? panelRoot.urgent : panelRoot.foreground
        font.family: panelRoot.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: row.entry ? Model.baseName(row.entry.path) : ""
          color: panelRoot.foreground
          font.family: panelRoot.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideMiddle
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: row.entry
            ? strings.t("recent.meta").arg(strings.t(Model.actionKey(row.entry.action))).arg(panelRoot.rel(row.entry.time))
              + (Model.parentDir(row.entry.path) !== "" ? " · " + Model.parentDir(row.entry.path) : "")
            : ""
          color: panelRoot.dim
          font.family: panelRoot.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }

  component ActionRow: CursorSurface {
    id: actionRow
    property string glyph: ""
    property string title: ""
    property string detail: ""
    property string actionGlyph: ""
    property string actionTip: ""
    signal activated()

    foreground: panelRoot.foreground
    implicitHeight: actionContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      enabled: !drive.busy
      onClicked: actionRow.activated()
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: actionRow.glyph
        color: panelRoot.foreground
        font.family: panelRoot.fontFamily
        font.pixelSize: Style.font.heading
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: actionContent
        Layout.fillWidth: true
        spacing: Style.space(1)
        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: actionRow.title
          color: panelRoot.foreground
          font.family: panelRoot.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }
        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: actionRow.detail
          color: panelRoot.dim
          font.family: panelRoot.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }

      PanelActionButton {
        iconText: actionRow.actionGlyph
        tooltipText: actionRow.actionTip
        foreground: panelRoot.foreground
        fontFamily: panelRoot.fontFamily
        enabled: !drive.busy
        Layout.alignment: Qt.AlignVCenter
        onClicked: actionRow.activated()
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""
    width: parent.width
    spacing: Style.space(8)

    Text {
      id: pairLabel
      textFormat: Text.PlainText
      text: parent.label
      color: panelRoot.foreground
      opacity: 0.6
      font.family: panelRoot.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
    Text {
      textFormat: Text.PlainText
      width: parent.width - pairLabel.implicitWidth - parent.spacing
      horizontalAlignment: Text.AlignRight
      text: parent.value
      color: panelRoot.foreground
      font.family: panelRoot.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideMiddle
    }
  }
}
