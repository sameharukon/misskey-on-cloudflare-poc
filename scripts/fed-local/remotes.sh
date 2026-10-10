#!/usr/bin/env bash
# Stock Misskey (https://m.mk.test) and Mastodon (https://t.mk.test, AUTHORIZED_FETCH) in Docker,
# next to the two misskey-cf environments of fed-local.sh (see scripts/fed-local/README.md).
#
#   bash scripts/fed-local/remotes.sh setup   # once: images, DBs, Mastodon schema + secrets, users + API tokens
#   bash scripts/fed-local/remotes.sh up      # start Redis, Misskey, Mastodon web + sidekiq
#   bash scripts/fed-local/remotes.sh down    # stop the containers
#   bash scripts/fed-local/remotes.sh reset   # down + drop the DBs and generated secrets
#
# Run `fed-local.sh setup` first (TLS certificate, /etc/hosts, local PostgreSQL). Needs a running
# Docker daemon (`dockerd &` in this container). Containers use the host network: Misskey listens on
# :3001, Mastodon on :3000, their Redis on :6390 / :6391; the HTTPS front of fed-local.sh serves both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$ROOT/.fed-local"
REMOTE="$WORK/remotes"
PG_URL_BASE="${PG_URL_BASE:-postgres://postgres:postgres@127.0.0.1:5432}"
MISSKEY_IMAGE="${MISSKEY_IMAGE:-misskey/misskey:2026.10.0}"
MASTODON_IMAGE="${MASTODON_IMAGE:-tootsuite/mastodon:v4.7.3}"
RELAY_IMAGE="${RELAY_IMAGE:-yukimochi/activity-relay:v2.0.11}"
# test users admin / carol on both servers
PASSWORD="fedtest-pass-123"

psql_admin() { psql "$PG_URL_BASE/postgres" -v ON_ERROR_STOP=1 -qtAc "$1"; }
create_db() {
  [ -n "$(psql_admin "SELECT 1 FROM pg_database WHERE datname = '$1'")" ] || psql_admin "CREATE DATABASE $1"
}

# Every container: host network, the local hosts resolved to loopback, the test CA trusted.
DOCKER_COMMON=(--network host
  --add-host a.mk.test:127.0.0.1 --add-host b.mk.test:127.0.0.1 --add-host m.mk.test:127.0.0.1 --add-host t.mk.test:127.0.0.1
  --add-host relay.mk.test:127.0.0.1
  -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro
  -v "$WORK/tls/ca.crt:/fed-ca.crt:ro")

misskey_config() {
  mkdir -p "$REMOTE/misskey"
  cat > "$REMOTE/misskey/default.yml" <<EOF
url: https://m.mk.test/
port: 3001
db:
  host: 127.0.0.1
  port: 5432
  db: mk_misskey
  user: postgres
  pass: postgres
dbReplications: false
redis:
  host: 127.0.0.1
  port: 6390
id: aidx
# the test hosts resolve to loopback
allowedPrivateNetworks:
  - '127.0.0.1/32'
EOF
}

mastodon_env() {
  local f="$REMOTE/mastodon.env"
  [ -f "$f" ] && return
  mkdir -p "$REMOTE"
  local r
  r() { openssl rand -hex "$1"; }
  cat > "$f" <<EOF
RAILS_ENV=production
NODE_ENV=production
LOCAL_DOMAIN=t.mk.test
AUTHORIZED_FETCH=true
ALLOWED_PRIVATE_ADDRESSES=127.0.0.1/32
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=mk_mastodon
DB_USER=postgres
DB_PASS=postgres
REDIS_HOST=127.0.0.1
REDIS_PORT=6391
PORT=3000
SECRET_KEY_BASE=$(r 64)
OTP_SECRET=$(r 64)
ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(r 16)
ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(r 16)
ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(r 16)
SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
RAILS_LOG_LEVEL=info
EOF
  # Web Push keys (Mastodon refuses to boot some pages without them)
  docker run --rm --env-file "$f" "$MASTODON_IMAGE" bundle exec rails mastodon:webpush:generate_vapid_key 2>/dev/null >> "$f"
}

# ActivityPub relay (https://relay.mk.test, yukimochi/activity-relay): API server on :8095, a job
# worker, its own Redis on :6392. Follow requests are accepted automatically (the default).
relay_config() {
  mkdir -p "$REMOTE/relay"
  [ -f "$REMOTE/relay/actor.pem" ] || openssl genrsa -traditional -out "$REMOTE/relay/actor.pem" 2048 2>/dev/null
  cat > "$REMOTE/relay/config.yml" <<EOF
ACTOR_PEM: /relay/actor.pem
REDIS_URL: redis://127.0.0.1:6392
RELAY_BIND: 127.0.0.1:8095
RELAY_DOMAIN: relay.mk.test
RELAY_SERVICENAME: fed-local relay
JOB_CONCURRENCY: 10
EOF
}

