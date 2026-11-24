// Claude Usage — GNOME Shell top-bar indicator (prototype).
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

const REFRESH_SECONDS = 180;
const FETCH_LIMITS = true; // false = local Claude Code logs only, no network

function fmtTokens(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return `${n ?? 0}`;
}

function fmtReset(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso) - Date.now();
    if (ms <= 0) return 'now';
    const min = Math.round(ms / 60000);
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h${String(m).padStart(2, '0')}`;
    return `in ${m} min`;
}

function bar(percent, width = 20) {
    const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(scriptPath) {
        super._init(0.0, 'Claude Usage');
        this._scriptPath = scriptPath;
        this._cancellable = new Gio.Cancellable();

        this._label = new St.Label({
            text: '✻ …',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this.add_child(this._label);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh');
        refresh.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refresh);

        this._addInfo('Loading…');
    }

    _addInfo(text, styleClass = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (styleClass) item.label.add_style_class_name(styleClass);
        this._section.addMenuItem(item);
    }

    _addHeader(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.set_style('font-weight: bold;');
        this._section.addMenuItem(item);
    }

    refresh() {
        const argv = ['python3', this._scriptPath];
        if (FETCH_LIMITS) argv.push('--limits');
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._showError(e.message);
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) throw new Error(stderr || 'script failed');
                this._render(JSON.parse(stdout));
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._showError(e.message);
            }
        });
    }

    _showError(msg) {
        this._label.text = '✻ !';
        this._section.removeAll();
        this._addInfo(`Error: ${msg}`.slice(0, 200), 'claude-usage-crit');
    }

    _render(data) {
        this._section.removeAll();
        const limits = data.limits;
        const local = data.local ?? {};

        // Panel label: subscription % if available, else today's output tokens.
        this._label.remove_style_class_name('claude-usage-warn');
        this._label.remove_style_class_name('claude-usage-crit');
        if (limits && limits.five_hour) {
            const p5 = limits.five_hour.percent;
            const p7 = limits.seven_day?.percent;
            this._label.text = p7 != null
                ? `✻ ${Math.round(p5)}% · ${Math.round(p7)}%`
                : `✻ ${Math.round(p5)}%`;
            const worst = Math.max(p5, p7 ?? 0);
            if (worst >= 90) this._label.add_style_class_name('claude-usage-crit');
            else if (worst >= 70) this._label.add_style_class_name('claude-usage-warn');
        } else {
            this._label.text = `✻ ${fmtTokens(local.today?.output ?? 0)}`;
        }

        // Subscription section
        if (limits) {
            if (limits.error) {
                this._addHeader('Subscription limits');
                this._addInfo(limits.error, 'claude-usage-dim');
            } else {
                this._addHeader(`Subscription limits${limits.plan ? ` (${limits.plan})` : ''}`);
                const windows = [
                    ['five_hour', 'Session (5 h)'],
                    ['seven_day', 'Week'],
                    ['seven_day_opus', 'Week · Opus'],
                    ['seven_day_sonnet', 'Week · Sonnet'],
                ];
                for (const [key, name] of windows) {
                    const w = limits[key];
                    if (!w) continue;
                    this._addInfo(`${name.padEnd(16)} ${bar(w.percent)} ${Math.round(w.percent)}%`, 'claude-usage-mono');
                    this._addInfo(`    resets ${fmtReset(w.resets_at)}`, 'claude-usage-dim');
                }
                const rows = (limits.weekly_breakdown ?? []).filter(r => r.percent_of_limit > 0);
                if (rows.length)
                    this._addInfo('This week: ' + rows.map(r => `${r.name} ${r.percent_of_limit}%`).join(' · '),
                        'claude-usage-dim');
            }
            this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Local Claude Code section
        this._addHeader('Claude Code (local logs)');
        if (local.error) {
            this._addInfo(local.error, 'claude-usage-crit');
        } else {
            const t = local.today ?? {};
            this._addInfo(`Today: ${t.messages ?? 0} responses · ` +
                `${fmtTokens(t.output)} output · ${fmtTokens((t.input ?? 0) + (t.cache_write ?? 0))} input`);
            this._addInfo(`    cache read: ${fmtTokens(t.cache_read)}`, 'claude-usage-dim');
            const h = local.last_5h ?? {};
            this._addInfo(`Last 5 h: ${fmtTokens(h.output)} output`);
            for (const [model, n] of Object.entries(local.models_today ?? {}))
                this._addInfo(`    ${model}: ${fmtTokens(n)}`, 'claude-usage-dim');
        }

        const at = new Date(data.generated_at);
        this._addInfo(`Updated at ${at.toLocaleTimeString()}`, 'claude-usage-dim');
    }

    destroy() {
        this._cancellable.cancel();
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        const script = this.dir.get_child('claude-usage.py').get_path();
        this._indicator = new ClaudeIndicator(script);
        Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'left');
        this._indicator.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._indicator.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
