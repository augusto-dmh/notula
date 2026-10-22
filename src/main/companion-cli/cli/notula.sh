#!/bin/sh
# notula: Notula's companion CLI launcher (macOS). Written by Notula; do not edit.
NOTULA_EXE='__NOTULA_EXE__'
NOTULA_APP_ARGS='__NOTULA_APP_ARGS__'
export NOTULA_EXE NOTULA_APP_ARGS
__NOTULA_DEV_ENV__
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1 && node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)" >/dev/null 2>&1; then
  exec node "$DIR/notula-cli.cjs" "$@"
fi
ELECTRON_RUN_AS_NODE=1 exec "$NOTULA_EXE" "$DIR/notula-cli.cjs" "$@"
