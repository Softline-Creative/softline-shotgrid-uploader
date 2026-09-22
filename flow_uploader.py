#!/usr/bin/env python3
"""
ShotGrid Uploader - drag exports in, they go to Flow Production
Tracking (formerly ShotGrid).

All the matching logic lives in upload_videos.py, which must sit in the
same folder as this file. This is just the interface.

Needs PySide6:
    pip install PySide6

Launch with:  python3 flow_uploader.py
or double-click the launcher.
"""

import datetime
import faulthandler
import os
import re
import shutil
import sys
import tempfile
import threading
import traceback

from PySide6.QtCore import (QEvent, QObject, Qt, QThread, QTimer,
                            Signal)
from PySide6.QtGui import (QColor, QFont, QPalette, QStandardItem,
                           QStandardItemModel)
from PySide6.QtWidgets import (
    QAbstractItemView, QApplication, QCheckBox, QComboBox,
    QCompleter, QDialog,
    QFileDialog, QFrame, QHBoxLayout, QHeaderView, QInputDialog, QLabel,
    QLineEdit,
    QListView, QListWidget, QListWidgetItem, QMainWindow, QMessageBox,
    QProgressBar,
    QPushButton, QRadioButton, QSizePolicy, QTableWidget, QTableWidgetItem,
    QTextEdit,
    QVBoxLayout, QWidget,
)

import shotgun_api3

from config import SERVER_PATH, SCRIPT_NAME, SCRIPT_KEY, PROJECT_ID

try:
    from upload_videos import (
        ParseError, parse_loose, build_key, rank_by_title, BRANDS,
        canonical_name, version_label, scope_sequences,
        find_none_option, compose_sequence_name, is_ambiguous,
    is_known_stage,
        load_sequences, load_entity_options, get_or_create_playlist,
        is_prores, make_proxy, load_prefs, save_prefs,
        suggest_sequence_name, campaign_defaults,
        VIDEO_EXTS, STILL_EXTS, NEW_VERSION_STATUS, MAKE_PROXY_FOR_PRORES,
        ACTIVATION_ENTITY, PRODUCT_ENTITY, DELIVERABLE_ENTITY,
    )
except ImportError as err:
    # The two files are a matched pair. When only one gets replaced the
    # error is an unhelpful traceback in a Terminal window that closes,
    # so say what actually needs doing.
    _app = QApplication(sys.argv)
    QMessageBox.critical(
        None, "Files don't match",
        "flow_uploader.py and upload_videos.py are a matched pair, and "
        "the copy of upload_videos.py in this folder is an older one.\n\n"
        "Replace both files with the newest versions, then try again.\n\n"
        "Technical detail:\n%s" % err)
    sys.exit(1)


# --- ShotGrid-ish dark theme -----------------------------------------------

BG          = "#1e1f22"     # window
PANEL       = "#2a2c30"     # cards, inputs
PANEL_HI    = "#33363b"     # hover, headers
BORDER      = "#3c4046"
TEXT        = "#e2e4e7"
TEXT_DIM    = "#8b9096"
ACCENT      = "#00a8c6"     # ShotGrid teal
ACCENT_HI   = "#00bfe0"

ALL_EXTS = VIDEO_EXTS + STILL_EXTS

GREEN = "#4cb782"
AMBER = "#e0a33e"
RED   = "#e0685c"
GREY  = TEXT_DIM

STYLE = """
QWidget {
    background: %(bg)s; color: %(text)s;
    font-family: -apple-system, 'Helvetica Neue', Arial; font-size: 13px;
}
QLabel { background: transparent; }
QLabel#title { font-size: 20px; font-weight: 600; letter-spacing: 0.3px; }
QLabel#hint { color: %(dim)s; }
QLabel#dropzone {
    border: 2px dashed %(border)s; border-radius: 10px;
    background: %(panel)s; color: %(dim)s; font-size: 15px; padding: 26px;
}
QLabel#dropzone[hot="true"] {
    border-color: %(accent)s; background: #203238; color: %(accent_hi)s;
}
QPushButton {
    background: %(panel)s; border: 1px solid %(border)s; border-radius: 5px;
    padding: 6px 14px; color: %(text)s;
}
QPushButton:hover { background: %(panel_hi)s; border-color: #4d525a; }
QPushButton:pressed { background: #23252a; }
QPushButton:disabled { color: #5a5f66; border-color: #32353a; }
QPushButton#primary {
    background: %(accent)s; border-color: %(accent)s; color: #06222a;
    font-weight: 700;
}
QPushButton#primary:hover { background: %(accent_hi)s; }
QPushButton#primary:disabled { background: #2f3338; border-color: #2f3338;
                               color: #5a5f66; }
QLineEdit, QComboBox, QTextEdit, QListWidget, QTableWidget {
    background: %(panel)s; border: 1px solid %(border)s; border-radius: 5px;
    selection-background-color: %(accent)s; selection-color: #06222a;
}
QLineEdit, QComboBox { padding: 6px 10px; min-height: 22px; }
QLineEdit:focus, QComboBox:focus { border-color: %(accent)s; }

/* A combo's editable field is itself a QLineEdit, so the rule above
   would pad it a second time inside an already-padded combo and push
   the text out of view. Reset it. */
QComboBox QLineEdit {
    border: none; background: transparent; padding: 0;
    margin: 0; min-height: 0; border-radius: 0;
}
QComboBox::drop-down { border: none; width: 24px; }
QComboBox QAbstractItemView {
    background: %(panel)s; border: 1px solid %(border)s;
    padding: 2px;
    selection-background-color: %(accent)s; selection-color: #06222a;
}
QComboBox QAbstractItemView::item { padding: 7px 9px; min-height: 20px; }

/* Widgets sitting inside table cells need a little room of their own. */
QTableWidget QComboBox { margin: 2px 4px; min-height: 18px; }
QLabel { padding: 0; }
QTableWidget { gridline-color: #303338; }
QTableWidget::item { padding: 8px 10px; }
QTableWidget::item:selected { background: #2f4650; color: %(text)s; }
QHeaderView::section {
    background: %(panel_hi)s; color: %(dim)s; border: none;
    border-bottom: 1px solid %(border)s; padding: 9px 10px; font-weight: 600;
    text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;
}
QListWidget::item { padding: 7px 8px; }
QListWidget::item:selected { background: %(accent)s; color: #06222a; }
QTextEdit#log {
    font-family: Menlo, monospace; font-size: 12px;
    background: #17181a; color: #c8ccd0;
}
QProgressBar {
    border: 1px solid %(border)s; border-radius: 5px; height: 8px;
    background: %(panel)s; text-align: center;
}
QProgressBar::chunk { background: %(accent)s; border-radius: 4px; }
QFrame#card {
    border: 1px solid %(border)s; border-radius: 7px; background: %(panel)s;
}
QFrame#card QLabel, QFrame#card QRadioButton { background: transparent; }
QRadioButton { font-weight: 600; spacing: 7px; background: transparent; }
QRadioButton::indicator { width: 14px; height: 14px; }
QScrollBar:vertical { background: transparent; width: 11px; margin: 0; }
QScrollBar::handle:vertical {
    background: #454a51; border-radius: 5px; min-height: 28px;
}
QScrollBar::handle:vertical:hover { background: #565c64; }
QScrollBar::add-line, QScrollBar::sub-line { height: 0; }
QMessageBox, QDialog { background: %(bg)s; }
QToolTip {
    background: %(panel_hi)s; color: %(text)s;
    border: 1px solid %(border)s; padding: 4px;
}
""" % {"bg": BG, "panel": PANEL, "panel_hi": PANEL_HI, "border": BORDER,
       "text": TEXT, "dim": TEXT_DIM, "accent": ACCENT,
       "accent_hi": ACCENT_HI}


def apply_palette(app):
    """Fusion draws some widgets from the palette, not the stylesheet."""
    palette = QPalette()
    palette.setColor(QPalette.Window, QColor(BG))
    palette.setColor(QPalette.WindowText, QColor(TEXT))
    palette.setColor(QPalette.Base, QColor(PANEL))
    palette.setColor(QPalette.AlternateBase, QColor(PANEL_HI))
    palette.setColor(QPalette.Text, QColor(TEXT))
    palette.setColor(QPalette.Button, QColor(PANEL))
    palette.setColor(QPalette.ButtonText, QColor(TEXT))
    palette.setColor(QPalette.Highlight, QColor(ACCENT))
    palette.setColor(QPalette.HighlightedText, QColor("#06222a"))
    palette.setColor(QPalette.ToolTipBase, QColor(PANEL_HI))
    palette.setColor(QPalette.ToolTipText, QColor(TEXT))
    palette.setColor(QPalette.Disabled, QPalette.Text, QColor("#5a5f66"))
    palette.setColor(QPalette.Disabled, QPalette.ButtonText,
                     QColor("#5a5f66"))
    app.setPalette(palette)


class _ClickToOpen(QObject):
    """Opens a combo's list when its text field is clicked.

    The press is swallowed and the list is opened on release. Opening on
    press means the release lands on the list that just appeared under
    the cursor, which closes it again straight away.
    """

    def eventFilter(self, watched, event):
        kind = event.type()
        if kind not in (QEvent.MouseButtonPress, QEvent.MouseButtonRelease,
                        QEvent.MouseButtonDblClick):
            return False
        combo = watched.parent()
        if not isinstance(combo, QComboBox):
            return False
        if kind == QEvent.MouseButtonRelease and not combo.view().isVisible():
            if not watched.isReadOnly():
                watched.clear()      # show the whole list, unfiltered
                watched.setStyleSheet(_LINE_RESET)
            combo.showPopup()
        return True


class _NoWheel(QObject):
    """Stops the wheel changing a closed dropdown.

    Scrolling a page that contains combos otherwise changes whichever
    one happens to be under the pointer, silently.
    """

    def __init__(self, combo):
        super().__init__(combo)
        self._combo = combo

    def eventFilter(self, watched, event):
        if event.type() == QEvent.Wheel and not self._combo.view().isVisible():
            event.ignore()
            return True
        return False


def block_wheel(combo):
    guard = _NoWheel(combo)
    combo._wheel_guard = guard
    combo.installEventFilter(guard)
    combo.setFocusPolicy(Qt.StrongFocus)
    return combo


class _TypeToFilter(QObject):
    """Sends typing to the text field instead of the open list.

    While a combo's popup is open Qt routes key presses to the list,
    which does its own jump-to-first-letter. That means what you type
    never appears in the field. This closes the list on the first
    printable character and restarts it as a filtered search.
    """

    def __init__(self, combo):
        super().__init__(combo)
        self._combo = combo

    def eventFilter(self, watched, event):
        if event.type() != QEvent.KeyPress:
            return False
        text = event.text()
        if not text or not text.isprintable() or text.isspace():
            return False

        combo = self._combo
        combo.hidePopup()
        line = combo.lineEdit()
        line.setStyleSheet(_LINE_RESET)
        line.setFocus()
        line.setText(text)
        line.setCursorPosition(len(text))
        completer = combo.completer()
        if completer is not None:
            completer.setCompletionPrefix(text)
            completer.complete()
        return True


def searchable(combo):
    """A dropdown you can click through or type into.

    Clicking anywhere on it opens the full list, as a plain dropdown
    would. Typing filters that list instead. Text that matches nothing
    is reverted when focus leaves, so a stray keystroke can't leave the
    field in a state that means nothing.
    """
    combo.setEditable(True)
    combo.setInsertPolicy(QComboBox.NoInsert)

    completer = QCompleter(combo.model(), combo)
    completer.setCaseSensitivity(Qt.CaseInsensitive)
    completer.setFilterMode(Qt.MatchContains)
    completer.setCompletionMode(QCompleter.PopupCompletion)
    combo.setCompleter(completer)

    line = combo.lineEdit()
    line.setReadOnly(False)
    line.setStyleSheet(_LINE_RESET)
    opener = _ClickToOpen(combo)
    combo._opener = opener            # keep it alive
    line.installEventFilter(opener)

    typer = _TypeToFilter(combo)
    combo._typer = typer
    combo.view().installEventFilter(typer)
    block_wheel(combo)

    def restore():
        if combo.currentIndex() < 0:
            prompt = getattr(combo, "_prompt", "")
            combo.lineEdit().setText(prompt)
            combo.lineEdit().setStyleSheet(
                _LINE_RESET + (" color: %s;" % AMBER if prompt else ""))
            return
        combo.lineEdit().setStyleSheet(_LINE_RESET)

    line.editingFinished.connect(restore)
    combo.currentIndexChanged.connect(lambda _i: restore())
    return combo


