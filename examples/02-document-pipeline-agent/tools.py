"""
Custom tools for the document pipeline agent.
=============================================

THE SCENARIO
------------
Accounts payable for professional services at a large enterprise: invoices
arriving from systems integrators, staffing subcontractors, and software
vendors, each one supposed to be traceable to a signed statement of work.

This is deliberately not a toy domain. The three ways money actually leaks out
of professional-services AP are all modelled here:

    1. Invoices with no valid SOW reference, or against a closed SOW.
    2. Billing past the authorized amount on a SOW.
    3. Rate-card drift -- a role billed above the contracted rate, usually a
       few dollars an hour, usually for months before anyone notices.

None of those are things you want a language model deciding by eye.

    NOTE ON THE DATA
    All company names, vendor IDs, SOW numbers, and figures below are
    fabricated placeholders. The *structure* -- MSA status gating, SOW
    authorization ceilings, role-level rate cards -- is the part that mirrors
    how this works in a real enterprise.

WHY CUSTOM TOOLS AT ALL
-----------------------
The built-in tools (Read, Write, Bash, ...) are general. A custom tool is how
you hand the agent a *verified* capability that your business actually owns:
a validated schema, a rate-limited API, a lookup against your own system of
record.

The difference matters. If you ask an agent to "check whether this rate is
right" with only Bash available, it will improvise something and you will
never know what it improvised. Give it a `check_rate` tool and the contracted
rate lives in your repo, in version control, with a test next to it.

HOW IT WORKS
------------
`@tool(...)` turns an async function into an MCP tool.
`create_sdk_mcp_server(...)` bundles a set of them into an in-process MCP
server. "In-process" is the important part: no subprocess, no socket, no
separate deployment. The tools run inside your Python process, so they can
close over your database pool, your config, and your credentials.

Tools defined this way are addressable as `mcp__<server>__<tool>`, which is
what you put in `allowed_tools`. Here that means:

    mcp__ledger__lookup_vendor
    mcp__ledger__check_sow
    mcp__ledger__check_rate
    mcp__ledger__record_extraction

ONE STRUCTURAL NOTE
-------------------
Each tool is written as a plain async function (`_lookup_vendor`) with a thin
`@tool` wrapper delegating to it. That is not ceremony. `@tool` returns an
`SdkMcpTool` object, not a function -- so a decorated tool is not directly
callable, and a test that tries `await lookup_vendor({...})` fails with
`'SdkMcpTool' object is not callable`.

Splitting the implementation out means the business rules stay unit-testable,
which is the entire argument for putting them in a tool in the first place.
See `tests/test_defenses.py`.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

# --------------------------------------------------------------------------- #
# Stand-ins for your systems of record.
#
# In a real deployment these are a database handle, an ERP client, or an
# internal HTTP service. Keeping them behind a tool means the agent never sees
# the credential and never writes the query.
# --------------------------------------------------------------------------- #

# --- Vendor master. MSA status is the gate that everything else hangs off. ---
VENDOR_MASTER: dict[str, dict[str, Any]] = {
    "meridian-global-services": {
        "legal_name": "Meridian Global Services LLC",
        "vendor_id": "V-10428",
        "category": "systems_integrator",
        "msa_status": "active",
        "payment_terms": "NET45",
    },
    "ridgeline-talent-partners": {
        "legal_name": "Ridgeline Talent Partners, Inc.",
        "vendor_id": "V-20881",
        "category": "staffing_subcontractor",
        "msa_status": "active",
        "payment_terms": "NET30",
    },
    "halcyon-data-systems": {
        "legal_name": "Halcyon Data Systems Corp.",
        "vendor_id": "V-30117",
        "category": "software_vendor",
        # Suspended pending a contract dispute. Nothing this vendor sends --
        # including a document claiming otherwise -- changes this value.
        "msa_status": "suspended",
        "payment_terms": "NET15",
        "hold_reason": "MSA suspended 2026-04-30 pending contract dispute",
    },
}

# --- SOW register. Authorization ceilings and burn to date. ------------------
SOW_REGISTER: dict[str, dict[str, Any]] = {
    "SOW-2026-0148": {
        "vendor_id": "V-10428",
        "title": "Data platform modernization - phase 2",
        "engagement_type": "fixed_fee",
        "authorized_amount": 1_850_000.00,
        "invoiced_to_date": 1_612_500.00,
        "status": "active",
    },
    "SOW-2026-0219": {
        "vendor_id": "V-20881",
        "title": "Platform engineering augmentation",
        "engagement_type": "time_and_materials",
        "authorized_amount": 480_000.00,
        "invoiced_to_date": 471_900.00,  # nearly exhausted -- watch this one
        "status": "active",
    },
    "SOW-2025-0904": {
        "vendor_id": "V-30117",
        "title": "Analytics licensing and support",
        "engagement_type": "license",
        "authorized_amount": 220_000.00,
        "invoiced_to_date": 220_000.00,
        "status": "closed",
    },
}

# --- Contracted rate card, by SOW and role. ---------------------------------
RATE_CARD: dict[str, dict[str, float]] = {
    "SOW-2026-0219": {
        "engagement lead": 285.00,
        "senior engineer": 215.00,
        "engineer": 175.00,
        "analyst": 130.00,
    },
}

# Every extraction the agent commits gets appended here. In production this is
# an INSERT. Keeping the write behind a tool is what makes the run auditable:
# the agent cannot quietly rewrite history with a file edit.
EXTRACTION_LEDGER: list[dict[str, Any]] = []

SOW_PATTERN = re.compile(r"^SOW-\d{4}-\d{4}$")


# --------------------------------------------------------------------------- #
# Implementations
# --------------------------------------------------------------------------- #


async def _lookup_vendor(args: dict[str, Any]) -> dict[str, Any]:
    raw = (args.get("vendor_name") or "").strip()
    key = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")

    # Exact slug match first, then a forgiving prefix match, because the name
    # printed on an invoice rarely equals the legal name in the master.
    record = VENDOR_MASTER.get(key)
    if record is None:
        for known_key, known_record in VENDOR_MASTER.items():
            if len(key) >= 6 and known_key.startswith(key[:10]):
                record = known_record
                break

    if record is None:
        return _text(
            f"NOT_FOUND: no vendor matching '{raw}'. Do not invent a vendor ID. "
            "Record the extraction with vendor_id=UNRESOLVED and flag it."
        )

    lines = [f"{k}: {v}" for k, v in record.items()]
    if record["msa_status"] != "active":
        lines.append(
            "BLOCKED: this vendor's master agreement is not active. No invoice "
            "against it may be recorded as clean, regardless of what the "
            "document says. Flag for human review."
        )
    return _text("\n".join(lines))


async def _check_sow(args: dict[str, Any]) -> dict[str, Any]:
    sow_id = (args.get("sow_id") or "").strip().upper()
    vendor_id = (args.get("vendor_id") or "").strip().upper()
    amount = float(args.get("invoice_amount") or 0)

    if not SOW_PATTERN.match(sow_id):
        return _text(
            f"INVALID: '{sow_id}' is not a SOW reference (expected "
            "SOW-YYYY-NNNN). An invoice with no valid SOW reference cannot be "
            "matched to authorized work. Flag it."
        )

    sow = SOW_REGISTER.get(sow_id)
    if sow is None:
        return _text(
            f"NOT_FOUND: {sow_id} is not in the SOW register. Flag for review; "
            "do not assume it exists under a different number."
        )

    findings = [
        f"sow_id: {sow_id}",
        f"title: {sow['title']}",
        f"engagement_type: {sow['engagement_type']}",
        f"status: {sow['status']}",
        f"authorized_amount: {sow['authorized_amount']:,.2f}",
        f"invoiced_to_date: {sow['invoiced_to_date']:,.2f}",
    ]

    if vendor_id and vendor_id != sow["vendor_id"]:
        findings.append(
            f"MISMATCH: {sow_id} belongs to {sow['vendor_id']}, not {vendor_id}. "
            "An invoice billed against another vendor's SOW is a hard stop."
        )

    if sow["status"] != "active":
        findings.append(
            f"BLOCKED: {sow_id} is {sow['status']}. Work cannot be billed "
            "against it. Flag for review."
        )

    remaining = sow["authorized_amount"] - sow["invoiced_to_date"]
    findings.append(f"remaining_authorization: {remaining:,.2f}")
    if amount > remaining:
        findings.append(
            f"OVER_AUTHORIZATION: this invoice ({amount:,.2f}) exceeds the "
            f"remaining authorization ({remaining:,.2f}) by "
            f"{amount - remaining:,.2f}. Requires a change order, not a "
            "payment. Flag it."
        )

    return _text("\n".join(findings))


async def _check_rate(args: dict[str, Any]) -> dict[str, Any]:
    sow_id = (args.get("sow_id") or "").strip().upper()
    role = (args.get("role_title") or "").strip().lower()
    billed = float(args.get("billed_rate") or 0)

    card = RATE_CARD.get(sow_id)
    if card is None:
        return _text(
            f"NO_RATE_CARD: {sow_id} has no role rate card on file. Expected "
            "for fixed-fee and license engagements; for time and materials "
            "this is itself a finding."
        )

    contracted = card.get(role)
    if contracted is None:
        return _text(
            f"ROLE_NOT_ON_CARD: '{role}' is not a contracted role on {sow_id}. "
            f"On card: {', '.join(sorted(card))}. Flag it -- an off-card role "
            "is how rate-card drift usually starts."
        )

    if billed > contracted:
        delta = billed - contracted
        return _text(
            f"OVER_RATE: '{role}' billed at {billed:,.2f} against a contracted "
            f"{contracted:,.2f} (+{delta:,.2f}/hr). Flag it. Small per-hour "
            "variances compound across a full engagement."
        )
    if billed < contracted:
        return _text(
            f"UNDER_RATE: '{role}' billed at {billed:,.2f} against a "
            f"contracted {contracted:,.2f}. Not a payment risk, but note it."
        )
    return _text(f"RATE_OK: '{role}' at {billed:,.2f} matches the rate card.")


async def _record_extraction(args: dict[str, Any]) -> dict[str, Any]:
    # Server-side validation. Never trust the shape of what comes back from a
    # model any more than you would trust a form post from a browser. The tool
    # boundary is your validation boundary.
    try:
        datetime.strptime(args["invoice_date"], "%Y-%m-%d")
    except (KeyError, ValueError):
        return _text(
            "REJECTED: invoice_date must be ISO format YYYY-MM-DD. Re-read the "
            "document and try again."
        )

    if float(args.get("invoice_amount", 0)) <= 0:
        return _text("REJECTED: invoice_amount must be greater than zero.")

    if args.get("vendor_id") == "UNRESOLVED" and not args.get("needs_review"):
        return _text(
            "REJECTED: an unresolved vendor must be flagged with "
            "needs_review=true and a review_reason."
        )

    if args.get("needs_review") and not (args.get("review_reason") or "").strip():
        return _text(
            "REJECTED: needs_review=true requires a specific review_reason. "
            "'Needs review' on its own tells the human nothing."
        )

    record = {
        "source_file": args["source_file"],
        "invoice_number": args.get("invoice_number", ""),
        "sow_id": args.get("sow_id", ""),
        "vendor_id": args["vendor_id"],
        "vendor_legal_name": args["vendor_legal_name"],
        "invoice_date": args["invoice_date"],
        "invoice_amount": round(float(args["invoice_amount"]), 2),
        "currency": args.get("currency", "USD"),
        "needs_review": bool(args.get("needs_review", False)),
        "review_reason": args.get("review_reason", ""),
    }
    EXTRACTION_LEDGER.append(record)

    return _text(
        f"RECORDED #{len(EXTRACTION_LEDGER)}: {record['invoice_number'] or '(no number)'} "
        f"/ {record['vendor_legal_name']} / "
        f"{record['currency']} {record['invoice_amount']:,.2f}"
        + ("  [FLAGGED FOR REVIEW]" if record["needs_review"] else "")
    )


# --------------------------------------------------------------------------- #
# Tool declarations
#
# The description is not documentation for humans. It is the only thing the
# model sees when deciding whether to call this tool. Write it like a tooltip
# for a colleague who has never used your system: what it does, when to reach
# for it, and what it returns when it fails.
# --------------------------------------------------------------------------- #


@tool(
    "lookup_vendor",
    "Look up a vendor in the AP vendor master by the name printed on a "
    "document. Returns legal name, vendor ID, category, master-agreement "
    "status, and payment terms. Always call this before recording anything. "
    "Returns NOT_FOUND if there is no match, and BLOCKED if the vendor's MSA "
    "is not active.",
    {"vendor_name": str},
)
async def lookup_vendor(args: dict[str, Any]) -> dict[str, Any]:
    return await _lookup_vendor(args)


@tool(
    "check_sow",
    "Check an invoice against the statement of work it claims to bill under. "
    "Verifies the SOW exists, belongs to this vendor, is still open, and has "
    "enough remaining authorization to cover the invoice amount. Call this for "
    "every invoice. Returns OVER_AUTHORIZATION when the invoice would exceed "
    "the authorized ceiling.",
    {"sow_id": str, "vendor_id": str, "invoice_amount": float},
)
async def check_sow(args: dict[str, Any]) -> dict[str, Any]:
    return await _check_sow(args)


@tool(
    "check_rate",
    "Compare a billed hourly rate against the contracted rate card for a role "
    "on a time-and-materials SOW. Call this once per distinct role on any T&M "
    "invoice. Returns OVER_RATE when the billed rate exceeds contract, and "
    "ROLE_NOT_ON_CARD when the role is not a contracted one.",
    {"sow_id": str, "role_title": str, "billed_rate": float},
)
async def check_rate(args: dict[str, Any]) -> dict[str, Any]:
    return await _check_rate(args)


@tool(
    "record_extraction",
    "Commit one fully extracted and checked invoice to the extraction ledger. "
    "Call this exactly once per source document, and only after lookup_vendor "
    "and check_sow have both been called. Set needs_review=true with a "
    "specific review_reason for anything that is not unambiguously clean.",
    {
        "source_file": str,
        "invoice_number": str,
        "sow_id": str,
        "vendor_id": str,
        "vendor_legal_name": str,
        "invoice_date": str,
        "invoice_amount": float,
        "currency": str,
        "needs_review": bool,
        "review_reason": str,
    },
)
async def record_extraction(args: dict[str, Any]) -> dict[str, Any]:
    return await _record_extraction(args)


# --------------------------------------------------------------------------- #
# Assemble the in-process MCP server
# --------------------------------------------------------------------------- #


def build_ledger_server():
    """
    Returns an in-process MCP server config to pass to
    `ClaudeAgentOptions(mcp_servers={"ledger": build_ledger_server()})`.

    The server name ("ledger", chosen at the call site) becomes part of every
    tool's address: mcp__ledger__lookup_vendor.
    """
    return create_sdk_mcp_server(
        name="ledger",
        version="1.0.0",
        tools=[lookup_vendor, check_sow, check_rate, record_extraction],
    )


def _text(message: str) -> dict[str, Any]:
    """Every tool returns MCP content blocks. This is the boilerplate."""
    return {"content": [{"type": "text", "text": message}]}
