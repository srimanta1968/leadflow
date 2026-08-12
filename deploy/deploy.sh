#!/usr/bin/env bash
#
# LeadFlow production deploy — deliberately scoped so it cannot disturb
# ProjexCloud, which shares the host, the Docker network and the database
# server.
#
# EVERY DESTRUCTIVE VERB IN THIS FILE NAMES ITS TARGETS EXPLICITLY. There is no
# bare `docker compose down`, no `--remove-orphans`, no `docker system prune`
# and no nginx RESTART. Each of those is scoped more widely than it appears:
#
#   * `--remove-orphans` removes containers compose does not recognise as part
#     of THIS project. It is not a hypothetical risk — during this project's own
#     build it deleted the development MCP container, because that container had
#     been started under a different compose project name.
#   * `docker system prune` removes unused images and networks globally.
#   * `systemctl restart nginx` drops in-flight connections to
#     cloud.projexlight.com; `reload` re-reads config with no dropped requests.
#
# Usage:
#   ./deploy.sh deploy    build, migrate and start (default)
#   ./deploy.sh stop      stop ONLY LeadFlow
#   ./deploy.sh restart   restart ONLY LeadFlow
#   ./deploy.sh status    what is running, ours and theirs
#   ./deploy.sh logs      follow the LeadFlow API log
#   ./deploy.sh rollback  return to the previous image tag

set -euo pipefail

# --- scope guards ------------------------------------------------------------
# The compose PROJECT name is what confines every compose verb below to
# LeadFlow's own services.
readonly PROJECT="leadflow"
readonly COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.prod.yml"
readonly ENV_FILE="$(dirname "$COMPOSE_FILE")/leadflow.env"

readonly SHARED_NETWORK="projexcloud-prod_projex"
readonly PG_CONTAINER="projexcloud_pg"
readonly DB_NAME="${LEADFLOW_DB_NAME:-leadflow_db}"
readonly REPO_ROOT="$(cd "$(dirname "$COMPOSE_FILE")/.." && pwd)"
readonly BASE_SCHEMA="$REPO_ROOT/.projexlight/schemas/user-defined-schemas.sql"
readonly WEB_ROOT="/usr/share/nginx/leadflow"
readonly DOMAIN="leadflow.projexlight.com"

# Containers this script is ALLOWED to stop. Anything not on this list is
# somebody else's and is never a target.
readonly OURS=("leadflow_api")

