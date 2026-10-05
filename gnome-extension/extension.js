// Visual feedback for midscroll on GNOME Shell (Wayland or X11).
//
// midscroll's daemon runs below the compositor and can't see the screen,
// and its own overlay only works on KDE. This extension connects to the
// daemon's state socket and:
//   - on "press", remembers where the pointer was (the anchor) and starts
//     reporting the on-screen offset back as "screen <dx> <dy>", so the
//     scroll speed follows the distance you actually see;
//   - while a drag-scroll is active ("1"), draws a badge at the anchor, a
//     bar from the anchor to the pointer colored by distance (green at the
//     anchor, red half a screen away) and a live speed readout from the
//     daemon's "speed <vx> <vy>" lines.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SOCK_PATH = '/run/midscroll/state.sock';
const RECONNECT_S = 3;
const POLL_MS = 16;          // ~60 Hz pointer sampling while the button is held
const BAR_WIDTH = 6;
const ANCHOR_SIZE = 30;
// Fraction of the screen's height at which the bar turns fully red.
const RED_AT_FRACTION = 0.5;

function hueColor(frac) {
    // 0 -> green (120deg), 1 -> red (0deg), via yellow/orange.
    const h = 120 * (1 - Math.min(Math.max(frac, 0), 1));
    const c = 1, x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    let [r, g, b] = h < 60 ? [c, x, 0] : [x, c, 0];
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.85)`;
}

function fmtSpeed(v) {
    const a = Math.abs(v);
    return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
}

export default class MidscrollIndicator extends Extension {
    enable() {
        this._cancel = new Gio.Cancellable();
        this._conn = null;
        this._out = null;
        this._writing = false;
        this._queued = null;
        this._pollId = 0;
        this._reconnectId = 0;
        this._anchor = null;
        this._active = false;
        this._speed = [0, 0];
        this._buildUi();
        this._connect();
    }

    disable() {
        this._cancel.cancel();
        this._stopPoll();
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        try {
            this._conn?.close(null);
        } catch (e) {}
        this._conn = this._out = null;
        this._group?.destroy();
        this._group = null;
    }

    // ---- UI ---------------------------------------------------------------

    _buildUi() {
        this._group = new Clutter.Actor({reactive: false, visible: false});
        this._vbar = new St.Widget({style_class: 'midscroll-bar', reactive: false});
        this._hbar = new St.Widget({style_class: 'midscroll-bar', reactive: false});
        this._badge = new St.BoxLayout({
            style_class: 'midscroll-anchor', vertical: true, reactive: false,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        for (const name of ['pan-up-symbolic', 'pan-down-symbolic']) {
            this._badge.add_child(new St.Icon({
                icon_name: name, icon_size: 12, x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._label = new St.Label({style_class: 'midscroll-label', reactive: false});
        for (const a of [this._vbar, this._hbar, this._badge, this._label])
            this._group.add_child(a);
        Main.uiGroup.add_child(this._group);
    }

    _show(on) {
        if (!this._group)
            return;
        if (on) {
            Main.uiGroup.set_child_above_sibling(this._group, null);
            this._redraw();
        }
        this._group.visible = on;
    }

    _redraw() {
        if (!this._active || !this._anchor)
            return;
        const [ax, ay] = this._anchor;
        const [px, py] = global.get_pointer();
        const dx = px - ax, dy = py - ay;
        const redAt = global.stage.height * RED_AT_FRACTION;

        this._badge.set_position(ax - ANCHOR_SIZE / 2, ay - ANCHOR_SIZE / 2);

        // Vertical bar: anchor -> pointer height, colored by distance.
        this._vbar.visible = Math.abs(dy) > ANCHOR_SIZE / 2;
        if (this._vbar.visible) {
            this._vbar.set_position(ax - BAR_WIDTH / 2, Math.min(ay, py));
            this._vbar.set_size(BAR_WIDTH, Math.abs(dy));
            this._vbar.set_style(`background-color: ${hueColor(Math.abs(dy) / redAt)};`);
        }
        this._hbar.visible = Math.abs(dx) > ANCHOR_SIZE / 2;
        if (this._hbar.visible) {
            this._hbar.set_position(Math.min(ax, px), ay - BAR_WIDTH / 2);
            this._hbar.set_size(Math.abs(dx), BAR_WIDTH);
            this._hbar.set_style(`background-color: ${hueColor(Math.abs(dx) / redAt)};`);
        }

        const [vx, vy] = this._speed;
        const parts = [];
        if (vy)
            parts.push(`${vy > 0 ? '▼' : '▲'} ${fmtSpeed(vy)}`);
        if (vx)
            parts.push(`${vx > 0 ? '▶' : '◀'} ${fmtSpeed(vx)}`);
        this._label.text = parts.length ? `${parts.join('  ')} px/s` : '·';
        this._label.set_position(px + 22, py + 14);
    }

    // ---- pointer sampling ------------------------------------------------

    _startPoll() {
        this._stopPoll();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_HIGH, POLL_MS, () => {
            if (!this._anchor)
                return GLib.SOURCE_REMOVE;
            const [px, py] = global.get_pointer();
            this._send(`screen ${Math.round(px - this._anchor[0])} ${Math.round(py - this._anchor[1])}\n`);
            this._redraw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    // ---- socket ------------------------------------------------------------

    _connect() {
        const client = new Gio.SocketClient();
        client.connect_async(Gio.UnixSocketAddress.new(SOCK_PATH), this._cancel, (c, res) => {
            try {
                this._conn = c.connect_finish(res);
            } catch (e) {
                this._scheduleReconnect();
                return;
            }
            this._out = this._conn.get_output_stream();
            this._in = new Gio.DataInputStream({base_stream: this._conn.get_input_stream()});
            this._readLine();
        });
    }

    _scheduleReconnect() {
        if (this._cancel.is_cancelled() || this._reconnectId)
            return;
        this._reconnectId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RECONNECT_S, () => {
            this._reconnectId = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _lost() {
        try {
            this._conn?.close(null);
        } catch (e) {}
        this._conn = this._out = this._in = null;
        this._writing = false;
        this._queued = null;
        this._onLine('release');
        this._scheduleReconnect();
    }

    _readLine() {
        this._in.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                if (!this._cancel.is_cancelled())
                    this._lost();
                return;
            }
            if (line === null) {
                this._lost();
                return;
            }
            this._onLine(line.trim());
            this._readLine();
        });
    }

    _send(text) {
        if (!this._out)
            return;
        if (this._writing) {
            this._queued = text;   // only the newest offset matters
            return;
        }
        this._writing = true;
        const bytes = new GLib.Bytes(new TextEncoder().encode(text));
        this._out.write_bytes_async(bytes, GLib.PRIORITY_HIGH, this._cancel, (o, res) => {
            this._writing = false;
            try {
                o.write_bytes_finish(res);
            } catch (e) {
                return;
            }
            if (this._queued) {
                const next = this._queued;
                this._queued = null;
                this._send(next);
            }
        });
    }

    _onLine(line) {
        if (line === 'press') {
            const [px, py] = global.get_pointer();
            this._anchor = [px, py];
            this._speed = [0, 0];
            this._startPoll();
        } else if (line === 'release') {
            this._anchor = null;
            this._active = false;
            this._stopPoll();
            this._show(false);
        } else if (line === '1') {
            this._active = true;
            this._show(true);
        } else if (line === '0') {
            this._active = false;
            this._show(false);
        } else if (line.startsWith('speed ')) {
            const [vx, vy] = line.slice(6).split(' ').map(Number);
            this._speed = [vx || 0, vy || 0];
            this._redraw();
        }
    }
}