relay_up() {
  relay_config
  docker rm -f mkfed-relay mkfed-relay-worker mkfed-redis-relay >/dev/null 2>&1 || true
  docker run -d --name mkfed-redis-relay --network host redis:7-alpine redis-server --port 6392 --save "" >/dev/null
  for cmd in server worker; do
    local name=mkfed-relay
    [ "$cmd" = worker ] && name=mkfed-relay-worker
    docker run -d --name "$name" "${DOCKER_COMMON[@]}" -v "$REMOTE/relay:/relay:ro" "$RELAY_IMAGE" \
      relay -c /relay/config.yml "$cmd" >/dev/null
  done
}

redis_up() {
  docker rm -f mkfed-redis-m mkfed-redis-t >/dev/null 2>&1 || true
  docker run -d --name mkfed-redis-m --network host redis:7-alpine redis-server --port 6390 --save "" >/dev/null
  docker run -d --name mkfed-redis-t --network host redis:7-alpine redis-server --port 6391 --save "" >/dev/null
}

# Misskey resolves names with cacheable-lookup (DNS only, never /etc/hosts): dns.mjs answers
# *.mk.test on 127.0.0.53 and is the container's only nameserver.
dns_up() {
  pgrep -f "[d]ns.mjs 53 127.0.0.53" >/dev/null && return
  nohup node "$ROOT/scripts/fed-local/dns.mjs" 53 127.0.0.53 > "$WORK/logs/dns.log" 2>&1 &
  echo "nameserver 127.0.0.53" > "$REMOTE/resolv.conf"
}

misskey_up() {
  docker rm -f mkfed-misskey >/dev/null 2>&1 || true
  docker run -d --name mkfed-misskey "${DOCKER_COMMON[@]}" -e NODE_EXTRA_CA_CERTS=/fed-ca.crt \
    -v "$REMOTE/resolv.conf:/etc/resolv.conf:ro" \
    -v "$REMOTE/misskey/default.yml:/misskey/.config/default.yml:ro" "$MISSKEY_IMAGE" >/dev/null
}

mastodon_up() {
  docker rm -f mkfed-mastodon-web mkfed-mastodon-sidekiq >/dev/null 2>&1 || true
  docker run -d --name mkfed-mastodon-web "${DOCKER_COMMON[@]}" --env-file "$REMOTE/mastodon.env" "$MASTODON_IMAGE" \
    bundle exec puma -C config/puma.rb >/dev/null
  docker run -d --name mkfed-mastodon-sidekiq "${DOCKER_COMMON[@]}" --env-file "$REMOTE/mastodon.env" "$MASTODON_IMAGE" \
    bundle exec sidekiq >/dev/null
}

wait_http() {
  for _ in $(seq 1 "${3:-180}"); do
    [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$1")" = "$2" ] && return 0
    sleep 2
  done
  echo "timed out waiting for $1" >&2
  return 1
}

mastodon_rails() {
  docker run --rm "${DOCKER_COMMON[@]}" --env-file "$REMOTE/mastodon.env" "$MASTODON_IMAGE" "$@"
}

cmd_setup() {
  [ -f "$WORK/tls/ca.crt" ] || { echo "run fed-local.sh setup first" >&2; exit 1; }
  # pull only what is missing (Docker Hub rate-limits anonymous pulls)
  for img in redis:7-alpine "$MISSKEY_IMAGE" "$MASTODON_IMAGE" "$RELAY_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
  done
  create_db mk_misskey
  create_db mk_mastodon
  misskey_config
  mastodon_env
  redis_up
  # Mastodon schema + seeds (idempotent: skipped once the accounts table exists)
  if [ -z "$(psql "$PG_URL_BASE/mk_mastodon" -tAc "SELECT 1 FROM pg_tables WHERE tablename = 'accounts'")" ]; then
    mastodon_rails bundle exec rails db:schema:load db:seed
  fi
  cmd_up
  users
  echo "remotes setup done; tokens in $REMOTE/tokens.env"
}

