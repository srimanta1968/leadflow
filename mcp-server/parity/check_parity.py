#!/usr/bin/env python3
"""
Dev MCP side of the header-contract parity check.

Feeds header-parity-fixture.json through the Dev MCP's own resolver and asserts
the documented outcome. The Test MCP and the ProjexLight executor must run the
same fixture and produce the same headers; a disagreement is a contract
violation in whichever executor differs, not a reason to edit the fixture.

    python dist/parity/check_parity.py        # exit 0 = conforms

Why this exists: three programs implement one contract. Nothing but an
executable comparison keeps them together, and the drift is invisible until a
staging run behaves differently from a laptop.
"""
import hashlib
import hmac
import json
import logging
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))
logging.disable(logging.CRITICAL)

from src.services.api_tester import APITester  # noqa: E402


def build(fixture):
    t = object.__new__(APITester)
    t._test_config_cache = fixture['config']
    # No placeholder engine here: the fixture resolves {{var:}} through the same
    # tier lookup the runner uses, so stub only what the resolver calls back into.
    env_vars = (fixture['config'].get('environments', {})
                .get(fixture['config'].get('activeEnvironment'), {})
                .get('variables', {}) or {})
    global_vars = fixture['config'].get('variables', {}) or {}

    def resolve(payload, endpoint, location=None):
        out = {}
        for k, v in payload.items():
            if isinstance(v, str) and v.startswith('{{var:') and v.endswith('}}'):
                name = v[len('{{var:'):-2]
                # environment BEFORE global — the whole point of case 1
                out[k] = env_vars.get(name, global_vars.get(name, v))
            else:
                out[k] = v
        return out

    t._process_declarative_placeholders = resolve
    t._resolve_embedded_auth_placeholders = lambda v, e: v
    return t


def run():
    fixture = json.load(open(os.path.join(HERE, 'header-parity-fixture.json'), encoding='utf-8'))
    failures = []

    for case in fixture['cases']:
        t = build(fixture)
        d = case['definition']
        endpoint = d['endpoint']
        t.json_test_definitions = {f"{d['method']} {endpoint}": d}
        t._active_test_key = f"{d['method']} {endpoint}"
        t._active_dataset_index = case.get('datasetIndex', 0)

        headers = t._config_header_layers(endpoint, d)
        headers = t._process_declarative_placeholders(dict(headers), endpoint, location='header')

        # layer 6 — the dataset's own headers
        cases_ = d.get('testCases') or []
        idx = case.get('datasetIndex', 0)
        if 0 <= idx < len(cases_):
            headers.update({k: v for k, v in (cases_[idx].get('headers') or {}).items() if v})

        for key, want in (case.get('expect') or {}).items():
            got = headers.get(key)
            if got != want:
                failures.append(f"{case['name']}: {key} = {got!r}, expected {want!r}")

        for key in (case.get('expectAbsent') or []):
            if key in headers:
                failures.append(f"{case['name']}: {key} should be absent, got {headers[key]!r}")

        spec = case.get('expectComputed')
        if spec:
            body = (cases_[idx].get('payload') if 0 <= idx < len(cases_) else None)
            computed = {}
            t._apply_computed_headers(computed, endpoint, body)
            want = spec['prefix'] + hmac.new(
                spec['secret'].encode(), json.dumps(spec['bodyJson']).encode(), hashlib.sha256
            ).hexdigest()
            if computed.get(spec['header']) != want:
                failures.append(
                    f"{case['name']}: {spec['header']} = {computed.get(spec['header'])!r}, expected {want!r}")

    print(f"parity cases: {len(fixture['cases'])}, failures: {len(failures)}")
    for f in failures:
        print("  FAIL", f)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(run())
