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
//   - draws an indicator while the drag scrolls: by default a small ring
//     at the anchor that lights the arrows you're pulling toward, and a
//     line fading in from the ring to the hand. The look (ring and trail,
//     ring only, the older bars and badge, or nothing), its color, size,
//     opacity and a speed readout are per-user settings (prefs.js);
//     changing one plays a short preview mid-screen.

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
// The ring, in units at size 1 (scaled by the display and the size setting).
const RING_SIZE = 28;
const TRAIL_WIDTH = 3;
const PREVIEW_US = 4e6;
// Used until the settings load, or for good if their schema is missing.
const LOOK_DEFAULTS = {style: 'ring-trail', color: 'accent', showSpeed: false, opacity: 0.85, size: 1};
// libadwaita's accent colors (GNOME 47+), and Ubuntu's Yaru accents, which
// GNOME 46 on Ubuntu names in the theme ("Yaru-blue-dark"; plain Yaru is
// orange).
const ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800', orange: '#ed5b00',
    red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};
const YARU_ACCENTS = {
    '': '#e95420', bark: '#787859', sage: '#657b69', olive: '#4b8501', viridian: '#03875b',
    prussiangreen: '#308280', blue: '#0073e5', purple: '#7764d8', magenta: '#b34cb3',
    red: '#da3450',
};
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

function hueRgb(frac) {
    // 0 -> green (120deg), 1 -> red (0deg), via yellow/orange.
    const h = 120 * (1 - Math.min(Math.max(frac, 0), 1));
    const x = 1 - Math.abs(((h / 60) % 2) - 1);
    return (h < 60 ? [1, x, 0] : [x, 1, 0]).map(v => Math.round(v * 255));
}

function hexRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function rgba([r, g, b], a) {
    return `rgba(${r}, ${g}, ${b}, ${a})`;
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
        this._demo = null;
        this._look = {...LOOK_DEFAULTS};
        this._watchSettings();
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
        this._stopDemo();
        for (const [obj, id] of this._settingsIds)
            obj.disconnect(id);
        this._settingsIds = [];
        this._settings = this._iface = null;
        this._hideCursor(false);
        this._group?.destroy();
        this._ghost?.destroy();
        this._group = this._ghost = null;
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

    // Where the hand is: the ghost when anchored, else the real pointer
    // (or the preview's made-up hand).
    _hand() {
        if (this._demo)
            return [this._anchor[0] + this._demo.hand[0], this._anchor[1] + this._demo.hand[1]];
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

    // ---- look settings -------------------------------------------------------

    // The look settings (prefs.js) and the desktop's accent color. A copy
    // installed without its schemas/ just keeps the defaults.
    _watchSettings() {
        this._settingsIds = [];
        try {
            this._settings = this.getSettings();
        } catch (e) {
            this._settings = null;
        }
        if (this._settings) {
            this._readLook();
            this._settingsIds.push([this._settings, this._settings.connect('changed', () => {
                this._readLook();
                this._applyLook();
                this._preview();
            })]);
        }
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._readAccent();
        this._settingsIds.push([this._iface, this._iface.connect('changed', (s, key) => {
            if (key === 'accent-color' || key === 'gtk-theme') {
                this._readAccent();
                this._ringKey = this._trailKey = null;
            } else if (key === 'cursor-size') {
                this._applyLook();
            }
        })]);
    }

    _readLook() {
        const s = this._settings;
        this._look = {
            style: s.get_string('style'), color: s.get_string('color'),
            showSpeed: s.get_boolean('show-speed'),
            opacity: s.get_double('opacity'), size: s.get_double('size'),
        };
    }

    _readAccent() {
        const iface = this._iface;
        if (iface.settings_schema.has_key('accent-color')) {
            this._accent = hexRgb(ACCENTS[iface.get_string('accent-color')] ?? ACCENTS.blue);
            return;
        }
        const theme = iface.get_string('gtk-theme').replace(/-dark$/, '');
        const yaru = theme === 'Yaru' ? '' : theme.startsWith('Yaru-') ? theme.slice(5) : null;
        this._accent = hexRgb(YARU_ACCENTS[yaru] ?? ACCENTS.blue);
    }

    // The indicator's color, for a hand `frac` of the way to "fast".
    _tint(frac) {
        if (this._look.color === 'speed')
            return hueRgb(Math.round(frac * 16) / 16);
        return this._look.color === 'white' ? [255, 255, 255] : this._accent;
    }

    // ---- UI ---------------------------------------------------------------

    _buildUi() {
        // _group fades in and out; _indicator inside it carries the opacity
        // setting. The ghost cursor stays apart from both: it stands in
        // for the real pointer, so it is never see-through and appears and
        // goes in step with it.
        this._group = new Clutter.Actor({reactive: false, visible: false});
        this._indicator = new Clutter.Actor({reactive: false});
        this._group.add_child(this._indicator);
        this._showGen = 0;
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
        this._badge.set_pivot_point(0.5, 0.5);
        this._ring = new St.DrawingArea({reactive: false});
        this._ring.set_pivot_point(0.5, 0.5);
        this._ring.connect('repaint', area => this._paintRing(area));
        // Rotated about its left end, which sits at the ring's edge.
        this._trail = new St.Widget({reactive: false});
        this._trail.set_pivot_point(0, 0.5);
        this._label = new St.Label({style_class: 'midscroll-label', reactive: false});
        this._ghost = new St.DrawingArea({reactive: false, visible: false});
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
        for (const a of [this._trail, this._vbar, this._hbar, this._badge, this._ring, this._label])
            this._indicator.add_child(a);
        Main.uiGroup.add_child(this._group);
        Main.uiGroup.add_child(this._ghost);
        this._applyLook();
    }

    // Sizes that follow the size setting and the display's scale.
    _applyLook() {
        if (!this._group)
            return;
        this._theme = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const {size, opacity} = this._look;
        this._k = this._theme * size;
        const ring = Math.round(RING_SIZE * this._k);
        this._ring.set_size(ring, ring);
        this._badge.set_scale(size, size);
        this._label.set_style(`font-size: ${(10 * size).toFixed(1)}pt;`);
        this._ringKey = this._trailKey = null;
        this._indicator.opacity = Math.round(255 * opacity);
        // The ghost matches the real pointer's size.
        const ghost = Math.round((this._iface?.get_int('cursor-size') || GHOST_SIZE) * this._theme);
        this._ghost.set_size(ghost, ghost);
    }

    _show(on) {
        if (!this._group)
            return;
        const gen = ++this._showGen;
        this._group.remove_all_transitions();
        if (on) {
            Main.uiGroup.set_child_above_sibling(this._group, null);
            Main.uiGroup.set_child_above_sibling(this._ghost, null);
            this._ringKey = this._trailKey = null;
            this._redraw();
            if (!this._group.visible) {
                this._group.opacity = 0;
                this._group.visible = true;
                // The ring pops in from half size.
                this._ring.set_scale(0.5, 0.5);
                this._ring.ease({
                    scale_x: 1, scale_y: 1, duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
            this._group.ease({
                opacity: 255, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }
        this._ghost.visible = false;
        if (this._group.visible) {
            this._group.ease({
                opacity: 0, duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (gen === this._showGen && this._group)
                        this._group.visible = false;
                },
            });
        }
    }

    _redraw() {
        if (!this._active || !this._anchor)
            return;
        const [ax, ay] = this._anchor;
        const [px, py] = this._hand();
        const dx = px - ax, dy = py - ay;
        const redAt = global.stage.height * RED_AT_FRACTION;
        const {style} = this._look;

        this._drawClassic(style === 'classic', ax, ay, dx, dy, redAt);
        const tint = this._tint(Math.hypot(dx, dy) / redAt);
        this._drawRing(style === 'ring-trail' || style === 'ring', ax, ay, tint);
        this._drawTrail(style === 'ring-trail', ax, ay, dx, dy, tint);

        const [vx, vy] = this._speed;
        const parts = [];
        if (vy)
            parts.push(`${vy > 0 ? '▼' : '▲'} ${fmtSpeed(vy)}`);
        if (vx)
            parts.push(`${vx > 0 ? '▶' : '◀'} ${fmtSpeed(vx)}`);
        this._label.visible = this._look.showSpeed && parts.length > 0;
        this._label.text = `${parts.join('  ')} px/s`;
        this._label.set_position(px + 22 * this._k, py + 14 * this._k);
        // The preview draws one too, for the made-up hand.
        this._ghost.visible = !!this._demo || (this._anchored && this._cfg.ghost);
        this._ghost.set_position(px - 1, py - 1);
    }

    // The older look: a badge at the anchor and a bar along each axis out
    // to the hand.
    _drawClassic(on, ax, ay, dx, dy, redAt) {
        const w = BAR_WIDTH * this._look.size, gap = ANCHOR_SIZE * this._look.size / 2;
        this._badge.visible = on;
        this._vbar.visible = on && Math.abs(dy) > gap;
        this._hbar.visible = on && Math.abs(dx) > gap;
        if (!on)
            return;
        this._badge.set_position(ax - ANCHOR_SIZE / 2, ay - ANCHOR_SIZE / 2);
        if (this._vbar.visible) {
            this._vbar.set_position(ax - w / 2, Math.min(ay, ay + dy));
            this._vbar.set_size(w, Math.abs(dy));
            this._vbar.set_style(`background-color: ${rgba(this._tint(Math.abs(dy) / redAt), 0.85)};`);
        }
        if (this._hbar.visible) {
            this._hbar.set_position(Math.min(ax, ax + dx), ay - w / 2);
            this._hbar.set_size(Math.abs(dx), w);
            this._hbar.set_style(`background-color: ${rgba(this._tint(Math.abs(dx) / redAt), 0.85)};`);
        }
    }

    _drawRing(on, ax, ay, tint) {
        this._ring.visible = on;
        if (!on)
            return;
        const [w] = this._ring.get_size();
        this._ring.set_position(Math.round(ax - w / 2), Math.round(ay - w / 2));
        const [sx, sy] = this._speed.map(Math.sign);
        // Repaint only when the lit arrows or the color change.
        const key = `${sx} ${sy} ${tint}`;
        if (key !== this._ringKey) {
            this._ringKey = key;
            this._ringLit = [sx, sy, tint];
            this._ring.queue_repaint();
        }
    }

    _paintRing(area) {
        const cr = area.get_context();
        const [w] = area.get_surface_size();
        const k = w / RING_SIZE, c = w / 2, r = c - 1.5 * k;
        const [sx, sy, [R, G, B]] = this._ringLit ?? [0, 0, [255, 255, 255]];
        // A dark disc with a light rim, which takes the color once the
        // scroll is moving.
        cr.arc(c, c, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(0.08, 0.08, 0.1, 0.75);
        cr.fillPreserve();
        if (sx || sy)
            cr.setSourceRGBA(R / 255, G / 255, B / 255, 0.95);
        else
            cr.setSourceRGBA(1, 1, 1, 0.85);
        cr.setLineWidth(1.5 * k);
        cr.stroke();
        cr.arc(c, c, 1.5 * k, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.fill();
        // An arrow each way; the ones the hand is pulling toward light up.
        const tip = 0.8 * r, base = 0.45 * r, half = 0.28 * r;
        for (const [ux, uy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            cr.moveTo(c + ux * tip, c + uy * tip);
            cr.lineTo(c + ux * base - uy * half, c + uy * base + ux * half);
            cr.lineTo(c + ux * base + uy * half, c + uy * base - ux * half);
            cr.closePath();
            if ((ux && ux === sx) || (uy && uy === sy))
                cr.setSourceRGBA(R / 255, G / 255, B / 255, 1);
            else
                cr.setSourceRGBA(1, 1, 1, 0.45);
            cr.fill();
        }
        cr.$dispose();
    }

    // A line from the ring's edge to the hand, fading in toward the hand.
    _drawTrail(on, ax, ay, dx, dy, tint) {
        const start = (RING_SIZE / 2 + 2) * this._k;
        const len = Math.hypot(dx, dy) - start;
        this._trail.visible = on && len > 4;
        if (!this._trail.visible)
            return;
        const w = Math.max(2, Math.round(TRAIL_WIDTH * this._k));
        const a = Math.atan2(dy, dx);
        this._trail.set_size(len, w);
        this._trail.set_position(ax + Math.cos(a) * start, ay + Math.sin(a) * start - w / 2);
        this._trail.rotation_angle_z = a * 180 / Math.PI;
        const key = `${tint} ${w}`;
        if (key !== this._trailKey) {
            this._trailKey = key;
            // St scales CSS lengths by the display scale itself.
            this._trail.set_style(`border-radius: ${w / 2 / this._theme}px; ` +
                'background-gradient-direction: horizontal; ' +
                `background-gradient-start: ${rgba(tint, 0)}; ` +
                `background-gradient-end: ${rgba(tint, 0.95)};`);
        }
    }

    // While the pointer is held still the ghost is the cursor, so the real
    // one is hidden. Mutter takes the pointer's focus away from apps while
    // it is hidden (the touchscreen rule), unless something inhibits that,
    // so hold an inhibit for as long: the scrolls must keep reaching the
    // app. GNOME 49 hides it with a counted inhibit; before that, each
    // scroll makes Mutter show the pointer again, so it is hidden again
    // straight away, before anything is drawn.
    _hideCursor(hide) {
        if (hide === !!this._cursorHidden)
            return;
        const seat = Clutter.get_default_backend().get_default_seat();
        if (hide) {
            // GNOME 47 moved the tracker from the display to the backend.
            const tracker = global.backend.get_cursor_tracker?.() ??
                Meta.CursorTracker.get_for_display(global.display);
            seat.inhibit_unfocus();
            let id = 0;
            if (tracker.inhibit_cursor_visibility) {
                tracker.inhibit_cursor_visibility();
            } else {
                tracker.set_pointer_visible(false);
                id = tracker.connect('visibility-changed', () => {
                    if (tracker.get_pointer_visible())
                        tracker.set_pointer_visible(false);
                });
            }
            this._cursorHidden = {tracker, id};
        } else {
            const {tracker, id} = this._cursorHidden;
            this._cursorHidden = null;
            if (id) {
                tracker.disconnect(id);
                tracker.set_pointer_visible(true);
            } else {
                tracker.uninhibit_cursor_visibility();
            }
            seat.uninhibit_unfocus();
        }
    }

    // ---- preview -------------------------------------------------------------

    // A few seconds of the indicator mid-screen, following a made-up hand,
    // so a setting can be judged without dragging. Another change while it
    // plays makes it play longer.
    _preview() {
        if (!this._group || (this._anchor && !this._demo))
            return;
        const now = GLib.get_monotonic_time();
        if (this._demo) {
            this._demo.end = now + PREVIEW_US;
            return;
        }
        const g = global.display.get_monitor_geometry(global.display.get_current_monitor());
        this._demo = {start: now, end: now + PREVIEW_US, hand: [0, 0], reach: g.height * 0.28};
        this._anchor = [g.x + g.width / 2, g.y + g.height / 2];
        this._speed = [0, 0];
        this._active = true;
        this._demoTimeline = new Clutter.Timeline({actor: global.stage, duration: 1000});
        this._demoTimeline.set_repeat_count(-1);
        this._demoTimeline.connect('new-frame', () => {
            const t = GLib.get_monotonic_time();
            if (t > this._demo.end) {
                this._stopDemo();
                return;
            }
            const s = (t - this._demo.start) / 1e6, reach = this._demo.reach;
            this._demo.hand = [0.35 * reach * Math.sin(s * 1.9), reach * Math.sin(s * 1.3)];
            this._speed = this._demo.hand.map(v => this._speedPx(v));
            this._redraw();
        });
        this._demoTimeline.start();
        this._show(true);
    }

    _stopDemo() {
        if (!this._demo)
            return;
        this._demoTimeline?.stop();
        this._demoTimeline = null;
        this._demo = null;
        this._anchor = null;
        this._active = false;
        this._show(false);
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
            this._stopDemo();
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
            this._hideCursor(false);
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
            this._hideCursor(this._anchored && this._cfg.ghost);
        } else if (line === '0') {
            this._active = false;
            this._hideCursor(false);
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
