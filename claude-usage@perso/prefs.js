// Claude Usage — preferences window.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMA = 'org.gnome.shell.extensions.claude-usage';

function comboRow(settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title, subtitle,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const index = options.findIndex(([value]) => value === settings.get_string(key));
    row.selected = Math.max(0, index);
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA);
        window._settings = settings; // keep alive with the window
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const panel = new Adw.PreferencesGroup({title: 'Panel'});
        panel.add(comboRow(settings, 'panel-display', 'Label shows', 'What appears next to the icon in the top bar', [
            ['session-weekly', 'Session and weekly limits'],
            ['session', 'Session limit only'],
            ['weekly', 'Weekly limit only'],
            ['tokens', 'Claude Code output tokens today'],
        ]));
        panel.add(comboRow(settings, 'panel-position', 'Position', 'Part of the top bar the indicator sits in', [
            ['left', 'Left'],
            ['center', 'Center'],
            ['right', 'Right'],
        ]));
        panel.add(switchRow(settings, 'show-icon', 'Show icon'));
        page.add(panel);

        const data = new Adw.PreferencesGroup({title: 'Data'});
        data.add(switchRow(settings, 'fetch-limits', 'Subscription limits',
            'Fetch usage from api.anthropic.com with your Claude Code login. Unofficial endpoint, may break.'));
        data.add(switchRow(settings, 'show-local', 'Claude Code stats',
            'Token counts read from local logs in ~/.claude/projects'));
        data.add(spinRow(settings, 'refresh-interval', 'Refresh interval', 'In seconds', 30, 3600, 30));
        page.add(data);

        const colors = new Adw.PreferencesGroup({
            title: 'Alert thresholds',
            description: 'Usage turns yellow, then red, at these percentages',
        });
        colors.add(spinRow(settings, 'warn-threshold', 'Warning', 'Percent', 1, 100, 5));
        colors.add(spinRow(settings, 'crit-threshold', 'Critical', 'Percent', 1, 100, 5));
        page.add(colors);
    }
}
