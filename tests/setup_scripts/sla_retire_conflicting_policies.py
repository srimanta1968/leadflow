#!/usr/bin/env python3
"""
@fixture scope=tenant tier=api

MUST-51 API-based setup: clear the SLA policy slot that POST /api/sla/policies
creates into, so the definition is re-run-safe.

SCOPE IS TENANT, NOT PLATFORM, and stated rather than derived. The uniqueness
this clears — active policy per (source_channel, evaluation_order) — is enforced
inside one tenant's policy set, and the retire calls run under that tenant's
token. A platform-scoped reading would suggest the fixture reaches rows another
tenant owns, which it neither does nor should. Tier is api because it retires
through the SLA endpoints rather than touching the table.

THE PROBLEM. `sla/policies-post.json` creates a live_chat policy at
evaluation_order 10. An active policy is unique on (source_channel,
evaluation_order), so the definition passes exactly once — on a database that has
never run it — and answers 409 on every run after that:

    409  An active SLA policy already exists for that lead type at that
         evaluation order. Choose a different evaluation order.

That is the endpoint behaving correctly. The suite is what is wrong: it was only
ever idempotent by accident, on a database nobody had run it against twice. The
same defect shows up as a first-run PASS and a second-run FAIL, which is the most
expensive shape a test failure can take — it looks like a regression in whatever
changed most recently.

It cannot be fixed inside the definition. `evaluation_order` is an integer and the
runner's `{{dynamic:...}}` vocabulary has no numeric generator, so there is no way
to ask for a fresh slot per run; and a definition cannot clean up after itself.

WHY HTTP AND NOT SQL. `api_test_runner.py` runs `*.py`/`*.js` setup scripts on
every run and explicitly skips `*.sql`, because the Test MCP has no database
access to a deployed host. Retiring through the real endpoint therefore works
identically against localhost and against a remote staging target — which is the
only reason this also solves the no-seed-data case rather than just the local one.

Retire, not delete: retirement is the product's own soft-delete, so this leaves
the historical policy readable — a retired policy still explains why a lead
captured last week had the deadline it had.

Idempotent, and NON-FATAL by design: it always exits 0. A setup script that can
fail the run would turn a housekeeping hiccup into a suite-wide outage, and the
definition's own 409 is a perfectly clear diagnosis if this did not do its job.

Reads env: API_BASE_URL, USER_TOKEN (falls back to TENANT_TOKEN).
"""
import json
import os
import urllib.error
import urllib.request

BASE = (os.environ.get("API_BASE_URL") or "").rstrip("/")
TOKEN = os.environ.get("USER_TOKEN") or os.environ.get("TENANT_TOKEN") or ""

# Must match the positive case in tests/api_definitions/sla/policies-post.json.
CONFLICT_CHANNEL = "live_chat"
CONFLICT_ORDER = 10


def _request(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + TOKEN,
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read().decode() or "{}"
        return response.status, json.loads(raw)


def main():
    if not BASE or not TOKEN:
        print("  [skip] SLA policy slot: no API_BASE_URL/token in context")
        return

    try:
        _, listed = _request("GET", "/api/sla/policies?active=true")
    except urllib.error.HTTPError as error:
        # A 403 here is the informative case: it means the QA account is not
        # elevated, which is the same reason the governed endpoints are failing.
        print(f"  [skip] SLA policy slot: list returned {error.code}")
        return
    except Exception as error:  # noqa: BLE001 - never fail the run
        print(f"  [skip] SLA policy slot: {error}")
        return

    policies = (listed.get("data") or {}).get("policies") or []
    doomed = [
        p
        for p in policies
        if p.get("source_channel") == CONFLICT_CHANNEL
        and p.get("evaluation_order") == CONFLICT_ORDER
        and p.get("is_active") is not False
    ]

    if not doomed:
        print("  [ok] SLA policy slot already free")
        return

    for policy in doomed:
        policy_id = policy.get("id")
        try:
            status, _ = _request("DELETE", f"/api/sla/policies/{policy_id}")
            print(f"  [ok] retired conflicting SLA policy {policy_id} ({status})")
        except urllib.error.HTTPError as error:
            print(f"  [warn] could not retire {policy_id}: {error.code}")
        except Exception as error:  # noqa: BLE001
            print(f"  [warn] could not retire {policy_id}: {error}")


if __name__ == "__main__":
    main()
