// Claude Usage — GNOME Shell top-bar indicator.
// Data comes from claude-usage.py (same folder), run asynchronously.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const SCHEMA = 'org.gnome.shell.extensions.claude-usage';
const VERTICAL = Clutter.Orientation.VERTICAL;

const LIMIT_WINDOWS = [
    ['five_hour', 'Current session (5 h)'],
    ['seven_day', 'Weekly · all models'],
    ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'Weekly · Sonnet'],
];

function fmtTokens(n) {
    n ??= 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return `${n}`;
}

function fmtReset(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (Number.isNaN(ms)) return '';
    if (ms <= 0) return 'Resets now';
    const min = Math.round(ms / 60000);
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    let rel;
    if (d > 0) rel = `${d}d ${h}h`;
    else if (h > 0) rel = `${h}h ${String(m).padStart(2, '0')}m`;
    else rel = `${m} min`;
    const at = GLib.DateTime.new_from_unix_local(Math.floor(Date.parse(iso) / 1000));
    const when = at.format(d > 0 ? '%a %H:%M' : '%H:%M');
    return `Resets in ${rel} · ${when}`;
}

function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Lays out its single child from the left edge over `fraction` of the width.
const FractionLayout = GObject.registerClass(
class FractionLayout extends Clutter.LayoutManager {
    _init(fraction) {
        super._init();
        this._fraction = fraction;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(container, forWidth) {
        return container.get_first_child()?.get_preferred_height(forWidth) ?? [0, 0];
    }

    vfunc_allocate(container, box) {
        const child = container.get_first_child();
        if (!child) return;
        const b = box.copy();
        const w = (box.x2 - box.x1) * this._fraction;
        b.x2 = b.x1 + Math.max(w, box.y2 - box.y1);
        child.allocate(b);
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(ext, settings) {
        super._init(0.5, 'Claude Usage');
        this._ext = ext;
        this._settings = settings;
        this._scriptPath = ext.dir.get_child('claude-usage.py').get_path();
        this._cancellable = new Gio.Cancellable();
        this._data = null;
        this._error = null;

        const box = new St.BoxLayout({style_class: 'claude-usage-panel'});
        this._icon = new St.Label({
            text: '✻', y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-usage-icon',
        });
        this._label = new St.Label({
            text: '…', y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-usage-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this.menu.box.add_style_class_name('claude-usage-menu');
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildFooter();

        this._addText('Loading…', 'claude-usage-dim');
    }

    _buildFooter() {
        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._updated = new St.Label({
            text: '', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-dim claude-usage-small',
        });
        footer.add_child(this._updated);
        const button = (icon, accessible, cb) => {
            const b = new St.Button({
                style_class: 'button claude-usage-icon-button',
                can_focus: true,
                accessible_name: accessible,
                child: new St.Icon({icon_name: icon, icon_size: 16}),
            });
            b.connect('clicked', cb);
            footer.add_child(b);
        };
        button('view-refresh-symbolic', 'Refresh', () => this.refresh());
        button('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._ext.openPreferences();
        });
        this.menu.addMenuItem(footer);
    }

    // ---- data -------------------------------------------------------------

    refresh() {
        if (this._busy) return;
        const argv = ['python3', this._scriptPath];
        if (this._settings.get_boolean('fetch-limits')) argv.push('--limits');
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._setError(e.message);
            return;
        }
        this._busy = true;
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            this._busy = false;
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) throw new Error(stderr || 'script failed');
                this._data = JSON.parse(stdout);
                this._error = null;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                this._error = e.message;
            }
            this.render();
        });
    }

    _setError(msg) {
        this._error = msg;
        this.render();
    }

    // ---- menu building helpers --------------------------------------------

    _item() {
        const it = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._section.addMenuItem(it);
        return it;
    }

    _addHeader(text, badge = null) {
        const it = this._item();
        it.add_child(new St.Label({
            text, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-usage-header',
        }));
        if (badge)
            it.add_child(new St.Label({text: badge, y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-usage-badge'}));
    }

    _addText(text, styleClass = '') {
        const label = new St.Label({text, x_expand: true, style_class: styleClass});
        label.clutter_text.line_wrap = true;
        this._item().add_child(label);
    }

    _addKeyValue(key, value, styleClass = '') {
        const it = this._item();
        it.add_style_class_name('claude-usage-kv');
        it.add_child(new St.Label({text: key, x_expand: true, style_class: styleClass}));
        it.add_child(new St.Label({text: value, style_class: `claude-usage-num ${styleClass}`}));
    }

    _bar(percent, level) {
        const frac = Math.min(1, Math.max(0, percent / 100));
        const track = new St.Widget({
            style_class: 'claude-usage-bar-track', x_expand: true,
            layout_manager: new FractionLayout(frac),
        });
        if (frac > 0)
            track.add_child(new St.Widget({style_class: `claude-usage-bar-fill claude-usage-bg-${level}`}));
        return track;
    }

    _addLimit(name, w, level) {
        const box = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'claude-usage-limit'});
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(new St.Label({text: name, x_expand: true}));
        top.add_child(new St.Label({
            text: `${Math.round(w.percent)}%`, style_class: `claude-usage-num claude-usage-percent claude-usage-${level}`,
        }));
        box.add_child(top);
        box.add_child(this._bar(w.percent, level));
        if (w.resets_at)
            box.add_child(new St.Label({text: fmtReset(w.resets_at), style_class: 'claude-usage-dim claude-usage-small'}));
        this._item().add_child(box);
    }

    _addStats(stats) {
        const row = new St.BoxLayout({x_expand: true, style_class: 'claude-usage-stats'});
        for (const [value, caption] of stats) {
            const col = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
            col.add_child(new St.Label({text: value, style_class: 'claude-usage-stat-value'}));
            col.add_child(new St.Label({text: caption, style_class: 'claude-usage-dim claude-usage-small'}));
            row.add_child(col);
        }
        this._item().add_child(row);
    }

    // ---- rendering --------------------------------------------------------

    render() {
        const s = this._settings;
        const warn = s.get_int('warn-threshold');
        const crit = s.get_int('crit-threshold');
        const levelOf = p => (p >= crit ? 'crit' : p >= warn ? 'warn' : 'ok');

        this._icon.visible = s.get_boolean('show-icon');
        this._label.remove_style_class_name('claude-usage-warn');
        this._label.remove_style_class_name('claude-usage-crit');
        this._section.removeAll();

        if (this._error && !this._data) {
            this._label.text = '!';
            this._label.add_style_class_name('claude-usage-crit');
            this._addText(`Error: ${this._error}`.slice(0, 300), 'claude-usage-crit');
            return;
        }
        const data = this._data;
        if (!data) return;

        const limits = s.get_boolean('fetch-limits') ? data.limits : null;
        const local = data.local ?? {};
        const haveLimits = limits && !limits.error && limits.five_hour;

        // Panel label
        const mode = s.get_string('panel-display');
        if (haveLimits && mode !== 'tokens') {
            const p5 = limits.five_hour.percent, p7 = limits.seven_day?.percent;
            let parts;
            if (mode === 'session') parts = [p5];
            else if (mode === 'weekly') parts = [p7 ?? p5];
            else parts = [p5, p7].filter(p => p != null);
            this._label.text = parts.map(p => `${Math.round(p)}%`).join(' · ');
            const level = levelOf(Math.max(...parts));
            if (level !== 'ok') this._label.add_style_class_name(`claude-usage-${level}`);
        } else {
            this._label.text = fmtTokens(local.today?.output);
        }

        // Subscription limits
        if (limits) {
            this._addHeader('Subscription limits', limits.plan ? capitalize(limits.plan) : null);
            if (limits.error) {
                this._addText(limits.error, 'claude-usage-dim');
            } else {
                for (const [key, name] of LIMIT_WINDOWS) {
                    const w = limits[key];
                    if (w) this._addLimit(name, w, levelOf(w.percent));
                }
                const rows = (limits.weekly_breakdown ?? []).filter(r => r.percent_of_limit > 0);
                if (rows.length) {
                    this._addKeyValue('This week by product',
                        rows.map(r => `${r.name} ${r.percent_of_limit}%`).join(' · '),
                        'claude-usage-dim claude-usage-small');
                }
            }
        }

        // Local Claude Code stats
        if (s.get_boolean('show-local')) {
            if (limits) this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addHeader('Claude Code today');
            if (local.error) {
                this._addText(local.error, 'claude-usage-crit');
            } else {
                const t = local.today ?? {};
                this._addStats([
                    [`${t.messages ?? 0}`, 'responses'],
                    [fmtTokens(t.output), 'output'],
                    [fmtTokens((t.input ?? 0) + (t.cache_write ?? 0)), 'input'],
                    [fmtTokens(t.cache_read), 'cache read'],
                ]);
                this._addKeyValue('Output, last 5 hours', fmtTokens(local.last_5h?.output), 'claude-usage-small');
                for (const [model, n] of Object.entries(local.models_today ?? {}))
                    this._addKeyValue(model, fmtTokens(n), 'claude-usage-dim claude-usage-small');
            }
        }

        const at = GLib.DateTime.new_from_unix_local(Math.floor(Date.parse(data.generated_at) / 1000));
        this._updated.text = this._error
            ? `Update failed · last data ${at.format('%H:%M')}`
            : `Updated at ${at.format('%H:%M')}`;
    }

    destroy() {
        this._cancellable.cancel();
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA);
        this._addIndicator();
        this._startTimer();
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            switch (key) {
            case 'refresh-interval':
                this._startTimer();
                break;
            case 'panel-position':
                this._indicator.destroy();
                this._addIndicator();
                break;
            case 'fetch-limits':
                this._indicator.refresh();
                break;
            default:
                this._indicator.render();
            }
        });
    }

    _addIndicator() {
        this._indicator = new ClaudeIndicator(this, this._settings);
        const pos = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, pos === 'right' ? 0 : -1, pos);
        this._indicator.refresh();
    }

    _startTimer() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._indicator?.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