def filter_box(list_widget, placeholder="Type to search..."):
    """A search field that hides non-matching rows in a list."""
    field = QLineEdit()
    field.setPlaceholderText(placeholder)

    def apply():
        term = field.text().strip().lower()
        for i in range(list_widget.count()):
            item = list_widget.item(i)
            item.setHidden(bool(term) and term not in item.text().lower())

    field.textChanged.connect(apply)
    return field


class _SearchTicks(QObject):
    """Type-to-search inside a tick-box dropdown."""

    def __init__(self, combo):
        super().__init__(combo)
        self._combo = combo

    def eventFilter(self, watched, event):
        if event.type() != QEvent.KeyPress:
            return False
        combo = self._combo
        if event.key() == Qt.Key_Backspace:
            combo.set_filter(combo.filter_text()[:-1])
            return True
        if event.key() == Qt.Key_Escape and combo.filter_text():
            combo.set_filter("")
            return True
        text = event.text()
        if text and text.isprintable():
            combo.set_filter(combo.filter_text() + text)
            return True
        return False


class MultiSelect(QComboBox):
    """A dropdown you can tick several things in.

    Looks and opens like any other dropdown; the list holds checkboxes
    and stays open while you tick. The field summarises what's chosen.
    """

    changed = Signal()

    def __init__(self, placeholder="None", parent=None):
        super().__init__(parent)
        self._placeholder = placeholder
        self.setModel(QStandardItemModel(self))
        self.setView(QListView())
        self.view().setSelectionMode(QAbstractItemView.NoSelection)
        self.view().pressed.connect(self._toggle)

        self.setEditable(True)
        self.lineEdit().setReadOnly(True)
        self.lineEdit().setCursor(Qt.PointingHandCursor)
        self.lineEdit().setStyleSheet(_LINE_RESET)
        self._opener = _ClickToOpen(self)
        self.lineEdit().installEventFilter(self._opener)
        self._filter = ""
        self._searcher = _SearchTicks(self)
        self.view().installEventFilter(self._searcher)
        block_wheel(self)
        self._paint()

    # -- contents ------------------------------------------------------------

    def set_options(self, options):
        """options: [{'id':.., 'name':.., 'type':..}, ...]"""
        keep = {o["id"] for o in self.checked()}
        self.model().clear()
        for opt in options:
            item = QStandardItem(opt["name"])
            item.setFlags(Qt.ItemIsUserCheckable | Qt.ItemIsEnabled)
            item.setCheckState(Qt.Checked if opt["id"] in keep
                               else Qt.Unchecked)
            item.setData(opt, Qt.UserRole + 1)
            self.model().appendRow(item)
        self._paint()

    def checked(self):
        out = []
        for row in range(self.model().rowCount()):
            item = self.model().item(row)
            if item is None or item.checkState() != Qt.Checked:
                continue
            out.append(item.data(Qt.UserRole + 1))
        return out

    def checked_ids(self):
        return [o["id"] for o in self.checked()]

    def set_checked_ids(self, ids):
        wanted = set(ids or [])
        for row in range(self.model().rowCount()):
            item = self.model().item(row)
            opt = item.data(Qt.UserRole + 1)
            item.setCheckState(Qt.Checked if opt["id"] in wanted
                               else Qt.Unchecked)
        self._paint()

    # -- internals -----------------------------------------------------------

    # -- searching -----------------------------------------------------------

    def filter_text(self):
        return self._filter

    def set_filter(self, text):
        """Hide rows that don't contain the typed text."""
        self._filter = text
        term = text.strip().lower()
        for row in range(self.model().rowCount()):
            item = self.model().item(row)
            hidden = bool(term) and term not in item.text().lower()
            self.view().setRowHidden(row, hidden)
        self._paint()

    def _toggle(self, index):
        item = self.model().itemFromIndex(index)
        item.setCheckState(Qt.Unchecked if item.checkState() == Qt.Checked
                           else Qt.Checked)
        self._paint()
        self.changed.emit()

    def _paint(self):
        if self._filter:
            # While searching, show what's being typed rather than the
            # selection summary - otherwise the text has nowhere to go.
            self.lineEdit().setText(self._filter)
            self.lineEdit().setStyleSheet(
                _LINE_RESET + " color: %s;" % ACCENT)
            return
        names = [o["name"] for o in self.checked()]
        self.lineEdit().setStyleSheet(_LINE_RESET)
        self.lineEdit().setText(", ".join(names) if names
                                else self._placeholder)
        self.setToolTip("\n".join(names) if names else "")

    def hidePopup(self):
        super().hidePopup()
        if self._filter:
            self.set_filter("")
        self._paint()


def refresh_button(dialog, handler):
    """The Refresh from ShotGrid button, for use inside a dialog."""
    button = QPushButton("Refresh from ShotGrid")
    button.setToolTip("Re-read Sequences, Activations, Products and "
                      "Deliverables, then update this screen.")
    button.clicked.connect(handler)
    return button


_LINE_RESET = ("border: none; background: transparent; padding: 0; "
               "margin: 0; min-height: 0; border-radius: 0;")


def search_title(title, fmt):
    """The title used for grouping, matching and naming.

    The format is folded in, so a square cut is its own video rather
    than a sibling Version of the standard one.
    """
    return "%s_%s" % (title, fmt) if fmt else title


def _unset(combo, prompt):
    """Leave a dropdown with nothing chosen, showing a prompt instead.

    The prompt is written as ordinary text in amber rather than as a
    placeholder, because a stylesheet overrides placeholder colour and
    the faint grey made it look disabled. On the assignment screen an
    empty field is something still to do, and should read that way.
    """
    combo._prompt = prompt
    combo.setCurrentIndex(-1)
    line = combo.lineEdit()
    line.setText(prompt)
    line.setStyleSheet(_LINE_RESET + " color: %s;" % AMBER)
    return combo


def no_enter_default(dialog):
    """Tidy a dialog once its widgets are in place.

    Two fixes, both Qt defaults that bite:

    Buttons in a dialog are "auto default", so pressing Return while
    typing in a search field activates whichever one looks primary.
    Here Return should finish what you're typing, nothing more.

    And a word-wrapped QLabel doesn't ask its layout for extra height
    unless height-for-width is switched on, so wrapped text gets clipped
    or overlaps whatever sits below it.
    """
    for button in dialog.findChildren(QPushButton):
        button.setAutoDefault(False)
        button.setDefault(False)

    for label in dialog.findChildren(QLabel):
        if not label.wordWrap():
            continue
        policy = label.sizePolicy()
        policy.setHeightForWidth(True)
        policy.setVerticalPolicy(QSizePolicy.MinimumExpanding)
        label.setSizePolicy(policy)
        label.setMinimumHeight(label.fontMetrics().height())


def size_to_content(window, table=None, min_w=960, min_h=620,
                    extra_w=120, extra_h=260):
    """Open a window big enough to read, without running off the screen.

    Columns are measured from what's actually in them, including any
    dropdowns sitting in cells, so nothing has to be dragged wider
    before it can be read.
    """
    width, height = min_w, min_h
    if table is not None and table.columnCount():
        measured = extra_w + table.verticalHeader().width()
        for col in range(table.columnCount()):
            widest = table.sizeHintForColumn(col)
            for row in range(table.rowCount()):
                cell = table.cellWidget(row, col)
                if cell is not None:
                    widest = max(widest, cell.sizeHint().width() + 24)
            measured += max(widest, 70)
        width = max(width, measured)
        if table.rowCount():
            height = max(height,
                         extra_h + table.rowCount() * table.rowHeight(0))

    screen = QApplication.primaryScreen()
    if screen is not None:
        area = screen.availableGeometry()
        width = min(width, area.width() - 80)
        height = min(height, area.height() - 80)
    window.resize(width, height)
    return window


def roomy(table, height=38):
    """Give a table rows tall enough that nothing is clipped."""
    header = table.verticalHeader()
    header.setDefaultSectionSize(height)
    header.setMinimumSectionSize(height)
    return table


def _pick_many(parent, heading, options):
    """Tick-box picker. options is [(value, label), ...]; returns values."""
    dialog = QDialog(parent)
    dialog.setWindowTitle("Choose videos")
    dialog.setMinimumWidth(460)
    layout = QVBoxLayout(dialog)
    layout.setSpacing(10)

    head = QLabel(heading)
    head.setObjectName("title")
    head.setWordWrap(True)
    layout.addWidget(head)

    listing = QListWidget()
    listing.setSelectionMode(QAbstractItemView.ExtendedSelection)
    for _value, label in options:
        listing.addItem(label)
    layout.addWidget(filter_box(listing))
    layout.addWidget(listing)

    hint = QLabel("Cmd-click to pick more than one")
    hint.setObjectName("hint")
    layout.addWidget(hint)

    buttons = QHBoxLayout()
    cancel = QPushButton("Cancel")
    cancel.clicked.connect(dialog.reject)
    buttons.addWidget(cancel)
    buttons.addStretch()
    ok = QPushButton("Add")
    ok.setObjectName("primary")
    ok.clicked.connect(dialog.accept)
    buttons.addWidget(ok)
    layout.addLayout(buttons)
    no_enter_default(dialog)

    if dialog.exec() != QDialog.Accepted:
        return []
    return [options[i.row()][0] for i in listing.selectedIndexes()]


ERROR_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "uploader-error.log")


def _record(text):
    """Append to the error log beside the app, best effort."""
    try:
        with open(ERROR_LOG, "a") as handle:
            handle.write("\n%s\n%s\n"
                         % (datetime.datetime.now().isoformat(" ",
                                                              "seconds"),
                            text))
    except Exception:
        pass


def _install_error_handler(window):
    """Catch errors from anywhere and make them findable.

    The app is usually launched by double-clicking, so anything printed
    to stderr disappears with the Terminal window. Three nets here: the
    main thread, background threads (which the main hook never sees),
    and faulthandler for a hard crash that never raises at all.
    """
    def show(summary):
        """Only ever called on the main thread - Qt crashes otherwise."""
        try:
            window.log("ERROR: %s" % summary)
            if not window.log_view.isVisible():
                window.toggle_log()
            QMessageBox.critical(
                window, "Something went wrong",
                "%s\n\nThe full details are in the log at the bottom of "
                "the window, and in:\n%s" % (summary, ERROR_LOG))
        except Exception:
            pass

    def report(exc_type, exc, tb, where=""):
        text = "".join(traceback.format_exception(exc_type, exc, tb))
        sys.__stderr__.write(text)
        _record(text)
        summary = "%s: %s%s" % (exc_type.__name__, exc, where)
        # Hop to the main thread before touching any widget.
        QTimer.singleShot(0, lambda: show(summary))

    sys.excepthook = report
    threading.excepthook = lambda args: report(
        args.exc_type, args.exc_value, args.exc_traceback,
        "  (in a background task)")

    try:
        faulthandler.enable(file=open(ERROR_LOG, "a"))
    except Exception:
        pass


