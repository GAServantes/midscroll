// SPDX-License-Identifier: GPL-3.0-or-later
// The look of midscroll's on-screen indicator. Every change plays a short
// preview mid-screen (extension.js watches these settings), so a choice
// can be judged without middle-dragging.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// value, title, subtitle
const STYLES = [
    ['ring-trail', 'Ring and trail',
        'A small ring where you pressed, and a line fading in toward your hand'],
    ['ring', 'Ring only', 'Just the ring where you pressed'],
    ['classic', 'Bars', 'The older look: a badge and a bar along each direction you drag'],
    ['hidden', 'Nothing', 'No indicator while scrolling'],
];
const COLORS = [
    ['accent', 'Accent color', 'Follows the desktop’s accent color'],
    ['speed', 'Speed', 'Green when slow, turning red as you go faster'],
    ['white', 'White', 'Plain white'],
];

export default class MidscrollPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const ids = [];
        window.connect('close-request', () => {
            for (const id of ids)
                settings.disconnect(id);
            return false;
        });

        const page = new Adw.PreferencesPage({title: 'Look', icon_name: 'applications-graphics-symbolic'});
        window.add(page);

        const look = new Adw.PreferencesGroup({
            title: 'On-screen indicator',
            description: 'What appears while you middle-drag to scroll. ' +
                'Each change plays a short preview in the middle of the screen.',
        });
        page.add(look);
        look.add(this._choiceRow(settings, ids, 'style', 'Style', STYLES));
        look.add(this._choiceRow(settings, ids, 'color', 'Color', COLORS));
        look.add(this._sliderRow(settings, 'size', 'Size', 0.6, 2.0, 0.1));
        look.add(this._sliderRow(settings, 'opacity', 'Opacity',
            0.2, 1.0, 0.05, 'Lower is more see-through'));
        const speed = new Adw.SwitchRow({
            title: 'Show speed', subtitle: 'A small readout of the scroll speed next to the pointer',
        });
        settings.bind('show-speed', speed, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(speed);

        const more = new Adw.PreferencesGroup();
        page.add(more);
        const preview = new Adw.ActionRow({title: 'Preview', subtitle: 'Play the indicator again'});
        const play = new Gtk.Button({label: 'Show', valign: Gtk.Align.CENTER});
        play.connect('clicked', () => settings.set_int('preview', settings.get_int('preview') + 1));
        preview.add_suffix(play);
        preview.activatable_widget = play;
        more.add(preview);
        const reset = new Adw.ActionRow({title: 'Reset', subtitle: 'Go back to the default look'});
        const resetBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        resetBtn.connect('clicked', () => {
            for (const key of ['style', 'color', 'size', 'opacity', 'show-speed'])
                settings.reset(key);
        });
        reset.add_suffix(resetBtn);
        more.add(reset);
    }

    // A drop-down over a string setting, showing the chosen item's
    // description underneath.
    _choiceRow(settings, ids, key, title, items) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(items.map(i => i[1]))});
        const sync = () => {
            const i = Math.max(items.findIndex(i => i[0] === settings.get_string(key)), 0);
            row.selected = i;
            row.subtitle = items[i][2];
        };
        sync();
        row.connect('notify::selected', () => {
            const [value, , subtitle] = items[row.selected];
            row.subtitle = subtitle;
            if (settings.get_string(key) !== value)
                settings.set_string(key, value);
        });
        ids.push(settings.connect(`changed::${key}`, sync));
        return row;
    }

    _sliderRow(settings, key, title, lower, upper, step, subtitle = null) {
        const row = new Adw.ActionRow({title});
        if (subtitle)
            row.subtitle = subtitle;
        const adj = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 2});
        settings.bind(key, adj, 'value', Gio.SettingsBindFlags.DEFAULT);
        const scale = new Gtk.Scale({
            adjustment: adj, digits: 2, draw_value: false,
            width_request: 200, valign: Gtk.Align.CENTER,
        });
        row.add_suffix(scale);
        return row;
    }
}
