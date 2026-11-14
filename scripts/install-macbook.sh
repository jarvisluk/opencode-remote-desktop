#!/bin/sh
# Sync this checkout to the MacBook controller: fast-forward its git repo to local main
# via a bundle (it has no remote and no node), then copy the locally built dist/.
#
#   scripts/install-macbook.sh            # host defaults to "macbook"
#   BOT_REMOTE=other-host scripts/install-macbook.sh
set -eu

HOST="${BOT_REMOTE:-macbook}"
DIR="${BOT_REMOTE_DIR:-codespace/opencode-bot}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交改动，先提交再安装" >&2
  exit 1
fi

npm run build
npm run build:native

LOCAL="$(git rev-parse main)"
REMOTE="$(ssh -o BatchMode=yes "$HOST" "git -C ~/$DIR rev-parse HEAD")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "代码已是最新 ($(git log -1 --format=%h main))"
else
  BUNDLE="$(mktemp -t bot).bundle"
  trap 'rm -f "$BUNDLE"' EXIT
  git bundle create "$BUNDLE" "$REMOTE..main"
  scp -q "$BUNDLE" "$HOST:/tmp/bot.bundle"
  ssh -o BatchMode=yes "$HOST" "cd ~/$DIR && git pull --ff-only /tmp/bot.bundle main; s=\$?; rm -f /tmp/bot.bundle; exit \$s"
fi

rsync -a --delete dist/ "$HOST:$DIR/dist/"

echo "本机 $(git log -1 --oneline main)"
ssh -o BatchMode=yes "$HOST" "echo \"$HOST \$(git -C ~/$DIR log -1 --oneline)\""
echo "完成。重启 MacBook 上的 OpenCode 生效"