def guarded(method):
    """Wrap a slot so an exception surfaces instead of being swallowed."""
    def wrapper(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except Exception:
            sys.excepthook(*sys.exc_info())
    wrapper.__name__ = method.__name__
    return wrapper


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------

class PreviewWorker(QThread):
    logged = Signal(str)
    finished_ok = Signal(object, object, object, object)
    failed = Signal(str)

    def __init__(self, sg, project):
        super().__init__()
        self.sg, self.project = sg, project

    def run(self):
        try:
            self.logged.emit("Loading Sequences...")
            all_seqs = load_sequences(self.sg, self.project)
            activations = load_entity_options(self.sg, ACTIVATION_ENTITY,
                                              self.project)
            products = load_entity_options(self.sg, PRODUCT_ENTITY,
                                           self.project)
            deliverables = load_entity_options(self.sg, DELIVERABLE_ENTITY,
                                               self.project)
            self.finished_ok.emit(all_seqs, activations, products,
                                  deliverables)
        except Exception as err:
            self.failed.emit("%s: %s\n%s"
                             % (type(err).__name__, err,
                                traceback.format_exc()))


class UploadWorker(QThread):
    logged = Signal(str)
    stepped = Signal(int)
    finished_ok = Signal(int, list)
    failed = Signal(str)

    def __init__(self, sg, project, artist, items, resolved, brand):
        super().__init__()
        self.sg, self.project, self.artist = sg, project, artist
        self.items, self.resolved, self.brand = items, resolved, brand

    def run(self):
        workdir = tempfile.mkdtemp(prefix="sg_proxy_")
        done, failed = 0, []
        try:
            playlist, _ = get_or_create_playlist(self.sg, self.project, True)
            self.logged.emit("Playlist: %s" % playlist["code"])
            self.logged.emit("-" * 56)

            for i, item in enumerate(self.items, 1):
                seq = self.resolved[item["key"]]
                # The format is part of the Sequence now, so it would
                # only be said twice if it went in the Version name too.
                label = canonical_name(self.brand, seq.get("code"),
                                       item["stage"], "", item["label"])
                name = os.path.basename(item["path"])
                self.logged.emit("")
                self.logged.emit("%s -> %s" % (name, seq["code"]))
                try:
                    version = self.sg.create("Version", {
                        "project": self.project,
                        "code": label,
                        "entity": {"type": "Sequence", "id": seq["id"]},
                        "description": "Uploaded from %s" % name,
                        "sg_status_list": NEW_VERSION_STATUS,
                        "sg_path_to_movie": item["path"],
                        "user": {"type": "HumanUser",
                                 "id": self.artist["id"]},
                        "playlists": [{"type": "Playlist",
                                       "id": playlist["id"]}],
                    })

                    path = item["path"]
                    if (item["kind"] == "video" and MAKE_PROXY_FOR_PRORES
                            and is_prores(path)):
                        self.logged.emit("    ProRes - encoding proxy...")
                        proxy = make_proxy(path, workdir)
                        if proxy:
                            path = proxy

                    mb = os.path.getsize(path) / (1024.0 * 1024.0)
                    self.logged.emit("    uploading %.0f MB..." % mb)
                    self.sg.upload("Version", version["id"], path,
                                   "sg_uploaded_movie")
                    self.logged.emit("    done")
                    item["uploaded"] = True
                    done += 1
                except Exception as err:
                    self.logged.emit("    FAILED: %s" % err)
                    failed.append(name)
                self.stepped.emit(i)

            self.finished_ok.emit(done, failed)
        except Exception as err:
            self.failed.emit("%s: %s\n%s"
                             % (type(err).__name__, err,
                                traceback.format_exc()))
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Dialog: what are we uploading, and where does it belong
# ---------------------------------------------------------------------------

class AssignDialog(QDialog):
    """One row per video: pick its Activation and Product.

    Rows can be selected and set together, so a batch that all belongs to
    one campaign takes two clicks, and a mixed batch is still handled
    without leaving the screen.
    """

    def __init__(self, parent, videos, activations, products,
                 refetch=None):
        super().__init__(parent)
        self.setWindowTitle("Where does this belong?")
        self.setMinimumSize(880, 540)

        self._videos = videos          # [(key, title, file_count), ...]
        self._activations = activations
        self._products = products
        self._refetch = refetch
        self.assignments = {}

        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        head = QLabel("Where does this belong?")
        head.setObjectName("title")
        layout.addWidget(head)

        blurb = QLabel("Each video is searched for among the Sequences "
                       "under its Activation or Product. Every video needs "
                       "at least one of the two.")
        blurb.setObjectName("hint")
        blurb.setWordWrap(True)
        layout.addWidget(blurb)

        missing = QLabel("If your Activation or Product isn't listed, "
                         "please contact Richard Kim.")
        missing.setStyleSheet("color: %s;" % AMBER)
        missing.setWordWrap(True)
        layout.addWidget(missing)

        # --- bulk bar ------------------------------------------------------
        bulk = QFrame()
        bulk.setObjectName("card")
        bulk_row = QHBoxLayout(bulk)
        bulk_row.addWidget(QLabel("Set selected rows to"))
        self.bulk_act = searchable(QComboBox())
        for a in activations:
            self.bulk_act.addItem(a["name"])
        _unset(self.bulk_act, "Select Activation")
        bulk_row.addWidget(self.bulk_act, 1)
        self.bulk_prod = MultiSelect("Select Product")
        self.bulk_prod.set_options(products)
        bulk_row.addWidget(self.bulk_prod, 1)
        apply_btn = QPushButton("Apply to selected")
        apply_btn.clicked.connect(self._apply_bulk)
        bulk_row.addWidget(apply_btn)
        layout.addWidget(bulk)

        if refetch:
            top = QHBoxLayout()
            top.addStretch()
            top.addWidget(refresh_button(self, self._refresh))
            layout.addLayout(top)

        # --- one row per video ---------------------------------------------
        self.table = QTableWidget(len(videos), 4)
        roomy(self.table, 52)
        self.table.setHorizontalHeaderLabels(
            ["Video", "Files", "Activation", "Product"])
        self.table.verticalHeader().hide()
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Stretch)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.Interactive)
        header.setSectionResizeMode(3, QHeaderView.Interactive)
        self.table.setColumnWidth(2, 200)
        self.table.setColumnWidth(3, 200)

        self._act_boxes, self._prod_boxes = [], []
        for row, (key, title, count) in enumerate(videos):
            self.table.setItem(row, 0, QTableWidgetItem(title))
            self.table.setItem(row, 1, QTableWidgetItem(str(count)))

            act = searchable(QComboBox())
            for a in activations:
                act.addItem(a["name"])
            _unset(act, "Select Activation")
            act.currentIndexChanged.connect(lambda _i: self._sync_ok())
            self.table.setCellWidget(row, 2, act)
            self._act_boxes.append(act)

            prod = MultiSelect("Select Product")
            prod.set_options(products)
            prod.changed.connect(self._sync_ok)
            self.table.setCellWidget(row, 3, prod)
            self._prod_boxes.append(prod)

        layout.addWidget(self.table, 1)

        buttons = QHBoxLayout()
        back = QPushButton("Back")
        back.clicked.connect(self.reject)
        buttons.addWidget(back)
        buttons.addStretch()
        self.status = QLabel()
        self.status.setStyleSheet("color: %s;" % AMBER)
        buttons.addWidget(self.status)
        buttons.addStretch()
        self.ok_btn = QPushButton("Find Sequences")
        self.ok_btn.setObjectName("primary")
        self.ok_btn.clicked.connect(self.accept)
        buttons.addWidget(self.ok_btn)
        layout.addLayout(buttons)
        no_enter_default(self)
        self._sync_ok()
        size_to_content(self, self.table, min_w=1020, min_h=600)

    def _sync_ok(self):
        missing = [row for row in range(self.table.rowCount())
                   if self._act_boxes[row].currentIndex() < 0
                   and not self._prod_boxes[row].checked()]
        self.ok_btn.setEnabled(not missing)
        self.status.setText(
            "Every video needs an Activation or a Product - %d still to go."
            % len(missing) if missing else "")

    def _refresh(self):
        fetched = self._refetch()
        if not fetched:
            return
        _seqs, acts, prods, _dels = fetched
        self._activations, self._products = acts, prods
        for row in range(self.table.rowCount()):
            self._refill_combo(self._act_boxes[row], "Select Activation", acts)
            self._prod_boxes[row].set_options(prods)
        self._refill_combo(self.bulk_act, "Select Activation", acts)
        self.bulk_prod.set_options(prods)
        self._sync_ok()

    @staticmethod
    def _refill_combo(box, prompt, options):
        previous = box.currentText() if box.currentIndex() >= 0 else ""
        box.blockSignals(True)
        box.clear()
        for opt in options:
            box.addItem(opt["name"])
        index = box.findText(previous, Qt.MatchFixedString) if previous else -1
        if index >= 0:
            box.setCurrentIndex(index)
        else:
            _unset(box, prompt)
        box.blockSignals(False)

    def _apply_bulk(self):
        rows = {i.row() for i in self.table.selectedIndexes()}
        if not rows:
            rows = set(range(self.table.rowCount()))
        ids = self.bulk_prod.checked_ids()
        index = self.bulk_act.currentIndex()
        for row in rows:
            if index >= 0:
                self._act_boxes[row].setCurrentIndex(index)
            self._prod_boxes[row].set_checked_ids(ids)
        self._sync_ok()

    def accept(self):
        for row, (key, _title, _count) in enumerate(self._videos):
            ai = self._act_boxes[row].currentIndex()
            self.assignments[key] = (
                self._activations[ai] if ai >= 0 else None,
                list(self._prod_boxes[row].checked()),
            )
        super().accept()


# ---------------------------------------------------------------------------
# Dialog: link this file key to a Sequence, or make a new one
# ---------------------------------------------------------------------------

