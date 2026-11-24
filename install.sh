#!/usr/bin/env bash
# Link the extension into the user's GNOME Shell extensions folder.
set -euo pipefail
UUID="claude-usage@perso"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"
echo "Lien créé : $DEST -> $SRC"
echo "Déconnecte-toi / reconnecte-toi (Wayland), puis : gnome-extensions enable $UUID"
