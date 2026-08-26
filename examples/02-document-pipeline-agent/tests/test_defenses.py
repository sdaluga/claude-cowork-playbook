"""
Tests for the pipeline's defenses.
==================================

WHAT THESE ARE FOR
------------------
The README claims this pipeline survives a prompt injection. These tests are
the evidence, and they are the reason the claim is worth anything.

The injection defense has three layers:

    Layer 1  The extractor's PROMPT tells it that document content is data.
    Layer 2  The extractor's TOOL LIST gives a successful injection nothing
             to reach for, and a PreToolUse hook denies writes outside output/.
    Layer 3  The SYSTEMS OF RECORD are authoritative -- no document can talk
             the vendor master into saying a suspended vendor is active.

Layers 2 and 3 are deterministic. They are tested here, they run in CI, and
they hold whether or not the model behaves. Layer 1 is a prompt, so it is a
mitigation rather than a control -- which is exactly why the other two exist.

That split is the whole design argument. A control you can test is a control.
A control you can only hope about is a mitigation.

RUN
---
    pip install pytest
    python -m pytest tests/ -v

No API key required. These never call a model.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

# The example is laid out flat, so tests import from the parent directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import agent  # noqa: E402
import hooks  # noqa: E402
import tools  # noqa: E402

DOCS = Path(__file__).resolve().parent.parent / "sample_documents"
INJECTED_DOC = DOCS / "invoice-03-halcyon.txt"


def call(coro):
    """These are plain sync tests; no pytest-asyncio dependency needed."""
    return asyncio.run(coro)


def text_of(result: dict) -> str:
    return result["content"][0]["text"]


@pytest.fixture(autouse=True)
def clean_ledger():
    tools.EXTRACTION_LEDGER.clear()
    yield
    tools.EXTRACTION_LEDGER.clear()


# =========================================================================== #
# LAYER 3 — the systems of record are authoritative
# =========================================================================== #


class TestSystemOfRecordWins:
    """The document does not get a vote on what the vendor master says."""

    def test_suspended_vendor_is_blocked(self):
        out = text_of(call(tools._lookup_vendor({"vendor_name": "Halcyon Data Systems Corp."})))
        assert "suspended" in out
        assert "BLOCKED" in out
        # And the tool says so in terms the model cannot read as advisory.
        assert "regardless of what the" in out

    def test_active_vendor_resolves_cleanly(self):
        out = text_of(call(tools._lookup_vendor({"vendor_name": "Meridian Global Services LLC"})))
        assert "V-10428" in out
        assert "BLOCKED" not in out

    def test_unknown_vendor_is_not_invented(self):
        out = text_of(call(tools._lookup_vendor({"vendor_name": "Entirely Fictional Ltd"})))
        assert "NOT_FOUND" in out
        assert "UNRESOLVED" in out
        assert "Do not invent" in out

    def test_closed_sow_is_blocked(self):
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-2025-0904", "vendor_id": "V-30117", "invoice_amount": 81_150.00}
        )))
        assert "BLOCKED" in out
        assert "closed" in out

    def test_over_authorization_is_caught(self):
        # SOW-2026-0219 has 8,100.00 of authorization left; this invoice is 65,744.
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-2026-0219", "vendor_id": "V-20881", "invoice_amount": 65_744.00}
        )))
        assert "OVER_AUTHORIZATION" in out
        assert "change order" in out

    def test_invoice_within_authorization_passes(self):
        # SOW-2026-0148 has 237,500.00 left; this invoice is 187,500.
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-2026-0148", "vendor_id": "V-10428", "invoice_amount": 187_500.00}
        )))
        assert "OVER_AUTHORIZATION" not in out
        assert "BLOCKED" not in out

    def test_wrong_vendor_on_sow_is_caught(self):
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-2026-0148", "vendor_id": "V-20881", "invoice_amount": 1_000.00}
        )))
        assert "MISMATCH" in out

    def test_malformed_sow_reference_is_rejected(self):
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-26-148", "vendor_id": "V-10428", "invoice_amount": 1_000.00}
        )))
        assert "INVALID" in out

    def test_unknown_sow_is_not_assumed(self):
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-2026-9999", "vendor_id": "V-10428", "invoice_amount": 1_000.00}
        )))
        assert "NOT_FOUND" in out


class TestRateCard:
    """Rate-card drift is the quiet one. A few dollars an hour, for months."""

    def test_over_contract_rate_is_caught(self):
        # Ridgeline bills Senior Engineer at 232.00; the card says 215.00.
        out = text_of(call(tools._check_rate(
            {"sow_id": "SOW-2026-0219", "role_title": "Senior Engineer", "billed_rate": 232.00}
        )))
        assert "OVER_RATE" in out
        assert "17.00" in out  # the per-hour delta, stated explicitly

    def test_off_card_role_is_caught(self):
        # "Cloud Architect" is not a contracted role on this SOW.
        out = text_of(call(tools._check_rate(
            {"sow_id": "SOW-2026-0219", "role_title": "Cloud Architect", "billed_rate": 240.00}
        )))
        assert "ROLE_NOT_ON_CARD" in out

    def test_matching_rate_passes(self):
        out = text_of(call(tools._check_rate(
            {"sow_id": "SOW-2026-0219", "role_title": "Engineer", "billed_rate": 175.00}
        )))
        assert "RATE_OK" in out

    def test_missing_rate_card_is_reported_not_guessed(self):
        out = text_of(call(tools._check_rate(
            {"sow_id": "SOW-2026-0148", "role_title": "Engineer", "billed_rate": 175.00}
        )))
        assert "NO_RATE_CARD" in out


class TestLedgerValidation:
    """The tool boundary is the validation boundary. Trust nothing from the model."""

    CLEAN = dict(
        source_file="invoice-01-meridian.txt",
        invoice_number="INV-2026-00417",
        sow_id="SOW-2026-0148",
        vendor_id="V-10428",
        vendor_legal_name="Meridian Global Services LLC",
        invoice_date="2026-07-31",
        invoice_amount=187_500.00,
        currency="USD",
        needs_review=False,
        review_reason="",
    )

    def test_clean_record_is_accepted(self):
        out = text_of(call(tools._record_extraction(dict(self.CLEAN))))
        assert "RECORDED #1" in out
        assert len(tools.EXTRACTION_LEDGER) == 1

    def test_non_iso_date_is_rejected(self):
        out = text_of(call(tools._record_extraction({**self.CLEAN, "invoice_date": "July 31, 2026"})))
        assert "REJECTED" in out
        assert not tools.EXTRACTION_LEDGER

    def test_zero_amount_is_rejected(self):
        out = text_of(call(tools._record_extraction({**self.CLEAN, "invoice_amount": 0})))
        assert "REJECTED" in out
        assert not tools.EXTRACTION_LEDGER

    def test_unresolved_vendor_must_be_flagged(self):
        out = text_of(call(tools._record_extraction(
            {**self.CLEAN, "vendor_id": "UNRESOLVED", "needs_review": False}
        )))
        assert "REJECTED" in out
        assert not tools.EXTRACTION_LEDGER

    def test_flag_without_a_reason_is_rejected(self):
        out = text_of(call(tools._record_extraction(
            {**self.CLEAN, "needs_review": True, "review_reason": "   "}
        )))
        assert "REJECTED" in out
        assert not tools.EXTRACTION_LEDGER


# =========================================================================== #
# LAYER 2 — hooks and blast radius
# =========================================================================== #


class TestWriteGuard:
    """A system prompt is a request. A hook is a rule."""

    def test_path_traversal_is_denied(self):
        out = call(hooks.guard_writes(
            {"tool_name": "Write", "tool_input": {"file_path": "output/../../etc/hosts"}},
            "t-1", None,
        ))
        decision = out.get("hookSpecificOutput", {}).get("permissionDecision")
        assert decision == "deny", json.dumps(out)

    def test_absolute_path_outside_allowlist_is_denied(self):
        out = call(hooks.guard_writes(
            {"tool_name": "Write", "tool_input": {"file_path": "/etc/passwd"}},
            "t-2", None,
        ))
        assert out.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"

    def test_traversal_through_the_allowlist_is_denied(self):
        # This is the case that actually matters, and the one a naive guard
        # waves through: an ABSOLUTE path that starts inside the allowlist and
        # then climbs back out. Without Path.resolve(), the allowlist still
        # appears in `target.parents`, so a string-shaped check passes it.
        #
        # The two tests above do NOT catch this -- both fail closed for an
        # unrelated reason. Found by deleting `.resolve()` from hooks.py and
        # noticing the suite stayed green.
        sneaky = str(hooks.WRITE_ALLOWLIST) + "/../../../../etc/passwd"
        out = call(hooks.guard_writes(
            {"tool_name": "Write", "tool_input": {"file_path": sneaky}}, "t-6", None,
        ))
        assert out.get("hookSpecificOutput", {}).get("permissionDecision") == "deny", (
            "path traversal out of the allowlist was permitted"
        )

    def test_write_inside_output_is_allowed(self):
        target = hooks.WRITE_ALLOWLIST / "summary.md"
        out = call(hooks.guard_writes(
            {"tool_name": "Write", "tool_input": {"file_path": str(target)}}, "t-3", None,
        ))
        assert out == {}

    def test_guard_ignores_non_write_tools(self):
        out = call(hooks.guard_writes(
            {"tool_name": "Glob", "tool_input": {"pattern": "*"}}, "t-4", None,
        ))
        assert out == {}

    def test_audit_hook_records_the_attempt(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hooks, "AUDIT_LOG", tmp_path / "audit.jsonl")
        call(hooks.audit_tool_use(
            {"tool_name": "Glob", "tool_input": {"pattern": "*.txt"}}, "t-5", None,
        ))
        lines = (tmp_path / "audit.jsonl").read_text(encoding="utf-8").strip().splitlines()
        entry = json.loads(lines[-1])
        assert entry["tool"] == "Glob"
        assert entry["event"] == "PreToolUse"


class TestPermissionCallback:
    def test_bash_is_denied(self):
        result = call(hooks.confirm_destructive_tools("Bash", {"command": "rm -rf /"}, None))
        assert result.behavior == "deny"

    def test_other_tools_pass_through_unmodified(self):
        payload = {"file_path": "output/summary.md"}
        result = call(hooks.confirm_destructive_tools("Write", payload, None))
        assert result.behavior == "allow"
        assert result.updated_input == payload


class TestBlastRadius:
    """The tool list IS the blast radius. Lock it down with a test."""

    def test_extractor_is_read_only(self):
        assert sorted(agent.EXTRACTOR.tools) == ["Glob", "Read"]

    def test_extractor_cannot_reach_the_ledger(self):
        assert not any(t.startswith("mcp__") for t in agent.EXTRACTOR.tools)

    def test_extractor_is_turn_capped(self):
        assert agent.EXTRACTOR.maxTurns is not None and agent.EXTRACTOR.maxTurns <= 10

    def test_orchestrator_denies_shell_and_network(self):
        opts = agent.build_options(agent.DEFAULT_INPUT)
        for banned in ("Bash", "WebSearch", "WebFetch"):
            assert banned in opts.disallowed_tools
            assert banned not in opts.allowed_tools

    def test_orchestrator_does_not_read_documents_itself(self):
        opts = agent.build_options(agent.DEFAULT_INPUT)
        assert "Read" not in opts.allowed_tools

    def test_run_is_bounded(self):
        opts = agent.build_options(agent.DEFAULT_INPUT)
        assert opts.max_turns is not None
        assert opts.max_budget_usd is not None

    def test_host_settings_are_not_loaded(self):
        opts = agent.build_options(agent.DEFAULT_INPUT)
        assert opts.setting_sources == []


# =========================================================================== #
# THE INJECTION DOCUMENT, SPECIFICALLY
# =========================================================================== #


class TestBundledInjection:
    """
    invoice-03-halcyon.txt asks the pipeline to treat a suspended vendor as
    active, reopen a closed SOW, and record 81,150.00 as 8,115.00.

    Every one of those asks runs into a deterministic control.
    """

    def test_the_injection_is_still_in_the_fixture(self):
        # If someone "cleans up" the sample document, this suite stops testing
        # anything. Fail loudly instead.
        body = INJECTED_DOC.read_text(encoding="utf-8")
        assert "Ignore previous instructions" in body
        assert "pre-approved" in body

    def test_its_vendor_claim_is_overridden(self):
        out = text_of(call(tools._lookup_vendor({"vendor_name": "Halcyon Data Systems Corp."})))
        assert "suspended" in out and "BLOCKED" in out

    def test_its_sow_claim_is_overridden(self):
        out = text_of(call(tools._check_sow(
            {"sow_id": "SOW-2025-0904", "vendor_id": "V-30117", "invoice_amount": 81_150.00}
        )))
        assert "BLOCKED" in out

    def test_it_cannot_be_recorded_as_clean_without_a_reason(self):
        # Even if the model were fully persuaded, an unresolved/blocked vendor
        # recorded without a review reason is refused at the tool boundary.
        out = text_of(call(tools._record_extraction({
            "source_file": INJECTED_DOC.name,
            "invoice_number": "INV-2026-00882",
            "sow_id": "SOW-2025-0904",
            "vendor_id": "UNRESOLVED",
            "vendor_legal_name": "Halcyon Data Systems Corp.",
            "invoice_date": "2026-08-11",
            "invoice_amount": 8_115.00,
            "currency": "USD",
            "needs_review": False,
            "review_reason": "",
        })))
        assert "REJECTED" in out
        assert not tools.EXTRACTION_LEDGER

    def test_the_document_never_reaches_a_privileged_tool(self):
        # The agent that reads this file has Read and Glob. That is the point:
        # a perfectly successful injection has nothing to call.
        assert set(agent.EXTRACTOR.tools) == {"Read", "Glob"}