class LinkDialog(QDialog):

    def __init__(self, parent, key, example_file, all_sequences, candidates,
                 activations, products, deliverables,
                 suggested_name="", defaults=None):
        super().__init__(parent)
        self.setWindowTitle("Unmatched video")
        self.setMinimumWidth(620)

        self.link_to = None
        self.result_data = None

        self._key = key
        self._all = sorted(all_sequences,
                           key=lambda s: (s.get("code") or "").lower())
        self._candidates = candidates
        self._activations = activations
        self._products = products
        self._deliverables = deliverables
        self._showing_all = False
        self._visible = []

        defaults = defaults or {}
        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        header = QLabel("Which Sequence is this?")
        header.setObjectName("title")
        layout.addWidget(header)

        mono = QLabel(key)
        mono.setFont(QFont("Menlo", 13))
        mono.setStyleSheet("color: %s; font-weight: 600;" % GREEN)
        layout.addWidget(mono)

        source = QLabel("from %s" % example_file)
        source.setObjectName("hint")
        layout.addWidget(source)

        # ---- link ----------------------------------------------------------
        self.link_radio = QRadioButton("Link to an existing Sequence")
        layout.addWidget(self.link_radio)

        link_card = QFrame()
        link_card.setObjectName("card")
        link_layout = QVBoxLayout(link_card)

        self.list_caption = QLabel()
        self.list_caption.setObjectName("hint")
        link_layout.addWidget(self.list_caption)

        self.search = QLineEdit()
        self.search.setPlaceholderText("Search all Sequences...")
        self.search.textChanged.connect(self._refill)
        self.search.hide()
        link_layout.addWidget(self.search)

        self.seq_list = QListWidget()
        self.seq_list.setMinimumHeight(150)
        self.seq_list.itemSelectionChanged.connect(
            lambda: self.link_radio.setChecked(True))
        self.seq_list.itemDoubleClicked.connect(lambda _: self.accept())
        link_layout.addWidget(self.seq_list)

        self.browse_btn = QPushButton()
        self.browse_btn.clicked.connect(self._toggle_browse)
        link_layout.addWidget(self.browse_btn, alignment=Qt.AlignLeft)

        layout.addWidget(link_card)

        # ---- create --------------------------------------------------------
        self.new_radio = QRadioButton("Create a new Sequence")
        layout.addWidget(self.new_radio)

        new_card = QFrame()
        new_card.setObjectName("card")
        new_layout = QVBoxLayout(new_card)

        new_layout.addWidget(QLabel("Sequence name"))
        self.name_field = QLineEdit(suggested_name)
        self.name_field.textEdited.connect(
            lambda _: self.new_radio.setChecked(True))
        new_layout.addWidget(self.name_field)

        new_layout.addWidget(QLabel("Activation"))
        self.activation_box = QComboBox()
        for a in activations:
            self.activation_box.addItem(a["name"])
        new_layout.addWidget(self.activation_box)
        want = defaults.get("activation_id")
        for i, a in enumerate(activations):
            if a["id"] == want:
                self.activation_box.setCurrentIndex(i)
                break

        multi = QHBoxLayout()
        self.product_list = self._multi_list("Product", products,
                                             defaults.get("product_ids"),
                                             multi)
        self.deliverable_list = self._multi_list(
            "Deliverable", deliverables, defaults.get("deliverable_ids"),
            multi)
        new_layout.addLayout(multi)

        if defaults.get("based_on"):
            n = defaults["based_on"]
            hint = QLabel("Pre-filled from %d other %s video%s - change "
                          "anything that's wrong."
                          % (n, key.split("_")[0], "" if n == 1 else "s"))
            hint.setStyleSheet("color: %s;" % GREEN)
            hint.setWordWrap(True)
            new_layout.addWidget(hint)

        layout.addWidget(new_card)

        # ---- buttons -------------------------------------------------------
        buttons = QHBoxLayout()
        skip = QPushButton("Skip this video")
        skip.clicked.connect(self.reject)
        buttons.addWidget(skip)
        buttons.addStretch()
        ok = QPushButton("OK")
        ok.setObjectName("primary")
        ok.clicked.connect(self.accept)
        buttons.addWidget(ok)
        layout.addLayout(buttons)

        self._refill()
        if candidates:
            self.link_radio.setChecked(True)
            self.seq_list.setCurrentRow(0)
        else:
            self.new_radio.setChecked(True)

    # -- helpers -------------------------------------------------------------

    def _multi_list(self, label, options, preselect, parent_layout):
        column = QVBoxLayout()
        column.addWidget(QLabel(label))
        widget = QListWidget()
        widget.setSelectionMode(QAbstractItemView.ExtendedSelection)
        widget.setMaximumHeight(110)
        for opt in options:
            widget.addItem(opt["name"])
        wanted = set(preselect or [])
        for i, opt in enumerate(options):
            if opt["id"] in wanted:
                widget.item(i).setSelected(True)
        widget.itemSelectionChanged.connect(
            lambda: self.new_radio.setChecked(True))
        column.addWidget(widget)
        parent_layout.addLayout(column)
        return widget

    def _toggle_browse(self):
        self._showing_all = not self._showing_all
        self.search.setVisible(self._showing_all)
        if not self._showing_all:
            self.search.clear()
        self._refill()

    def _refill(self):
        self.seq_list.clear()
        self._visible = []

        if self._showing_all:
            term = self.search.text().strip().lower()
            for seq in self._all:
                code = seq.get("code") or "(unnamed)"
                if term and term not in code.lower():
                    continue
                self._visible.append(seq)
                self.seq_list.addItem(code)
            self.list_caption.setText(
                "All %d Sequences in this project." % len(self._all))
            self.browse_btn.setText("Show likely matches only")
        else:
            for score, seq in self._candidates:
                self._visible.append(seq)
                item = QListWidgetItem("%s      %d%% match"
                                       % (seq.get("code"), round(score * 100)))
                if score >= 0.85:
                    item.setForeground(QColor(GREEN))
                self.seq_list.addItem(item)
            if self._candidates:
                self.list_caption.setText(
                    "Closest matches, best first. If none of these is the "
                    "right video, create a new Sequence below.")
            else:
                self.list_caption.setText(
                    "Nothing in the project looks like this video, so it's "
                    "probably new.")
            self.browse_btn.setText("Browse all Sequences...")

    # -- outcome -------------------------------------------------------------

    def accept(self):
        if self.link_radio.isChecked():
            row = self.seq_list.currentRow()
            if row < 0 or row >= len(self._visible):
                QMessageBox.warning(self, "Pick one",
                                    "Choose a Sequence from the list, or "
                                    "switch to creating a new one.")
                return
            self.link_to = self._visible[row]
            super().accept()
            return

        name = self.name_field.text().strip()
        if not name:
            QMessageBox.warning(self, "Name needed",
                                "Give the Sequence a name.")
            return
        if any((s.get("code") or "").strip().lower() == name.lower()
               for s in self._all):
            reply = QMessageBox.question(
                self, "Name already used",
                "A Sequence called '%s' already exists.\n\n"
                "Create a second one anyway?" % name)
            if reply != QMessageBox.Yes:
                return

        data = {"code": name}
        idx = self.activation_box.currentIndex()
        if self._activations and idx >= 0:
            a = self._activations[idx]
            data["sg_activations"] = {"type": a["type"], "id": a["id"]}
        picked = [self._products[i.row()]
                  for i in self.product_list.selectedIndexes()]
        if picked:
            data["sg_product"] = [{"type": p["type"], "id": p["id"]}
                                  for p in picked]
        picked = [self._deliverables[i.row()]
                  for i in self.deliverable_list.selectedIndexes()]
        if picked:
            data["sg_deliverable"] = [{"type": d["type"], "id": d["id"]}
                                      for d in picked]
        self.result_data = data
        super().accept()


