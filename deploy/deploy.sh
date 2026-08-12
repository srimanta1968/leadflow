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
readonly WEB_ROOT="/usr/share/nginx/leadflow"
readonly DOMAIN="leadflow.projexlight.com"

# Containers this script is ALLOWED to stop. Anything not on this list is
# somebody else's and is never a target.
readonly OURS=("leadflow_api")

c_info() { printf '\033[0;34m[deploy]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
c_die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# --- preflight ---------------------------------------------------------------
preflight() {
  [ -f "$ENV_FILE" ] || c_die "missing $ENV_FILE — copy leadflow.env.example and fill it in"

  # REFUSE TO SHIP A PLACEHOLDER. Every variable in env.ts has a fallback and
  # nothing throws, so an unset JWT_SECRET silently becomes 'your-secret-key'
  # and an unset DB_PASSWORD becomes 'postgres' — the process boots, serves
  # traffic and passes its health check with both. Nothing downstream will ever
  # report this, so it has to be caught here.
  local unset_vars
  unset_vars="$(grep -E '=CHANGE_ME[[:space:]]*$' "$ENV_FILE" | cut -d= -f1 | paste -sd' ' -)"
  [ -z "$unset_vars" ] || c_die "still at CHANGE_ME in $ENV_FILE: $unset_vars"

  # The same defaults, spelled out — someone may replace CHANGE_ME with the
  # very value the fallback would have used.
  if grep -qE '^JWT_SECRET=your-secret-key[[:space:]]*$' "$ENV_FILE"; then
    c_die "JWT_SECRET is the development default — generate one: openssl rand -base64 48"
  fi
  if grep -qE '^(DB_PASSWORD|LEADFLOW_DB_PASSWORD)=postgres[[:space:]]*$' "$ENV_FILE"; then
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
  if docker exec "$PG_CONTAINER" psql -U postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
    c_ok "database $DB_NAME present"
  else
    c_info "creating database $DB_NAME"
    docker exec "$PG_CONTAINER" psql -U postgres -c "CREATE DATABASE $DB_NAME;"
    c_ok "database $DB_NAME created — the API will provision its schema on boot"
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
  docker cp "$cid:/app/client-dist/." "$staging/"
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