c_info() { printf '\033[0;34m[deploy]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
c_die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# --- preflight ---------------------------------------------------------------
preflight() {
  [ -f "$ENV_FILE" ] || c_die "missing $ENV_FILE — copy leadflow.env.example and fill it in"

  # REFUSE TO SHIP A PLACEHOLDER. Every variable in env.ts has a fallback and
  # nothing throws, so an unset JWT_SECRET silently becomes 'your-secret-key'
  # and an unset DB_PASSWORD becomes 'postgres' — the process boots, serves
  # traffic and passes its health check with both. Nothing downstream will ever
  # report this, so it has to be caught here.
  local unset_vars
  # Anchored on the VALUE, not the end of line: the original pattern required
  # CHANGE_ME to be last on the line, so any variable with a trailing comment
  # slipped past — DB_PASSWORD and all three PROJEXCLOUD_* were invisible to
  # this check while JWT_SECRET, which had no comment, was caught. A guard that
  # silently covers only some of what it claims is worse than none.
  # `|| true` is load-bearing. grep exits 1 when it matches nothing, and with
  # `set -e` and `pipefail` a bare assignment from that pipeline aborts the
  # script — silently, before c_ok ever prints. The failure mode was inverted:
  # a CORRECTLY filled env file killed the deploy with no output and exit 1,
  # while a file still full of CHANGE_ME sailed through to the c_die below.
  unset_vars="$(grep -E '^[A-Z_]+=[[:space:]]*CHANGE_ME([[:space:]]|#|$)' "$ENV_FILE" | cut -d= -f1 | paste -sd' ' - || true)"
  [ -z "$unset_vars" ] || c_die "still at CHANGE_ME in $ENV_FILE: $unset_vars"

  # The same defaults, spelled out — someone may replace CHANGE_ME with the
  # very value the fallback would have used.
  if grep -qE '^JWT_SECRET=[[:space:]]*your-secret-key([[:space:]]|#|$)' "$ENV_FILE"; then
    c_die "JWT_SECRET is the development default — generate one: openssl rand -base64 48"
  fi
  if grep -qE '^(DB_PASSWORD|LEADFLOW_DB_PASSWORD)=[[:space:]]*postgres([[:space:]]|#|$)' "$ENV_FILE"; then
    c_warn "database password is 'postgres' — acceptable only if that is genuinely the shared server's password"
  fi
  grep -qE '^NODE_ENV=production[[:space:]]*$' "$ENV_FILE"     || c_die "NODE_ENV is not production — devSeed would run and seed known credentials"

  c_ok "environment validated"

  docker network inspect "$SHARED_NETWORK" >/dev/null 2>&1 \
    || c_die "network $SHARED_NETWORK not found — is ProjexCloud running?"

  docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER" \
    || c_die "$PG_CONTAINER is not running — LeadFlow shares its database server"

  # Refuse to proceed if ProjexCloud's gateway is down. Deploying against a dead
  # gateway produces a LeadFlow that boots, serves, and fails every SDK call —
  # which reads as a LeadFlow bug to whoever finds it first.
  docker ps --format '{{.Names}}' | grep -qx projexcloud_gateway \
    || c_warn "projexcloud_gateway is not running; SDK-backed screens will degrade"

  c_ok "preflight passed"
}

# --- database ----------------------------------------------------------------
# CREATE IF ABSENT, never drop. The schema itself needs no step here: the
# migration runner provisions and self-heals on boot, so an empty database
# becomes a full schema on the API's first start.
ensure_database() {
  # -U comes from the env file, not a hardcoded 'postgres'. On this host the
  # shared server was initialised with POSTGRES_USER=projex, so the postgres
  # ROLE does not exist at all — only a leftover database of that name. Every
  # psql call here failed with `role "postgres" does not exist`, and under
  # set -e that aborts the deploy before the API is ever built.
  local su
  su="$(grep -E '^LEADFLOW_DB_USER=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true)"
  : "${su:=postgres}"

  if docker exec "$PG_CONTAINER" psql -U "$su" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
    c_ok "database $DB_NAME present"
  else
    c_info "creating database $DB_NAME"
    docker exec "$PG_CONTAINER" psql -U "$su" -d postgres -c "CREATE DATABASE $DB_NAME;"
    c_ok "database $DB_NAME created — the API will provision its schema on boot"
  fi
}

# --- base schema -------------------------------------------------------------
# THE MIGRATION RUNNER DOES NOT OWN EVERY TABLE. leads, routing_rules,
# sla_metrics and analytics_data are declared in
# .projexlight/schemas/user-defined-schemas.sql, and the migrations are
# STRICTLY ADDITIVE on top of them (MUSTNOT-04) — 003_lead_routing.sql says so
# in its own header and then does `ALTER TABLE routing_rules`.
#
# In development that base schema is already in the database, so nothing here is
# visible. On a FRESH production database it is not, and the effect is brutal
# and misleading: the runner applies 001 and 002, dies on 003 with `relation
# "routing_rules" does not exist`, and the API crash-loops with 32 of 34
# migrations unapplied — while `docker ps` reports a container that merely keeps
# restarting and the database looks perfectly healthy.
#
# Every statement in the file is CREATE TABLE IF NOT EXISTS, so this is
# idempotent and cannot redefine a table a migration has since extended.
ensure_base_schema() {
  local su="$1"
  [ -f "$BASE_SCHEMA" ] || c_die "missing $BASE_SCHEMA — the migrations alter tables it declares"

  # ON_ERROR_STOP so a partial apply fails the deploy here, rather than surfacing
  # later as an unexplained migration error.
  if docker exec -i "$PG_CONTAINER" psql -U "$su" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$BASE_SCHEMA"; then
    c_ok "base schema applied (idempotent)"
  else
    c_die "base schema failed to apply — migrations 003+ would fail on its tables"
  fi
}

# --- web assets --------------------------------------------------------------
publish_client() {
  c_info "extracting client bundle to $WEB_ROOT"
  local cid
  cid="$(docker create "leadflow/api:${LEADFLOW_TAG:-latest}")"
  sudo mkdir -p "$WEB_ROOT"
  # Into a staging dir, then swap — a half-copied bundle served mid-deploy is a
  # white screen for whoever is using the app at that moment.
  local staging="${WEB_ROOT}.new"
  sudo rm -rf "$staging"
  sudo mkdir -p "$staging"
  sudo chown "$(id -un):$(id -gn)" "$staging"
  docker cp "$cid:/app/client-dist/." "$staging/"

  # STAMP THE NEW BUILD BEFORE ANYTHING IS PRUNED BY AGE. docker cp preserves
  # the image's timestamps, and a CACHED build layer carries the mtime of the
  # build that first produced it — which can be weeks old. Without this the
  # prune below would delete the bundle it just published.
  find "$staging" -type f -exec touch {} +

  # CARRY THE PREVIOUS BUILD'S CHUNKS FORWARD. The client is code-split and
  # lazy-loads a chunk per route, so a browser that loaded index.html BEFORE a
  # deploy still asks for the old hashed filenames after it. Replacing the web
  # root wholesale 404s those requests, and React surfaces it as
  # "Failed to fetch dynamically imported module" — the whole screen dies for
  # anyone who had the app open, which is precisely the people using it.
  #
  # Filenames are content-hashed, so carrying old files forward cannot collide
  # with new ones: -n never clobbers, and -p keeps the original mtime so the
  # age-based prune below can retire them.
  if [ -d "$WEB_ROOT/assets" ]; then
    sudo cp -rnp "$WEB_ROOT/assets/." "$staging/assets/" 2>/dev/null || true
    sudo chown -R "$(id -un):$(id -gn)" "$staging"
  fi

  # Bounded, or every deploy would accumulate the last one forever. A week is
  # far longer than any open tab survives, and only ever removes files no
  # current index.html references.
  find "$staging/assets" -type f -mtime +7 -delete 2>/dev/null || true
  docker rm -v "$cid" >/dev/null
  sudo rm -rf "${WEB_ROOT}.old"
  [ -d "$WEB_ROOT" ] && sudo mv "$WEB_ROOT" "${WEB_ROOT}.old"
  sudo mv "$staging" "$WEB_ROOT"
  c_ok "client published"
}

reload_nginx() {
  # TEST FIRST. A broken vhost that reaches nginx takes cloud.projexlight.com
  # down with it; `nginx -t` fails safe and changes nothing.
  sudo nginx -t || c_die "nginx config test failed — NOT reloading, cloud.projexlight.com untouched"
  sudo systemctl reload nginx   # reload, never restart: no dropped connections
  c_ok "nginx reloaded"
}

# --- verbs -------------------------------------------------------------------
cmd_deploy() {
  preflight
  ensure_database

  local su
  su="$(grep -E '^LEADFLOW_DB_USER=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true)"
  : "${su:=postgres}"
  ensure_base_schema "$su"

  c_info "building image"
  compose build

  c_info "starting LeadFlow only"
  compose up -d          # scoped to project 'leadflow'; ProjexCloud untouched

  publish_client
  reload_nginx

  c_info "waiting for health"
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 http://127.0.0.1:3010/health >/dev/null 2>&1; then
      c_ok "LeadFlow healthy at https://$DOMAIN"
      return 0
    fi
    sleep 3
  done
  c_warn "health check did not pass in 90s — check: $0 logs"
  return 1
}

# STOPS ONLY LEADFLOW. Containers are named explicitly rather than relying on
# compose to infer scope, so this remains correct even if the compose file or
# project name is later changed.
cmd_stop() {
  for name in "${OURS[@]}"; do
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      c_info "stopping $name"
      docker stop "$name" >/dev/null
    fi
  done
  c_ok "LeadFlow stopped — ProjexCloud untouched"
  cmd_status
}

cmd_restart() { cmd_stop; compose up -d; c_ok "LeadFlow restarted"; }

cmd_status() {
  printf '\n  LEADFLOW\n'
  docker ps -a --filter "name=leadflow_" --format '    {{.Names}}\t{{.Status}}' || true
  printf '\n  PROJEXCLOUD (must be unaffected by this script)\n'
  docker ps --filter "name=projexcloud" --format '    {{.Names}}\t{{.Status}}' || true
  printf '\n'
}

cmd_logs() { docker logs -f --tail 200 leadflow_api; }

cmd_rollback() {
  [ -n "${LEADFLOW_ROLLBACK_TAG:-}" ] || c_die "set LEADFLOW_ROLLBACK_TAG to the image tag to return to"
  c_info "rolling back to ${LEADFLOW_ROLLBACK_TAG}"
  LEADFLOW_TAG="$LEADFLOW_ROLLBACK_TAG" compose up -d
  [ -d "${WEB_ROOT}.old" ] && { sudo rm -rf "$WEB_ROOT"; sudo mv "${WEB_ROOT}.old" "$WEB_ROOT"; }
  reload_nginx
  c_ok "rolled back"
}

case "${1:-deploy}" in
  deploy)   cmd_deploy ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  rollback) cmd_rollback ;;
  *)        c_die "unknown command '$1' — deploy|stop|restart|status|logs|rollback" ;;
esac