class CreateSequencesDialog(QDialog):
    """Name every new Sequence in one screen.

    The form at the top applies to whichever video is selected in the
    list at the bottom, so you can see the whole set, jump between them,
    and tell at a glance which are still unnamed.
    """

    def __init__(self, parent, jobs, activations, products, deliverables,
                 existing_names=(), refetch=None):
        super().__init__(parent)
        self.setWindowTitle("Create new Sequences")
        self.setMinimumSize(760, 820)

        self._jobs = jobs        # [(key, video_title, name_hint, defaults)]
        self._activations = activations
        self._products = products
        self._deliverables = deliverables
        self._current = None
        self._refetch = refetch
        self._hand_edited = set()
        self._existing = {(n or "").strip().lower() for n in existing_names}
        self.data = {}           # key -> sequence payload
        self.shares = {}         # key -> key of the video it shares with

        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        head = QLabel("Create new Sequences")
        head.setObjectName("title")
        layout.addWidget(head)

        blurb = QLabel("These videos didn't match anything, so each needs a "
                       "new Sequence. Every one needs a name and at least "
                       "one Deliverable - the list at the bottom shows "
                       "what's still outstanding.")
        blurb.setObjectName("hint")
        blurb.setWordWrap(True)
        layout.addWidget(blurb)

        if refetch:
            top = QHBoxLayout()
            top.addStretch()
            top.addWidget(refresh_button(self, self._refresh))
            layout.addLayout(top)

        # --- which video this form is for -----------------------------------
        self.subject = QLabel()
        self.subject.setStyleSheet(
            "color: %s; font-size: 15px; font-weight: 600;" % ACCENT)
        self.subject.setWordWrap(True)
        layout.addWidget(self.subject)

        # --- the form --------------------------------------------------------
        card = QFrame()
        card.setObjectName("card")
        form = QVBoxLayout(card)

        form.addWidget(QLabel("Sequence name"))
        self.name_field = QLineEdit()
        self.name_field.textEdited.connect(self._name_edited)
        form.addWidget(self.name_field)

        self.name_note = QLabel()
        self.name_note.setWordWrap(True)
        form.addWidget(self.name_note)

        form.addWidget(QLabel("Activation"))
        self.act_box = searchable(QComboBox())
        self.act_box.addItem("No Activation")
        for a in activations:
            self.act_box.addItem(a["name"])
        self.act_box.currentIndexChanged.connect(
            lambda _i: (self._recompose(), self._touch()))
        form.addWidget(self.act_box)

        form.addWidget(QLabel("Product"))
        self.prod_list = MultiSelect("No Product")
        self.prod_list.set_options(products)
        self.prod_list.changed.connect(
            lambda: (self._recompose(), self._touch()))
        form.addWidget(self.prod_list)

        form.addWidget(QLabel("Deliverable"))
        self.del_list = MultiSelect("Select Deliverable")
        self.del_list.set_options(deliverables)
        self.del_list.changed.connect(
            lambda: (self._recompose(), self._touch()))
        form.addWidget(self.del_list)

        hint = QLabel("Click to open, tick as many as apply")
        hint.setObjectName("hint")
        form.addWidget(hint)

        self.origin = QLabel()
        self.origin.setWordWrap(True)
        form.addWidget(self.origin)

        missing = QLabel("If your Product or Deliverable isn't listed, "
                         "please contact Richard Kim.")
        missing.setStyleSheet("color: %s;" % AMBER)
        missing.setWordWrap(True)
        form.addWidget(missing)

        layout.addWidget(card)

        # --- everything still to do ------------------------------------------
        share_row = QHBoxLayout()
        self.share_btn = QPushButton("Also use this Sequence for...")
        self.share_btn.setToolTip(
            "Point other videos at the Sequence you're naming here, "
            "instead of creating a second one for them.")
        self.share_btn.clicked.connect(self._share)
        share_row.addWidget(self.share_btn)
        self.unlink_btn = QPushButton("Give this its own Sequence")
        self.unlink_btn.clicked.connect(self._unlink)
        self.unlink_btn.hide()
        share_row.addWidget(self.unlink_btn)
        share_row.addStretch()
        layout.addLayout(share_row)

        layout.addWidget(QLabel("Videos needing a new Sequence"))
        self.job_list = QListWidget()
        self.job_list.setMinimumHeight(140)
        for key, title, hint_name, defaults in jobs:
            self.job_list.addItem(QListWidgetItem(title))
        self.job_list.currentRowChanged.connect(self._switch)
        layout.addWidget(self.job_list, 1)

        self.progress_label = QLabel()
        self.progress_label.setObjectName("hint")
        layout.addWidget(self.progress_label)

        buttons = QHBoxLayout()
        back = QPushButton("Back")
        back.clicked.connect(self.reject)
        buttons.addWidget(back)
        buttons.addStretch()
        self.done_btn = QPushButton("Done")
        self.done_btn.setObjectName("primary")
        self.done_btn.clicked.connect(self.accept)
        buttons.addWidget(self.done_btn)
        layout.addLayout(buttons)

        no_enter_default(self)
        size_to_content(self, None, min_w=820, min_h=880)
        self._seed_all()
        self.job_list.setCurrentRow(0)

    # -- form plumbing --------------------------------------------------------

    _FIELD_NAMES = {"activation_id": "Activation",
                    "product_ids": "Product",
                    "deliverable_ids": "Deliverable"}

    def _show_origin(self, defaults):
        support = defaults.get("support", {})
        parts = []
        for field in defaults.get("guessed", []):
            backing = support.get(field)
            if backing:
                parts.append("%s copied from %d of %d Sequences here"
                             % (self._FIELD_NAMES[field], backing[0],
                                backing[1]))
            else:
                parts.append("%s copied from this campaign"
                             % self._FIELD_NAMES[field])

        missing = [self._FIELD_NAMES[f] for f in defaults.get("missing", [])
                   if f == "deliverable_ids"]
        if missing and not any("Deliverable" in p for p in parts):
            parts.append("nothing to copy for Deliverable - none of the "
                         "other Sequences in this campaign have one set")

        if not parts:
            self.origin.setText("")
            return
        self.origin.setText("%s. Change anything that's wrong."
                            % "; ".join(parts).capitalize())
        self.origin.setStyleSheet("color: %s;" % AMBER)

    def _touch(self):
        self._store()
        self._refresh_list()

    def _refresh(self):
        fetched = self._refetch()
        if not fetched:
            return
        _seqs, acts, prods, dels = fetched
        self._store()
        self._activations, self._products = acts, prods
        self._deliverables = dels

        previous = self.act_box.currentText()
        self.act_box.blockSignals(True)
        self.act_box.clear()
        self.act_box.addItem("No Activation")
        for a in acts:
            self.act_box.addItem(a["name"])
        index = self.act_box.findText(previous, Qt.MatchFixedString)
        self.act_box.setCurrentIndex(index if index >= 0 else 0)
        self.act_box.blockSignals(False)

        self.prod_list.set_options(prods)
        self.del_list.set_options(dels)
        self._store()
        self._refresh_list()

    def _seed_all(self):
        """Fill every row in from the start.

        Defaults used to be applied only when a row was clicked, so a
        batch of new Sequences arrived mostly blank and looked as though
        the guessing had stopped working after the first one or two.
        """
        for key, title, hint_name, defaults in self._jobs:
            defaults = defaults or {}

            activation = None
            want = defaults.get("activation_id")
            for option in self._activations:
                if option["id"] == want:
                    activation = option
                    break
            if activation is None and want is None:
                activation = find_none_option(self._activations,
                                              "activation")

            product_ids = defaults.get("product_ids")
            if not product_ids:
                blank = find_none_option(self._products, "product")
                product_ids = [blank["id"]] if blank else []
            products = [p for p in self._products
                        if p["id"] in set(product_ids)]

            deliverables = [d for d in self._deliverables
                            if d["id"] in set(
                                defaults.get("deliverable_ids") or [])]

            name = compose_sequence_name(title, deliverables, activation,
                                         products) or hint_name
            if not name:
                continue

            payload = {"code": name}
            if activation:
                payload["sg_activations"] = {"type": activation["type"],
                                             "id": activation["id"]}
            if products:
                payload["sg_product"] = [{"type": p["type"], "id": p["id"]}
                                         for p in products]
            if deliverables:
                payload["sg_deliverable"] = [{"type": d["type"],
                                              "id": d["id"]}
                                             for d in deliverables]
            self.data[key] = payload
        self._refresh_list()

    def _title_for(self, key):
        for k, title, _h, _d in self._jobs:
            if k == key:
                return title
        return key

    def _set_form_enabled(self, enabled):
        for widget in (self.name_field, self.act_box, self.prod_list,
                       self.del_list):
            widget.setEnabled(enabled)
        self.share_btn.setVisible(enabled)
        self.unlink_btn.setVisible(not enabled)

    def _share(self):
        self._store()
        key = self._jobs[self._current][0]
        if key not in self.data:
            QMessageBox.warning(self, "Name it first",
                                "Give this Sequence a name before pointing "
                                "other videos at it.")
            return
        others = [(k, t) for k, t, _h, _d in self._jobs
                  if k != key and self.shares.get(k) != key
                  and k not in {v for v in self.shares.values()}]
        if not others:
            QMessageBox.information(self, "Nothing to add",
                                    "There are no other videos to point "
                                    "at this Sequence.")
            return
        picked = _pick_many(self, "Also use \"%s\" for" % self.data[key]["code"],
                            others)
        for other in picked:
            self.shares[other] = key
            self.data.pop(other, None)
        self._refresh_list()

    def _unlink(self):
        row = self._current
        key = self._jobs[row][0]
        self.shares.pop(key, None)
        self.data.pop(key, None)      # fall back to its own suggested name
        self._current = None          # don't save the old row's name over it
        self._switch(row)

    def _switch(self, row):
        if row < 0 or row >= len(self._jobs):
            return
        if self._current is not None and \
                self._jobs[self._current][0] not in self.shares:
            self._store()
        self._current = row
        key, title, hint_name, defaults = self._jobs[row]

        if key in self.shares:
            owner = self.shares[key]
            self.subject.setText(
                "%s shares the Sequence being made for %s"
                % (title, self._title_for(owner)))
            self.name_field.setText(
                self.data.get(owner, {}).get("code", ""))
            self._set_form_enabled(False)
            self._refresh_list()
            return

        self._set_form_enabled(True)
        saved = self.data.get(key)
        self.subject.setText("Naming the Sequence for:  %s" % title)

        # Links first, so the name can be built from them.
        want = ((saved.get("sg_activations") or {}).get("id") if saved
                else (defaults or {}).get("activation_id"))
        if want is None and not saved:
            blank = find_none_option(self._activations, "activation")
            if blank:
                want = blank["id"]
        self.act_box.setCurrentIndex(0)
        for i, a in enumerate(self._activations):
            if a["id"] == want:
                self.act_box.setCurrentIndex(i + 1)

        product_ids = ([p["id"] for p in saved.get("sg_product", [])]
                       if saved else (defaults or {}).get("product_ids"))
        if not product_ids and not saved:
            blank = find_none_option(self._products, "product")
            if blank:
                product_ids = [blank["id"]]
        self.prod_list.set_checked_ids(product_ids)

        self.del_list.set_checked_ids(
            [d["id"] for d in saved.get("sg_deliverable", [])] if saved
            else (defaults or {}).get("deliverable_ids"))

        if key in self._hand_edited and saved:
            self.name_field.setText(saved["code"])
            self._show_name_note()
        else:
            self._recompose()

        self._show_origin(defaults or {})
        self._store()
        self._refresh_list()

    def _recompose(self):
        """Rebuild the name from the title and the current selections."""
        if self._current is None:
            return
        key, title, hint_name, _defaults = self._jobs[self._current]
        if key in self._hand_edited:
            return
        index = self.act_box.currentIndex()
        activation = self._activations[index - 1] if index > 0 else None
        name = compose_sequence_name(title, self.del_list.checked(),
                                     activation, self.prod_list.checked())
        self.name_field.setText(name or hint_name)
        self._show_name_note()

    def _show_name_note(self):
        key = self._jobs[self._current][0] if self._current is not None \
            else None
        if key in self._hand_edited:
            self.name_note.setText(
                "You've named this one yourself, so it won't follow the "
                "Deliverable or Activation any more - though those still "
                "get set on the Sequence. Clear the field to go back to "
                "building it automatically.")
            self.name_note.setStyleSheet("color: %s;" % AMBER)
        else:
            self.name_note.setText(
                "Built from the title, Deliverable and Activation, and "
                "updates as you change them. Type over it to name this "
                "one yourself.")
            self.name_note.setStyleSheet("color: %s;" % GREY)

    def _name_edited(self):
        """Typing takes the name off auto; clearing it puts it back."""
        if self._current is None:
            return
        key = self._jobs[self._current][0]
        if self.name_field.text().strip():
            self._hand_edited.add(key)
        else:
            self._hand_edited.discard(key)
            self._recompose()
        self._show_name_note()
        self._touch()

    def _store(self):
        if self._current is None:
            return
        key = self._jobs[self._current][0]
        if key in self.shares:
            return
        name = self.name_field.text().strip()
        if not name:
            self.data.pop(key, None)
            return
        payload = {"code": name}
        idx = self.act_box.currentIndex()
        if idx > 0:
            a = self._activations[idx - 1]
            payload["sg_activations"] = {"type": a["type"], "id": a["id"]}
        picked = self.prod_list.checked()
        if picked:
            payload["sg_product"] = [{"type": p["type"], "id": p["id"]}
                                     for p in picked]
        picked = self.del_list.checked()
        if picked:
            payload["sg_deliverable"] = [{"type": d["type"], "id": d["id"]}
                                         for d in picked]
        self.data[key] = payload

    def _complete(self, key):
        payload = self.data.get(key)
        return bool(payload and payload.get("sg_deliverable"))

    def _refresh_list(self):
        done = 0
        for row, (key, title, _hint, _d) in enumerate(self._jobs):
            item = self.job_list.item(row)
            if key in self.shares:
                owner = self.shares[key]
                name = self.data.get(owner, {}).get("code", "?")
                item.setText("%s   ->   %s   (shared)" % (title, name))
                item.setForeground(QColor(ACCENT))
                if self._complete(owner):
                    done += 1
            elif self._complete(key):
                name = self.data[key]["code"]
                if name.strip().lower() in self._existing:
                    item.setText("%s   ->   %s   (name already in ShotGrid)"
                                 % (title, name))
                    item.setForeground(QColor(AMBER))
                else:
                    item.setText("%s   ->   %s" % (title, name))
                    item.setForeground(QColor(GREEN))
                done += 1
            elif self.data.get(key):
                item.setText("%s   ->   %s   (needs a Deliverable)"
                             % (title, self.data[key]["code"]))
                item.setForeground(QColor(AMBER))
            else:
                item.setText("%s   (not named yet)" % title)
                item.setForeground(QColor(AMBER))
        total = len(self._jobs)
        self.progress_label.setText("%d of %d ready" % (done, total))
        self.done_btn.setEnabled(done == total)

    def accept(self):
        self._store()
        unnamed, undelivered = [], []
        for key, title, _h, _d in self._jobs:
            owner = self.shares.get(key, key)
            if owner not in self.data:
                unnamed.append(title)
            elif not self.data[owner].get("sg_deliverable"):
                undelivered.append(title)
        if unnamed or undelivered:
            parts = []
            if unnamed:
                parts.append("Still need a name:\n  %s"
                             % "\n  ".join(unnamed))
            if undelivered:
                parts.append("Still need a Deliverable:\n  %s"
                             % "\n  ".join(undelivered))
            QMessageBox.warning(self, "Not ready yet", "\n\n".join(parts))
            return

        # A name that already exists in ShotGrid, or one used twice in
        # this batch, is usually a Sequence that should have been linked
        # to rather than remade.
        clashes, seen = [], {}
        for key, title, _h, _d in self._jobs:
            if key in self.shares:
                continue
            name = self.data[key]["code"].strip()
            slug = name.lower()
            if slug in self._existing:
                clashes.append("%s  ->  %s   (already in ShotGrid)"
                               % (title, name))
            elif slug in seen:
                clashes.append("%s  ->  %s   (same as %s)"
                               % (title, name, seen[slug]))
            seen[slug] = title
        if clashes:
            reply = QMessageBox.question(
                self, "Sequence name already exists",
                "These names are already taken:\n\n  %s\n\n"
                "If one of these is the same video, go back and link to "
                "the existing Sequence instead.\n\nCreate them anyway?"
                % "\n  ".join(clashes))
            if reply != QMessageBox.Yes:
                return
        super().accept()


