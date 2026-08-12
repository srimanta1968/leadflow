#!/usr/bin/env bash
#
# QA accounts for the staging LeadFlow, created OVER HTTP.
#
# WHY THIS IS NOT A BOOT SEED. server/src/db/devSeed.ts creates the equivalent
# accounts in development and REFUSES to run when NODE_ENV=production — which
# staging is. That guard is correct and stays: an application that seeds known
# credentials into whatever environment it starts in eventually does it to a
# real one. Creating QA users is a DATA operation, and data goes through the
# API like any other write, which is also the only path that produces the audit
# trail a governed product is supposed to leave behind.
#
# WHY THE PASSWORD IS NOT IN THIS FILE. A credential committed to a repository
# is a credential published. The password comes from the environment, and the
# script refuses to invent one — a default here would be in every clone and
# every fork within a day.
#
# Usage:
#   export QA_PASSWORD='...'                    # required
#   export LEADFLOW_URL=https://leadflow.projexlight.com
#   ./seed-qa-users.sh              create the accounts
#   ./seed-qa-users.sh --list       print the roster to hand to QA
#
set -euo pipefail

readonly URL="${LEADFLOW_URL:-https://leadflow.projexlight.com}"
readonly DOMAIN="${QA_EMAIL_DOMAIN:-leadflow.test}"

# .test is reserved by RFC 2606 and can never be a real mailbox. That is
# deliberate: staging sends real notifications, and a QA account on a live
# domain means test traffic reaching somebody's actual inbox. Override
# QA_EMAIL_DOMAIN only if you genuinely need deliverable mail.

# role | local-part | what the account is FOR, in the words of the screens it
# unlocks — so QA knows which one to sign in as rather than guessing.
readonly ACCOUNTS=(
  "admin|qa.operator|Capture, leads, routing, pipeline, analytics, workflows, incidents. The everyday operator."
  "manager|qa.manager|Sales-manager scope: reassignment and the manager dashboards."
  "user|qa.rep|Sales-rep scope only. Use this to check that a rep CANNOT reach configuration."
  "steward|qa.steward|Data Review and Identity Review. These are Locked for admin by design."
  "privacy|qa.privacy|Consent & Preferences, DSAR and erasure. Also Locked for admin by design."
)

c_ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
c_info() { printf '\033[0;34m[qa]\033[0m %s\n' "$*"; }
c_die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

list_roster() {
  printf '\n  LeadFlow staging — QA accounts\n  %s\n\n' "$URL"
  printf '  %-28s %-9s %s\n' "EMAIL" "ROLE" "SCOPE"
  for row in "${ACCOUNTS[@]}"; do
    IFS='|' read -r role local purpose <<< "$row"
    printf '  %-28s %-9s %s\n' "${local}@${DOMAIN}" "$role" "$purpose"
  done
  printf '\n  Password: the value of QA_PASSWORD used at seed time.\n'
  printf '  Locked screens are NOT bugs — see the scope column. Governance, Offers\n'
  printf '  and Campaign Enrollment are Locked for EVERY role until a local role is\n'
  printf '  bridged to them; report those separately from a genuine permission fault.\n\n'
}

[ "${1:-}" = "--list" ] && { list_roster; exit 0; }

[ -n "${QA_PASSWORD:-}" ] || c_die "set QA_PASSWORD — this script will not invent one, and a default would be published with the repo"
[ "${#QA_PASSWORD}" -ge 12 ] || c_die "QA_PASSWORD is shorter than 12 characters"

curl -fsS -m 10 "$URL/api/health" >/dev/null 2>&1 \
  || curl -fsS -m 10 "$URL/health" >/dev/null 2>&1 \
  || c_die "$URL is not answering — deploy before seeding"

for row in "${ACCOUNTS[@]}"; do
  IFS='|' read -r role local _purpose <<< "$row"
  email="${local}@${DOMAIN}"

  # Idempotent by intent: an account that already exists is a success, not a
  # failure. Re-running after a partial seed must be safe, or nobody re-runs it.
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$URL/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$QA_PASSWORD\",\"first_name\":\"QA\",\"last_name\":\"${role^}\"}" || echo 000)"

  case "$code" in
    200|201) c_ok  "created $email" ;;
    409)     c_info "$email already exists — leaving it alone" ;;
    000)     c_die "no response from $URL — is it up?" ;;
    *)       c_info "$email -> HTTP $code (check the API log)" ;;
  esac

  # ROLE ASSIGNMENT IS NOT DONE HERE, and that is the honest position: register
  # creates every account at the default role, and elevating one is a governed
  # act that belongs to a person with user.role_assign — through the User
  # Administration screen, where it is audited with actor, subject and the
  # before/after values. Doing it from a shell script would be the one write in
  # this product with no accountable actor behind it.
done

c_info "accounts created at the DEFAULT role."
c_info "Now open $URL/app/admin/users as an admin and set each role from the roster below."
list_roster
