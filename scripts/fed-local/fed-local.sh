#!/usr/bin/env bash
# Two local misskey-cf environments for federation testing (see scripts/fed-local/README.md).
#
#   bash scripts/fed-local/fed-local.sh setup   # once: Postgres DBs + migrations + meta, TLS CA, /etc/hosts
#   bash scripts/fed-local/fed-local.sh up      # start env A / B (wrangler dev) and the HTTPS front
#   bash scripts/fed-local/fed-local.sh smoke   # run the federation smoke test (report in .fed-local/report.md)
#   bash scripts/fed-local/fed-local.sh smoke-remotes [misskey|mastodon]  # against stock Misskey / Mastodon (remotes.sh)
#   bash scripts/fed-local/fed-local.sh down    # stop everything
#   bash scripts/fed-local/fed-local.sh reset   # down + drop DBs and local DO / queue state
#
# Needs root (binds :443, edits /etc/hosts and the system CA store) and a local PostgreSQL
# reachable as postgres:postgres@127.0.0.1:5432 (PG_URL_BASE overrides it).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$ROOT/.fed-local"
PG_URL_BASE="${PG_URL_BASE:-postgres://postgres:postgres@127.0.0.1:5432}"
ENVS=(a b)
declare -A PORT=([a]=8701 [b]=8702)
declare -A INSPECTOR=([a]=9701 [b]=9702)
host() { echo "$1.mk.test"; }
# stock Misskey (m), Mastodon (t) and an ActivityPub relay started by remotes.sh; served through
# the same HTTPS front
REMOTE_HOSTS=(m.mk.test t.mk.test relay.mk.test)
declare -A REMOTE_PORT=([m.mk.test]=3001 [t.mk.test]=3000 [relay.mk.test]=8095)
db() { echo "mk_$1"; }
setup_password() { echo "setup-$1"; }
admin_password() { echo "pass-$1-123"; }

psql_admin() { psql "$PG_URL_BASE/postgres" -v ON_ERROR_STOP=1 -qtAc "$1"; }