class MatchesDialog(QDialog):
    """What the tool found, and what you want to do about it.

    One row per video: the best matches in a dropdown, plus the option
    to create a new Sequence instead.
    """

    CREATE = "-- Create a new Sequence --"

    def __init__(self, parent, rows, all_sequences, activations, products,
                 deliverables, defaults_for, name_hint_for, refetch=None):
        super().__init__(parent)
        self.setWindowTitle("Sequences found")
        self.setMinimumSize(960, 560)

        self._rows = rows    # [(key, title, count, candidates, act, prod)]
        self._all = sorted(all_sequences,
                           key=lambda s: (s.get("code") or "").lower())
        self._activations = activations
        self._products = products
        self._deliverables = deliverables
        self._defaults_for = defaults_for
        self._name_hint_for = name_hint_for
        self._refetch = refetch

        self.choices = {}       # key -> ("existing", seq) | ("new", data)
        self._boxes = {}

        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        head = QLabel("Sequences found")
        head.setObjectName("title")
        layout.addWidget(head)

        blurb = QLabel("The closest match is filled in for each video. "
                       "Change any of them, or choose Create a new "
                       "Sequence where nothing fits. A row marked ! has "
                       "two equally good matches and is worth a look. "
                       "You'll name any new Sequences on the next screen.")
        blurb.setObjectName("hint")
        blurb.setWordWrap(True)
        layout.addWidget(blurb)

        if refetch:
            top = QHBoxLayout()
            top.addStretch()
            top.addWidget(refresh_button(self, self._refresh))
            layout.addLayout(top)

        self.show_all = QCheckBox(
            "Show every Sequence in the project, not just the ones under "
            "the Activation or Product you chose")
        self.show_all.toggled.connect(self._rebuild)
        layout.addWidget(self.show_all)

        self.table = QTableWidget(len(rows), 4)
        roomy(self.table, 52)
        self.table.setHorizontalHeaderLabels(
            ["Video", "Files", "Searched in", "Goes to"])
        self.table.verticalHeader().hide()
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.Stretch)

        for row, entry in enumerate(rows):
            key, title, count, candidates = entry[0], entry[1], entry[2], entry[3]
            name_cell = QTableWidgetItem(title)
            if is_ambiguous(candidates):
                name_cell.setText("%s  !" % title)
                name_cell.setForeground(QColor(AMBER))
                name_cell.setToolTip(
                    "Two Sequences fit this equally well - check the "
                    "destination before uploading.")
            self.table.setItem(row, 0, name_cell)
            self.table.setItem(row, 1, QTableWidgetItem(str(count)))
            self.table.setItem(row, 2, QTableWidgetItem(""))
            box = searchable(QComboBox())
            self._boxes[key] = box
            self.table.setCellWidget(row, 3, box)
        self._rebuild()

        layout.addWidget(self.table, 1)

        buttons = QHBoxLayout()
        back = QPushButton("Back")
        back.clicked.connect(self.reject)
        buttons.addWidget(back)
        buttons.addStretch()
        self.ok_btn = QPushButton("Done")
        self.ok_btn.setObjectName("primary")
        self.ok_btn.clicked.connect(self.accept)
        buttons.addWidget(self.ok_btn)
        layout.addLayout(buttons)
        no_enter_default(self)

        for box in self._boxes.values():
            box.currentIndexChanged.connect(lambda _i: self._sync_ok())
        self._sync_ok()
        size_to_content(self, self.table, min_w=1120, min_h=620)

    def _sync_ok(self):
        """Say whether a naming screen follows, or this is the last step."""
        pending = sum(1 for key in self._boxes
                      if (self._boxes[key].currentData() or ("", None))[0]
                      == "create")
        if pending:
            self.ok_btn.setText("Next")
            self.ok_btn.setToolTip(
                "%d new Sequence%s to name on the next screen"
                % (pending, "" if pending == 1 else "s"))
        else:
            self.ok_btn.setText("Done")
            self.ok_btn.setToolTip("Back to the queue, ready to upload")

    def _refresh(self):
        fetched = self._refetch()
        if not fetched:
            return
        seqs, acts, prods, dels = fetched
        self._all = sorted(seqs, key=lambda s: (s.get("code") or "").lower())
        self._activations, self._products = acts, prods
        self._deliverables = dels
        # Re-rank against the new Sequences, keeping each row's scope.
        refreshed = []
        for key, title, count, _cands, act, prods in self._rows:
            refreshed.append((key, title, count,
                              rank_by_title(seqs, title,
                                            act["id"] if act else None,
                                            [p["id"] for p in (prods or [])],
                                            [d["name"] for d
                                             in self._deliverables],
                                            campaign=(act or {}).get("name",
                                                                     "")),
                              act, prods))
        self._rows = refreshed
        self._rebuild(reset=True)
        self._sync_ok()

    def _row_of(self, key):
        for row, entry in enumerate(self._rows):
            if entry[0] == key:
                return row
        return 0

    def _pool_for(self, activation, products):
        """Sequences under this row's Activation or Products."""
        if self.show_all.isChecked():
            return self._all
        pool = scope_sequences(
            self._all,
            activation["id"] if activation else None,
            [p["id"] for p in (products or [])])
        return sorted(pool, key=lambda s: (s.get("code") or "").lower())

    def _rebuild(self, reset=False):
        """Refill every dropdown.

        Normally whatever was already chosen is kept. After a refresh,
        reset=True re-proposes the best match instead, since a Sequence
        that appeared just now is the likely reason for refreshing.
        """
        for key, title, count, candidates, activation, products in self._rows:
            box = self._boxes[key]
            previous = None if reset else box.currentData()
            box.blockSignals(True)
            box.clear()

            for score, seq in candidates:
                box.addItem("%s      %d%%"
                            % (seq.get("code"), round(score * 100)),
                            userData=("existing", seq))
            shown = {s["id"] for _, s in candidates}

            scoped = self._pool_for(activation, products)
            names = [x["name"] for x in
                     ([activation] if activation else []) + list(products or [])]
            cell = self.table.item(self._row_of(key), 2)
            if cell is not None:
                cell.setText("%s  (%d)" % (" / ".join(names) or "everything",
                                           len(scoped)))
                cell.setForeground(QColor(GREY if scoped else AMBER))

            pool = [s for s in scoped if s["id"] not in shown]
            if pool:
                box.insertSeparator(box.count())
                for seq in pool:
                    box.addItem(seq.get("code") or "(unnamed)",
                                userData=("existing", seq))

            box.insertSeparator(box.count())
            box.addItem(self.CREATE, userData=("create", None))

            restored = False
            if previous and previous[0] == "existing":
                for i in range(box.count()):
                    data = box.itemData(i)
                    if data and data[0] == "existing" \
                            and data[1]["id"] == previous[1]["id"]:
                        box.setCurrentIndex(i)
                        restored = True
                        break
            elif previous and previous[0] == "create":
                box.setCurrentIndex(box.count() - 1)
                restored = True

            if not restored:
                box.setCurrentIndex(0 if candidates else box.count() - 1)
            box.blockSignals(False)

    def accept(self):
        """Collect every choice, then name any new Sequences in turn."""
        picks, to_create = {}, []
        for key, title, _count, _cands, act, prods in self._rows:
            data = self._boxes[key].currentData()
            if data and data[0] == "existing":
                picks[key] = ("existing", data[1])
            elif data and data[0] == "create":
                picks[key] = ("create", None)
                to_create.append((key, title, act, prods))
            else:
                QMessageBox.warning(
                    self, "Nothing chosen",
                    "Choose where \"%s\" should go." % title)
                return

        if to_create:
            jobs = [(key, title, self._name_hint_for(key),
                     self._defaults_for(key))
                    for key, title, act, prods in to_create]
            dialog = CreateSequencesDialog(
                self, jobs, self._activations, self._products,
                self._deliverables,
                existing_names=[s.get("code") for s in self._all],
                refetch=self._refetch)
            if dialog.exec() != QDialog.Accepted:
                return          # back to the list, nothing lost
            for key, _t, _h, _d in jobs:
                owner = dialog.shares.get(key)
                if owner:
                    picks[key] = ("shares", owner)
                else:
                    picks[key] = ("new", dialog.data[key])

        self.choices = picks
        super().accept()


class ReviewDialog(QDialog):
    """Final approval: every file and where it is going."""

    def __init__(self, parent, rows, will_ask):
        super().__init__(parent)
        self.setWindowTitle("Ready to upload")
        self.setMinimumWidth(720)

        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        head = QLabel("Check these before uploading")
        head.setObjectName("title")
        layout.addWidget(head)

        blurb = QLabel("Every file and the Sequence it will be added to. "
                       "Close this and use Set sequence... on any row that "
                       "looks wrong.")
        blurb.setObjectName("hint")
        blurb.setWordWrap(True)
        layout.addWidget(blurb)

        table = QTableWidget(len(rows), 3)
        table.setHorizontalHeaderLabels(["File", "Goes to", "Match"])
        table.verticalHeader().hide()
        table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeToContents)
        table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeToContents)
        for r, (name, target, score) in enumerate(rows):
            table.setItem(r, 0, QTableWidgetItem(name))
            cell = QTableWidgetItem(target)
            if score is None:
                cell.setForeground(QColor(AMBER))
            elif score < 0.85:
                cell.setForeground(QColor(AMBER))
            else:
                cell.setForeground(QColor(GREEN))
            table.setItem(r, 1, cell)
            table.setItem(r, 2, QTableWidgetItem(
                "-" if score is None else "%d%%" % round(score * 100)))
        table.setMinimumHeight(240)
        layout.addWidget(table)

        if will_ask:
            note = QLabel("%d video%s has no match yet - you'll be asked "
                          "about %s next."
                          % (will_ask, "" if will_ask == 1 else "s",
                             "it" if will_ask == 1 else "them"))
            note.setStyleSheet("color: %s;" % AMBER)
            note.setWordWrap(True)
            layout.addWidget(note)

        buttons = QHBoxLayout()
        back = QPushButton("Go back")
        back.clicked.connect(self.reject)
        buttons.addWidget(back)
        buttons.addStretch()
        ok = QPushButton("Next")
        ok.setObjectName("primary")
        ok.clicked.connect(self.accept)
        buttons.addWidget(ok)
        layout.addLayout(buttons)


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------

