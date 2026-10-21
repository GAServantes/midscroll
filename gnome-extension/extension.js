// SPDX-License-Identifier: GPL-3.0-or-later
// midscroll on GNOME Shell (Wayland or X11): visual feedback and the scroll
// itself.
//
// midscroll's daemon runs below the compositor and can't see the screen,
// and its own overlay only works on KDE. This extension connects to the
// daemon's state socket, announces "caps scroll" and receives the speed
// curve as a "cfg" line. Then:
//   - on "press", remembers where the pointer was (the anchor) and starts
//     reporting the on-screen offset back as "screen <dx> <dy>", which the
//     daemon uses to tell a click from a drag;
//   - while a drag-scroll is active ("1"), scrolls the window under the
//     drag through a Clutter virtual pointer as smooth (pixel) scroll,
//     at a speed set by how far the pointer is from the anchor. The
//     daemon's uinput wheel can't do this: libinput swallows the first
//     half notch of every hi-res wheel scroll and re-swallows it on every
//     direction change, which made slow and diagonal drags stall;
//   - fences the pointer inside the window the drag started in with pointer
//     barriers, so the scroll can't wander into another window. (Holding a
//     button would do it without fences, but Mutter only keeps an implicit
//     grab for buttons 1-5, so the daemon's lock button does nothing here.)
//   - draws a badge at the anchor, a bar from the anchor to the pointer
//     colored by distance (green at the anchor, red half a screen away)
//     and a live speed readout.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SOCK_PATH = GLib.getenv('MIDSCROLL_SOCK') || '/run/midscroll/state.sock';
const RECONNECT_S = 3;
const BAR_WIDTH = 6;
const ANCHOR_SIZE = 30;
// Fraction of the screen's height at which the bar turns fully red.
const RED_AT_FRACTION = 0.5;
// The finest scroll step that reaches apps unchanged: Mutter divides a
// continuous scroll by 10 and sends it as wl_fixed (1/256) times 10.
const SCROLL_STEP = 10 / 256;
// Until the daemon's "cfg" line arrives: its built-in defaults.
const DEFAULT_CFG = {
    deadzone: 0, mult: 0.008, exp: 2.2, maxSpeed: 30000, maxDrag: 1200,
    natural: false, free: true, ghost: true, snap: true, ghostScale: 1,
};
const BOOL_CFG = new Set(['natural', 'free', 'ghost', 'snap']);
// The ghost cursor: an arrow outline in 24 px cursor units, tip at 0,0.
const GHOST_ARROW = [[0, 0], [0, 17], [4, 13], [7, 20], [10, 19], [7, 12], [12, 12]];
const GHOST_SIZE = 24;

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
        this._queued = [];
        this._timeline = null;
        this._barriers = [];
        this._window = null;
        this._reconnectId = 0;
        this._anchor = null;
        this._active = false;
        this._speed = [0, 0];
        this._cfg = {...DEFAULT_CFG};
        this._lastTick = 0;
        this._carry = [0, 0];
        this._pos = [0, 0];
        const seat = Clutter.get_default_backend().get_default_seat();
        this._vdev = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._buildUi();
        this._connect();
    }

    disable() {
        this._cancel.cancel();
        this._stopPoll();
        this._unfence();
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        try {
            this._conn?.close(null);
        } catch (e) {}
        this._conn = this._out = null;
        this._vdev = null;
        this._group?.destroy();
        this._group = null;
    }

    // ---- speed and scrolling -----------------------------------------------

    // Pixels/second for a per-axis offset, the daemon's speed_px(): zero
    // inside the dead zone, then SPEED_MULT * distance ^ SPEED_EXP measured
    // from its edge.
    _speedPx(offset) {
        const {deadzone, mult, exp, maxSpeed, maxDrag} = this._cfg;
        const d = Math.min(Math.abs(offset), maxDrag);
        if (d <= deadzone)
            return 0;
        return Math.sign(offset) * Math.min(mult * (d - deadzone) ** exp, maxSpeed);
    }

    // The topmost window under the point, or null over the desktop and the
    // shell's own UI. The extension stays on while the screen is locked (so
    // GNOME never has to turn it back on at unlock); the windows are hidden
    // behind the lock screen then, so none of them counts.
    _windowAt(x, y) {
        if (Main.overview.visible || Main.sessionMode.isLocked)
            return null;
        const ws = global.workspace_manager.get_active_workspace();
        for (const actor of global.get_window_actors().reverse()) {
            const win = actor.meta_window;
            if (!actor.visible || win.minimized || !win.located_on_workspace(ws))
                continue;
            const r = win.get_frame_rect();
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                return win.get_window_type() === Meta.WindowType.DESKTOP ? null : win;
        }
        return null;
    }

    // Four one-way barriers along the window's frame: each lets the
    // pointer move inward and stops it going out.
    _fence(win) {
        this._unfence();
        const r = win.get_frame_rect();
        const D = Meta.BarrierDirection;
        const x2 = r.x + r.width, y2 = r.y + r.height;
        for (const [x1, y1, xb, yb, directions] of [
            [r.x, r.y, r.x, y2, D.POSITIVE_X],
            [x2, r.y, x2, y2, D.NEGATIVE_X],
            [r.x, r.y, x2, r.y, D.POSITIVE_Y],
            [r.x, y2, x2, y2, D.NEGATIVE_Y],
        ]) {
            try {
                this._barriers.push(new Meta.Barrier({
                    backend: global.backend, x1, y1, x2: xb, y2: yb, directions,
                }));
            } catch (e) {
                logError(e, 'midscroll: barrier');
            }
        }
    }

    _unfence() {
        for (const b of this._barriers)
            b.destroy();
        this._barriers = [];
    }

    // FREE_CURSOR off: the daemon holds the real pointer at the anchor, so
    // scrolls keep landing on the spot the drag started on (not the tab
    // strip or toolbar the hand has moved over), and sends the hand's
    // offset as "pos" lines for the ghost cursor to follow.
    get _anchored() {
        return !this._cfg.free;
    }

    // Where the hand is: the ghost when anchored, else the real pointer.
    _hand() {
        if (!this._anchored)
            return global.get_pointer();
        return [this._anchor[0] + this._pos[0], this._anchor[1] + this._pos[1]];
    }

    _offset() {
        if (this._anchored) {
            const s = this._cfg.ghostScale || 1;
            return [this._pos[0] / s, this._pos[1] / s];
        }
        const [px, py] = global.get_pointer();
        return [px - this._anchor[0], py - this._anchor[1]];
    }

    _scroll(now) {
        const dt = Math.min((now - this._lastTick) / 1e6, 0.25);
        this._lastTick = now;
        const [dx, dy] = this._offset();
        const vx = this._speedPx(dx), vy = this._speedPx(dy);
        this._speed = [vx, vy];
        // Drag down/right scrolls the content down/right, like Windows;
        // NATURAL flips it.
        const s = this._cfg.natural ? -1 : 1;
        // Send whole SCROLL_STEPs and carry the rest, so every step reaches
        // the app intact. Apps scale it up (Chromium 12x, GTK3 ~8x, GTK4
        // ~2.5x): whole pixels made Chromium jump 12 px at a time.
        this._carry[0] += s * vx * dt;
        this._carry[1] += s * vy * dt;
        const ix = Math.trunc(this._carry[0] / SCROLL_STEP) * SCROLL_STEP;
        const iy = Math.trunc(this._carry[1] / SCROLL_STEP) * SCROLL_STEP;
        if (!ix && !iy)
            return;
        this._carry[0] -= ix;
        this._carry[1] -= iy;
        // Apps get this as wl_pointer.axis of the same value, in pixels.
        this._vdev?.notify_scroll_continuous(now, ix, iy,
            Clutter.ScrollSource.CONTINUOUS, Clutter.ScrollFinishFlags.NONE);
    }

    // ---- UI ---------------------------------------------------------------

    _buildUi() {
        this._group = new Clutter.Actor({reactive: false, visible: false});
        this._vbar = new St.Widget({style_class: 'midscroll-bar', reactive: false});
        this._hbar = new St.Widget({style_class: 'midscroll-bar', reactive: false});
        this._badge = new St.BoxLayout({
            style_class: 'midscroll-anchor', reactive: false,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        // GNOME 48 replaced St.BoxLayout's `vertical` with `orientation`.
        if ('orientation' in this._badge)
            this._badge.orientation = Clutter.Orientation.VERTICAL;
        else
            this._badge.vertical = true;
        for (const name of ['pan-up-symbolic', 'pan-down-symbolic']) {
            this._badge.add_child(new St.Icon({
                icon_name: name, icon_size: 12, x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._label = new St.Label({style_class: 'midscroll-label', reactive: false});
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._ghost = new St.DrawingArea({
            reactive: false, visible: false,
            width: GHOST_SIZE * scale, height: GHOST_SIZE * scale,
        });
        this._ghost.connect('repaint', area => {
            const cr = area.get_context();
            const k = area.width / GHOST_SIZE;
            cr.translate(1, 1);
            for (const [i, [x, y]] of GHOST_ARROW.entries()) {
                if (i)
                    cr.lineTo(x * k, y * k);
                else
                    cr.moveTo(x * k, y * k);
            }
            cr.closePath();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.fillPreserve();
            cr.setSourceRGBA(0, 0, 0, 1);
            cr.setLineWidth(k);
            cr.stroke();
            cr.$dispose();
        });
        for (const a of [this._vbar, this._hbar, this._badge, this._label, this._ghost])
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
        const [px, py] = this._hand();
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
        // Mutter stops sending pointer events to apps while the pointer is
        // hidden, so the real one stays visible at the anchor.
        this._ghost.visible = this._anchored && this._cfg.ghost;
        this._ghost.set_position(px - 1, py - 1);
    }

    // ---- pointer sampling ------------------------------------------------

    // Runs once per frame of the monitor's refresh while the button is
    // held, so the scroll steps line up with what the apps draw.
    _startPoll() {
        this._stopPoll();
        this._lastTick = GLib.get_monotonic_time();
        this._carry = [0, 0];
        this._timeline = new Clutter.Timeline({actor: global.stage, duration: 1000});
        this._timeline.set_repeat_count(-1);
        this._timeline.connect('new-frame', () => {
            if (!this._anchor)
                return;
            if (!this._anchored) {
                const [dx, dy] = this._offset();
                this._send(`screen ${Math.round(dx)} ${Math.round(dy)}\n`);
            }
            const now = GLib.get_monotonic_time();
            if (this._active)
                this._scroll(now);
            else
                this._lastTick = now;
            this._redraw();
        });
        this._timeline.start();
    }

    _stopPoll() {
        this._timeline?.stop();
        this._timeline = null;
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
            this._send('caps scroll\n');
            this._send('caps anchored\n');
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
        this._queued = [];
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
            // Only the newest offset matters, but other lines must all go.
            const keep = text.startsWith('screen ')
                ? this._queued.filter(q => !q.startsWith('screen '))
                : this._queued;
            this._queued = keep.concat(text);
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
            if (this._queued.length)
                this._send(this._queued.shift());
        });
    }

    _onCfg(text) {
        const cfg = {...DEFAULT_CFG};
        for (const pair of text.split(' ')) {
            const [k, v] = pair.split('=');
            const n = Number(v);
            if (BOOL_CFG.has(k))
                cfg[k] = v === '1';
            else if (k in cfg && Number.isFinite(n) && n >= 0)
                cfg[k] = n;
        }
        this._cfg = cfg;
    }

    _onLine(line) {
        if (line === 'press') {
            const [px, py] = global.get_pointer();
            this._anchor = [px, py];
            this._window = this._windowAt(px, py);
            this._speed = [0, 0];
            this._pos = [0, 0];
            this._startPoll();
        } else if (line === 'release') {
            // Like Windows, the cursor ends up where the hand is.
            if (this._anchor && this._anchored && this._cfg.snap &&
                    (this._pos[0] || this._pos[1])) {
                const [hx, hy] = this._hand();
                Clutter.get_default_backend().get_default_seat().warp_pointer(hx, hy);
            }
            this._anchor = null;
            this._window = null;
            this._active = false;
            this._stopPoll();
            this._unfence();
            this._show(false);
        } else if (line === '1') {
            this._active = true;
            if (!this._anchored && this._window)
                this._fence(this._window);
            this._show(true);
        } else if (line === '0') {
            this._active = false;
            this._unfence();
            this._show(false);
        } else if (line.startsWith('pos ')) {
            const [x, y] = line.slice(4).split(' ').map(Number);
            if (Number.isFinite(x) && Number.isFinite(y))
                this._pos = [x, y];
        } else if (line.startsWith('cfg ')) {
            this._onCfg(line.slice(4));
        }
    }
}
