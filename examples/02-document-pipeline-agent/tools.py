"""
Custom tools for the document pipeline agent.
=============================================

WHY CUSTOM TOOLS AT ALL
-----------------------
The built-in tools (Read, Write, Bash, ...) are general. A custom tool is how
you hand the agent a *verified* capability that your business actually owns:
a validated schema, a rate-limited API, a lookup against your own system of
record.

The difference matters. If you ask an agent to "validate this invoice number"
with only Bash available, it will write a regex on the fly and you will never
know which regex it used. If you give it a `validate_invoice` tool, the rule
lives in your repo, in version control, with a test next to it.

HOW IT WORKS
------------
`@tool(...)` turns an async Python function into an MCP tool.
`create_sdk_mcp_server(...)` bundles a set of them into an in-process MCP
server. "In-process" is the important part: no subprocess, no socket, no
separate deployment. The tools run inside your Python process, so they can
close over your database pool, your config, and your credentials.

Tools defined this way are addressable as `mcp__<server>__<tool>`, which is
what you put in `allowed_tools`. Here that means:

    mcp__ledger__validate_invoice
    mcp__ledger__lookup_vendor
    mcp__ledger__record_extraction
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

# --------------------------------------------------------------------------- #
# A stand-in for your system of record.
# In a real deployment this is a database handle, an ERP client, or an
# internal HTTP service. Keeping it behind a tool means the agent never sees
# the credential and never writes the query.
# --------------------------------------------------------------------------- #

KNOWN_VENDORS: dict[str, dict[str, Any]] = {
    "northwind-logistics": {
        "legal_name": "Northwind Logistics LLC",
        "vendor_id": "V-10428",
        "payment_terms": "NET30",
        "status": "active",
    },
    "brightpath-consulting": {
        "legal_name": "BrightPath Consulting Group, Inc.",
        "vendor_id": "V-20881",
        "payment_terms": "NET45",
        "status": "active",
    },
    "orion-supply": {
        "legal_name": "Orion Supply Co.",
        "vendor_id": "V-30117",
        "payment_terms": "NET15",
        "status": "on_hold",
    },
}

# Every extraction the agent commits gets appended here. In production this is
# an INSERT. Keeping the write behind a tool is what makes the run auditable:
# the agent cannot quietly rewrite history with a file edit.
EXTRACTION_LEDGER: list[dict[str, Any]] = []


# --------------------------------------------------------------------------- #
# Tool 1 — validate an invoice number against the house format
# --------------------------------------------------------------------------- #

INVOICE_PATTERN = re.compile(r"^INV-\d{4}-\d{5}$")


@tool(
    "validate_invoice",
    # This description is not documentation for humans. It is the only thing
    # the model sees when deciding whether to call this tool. Write it like a
    # tool-tip for a colleague who has never used your system: what it does,
    # and when to reach for it.
    "Validate an invoice number against the company format INV-YYYY-NNNNN. "
    "Call this before recording any extracted invoice. Returns whether the "
    "number is well-formed and, if not, why.",
    {"invoice_number": str},
)
async def validate_invoice(args: dict[str, Any]) -> dict[str, Any]:
    number = (args.get("invoice_number") or "").strip().upper()

    if not number:
        return _text("INVALID: no invoice number supplied.")

    if not INVOICE_PATTERN.match(number):
        return _text(
            f"INVALID: '{number}' does not match INV-YYYY-NNNNN. "
            "Common causes: missing the INV- prefix, a two-digit year, or "
            "fewer than five digits in the sequence."
        )

    year = int(number.split("-")[1])
    current_year = date.today().year
    if year > current_year:
        return _text(
            f"INVALID: '{number}' is dated {year}, which is in the future."
        )
    if year < current_year - 7:
        return _text(
            f"SUSPECT: '{number}' is dated {year}, outside the 7-year "
            "retention window. Flag it rather than recording it silently."
        )

    return _text(f"VALID: {number}")


# --------------------------------------------------------------------------- #
# Tool 2 — resolve a vendor name to a record in the system of record
# --------------------------------------------------------------------------- #


@tool(
    "lookup_vendor",
    "Look up a vendor in the accounts-payable master by name. Returns the "
    "legal name, vendor ID, payment terms, and account status. Use this to "
    "resolve the free-text vendor name printed on a document to a real "
    "vendor record. Returns NOT_FOUND if there is no match.",
    {"vendor_name": str},
)
async def lookup_vendor(args: dict[str, Any]) -> dict[str, Any]:
    raw = (args.get("vendor_name") or "").strip()
    key = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")

    # Exact slug match first, then a forgiving prefix match, because the name
    # printed on a PDF rarely equals the legal name in the master.
    record = KNOWN_VENDORS.get(key)
    if record is None:
        for known_key, known_record in KNOWN_VENDORS.items():
            if known_key.startswith(key[:12]) and len(key) >= 6:
                record = known_record
                break

    if record is None:
        return _text(
            f"NOT_FOUND: no vendor matching '{raw}'. Do not invent a vendor "
            "ID. Record the extraction with vendor_id=UNRESOLVED and flag it."
        )

    lines = [f"{k}: {v}" for k, v in record.items()]
    if record["status"] != "active":
        lines.append(
            "WARNING: this vendor is not active. Flag any invoice against it "
            "for human review before payment."
        )
    return _text("\n".join(lines))


# --------------------------------------------------------------------------- #
# Tool 3 — commit one extracted record
# --------------------------------------------------------------------------- #


@tool(
    "record_extraction",
    "Commit one fully extracted and validated document record to the "
    "extraction ledger. Call this exactly once per source document, and only "
    "after validate_invoice and lookup_vendor have both been called. "
    "Set needs_review=true for anything you are not confident about.",
    {
        "source_file": str,
        "invoice_number": str,
        "vendor_id": str,
        "vendor_legal_name": str,
        "invoice_date": str,
        "total_amount": float,
        "currency": str,
        "needs_review": bool,
        "review_reason": str,
    },
)
async def record_extraction(args: dict[str, Any]) -> dict[str, Any]:
    # Server-side validation. Never trust the shape of what comes back from a
    # model any more than you would trust a form post from a browser. The
    # tool boundary is your validation boundary.
    try:
        datetime.strptime(args["invoice_date"], "%Y-%m-%d")
    except (KeyError, ValueError):
        return _text(
            "REJECTED: invoice_date must be ISO format YYYY-MM-DD. "
            "Re-read the document and try again."
        )

    if args.get("total_amount", 0) <= 0:
        return _text("REJECTED: total_amount must be greater than zero.")

    if args.get("vendor_id") == "UNRESOLVED" and not args.get("needs_review"):
        return _text(
            "REJECTED: an unresolved vendor must be flagged with "
            "needs_review=true and a review_reason."
        )

    record = {
        "source_file": args["source_file"],
        "invoice_number": args["invoice_number"],
        "vendor_id": args["vendor_id"],
        "vendor_legal_name": args["vendor_legal_name"],
        "invoice_date": args["invoice_date"],
        "total_amount": round(float(args["total_amount"]), 2),
        "currency": args.get("currency", "USD"),
        "needs_review": bool(args.get("needs_review", False)),
        "review_reason": args.get("review_reason", ""),
    }
    EXTRACTION_LEDGER.append(record)

    return _text(
        f"RECORDED #{len(EXTRACTION_LEDGER)}: {record['invoice_number']} "
        f"/ {record['vendor_legal_name']} / "
        f"{record['currency']} {record['total_amount']:,.2f}"
        + ("  [FLAGGED FOR REVIEW]" if record["needs_review"] else "")
    )


# --------------------------------------------------------------------------- #
# Assemble the in-process MCP server
# --------------------------------------------------------------------------- #


def build_ledger_server():
    """
    Returns an in-process MCP server config to pass to
    `ClaudeAgentOptions(mcp_servers={"ledger": build_ledger_server()})`.

    The server name ("ledger", chosen at the call site) becomes part of every
    tool's address: mcp__ledger__validate_invoice.
    """
    return create_sdk_mcp_server(
        name="ledger",
        version="1.0.0",
        tools=[validate_invoice, lookup_vendor, record_extraction],
    )


def _text(message: str) -> dict[str, Any]:
    """Every tool returns MCP content blocks. This is the boilerplate."""
    return {"content": [{"type": "text", "text": message}]}