cmd_setup() {
  mkdir -p "$WORK/logs" "$WORK/tls"
  if ! pg_isready -h 127.0.0.1 -q; then
    service postgresql start
    su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'postgres'\""
  fi
  for e in "${ENVS[@]}"; do
    if [ -z "$(psql_admin "SELECT 1 FROM pg_database WHERE datname = '$(db "$e")'")" ]; then
      psql_admin "CREATE DATABASE $(db "$e")"
    fi
    (cd "$ROOT" && DATABASE_URL="$PG_URL_BASE/$(db "$e")" pnpm -s db:migrate up)
    # Initial meta row (normally inserted once by the operator): federation open, sign-up allowed
    psql "$PG_URL_BASE/$(db "$e")" -qc "INSERT INTO meta (id, name, federation, \"disableRegistration\") SELECT 'x', 'fed-$e', 'all', false WHERE NOT EXISTS (SELECT 1 FROM meta)"
  done

  # Self-signed CA + one certificate for both hosts, trusted system-wide (workerd and curl use it)
  # one certificate for every host (re-issued when an older one lacks the remote hosts)
  if [ ! -f "$WORK/tls/server.crt" ] || ! openssl x509 -in "$WORK/tls/server.crt" -noout -text | grep -q "DNS:relay.mk.test"; then
    (
      cd "$WORK/tls"
      [ -f ca.crt ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 30 -subj "/CN=mkfed local CA" 2>/dev/null
      openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=mk.test" 2>/dev/null
      printf "subjectAltName=DNS:%s,DNS:%s,DNS:%s,DNS:%s,DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" "$(host a)" "$(host b)" "${REMOTE_HOSTS[@]}" > ext.cnf
      openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 30 -extfile ext.cnf 2>/dev/null
    )
  fi
  cp "$WORK/tls/ca.crt" /usr/local/share/ca-certificates/mkfed-local-ca.crt
  update-ca-certificates >/dev/null
  for h in "$(host a)" "$(host b)" "${REMOTE_HOSTS[@]}"; do
    grep -qw "$h" /etc/hosts || echo "127.0.0.1 $h" >> /etc/hosts
  done
  echo "setup done"
}

media_up() {
  # the media container server (sharp + ffmpeg) on the host, behind scripts/fed-local/media-shim.ts
  [ "${FED_NO_MEDIA:-}" = "1" ] && return
  curl -sf --noproxy '*' -o /dev/null http://127.0.0.1:8090/healthz && return
  local ffmpeg
  ffmpeg="$(command -v ffmpeg || echo ffmpeg)"
  (
    cd "$ROOT"
    PORT=8090 FFMPEG_PATH="$ffmpeg" setsid nohup npx tsx packages/media-container/src/server.ts > "$WORK/logs/media.log" 2>&1 < /dev/null &
  )
  for _ in $(seq 1 30); do curl -sf --noproxy '*' -o /dev/null http://127.0.0.1:8090/healthz && return; sleep 1; done
  echo "media server did not start; see $WORK/logs/media.log" >&2
}

cmd_up() {
  mkdir -p "$WORK/logs"
  media_up
  for e in "${ENVS[@]}"; do
    node "$ROOT/scripts/fed-local/gen-config.mjs" "$e" "$(host "$e")" "$PG_URL_BASE/$(db "$e")" "$(setup_password "$e")"
    (
      cd "$ROOT/packages/gateway"
      # The first config is the primary Worker (serves the port); the rest run in the same process.
      # --local-upstream / --upstream-protocol make request.url https://<host>/..., as in production.
      nohup npx wrangler dev -c "wrangler.fed-$e.toml" -c "../api/wrangler.fed-$e.toml" \
        -c "../stream/wrangler.fed-$e.toml" -c "../timeline/wrangler.fed-$e.toml" \
        $([ "${FED_NO_MEDIA:-}" = "1" ] || echo "-c ../../scripts/fed-local/wrangler.fed-$e-media.toml") \
        --ip 127.0.0.1 --port "${PORT[$e]}" --inspector-port "${INSPECTOR[$e]}" \
        --local-upstream "$(host "$e")" --upstream-protocol https \
        --persist-to "$WORK/state-$e" > "$WORK/logs/$e.log" 2>&1 &
      echo $! > "$WORK/$e.pid"
    )
  done
  nohup node "$ROOT/scripts/fed-local/tls-proxy.mjs" "$WORK/tls" "$(host a)=${PORT[a]}" "$(host b)=${PORT[b]}" \
    "m.mk.test=${REMOTE_PORT[m.mk.test]}" "t.mk.test=${REMOTE_PORT[t.mk.test]}" "relay.mk.test=${REMOTE_PORT[relay.mk.test]}" \
    > "$WORK/logs/tls.log" 2>&1 &
  echo $! > "$WORK/tls.pid"

  for e in "${ENVS[@]}"; do
    for _ in $(seq 1 90); do
      curl -sf --noproxy '*' -o /dev/null "https://$(host "$e")/nodeinfo/2.0" && break
      sleep 1
    done
    curl -sf --noproxy '*' -o /dev/null "https://$(host "$e")/nodeinfo/2.0" || { echo "env $e did not come up; see $WORK/logs/$e.log" >&2; exit 1; }
    # Root account on first start (ignored once one exists)
    curl -s --noproxy '*' -o /dev/null -X POST "https://$(host "$e")/api/admin/accounts/create" -H 'content-type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"$(admin_password "$e")\",\"setupPassword\":\"$(setup_password "$e")\"}"
    echo "env $e: https://$(host "$e") (admin / $(admin_password "$e"))"
  done
}

cmd_down() {
  for f in "$WORK"/*.pid; do
    [ -f "$f" ] || continue
    pid="$(cat "$f")"
    # wrangler dev spawns workerd; stop the whole process group of children too
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  pkill -f "wrangler.fed-[ab].toml" 2>/dev/null || true
  pkill -f "fed-local/tls-proxy.mjs" 2>/dev/null || true
  pkill -f "media-container/src/server.ts" 2>/dev/null || true
  echo "stopped"
}

cmd_reset() {
  cmd_down
  for e in "${ENVS[@]}"; do
    psql_admin "DROP DATABASE IF EXISTS $(db "$e")"
    rm -rf "$WORK/state-$e"
  done
  echo "reset; run setup again"
}

cmd_smoke() {
  local q='SELECT token FROM "user" WHERE username = '"'admin'"' AND host IS NULL'
  FED_ADMIN_TOKEN_A="$(psql "$PG_URL_BASE/$(db a)" -tAc "$q")" FED_ADMIN_TOKEN_B="$(psql "$PG_URL_BASE/$(db b)" -tAc "$q")" \
    NODE_EXTRA_CA_CERTS="$WORK/tls/ca.crt" NO_PROXY='*' node "$ROOT/scripts/fed-local/smoke.mjs" --report "$WORK/report.md" "$@"
}

cmd_smoke_remotes() {
  local q='SELECT token FROM "user" WHERE username = '"'admin'"' AND host IS NULL'
  FED_ADMIN_TOKEN_A="$(psql "$PG_URL_BASE/$(db a)" -tAc "$q")" FED_REMOTE_TOKENS="$WORK/remotes/tokens.env" \
    NODE_EXTRA_CA_CERTS="$WORK/tls/ca.crt" NO_PROXY='*' node "$ROOT/scripts/fed-local/smoke-remotes.mjs" --report "$WORK/report-remotes.md" "$@"
}

case "${1:-}" in
  setup) cmd_setup ;;
  up) cmd_up ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  smoke) shift; cmd_smoke "$@" ;;
  smoke-remotes) shift; cmd_smoke_remotes "$@" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