# Test users and API tokens (written to tokens.env for smoke-remotes.mjs)
users() {
  local tokens="$REMOTE/tokens.env"
  : > "$tokens"
  # Misskey: the first account becomes root without a setup password; later ones are created by it
  local root
  root="$(curl -s --noproxy '*' -X POST https://m.mk.test/api/admin/accounts/create -H 'content-type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token ?? ""')"
  if [ -z "$root" ]; then
    root="$(curl -s --noproxy '*' -X POST https://m.mk.test/api/signin-flow -H 'content-type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).i ?? ""')"
  fi
  echo "MISSKEY_ADMIN_TOKEN=$root" >> "$tokens"
  # meta.federation defaults to none on a new upstream instance
  curl -s --noproxy '*' -o /dev/null -X POST https://m.mk.test/api/admin/update-meta -H 'content-type: application/json' \
    -d "{\"i\":\"$root\",\"federation\":\"all\"}"
  curl -s --noproxy '*' -o /dev/null -X POST https://m.mk.test/api/admin/accounts/create -H 'content-type: application/json' \
    -d "{\"i\":\"$root\",\"username\":\"carol\",\"password\":\"$PASSWORD\"}"
  local carol
  carol="$(psql "$PG_URL_BASE/mk_misskey" -tAc "SELECT token FROM \"user\" WHERE username = 'carol' AND host IS NULL")"
  echo "MISSKEY_CAROL_TOKEN=$carol" >> "$tokens"
  # Mastodon: confirmed accounts (saved without validation: the e-mail MX check needs DNS) and an
  # OAuth token per user (read write follow push); admin gets the Owner role
  mastodon_rails bundle exec rails runner '
    app = Doorkeeper::Application.find_or_create_by!(name: "fed-local") { |a| a.redirect_uri = "urn:ietf:wg:oauth:2.0:oob"; a.scopes = "read write follow push" }
    %w[admin carol].each do |name|
      account = Account.find_local(name)
      unless account
        user = User.new(email: "#{name}@t.mk.test", password: "'"$PASSWORD"'", agreement: true, approved: true,
                        confirmed_at: Time.now.utc, account_attributes: { username: name })
        user.save!(validate: false)
        account = user.account
      end
      # validate: false also skipped the keypair (before_validation) and the approval
      if account.private_key.blank?
        account.send(:generate_keys)
        account.save!(validate: false)
      end
      user = account.user
      user.update_columns(approved: true)
      user.update_column(:role_id, UserRole.find_by!(name: "Owner").id) if name == "admin"
      tok = Doorkeeper::AccessToken.create!(application: app, resource_owner_id: user.id, scopes: "read write follow push")
      puts "MASTODON_TOKEN_#{name.upcase}=#{tok.token}"
    end
  ' 2>&1 | tee "$REMOTE/users.log" | grep '^MASTODON_TOKEN_' >> "$tokens" || true
  # a custom emoji on Mastodon (:fed_t:) for the emoji checks of smoke-remotes.mjs
  mastodon_rails bundle exec rails runner '
    unless CustomEmoji.local.exists?(shortcode: "fed_t")
      File.binwrite("/tmp/fed_t.png", Base64.decode64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
      CustomEmoji.create!(shortcode: "fed_t", image: File.open("/tmp/fed_t.png"), visible_in_picker: true)
    end
  ' >/dev/null 2>&1 || echo "warning: could not create the :fed_t: emoji on Mastodon" >&2
  cat "$tokens" | sed 's/=.*/=<set>/'
}

cmd_up() {
  [ -f "$REMOTE/mastodon.env" ] || { echo "run remotes.sh setup first" >&2; exit 1; }
  mkdir -p "$WORK/logs"
  dns_up
  docker ps --format '{{.Names}}' | grep -q '^mkfed-redis-m$' || redis_up
  misskey_up
  mastodon_up
  relay_up
  echo "waiting for Misskey and Mastodon to start (first Misskey start runs its migrations)..."
  wait_http https://m.mk.test/ 200 300
  wait_http https://t.mk.test/health 200 300
  wait_http https://relay.mk.test/actor 200 60
  echo "Misskey: https://m.mk.test  Mastodon: https://t.mk.test  (admin / carol, password $PASSWORD)"
}

cmd_down() {
  docker rm -f mkfed-misskey mkfed-mastodon-web mkfed-mastodon-sidekiq mkfed-redis-m mkfed-redis-t \
    mkfed-relay mkfed-relay-worker mkfed-redis-relay >/dev/null 2>&1 || true
  pkill -f "[d]ns.mjs 53 127.0.0.53" 2>/dev/null || true
  echo "stopped"
}

cmd_reset() {
  cmd_down
  psql_admin "DROP DATABASE IF EXISTS mk_misskey"
  psql_admin "DROP DATABASE IF EXISTS mk_mastodon"
  rm -rf "$REMOTE"
  echo "reset; run setup again"
}

case "${1:-}" in
  setup) cmd_setup ;;
  up) cmd_up ;;
  users) users ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  logs) docker logs --tail "${3:-100}" "mkfed-${2:-misskey}" ;;
  # run Ruby in Mastodon (smoke-remotes.mjs uses it where Mastodon has no API: aliases, Move, deletion)
  rails) mastodon_rails bundle exec rails runner "$2" 2> >(grep -v -E "^\s*$|Sidekiq|INFO" >&2) ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