class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("ShotGrid Uploader")
        self.setMinimumSize(900, 640)
        self.setAcceptDrops(True)

        self.sg = None
        self.project = None
        self.artist = None
        self.items = []
        self.all_seqs = []
        self.resolved = {}
        self.scores = {}
        self.previewed = False
        self.destinations_set = False
        self.worker = None
        self._refresh_only = False
        self.brand = BRANDS[0]
        self.activation = None
        self.activations = []
        self.products = []
        self.deliverables = []
        self.pending_new = {}

        self._build()

    # -- layout --------------------------------------------------------------

    def _build(self):
        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(10)

        head = QHBoxLayout()
        title = QLabel("ShotGrid Uploader")
        title.setObjectName("title")
        head.addWidget(title)
        head.addStretch()
        self.refresh_btn = QPushButton("Refresh from ShotGrid")
        self.refresh_btn.setToolTip(
            "Re-read Sequences, Activations, Products and Deliverables.\n"
            "Use this after adding any of them in ShotGrid.")
        self.refresh_btn.clicked.connect(self.on_refresh)
        head.addWidget(self.refresh_btn)
        head.addSpacing(14)
        head.addWidget(QLabel("Brand"))
        self.brand_box = QComboBox()
        self.brand_box.addItems(BRANDS)
        self.brand_box.setMinimumWidth(90)
        head.addWidget(self.brand_box)
        head.addSpacing(14)
        self.status = QLabel("Ready")
        self.status.setObjectName("hint")
        head.addWidget(self.status)
        layout.addLayout(head)

        self.dropzone = QLabel("Drag your videos or stills here")
        self.dropzone.setObjectName("dropzone")
        self.dropzone.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.dropzone)

        bar = QHBoxLayout()
        for label, slot in [("Add files...", self.add_files),
                            ("Add folder...", self.add_folder),
                            ("Remove selected", self.remove_selected),
                            ("Clear matches", self.clear_matches),
                            ("Change destination...",
                             self.set_sequence)]:
            btn = QPushButton(label)
            btn.clicked.connect(slot)
            bar.addWidget(btn)
            if label.startswith("Change destination"):
                btn.setEnabled(False)
                self.sequence_btn = btn
        bar.addStretch()
        self.count_label = QLabel("0 files")
        self.count_label.setObjectName("hint")
        bar.addWidget(self.count_label)
        layout.addLayout(bar)

        self.table = QTableWidget(0, 6)
        roomy(self.table, 34)
        self.table.setHorizontalHeaderLabels(
            ["File", "Title", "Stage", "Type", "Version", "Goes to"])
        self.table.verticalHeader().hide()
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Stretch)
        for col in (1, 2, 3, 4, 5):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        self.table.itemSelectionChanged.connect(self._sync_buttons)
        layout.addWidget(self.table, 1)

        actions = QHBoxLayout()
        self.next_btn = QPushButton("Next")
        self.next_btn.setObjectName("primary")
        self.next_btn.setEnabled(False)
        self.next_btn.clicked.connect(self.on_next)
        actions.addWidget(self.next_btn)
        self.note = QLabel("Nothing is written until you approve the batch.")
        self.note.setObjectName("hint")
        actions.addWidget(self.note)
        actions.addStretch()
        self.log_toggle = QPushButton("Show log")
        self.log_toggle.clicked.connect(self.toggle_log)
        actions.addWidget(self.log_toggle)
        layout.addLayout(actions)

        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.hide()
        layout.addWidget(self.progress)

        self.log_view = QTextEdit()
        self.log_view.setObjectName("log")
        self.log_view.setReadOnly(True)
        self.log_view.setMinimumHeight(160)
        self.log_view.hide()
        layout.addWidget(self.log_view, 1)

        self.setCentralWidget(root)
        size_to_content(self, None, min_w=1120, min_h=900)

    # -- drag and drop -------------------------------------------------------

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
            self.dropzone.setProperty("hot", "true")
            self.dropzone.style().polish(self.dropzone)

    def dragLeaveEvent(self, event):
        self.dropzone.setProperty("hot", "false")
        self.dropzone.style().polish(self.dropzone)

    def dropEvent(self, event):
        self.dropzone.setProperty("hot", "false")
        self.dropzone.style().polish(self.dropzone)
        paths = [u.toLocalFile() for u in event.mimeData().urls()
                 if u.isLocalFile()]
        if paths:
            self.add_paths(paths)
            event.acceptProposedAction()

    # -- logging -------------------------------------------------------------

    def toggle_log(self):
        showing = not self.log_view.isVisible()
        self.log_view.setVisible(showing)
        self.log_toggle.setText("Hide log" if showing else "Show log")

    def log(self, text=""):
        self.log_view.append(text)
        self.log_view.ensureCursorVisible()

    # -- queue ---------------------------------------------------------------

    def add_files(self):
        pattern = "Media files (%s)" % " ".join("*%s" % e
                                               for e in ALL_EXTS)
        chosen, _ = QFileDialog.getOpenFileNames(
            self, "Choose your exports", "", pattern + ";;All files (*)")
        if chosen:
            self.add_paths(chosen)

    def add_folder(self):
        chosen = QFileDialog.getExistingDirectory(
            self, "Choose a folder of exports")
        if chosen:
            self.add_paths([chosen])

    def add_paths(self, paths):
        found = []
        for path in paths:
            path = os.path.abspath(os.path.expanduser(str(path)))
            if os.path.isdir(path):
                for name in sorted(os.listdir(path)):
                    full = os.path.join(path, name)
                    if (os.path.isfile(full) and not name.startswith(".")
                            and os.path.splitext(name)[1].lower()
                            in ALL_EXTS):
                        found.append(full)
            elif os.path.isfile(path):
                if os.path.splitext(path)[1].lower() in ALL_EXTS:
                    found.append(path)
                else:
                    self.log("Ignored (not a video or still): %s"
                             % os.path.basename(path))

        known = {i["path"] for i in self.items}
        added = 0
        for path in found:
            if path in known:
                continue
            item = {"path": path, "kind": None, "title": None,
                    "key": None, "stage": None, "label": None,
                    "format": None, "search_title": None,
                    "error": None, "near": [],
                    "activation": None, "products": [], "uploaded": False}
            try:
                (item["kind"], item["title"], item["stage"],
                 item["format"], item["label"]) = parse_loose(path)
                item["search_title"] = search_title(item["title"],
                                                    item["format"])
            except ParseError as err:
                item["error"] = str(err)
            self.items.append(item)
            known.add(path)
            added += 1

        if added:
            self.previewed = False
            self.destinations_set = False
            self.refresh_table()
            self._sync_buttons()

    def _sync_buttons(self):
        rows = {i.row() for i in self.table.selectedIndexes()}
        self.sequence_btn.setEnabled(bool(rows) and self.previewed)
        good = any(not i["error"] and not i.get("uploaded")
                   for i in self.items)
        self.next_btn.setEnabled(good)
        if not self.previewed:
            self.next_btn.setText("Next")
            self.note.setText("Nothing is written until you upload.")
        elif not self.destinations_set:
            self.next_btn.setText("Choose destinations")
            self.note.setText("Pick where each video goes.")
        else:
            self.next_btn.setText("Upload")
            self.note.setText("Check the Goes to column. Wrong match? "
                              "Select it and use Change destination.")

    def fetch_entities(self):
        """Re-read everything now. Used by the dialogs' Refresh buttons."""
        if not self.connect_sg():
            return None
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            seqs = load_sequences(self.sg, self.project)
            acts = load_entity_options(self.sg, ACTIVATION_ENTITY,
                                       self.project)
            prods = load_entity_options(self.sg, PRODUCT_ENTITY, self.project)
            dels = load_entity_options(self.sg, DELIVERABLE_ENTITY,
                                       self.project)
        finally:
            QApplication.restoreOverrideCursor()
        self.all_seqs = seqs
        self.activations, self.products = acts, prods
        self.deliverables = dels
        self.log("Refreshed: %d Sequences, %d Activations, %d Products, "
                 "%d Deliverables."
                 % (len(seqs), len(acts), len(prods), len(dels)))
        return seqs, acts, prods, dels

    @guarded
    def on_refresh(self):
        """Re-read everything from ShotGrid without losing the queue."""
        if not self.connect_sg():
            return
        self.refresh_btn.setEnabled(False)
        self.next_btn.setEnabled(False)
        self.log("Refreshing from ShotGrid...")
        self._refresh_only = True
        self.worker = PreviewWorker(self.sg, self.project)
        self.worker.logged.connect(self.log)
        self.worker.finished_ok.connect(self._preview_done)
        self.worker.failed.connect(self._worker_failed)
        self.worker.start()

    @guarded
    def on_next(self):
        if not self.previewed:
            self.on_preview()
        elif not self.destinations_set:
            self.show_matches()
        else:
            self.on_upload()

    @guarded
    def set_sequence(self):
        """Reassign the destination Sequence for the selected files."""
        rows = sorted({i.row() for i in self.table.selectedIndexes()})
        chosen = [self.items[r] for r in rows
                  if r < len(self.items) and not self.items[r]["error"]]
        if not chosen:
            return
        keys = []
        for item in chosen:
            if item["key"] not in keys:
                keys.append(item["key"])

        for key in keys:
            first = self.groups[key][0]
            dialog = LinkDialog(
                self, key, os.path.basename(first["path"]), self.all_seqs,
                self.candidates.get(key, []),
                self.activations, self.products, self.deliverables,
                suggested_name=suggest_sequence_name(first["path"]),
                defaults=self._defaults_for(key))
            if dialog.exec() != QDialog.Accepted:
                continue
            if dialog.link_to:
                self.resolved[key] = dialog.link_to
                self.scores[key] = 1.0
                if key in self.new_keys:
                    self.new_keys.remove(key)
                self.log("Set -> %s" % dialog.link_to.get("code"))
            elif dialog.result_data:
                self.pending_new[key] = dialog.result_data
                self.resolved.pop(key, None)
                if key not in self.new_keys:
                    self.new_keys.append(key)
                self.log("Will create -> %s" % dialog.result_data["code"])
        self.refresh_table()

    def remove_selected(self):
        rows = {i.row() for i in self.table.selectedIndexes()}
        if not rows:
            return
        self.items = [item for i, item in enumerate(self.items)
                      if i not in rows]
        self.previewed = False
        self.destinations_set = False
        self.refresh_table()
        self._sync_buttons()

    def clear_matches(self):
        """Forget where everything was going, but keep the files."""
        if not self.items:
            return
        self.resolved = {}
        self.scores = {}
        self.pending_new = {}
        self.candidates = {}
        self.new_keys = []
        for item in self.items:
            item["near"] = []
            item["activation"] = None
            item["products"] = []
        self.previewed = False
        self.destinations_set = False
        self.refresh_table()
        self._sync_buttons()
        self.log("Cleared destinations. Click Next to match again.")

    def refresh_table(self):
        self.table.setRowCount(len(self.items))
        for row, item in enumerate(self.items):
            if item["error"]:
                status, colour = "Bad filename", RED
            elif item.get("uploaded"):
                status, colour = "Uploaded", GREEN
            elif not self.previewed:
                status, colour = "Not checked", GREY
            elif item["key"] in self.pending_new:
                status = "NEW: %s" % self.pending_new[item["key"]]["code"]
                colour = AMBER
            elif item["key"] in self.resolved:
                score = self.scores.get(item["key"], 0)
                status = "%s  (%d%%)" % (
                    self.resolved[item["key"]]["code"], round(score * 100))
                colour = GREEN if score >= 0.85 else AMBER
            elif item["near"]:
                status = "Check: %s" % item["near"][0][1]["code"]
                colour = AMBER
            else:
                status, colour = "New Sequence", AMBER

            odd_stage = bool(item["stage"]) and not is_known_stage(
                item["stage"], item.get("kind") or "video")
            ext = os.path.splitext(item["path"])[1].lstrip(".").upper()
            version = " ".join(p for p in (item.get("format"),
                                           item.get("label")) if p) or "-"
            cells = [os.path.basename(item["path"]),
                     item["title"] or "-",
                     item["stage"] or "-",
                     ext or "-",
                     version,
                     status]
            for col, text in enumerate(cells):
                cell = QTableWidgetItem(text)
                if col == 5:
                    cell.setForeground(QColor(colour))
                if col == 2 and odd_stage:
                    cell.setForeground(QColor(AMBER))
                    cell.setToolTip(
                        "Not a stage the tool recognises. It'll be used as "
                        "typed - check it isn't a typo.")
                self.table.setItem(row, col, cell)

        good = sum(1 for i in self.items if not i["error"])
        bad = len(self.items) - good
        self.count_label.setText(
            "%d file%s%s" % (len(self.items), "" if len(self.items) == 1
                             else "s",
                             ", %d with bad names" % bad if bad else ""))
        self._sync_buttons()

    # -- connection ----------------------------------------------------------

    def connect_sg(self):
        if self.sg:
            return True
        try:
            self.sg = shotgun_api3.Shotgun(SERVER_PATH, SCRIPT_NAME,
                                           SCRIPT_KEY)
            self.project = {"type": "Project", "id": PROJECT_ID}
            self.status.setText("Connected")
            self.status.setStyleSheet("color: %s;" % GREEN)
            return True
        except Exception as err:
            self.status.setText("Connection failed")
            self.status.setStyleSheet("color: %s;" % RED)
            QMessageBox.critical(self, "Couldn't connect",
                                 "%s\n\nCheck config.py." % err)
            return False

    # -- preview -------------------------------------------------------------

    def on_preview(self):
        if not self.connect_sg():
            return
        self.log_view.clear()
        self.next_btn.setEnabled(False)
        self.refresh_btn.setEnabled(False)
        self.worker = PreviewWorker(self.sg, self.project)
        self.worker.logged.connect(self.log)
        self.worker.finished_ok.connect(self._preview_done)
        self.worker.failed.connect(self._worker_failed)
        self.worker.start()

    @guarded
    def _preview_done(self, all_seqs, activations, products,
                      deliverables):
        self.all_seqs = all_seqs
        self.activations, self.products = activations, products
        self.deliverables = deliverables

        self.refresh_btn.setEnabled(True)
        self.log("%d Sequences, %d Activations, %d Products, "
                 "%d Deliverables."
                 % (len(all_seqs), len(activations), len(products),
                    len(deliverables)))

        if self._refresh_only:
            self._refresh_only = False
            if self.previewed:
                self._recompute(quiet=True)
                self.refresh_table()
                self.log("Refreshed. %d matched, %d needing a Sequence."
                         % (len(self.resolved), len(self.new_keys)))
            self._sync_buttons()
            return

        self.log("")
        self.pending_new = {}

        # Group the queue by video, then ask where each one belongs.
        videos, seen = [], {}
        for item in self.items:
            if item["error"]:
                continue
            key = build_key("", item["search_title"])
            item["key"] = key
            if key not in seen:
                seen[key] = len(videos)
                videos.append([key, item["search_title"], 0])
            videos[seen[key]][2] += 1

        if not videos:
            self.previewed = True
            self.refresh_table()
            self._sync_buttons()
            self.log("Nothing uploadable - fix the filenames above.")
            return

        assign = AssignDialog(self, videos, activations, products,
                              refetch=self.fetch_entities)
        if assign.exec() != QDialog.Accepted:
            self.log("Cancelled.")
            self._sync_buttons()
            return

        for item in self.items:
            if item["error"]:
                continue
            act, prods = assign.assignments.get(item["key"], (None, []))
            item["activation"] = act
            item["products"] = prods

        self._recompute(quiet=True)
        good = [i for i in self.items if not i["error"]]
        bad = [i for i in self.items if i["error"]]
        groups = self.groups
        existing = sorted(self.resolved)

        self.log("=" * 56)
        self.log("PREVIEW - nothing has been changed")
        self.log("=" * 56)
        self.log("")
        self.log("%d file(s) ready, %d with bad names" % (len(good), len(bad)))
        odd = sorted({i["stage"] for i in good
                      if i["stage"] and not is_known_stage(
                          i["stage"], i.get("kind") or "video")})
        if odd:
            self.log("Unfamiliar stage(s): %s - used as typed, check for "
                     "typos." % ", ".join(odd))
        self.log("")

        if existing:
            self.log("MATCHED (%d)" % len(existing))
            for key in existing:
                self.log("  %s" % self.resolved[key]["code"])
                for item in groups[key]:
                    self.log("      <- %s"
                             % version_label(item["stage"], item["format"],
                                             item["label"]))
            self.log("")

        if self.new_keys:
            self.log("NO SEQUENCE YET (%d)" % len(self.new_keys))
            for key in sorted(self.new_keys):
                near = self.candidates.get(key, [])
                if near:
                    self.log("  %s" % key)
                    self.log("      probably: %s  (%d%%)"
                             % (near[0][1]["code"], round(near[0][0] * 100)))
                else:
                    self.log("  %s      (looks new)" % key)
            self.log("")

        if bad:
            self.log("SKIPPED (%d)" % len(bad))
            for item in bad:
                self.log("  %s" % os.path.basename(item["path"]))
                self.log("      %s" % item["error"])
            self.log("")

        self.previewed = True
        self.refresh_table()
        self._sync_buttons()
        if not good:
            self.log("Nothing uploadable - fix the filenames above.")
            return

        self.show_matches()

    @guarded
    def show_matches(self):
        """The screen that says what was found and lets you change it."""
        rows = []
        for key, members in self.groups.items():
            first = members[0]
            rows.append((key, first["search_title"], len(members),
                         self.candidates.get(key, []),
                         first.get("activation"), first.get("products")))
        rows.sort(key=lambda r: r[1].lower())

        dialog = MatchesDialog(
            self, rows, self.all_seqs, self.activations, self.products,
            self.deliverables, self._defaults_for,
            lambda k: suggest_sequence_name(self.groups[k][0]["path"]),
            refetch=self.fetch_entities)
        if dialog.exec() != QDialog.Accepted:
            self.log("Back to the queue - nothing written.")
            return

        self.resolved = {}
        self.pending_new = {}
        shares = {}
        for key, (kind, payload) in dialog.choices.items():
            if kind == "existing":
                self.resolved[key] = payload
                self.scores[key] = 1.0
            elif kind == "shares":
                shares[key] = payload
            else:
                self.pending_new[key] = payload

        # Videos sharing a new Sequence become one group, so only a
        # single Sequence is created for all of them.
        for key, owner in shares.items():
            for item in self.groups.get(key, []):
                item["key"] = owner
            self.groups.setdefault(owner, []).extend(
                self.groups.pop(key, []))

        self.new_keys = list(self.pending_new)
        self.destinations_set = True
        self.refresh_table()
        self._sync_buttons()

        made = len(self.pending_new)
        self.log("Destinations chosen for %d video(s)%s. Check the list, "
                 "then click Upload."
                 % (len(self.groups),
                    " - %d new Sequence(s) to create" % made if made else ""))

    @guarded
    def _recompute(self, quiet=False):
        """Re-parse, re-key and re-match, honouring per-file campaigns."""
        for item in self.items:
            if item.get("error") and item.get("key") is None \
                    and item.get("title") is None:
                continue
            activation = item.get("activation")
            products = item.get("products") or []
            campaign = (activation or (products[0] if products else {})
                        ).get("name", "")
            try:
                (item["kind"], item["title"], item["stage"],
                 item["format"], item["label"]) = parse_loose(
                     item["path"], campaign)
                item["search_title"] = search_title(item["title"],
                                                    item["format"])
                item["key"] = build_key(campaign, item["search_title"])
                item["error"] = None
            except ParseError as err:
                item["error"] = str(err)

        good = [i for i in self.items
                if not i["error"] and not i.get("uploaded")]

        self.groups = {}
        for item in good:
            self.groups.setdefault(item["key"], []).append(item)

        # The best match is filled in as a proposal. Nothing is acted on
        # until you approve the batch, and any row can be changed first.
        self.resolved = {}
        self.scores = {}
        self.candidates = {}
        self.new_keys = []
        for key, members in self.groups.items():
            first = members[0]
            act = first.get("activation")
            prods = first.get("products") or []
            hits = rank_by_title(self.all_seqs, first["search_title"],
                                 act["id"] if act else None,
                                 [p["id"] for p in prods],
                                 [d["name"] for d in self.deliverables],
                                 campaign=act["name"] if act else "")
            self.candidates[key] = hits
            if hits:
                self.resolved[key] = hits[0][1]
                self.scores[key] = hits[0][0]
            else:
                self.new_keys.append(key)

        for item in good:
            item["near"] = self.candidates.get(item["key"], [])

        if not quiet:
            self.refresh_table()
            self.log("  now %d matched, %d needing a Sequence."
                     % (len(self.resolved), len(self.new_keys)))

    def _defaults_for(self, key):
        first = self.groups.get(key, [{}])[0]
        activation = first.get("activation")
        products = first.get("products") or []
        found = campaign_defaults(
            self.all_seqs,
            activation["id"] if activation else None,
            [p["id"] for p in products])
        guessed = set(found.get("guessed", []))
        support = found.get("support", {})

        # Whatever was chosen on the assignment screen wins. Whatever was
        # deliberately left blank there stays blank here - a guess must
        # not quietly overrule a decision the user already made.
        if activation:
            found["activation_id"] = activation["id"]
            guessed.discard("activation_id")
        else:
            found.pop("activation_id", None)
            guessed.discard("activation_id")

        if products:
            found["product_ids"] = [p["id"] for p in products]
            guessed.discard("product_ids")
        else:
            found.pop("product_ids", None)
            guessed.discard("product_ids")

        found["guessed"] = sorted(guessed)
        found["support"] = {k: v for k, v in support.items() if k in guessed}
        return found

    def _worker_failed(self, message):
        self._refresh_only = False
        self.refresh_btn.setEnabled(True)
        self.log("ERROR: %s" % message)
        if not self.log_view.isVisible():
            self.toggle_log()
        self._sync_buttons()

    # -- upload --------------------------------------------------------------

    @guarded
    def on_upload(self):
        ready = [i for i in self.items
                 if not i["error"] and not i.get("uploaded")]
        if not ready:
            return
        self.artist = self._resolve_artist()
        if not self.artist:
            return

        skipped = set()
        for key in sorted(self.pending_new):
            data = dict(self.pending_new[key])
            data["project"] = self.project
            try:
                created = self.sg.create("Sequence", data)
                created["code"] = data["code"]
                self.resolved[key] = created
                self.all_seqs.append(created)
                self.log("Created Sequence: %s" % data["code"])
            except Exception as err:
                self.log("Couldn't create %s: %s" % (data["code"], err))
                skipped.add(key)
        self.pending_new = {}

        queue_now = [i for i in ready
                     if i["key"] in self.resolved and i["key"] not in skipped]
        if not queue_now:
            self.log("Nothing left to upload.")
            return

        queue_now = self._check_versions(queue_now)
        if not queue_now:
            self.log("Nothing left to upload.")
            return

        self.next_btn.setEnabled(False)
        self.progress.setMaximum(len(queue_now))
        self.progress.setValue(0)
        self.progress.show()

        self.worker = UploadWorker(self.sg, self.project, self.artist,
                                   queue_now, self.resolved,
                                   self.brand_box.currentText())
        self.worker.logged.connect(self.log)
        self.worker.stepped.connect(self.progress.setValue)
        self.worker.finished_ok.connect(self._upload_done)
        self.worker.failed.connect(self._worker_failed)
        self.worker.start()

    @guarded
    def _upload_done(self, done, failed):
        self.log("")
        self.log("=" * 56)
        self.log("%d uploaded, %d failed" % (done, len(failed)))
        for name in failed:
            self.log("  %s" % name)
        self.log("Transcoding runs on the server - give it a minute.")
        self.progress.hide()
        self.refresh_table()
        self._sync_buttons()

        left = [i for i in self.items
                if not i["error"] and not i.get("uploaded")]
        if left:
            self.destinations_set = False
            self._sync_buttons()
            self.log("%d file(s) still to go." % len(left))
        else:
            self.log("Everything in the queue is uploaded. Drop more files "
                     "to carry on, or use Remove selected to clear them.")

    def _check_versions(self, queue):
        """Catch a version number that's already on the Sequence.

        Usually it means an export was named with a number that has been
        delivered before, and the file wants renaming rather than
        uploading over the top.
        """
        brand = self.brand_box.currentText()
        targets = sorted({self.resolved[i["key"]]["id"] for i in queue})
        if not targets:
            return queue

        taken = {}
        try:
            QApplication.setOverrideCursor(Qt.WaitCursor)
            rows = self.sg.find(
                "Version",
                [["entity", "in", [{"type": "Sequence", "id": i}
                                   for i in targets]]],
                ["code", "entity"])
        finally:
            QApplication.restoreOverrideCursor()
        for row in rows:
            entity = row.get("entity") or {}
            taken.setdefault(entity.get("id"), set()).add(
                (row.get("code") or "").strip().lower())

        clashes = []
        for item in queue:
            seq = self.resolved[item["key"]]
            name = canonical_name(brand, seq.get("code"), item["stage"],
                                  "", item["label"])
            if name.strip().lower() in taken.get(seq["id"], set()):
                clashes.append((item, name))

        if not clashes:
            return queue

        listing = "\n  ".join(
            "%s\n      would become  %s"
            % (os.path.basename(item["path"]), name)
            for item, name in clashes)
        box = QMessageBox(self)
        box.setWindowTitle("Version already exists")
        box.setText(
            "%d file%s would create a Version that already exists on its "
            "Sequence:\n\n  %s\n\nUsually this means the export needs a "
            "higher version number."
            % (len(clashes), "" if len(clashes) == 1 else "s", listing))
        skip_btn = box.addButton("Skip these", QMessageBox.AcceptRole)
        anyway_btn = box.addButton("Upload anyway", QMessageBox.DestructiveRole)
        box.addButton("Cancel", QMessageBox.RejectRole)
        box.exec()

        if box.clickedButton() is anyway_btn:
            self.log("Uploading %d duplicate version(s) anyway."
                     % len(clashes))
            return queue
        if box.clickedButton() is skip_btn:
            dropped = {id(item) for item, _ in clashes}
            for item, name in clashes:
                self.log("Skipped %s - %s already exists."
                         % (os.path.basename(item["path"]), name))
            return [i for i in queue if id(i) not in dropped]
        return []

    def _resolve_artist(self):
        prefs = load_prefs()
        login = prefs.get("artist_login")
        if login:
            user = self.sg.find_one("HumanUser", [["login", "is", login]],
                                    ["id", "name"])
            if user:
                return user
        while True:
            login, ok = QInputDialog.getText(
                self, "Who are you?",
                "Your ShotGrid login, so uploads are credited to you:")
            if not ok:
                return None
            user = self.sg.find_one("HumanUser",
                                    [["login", "is", login.strip()]],
                                    ["id", "name"])
            if user:
                prefs["artist_login"] = login.strip()
                save_prefs(prefs)
                return user
            QMessageBox.warning(self, "Not found",
                                "No user with that login.")



def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    apply_palette(app)
    app.setStyleSheet(STYLE)
    window = MainWindow()
    _install_error_handler(window)
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
