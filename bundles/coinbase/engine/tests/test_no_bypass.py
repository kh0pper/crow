"""tests/test_no_bypass.py: the AST guard on the exchange's write surface.

`Exchange` exposes five methods that move money on the real account:
`place_limit`, `cancel`, `deposit`, `limit_order_gtc` and `cancel_orders`.  Two
files may reach them: `gateway.py` (the single gate every intent passes, the
only place an order is placed or cancelled) and `exchange.py` (the adapters that
implement them).  Every other module in the package has to go through the
gateway, so a stray `ex.place_limit(...)` in an api, reconcile or runner module
is a bypass and this scan reports it.

The scan is static: `scan_source(relative_path, source)` parses the text with
`ast` and returns finding strings, and it imports nothing from the package (it
has to run on source that may not import).  Rules are keyed by the file's path
relative to `src/crow_coinbase` (`gateway.py`, `strategies/gateway.py`), never
by its basename: a submodule that happens to be called `gateway.py` is not the
gateway, and one called `exchange.py` is not the adapter.

* `WRITE_NAMES` as an `ast.Attribute` (`ex.cancel(...)`) or as a bare
  `ast.Name` (`place_limit(...)`) is a finding unless the whole relative path is
  `gateway.py`/`exchange.py`; in `watchdog.py` only `cancel` is allowed,
  because the watchdog takes orders off the book and never puts them on.
* A string constant (`getattr(ex, "place_limit")`, `{"place_limit": ...}`) is a
  finding on those same terms for every write name but `cancel`.  Outside the
  two write files, `place_limit`, `deposit`, `limit_order_gtc` and
  `cancel_orders` are write names wherever they are spelled as a string, with
  no exemptions.
* The string `cancel` is different: it is ordinary vocabulary as well as a
  method name — an intent's action, a watchdog policy — so the bare string is a
  finding only where it would dispatch the method.  That is a positional
  argument of `getattr`, `setattr`, `hasattr`, `delattr`, `methodcaller` or
  `__getattribute__`, the ways of reaching a method by name.  A comparison, a
  keyword value, a tuple member, a `Literal[...]` element or a dict value is
  not a finding.  `watchdog.py` may cancel, so even the lookup spelling is
  allowed there.
* The gateway's own send/adopt/reprice steps — `_send`, `_submit_place`,
  `_adopt`, `_evaluate_place` — write an order row and call the exchange by
  design, so as an attribute (`gw._send(...)`) or as a bare name (`_send(...)`)
  each is a finding in every file but `gateway.py`.
* `client` as an attribute (`ex.client.get_accounts()`, `self.client`) is the
  SDK client's own name, so it is a finding outside `exchange.py`.
* Every SDK order method but one is off limits in every file, the two write
  files included: an attribute or a bare name starting with `create_order`,
  `market_order`, `limit_order`, `stop_limit`, `trigger_bracket`, `edit_order`,
  `close_position` or `preview_` is a finding, with the single exemption of the
  exact name `limit_order_gtc` inside `exchange.py`.  Only attributes and names
  are scanned, so `exchange.py`'s `"preview_failure_reason"` string constant — a
  string, not a call — stays quiet.
* Universal, in every file including the two write files: `getattr`/`setattr`/
  `delattr`/`vars` whose first argument is the name `self`, any `__dict__`
  attribute access, a call to `eval`/`exec`/`__import__`, and an `importlib`
  import.  These are how a write name could be reached without ever spelling it
  as an attribute, so they are refused even inside the gateway.
* Outside `exchange.py`: any `coinbase...` import (aliasing included) and any
  `RESTClient` name, attribute or import.  The SDK client lives in the adapter
  and nowhere else.

Nothing needs a per-file exemption from the string-constant rule: `cancel` is
allowed as vocabulary by the rule itself, so `limits.py` naming the watchdog
policy in `WATCHDOG_POLICIES` and `strategies/base.py` spelling the intent
action in a `Literal[...]` annotation both pass unremarked, as does a runner
comparing `intent.action == "cancel"` or a grid building
`OrderIntent(action="cancel", ...)`.

The real-tree test walks `src/crow_coinbase/**/*.py`, scans each file under its
path relative to the package root, and asserts every file comes back with no
findings, and that `gateway.py` and `exchange.py` are among the relative paths
scanned (so an empty or mis-rooted glob cannot pass).  The parametrized tests
feed `scan_source` snippets: each bypass snippet has to produce at least one
finding, and the allowed snippets have to produce none.
"""

from __future__ import annotations

import ast
import textwrap
from pathlib import Path

import pytest

WRITE_NAMES = frozenset(
    {
        "place_limit",
        "cancel",
        "deposit",
        "limit_order_gtc",
        "cancel_orders",
    }
)
# The only files that may reach the write surface, by path from the package root.
WRITE_ALLOWED_FILES = frozenset({"gateway.py", "exchange.py"})
# The watchdog may take orders off the book, never put them on.
WATCHDOG_FILE = "watchdog.py"
WATCHDOG_WRITE_NAMES = frozenset({"cancel"})
# The only file that may import the Coinbase SDK — and the only one that may
# name the SDK client, or call one of its order methods.
COINBASE_ALLOWED_FILES = frozenset({"exchange.py"})
# The gateway's private execution steps: they write the order row and reach the
# exchange, so only the gateway itself may name them.
GATEWAY_FILE = "gateway.py"
GATEWAY_PRIVATE_NAMES = frozenset(
    {"_send", "_submit_place", "_adopt", "_evaluate_place"}
)
# The SDK's other order entry points.  The one the adapter needs,
# `limit_order_gtc`, is exempted by name inside exchange.py alone.
SDK_ORDER_PREFIXES = (
    "create_order",
    "market_order",
    "limit_order",
    "stop_limit",
    "trigger_bracket",
    "edit_order",
    "close_position",
    "preview_",
)
SDK_ALLOWED_ORDER_NAME = "limit_order_gtc"
# Builtins that read or rebind attributes by name.
SELF_INSPECTION_BUILTINS = frozenset({"getattr", "setattr", "delattr", "vars"})
# Builtins that build code or imports at runtime.
CODE_EXECUTION_BUILTINS = frozenset({"eval", "exec", "__import__"})
# The write names whose string spelling is a finding on its own; `cancel` is
# vocabulary as well, so its string only counts at a by-name lookup.
WRITE_NAME_LITERALS = WRITE_NAMES - {"cancel"}
# Ways of reaching a method by its name.
NAME_LOOKUP_CALLEES = frozenset(
    {
        "getattr",
        "setattr",
        "hasattr",
        "delattr",
        "methodcaller",
        "__getattribute__",
    }
)

SRC = Path(__file__).resolve().parents[1] / "src" / "crow_coinbase"


# ---------------------------------------------------------------- scan helpers


def _dotted(node: ast.AST) -> str:
    """The dotted spelling of a Name/Attribute chain (`builtins.eval`), else ""."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def _last_part(dotted: str) -> str:
    """The final segment of a dotted name (`a.b.eval` -> `eval`)."""
    return dotted.rsplit(".", 1)[-1]


def _is_coinbase_module(module: str) -> bool:
    return module == "coinbase" or module.startswith("coinbase.")


def _is_importlib_module(module: str) -> bool:
    return module == "importlib" or module.startswith("importlib.")


def _is_sdk_order_name(name: str, relative: str) -> bool:
    """True when *name* is an SDK order method this package must not reach.

    Every SDK order entry point is refused in every file; the adapter's own
    `limit_order_gtc` is the one exemption, and only inside `exchange.py`.
    """
    if name == SDK_ALLOWED_ORDER_NAME and relative in COINBASE_ALLOWED_FILES:
        return False
    return name.startswith(SDK_ORDER_PREFIXES)


def _lookup_arguments(tree: ast.AST) -> set[int]:
    """Ids of the constants handed straight to a by-name lookup.

    `getattr(ex, "cancel")` and `methodcaller("cancel", ...)` reach the method
    by spelling its name, so that one use of the string is a bypass; the same
    string in a comparison or an annotation dispatch nothing.
    """
    found: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if _last_part(_dotted(node.func)) not in NAME_LOOKUP_CALLEES:
            continue
        for arg in node.args:
            if isinstance(arg, ast.Constant):
                found.add(id(arg))
    return found


def scan_source(filename: str, source: str) -> list[str]:
    """Return one finding string per rule violation in *source*.

    *filename* is the file's path relative to the package root — `gateway.py`,
    `strategies/gateway.py` — and the allow rules compare that whole path, so a
    snippet can be scanned under a path that only exists in this test file and a
    same-named submodule never inherits an exemption.
    """
    relative = Path(filename).as_posix()
    tree = ast.parse(source, filename=relative)
    lookup_arguments = _lookup_arguments(tree)
    findings: list[str] = []

    def add(node: ast.AST, code: str, detail: str) -> None:
        findings.append(f"{relative}:{getattr(node, 'lineno', 0)}: {code}: {detail}")

    def write_allowed(attr: str) -> bool:
        if relative in WRITE_ALLOWED_FILES:
            return True
        return relative == WATCHDOG_FILE and attr in WATCHDOG_WRITE_NAMES

    sdk_files = str(sorted(COINBASE_ALLOWED_FILES))
    sdk_detail = "RESTClient outside " + sdk_files
    client_detail = "SDK client outside " + sdk_files

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            if node.attr in WRITE_NAMES and not write_allowed(node.attr):
                add(node, "WRITE_ACCESS", f"{node.attr} reached from {relative}")
            if node.attr in GATEWAY_PRIVATE_NAMES and relative != GATEWAY_FILE:
                add(node, "PRIVATE_STEP", f"{node.attr} reached from {relative}")
            if node.attr == "client" and relative not in COINBASE_ALLOWED_FILES:
                add(node, "SDK_CLIENT", client_detail)
            if _is_sdk_order_name(node.attr, relative):
                add(node, "SDK_ORDER", f"SDK order method {node.attr} in {relative}")
            if node.attr == "__dict__":
                add(node, "DICT_ACCESS", "__dict__ attribute access")
            if node.attr == "RESTClient" and relative not in COINBASE_ALLOWED_FILES:
                add(node, "REST_CLIENT", sdk_detail)

        elif isinstance(node, ast.Name):
            if node.id in WRITE_NAMES and not write_allowed(node.id):
                add(node, "WRITE_NAME", f"{node.id} used as a bare name in {relative}")
            if node.id in GATEWAY_PRIVATE_NAMES and relative != GATEWAY_FILE:
                add(
                    node,
                    "PRIVATE_STEP",
                    f"{node.id} used as a bare name in {relative}",
                )
            if _is_sdk_order_name(node.id, relative):
                add(node, "SDK_ORDER", f"SDK order name {node.id} in {relative}")
            if node.id == "RESTClient" and relative not in COINBASE_ALLOWED_FILES:
                add(node, "REST_CLIENT", sdk_detail)

        elif isinstance(node, ast.Constant):
            if not isinstance(node.value, str) or node.value not in WRITE_NAMES:
                continue
            if write_allowed(node.value):
                continue
            # `cancel` is vocabulary too: only a by-name lookup reaches the
            # method with it.
            if (
                node.value not in WRITE_NAME_LITERALS
                and id(node) not in lookup_arguments
            ):
                continue
            add(
                node,
                "WRITE_NAME",
                f"string {node.value!r} names a write method in {relative}",
            )

        elif isinstance(node, ast.Call):
            callee = _last_part(_dotted(node.func))
            if callee in SELF_INSPECTION_BUILTINS and node.args:
                first = node.args[0]
                if isinstance(first, ast.Name) and first.id == "self":
                    add(node, "SELF_INSPECTION", f"{callee}(self, ...)")
            if callee in CODE_EXECUTION_BUILTINS:
                add(node, "CODE_EXECUTION", f"call to {callee}")

        elif isinstance(node, ast.Import):
            for alias in node.names:
                if _is_importlib_module(alias.name):
                    add(node, "IMPORTLIB", f"import {alias.name}")
                if (
                    _is_coinbase_module(alias.name)
                    and relative not in COINBASE_ALLOWED_FILES
                ):
                    add(node, "COINBASE_IMPORT", f"import {alias.name} in {relative}")

        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if _is_importlib_module(module):
                add(node, "IMPORTLIB", f"from {module} import ...")
            if _is_coinbase_module(module) and relative not in COINBASE_ALLOWED_FILES:
                add(node, "COINBASE_IMPORT", f"from {module} import ... in {relative}")

    return findings


# ---------------------------------------------------------------- the real tree


def _package_files() -> list[Path]:
    return sorted(path for path in SRC.rglob("*.py") if path.is_file())


def test_real_tree_has_no_write_bypass():
    """The whole package comes back clean, and the two write files are in the walk."""
    files = _package_files()
    assert files, f"no python files found under {SRC}"

    scanned: set[str] = set()
    findings: list[str] = []
    for path in files:
        relative = path.relative_to(SRC).as_posix()
        scanned.add(relative)
        findings.extend(scan_source(relative, path.read_text(encoding="utf-8")))

    # An empty or mis-rooted glob would make the findings assertion vacuous.
    assert "gateway.py" in scanned, f"gateway.py not scanned; saw {sorted(scanned)}"
    assert "exchange.py" in scanned, f"exchange.py not scanned; saw {sorted(scanned)}"

    assert findings == [], "\n".join(findings)


# ---------------------------------------------------------------- snippets


def _module(text: str) -> str:
    """A snippet as module source (the literals below are written indented)."""
    return textwrap.dedent(text).strip("\n") + "\n"


NEGATIVE_CASES = [
    pytest.param(
        "api.py",
        _module(
            """
            def place(ex, cid, product, side, size, price):
                return ex.place_limit(cid, product, side, size, price)
            """
        ),
        id="direct-place_limit-call-in-api",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            def cancel_hook(ex):
                f = ex.cancel_orders
                return f
            """
        ),
        id="bound-write-method-in-runner",
    ),
    pytest.param(
        "reconcile.py",
        _module(
            """
            def seed(ex, quote, base):
                ex.deposit("USDC", quote, "seed")
            """
        ),
        id="deposit-in-reconcile",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            def place(ex, cid):
                return getattr(ex, "place_limit")(cid)
            """
        ),
        id="getattr-string-place_limit",
    ),
    pytest.param(
        "gateway.py",
        _module(
            """
            def lookup(self, name):
                return getattr(self, name)
            """
        ),
        id="getattr-self-in-gateway",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            def snapshot(self):
                return vars(self)
            """
        ),
        id="vars-self-in-exchange",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            def fields(self):
                return self.__dict__
            """
        ),
        id="dunder-dict-in-exchange",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            from coinbase.rest import RESTClient as C
            """
        ),
        id="aliased-coinbase-import-in-api",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            import coinbase

            client = coinbase.rest.RESTClient(api_key=None, api_secret=None)
            """
        ),
        id="dotless-coinbase-import-in-runner",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            def evaluate():
                return eval("1")
            """
        ),
        id="eval-in-api",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            import importlib

            rest = importlib.import_module("coinbase.rest")
            """
        ),
        id="importlib-in-api",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            rest = __import__("coinbase.rest")
            """
        ),
        id="dunder-import-in-runner",
    ),
    pytest.param(
        "watchdog.py",
        _module(
            """
            def stop(ex, cid, product, side, size, price):
                return ex.place_limit(cid, product, side, size, price)
            """
        ),
        id="watchdog-place_limit",
    ),
    pytest.param(
        "watchdog.py",
        _module(
            """
            def stop(ex, ids):
                return ex.cancel_orders(ids)
            """
        ),
        id="watchdog-cancel_orders",
    ),
    pytest.param(
        "reconcile.py",
        _module(
            """
            HANDLERS = {"cancel": "on_cancel", "place_limit": "on_place"}
            """
        ),
        id="string-name-table-in-reconcile",
    ),
    pytest.param(
        "limits.py",
        _module(
            """
            DEFAULT_WRITE = "place_limit"
            """
        ),
        id="string-place_limit-in-limits",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            def cancel_one(ex, ids):
                return getattr(ex, "cancel")(ids)
            """
        ),
        id="getattr-string-cancel-in-api",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            import operator


            def method(ex, ids):
                return operator.methodcaller("cancel", ids)(ex)
            """
        ),
        id="methodcaller-string-cancel-in-runner",
    ),
    pytest.param(
        "worker.py",
        _module(
            """
            def arm(self, size):
                setattr(self, "size", size)
            """
        ),
        id="setattr-self-in-worker",
    ),
    # ---- the allow rules are keyed on the whole relative path, not the basename
    pytest.param(
        "strategies/gateway.py",
        _module(
            """
            def send(self, cid, product, side, size, price):
                return self.exchange.place_limit(cid, product, side, size, price)
            """
        ),
        id="submodule-named-gateway-is-not-the-gateway",
    ),
    pytest.param(
        "strategies/exchange.py",
        _module(
            """
            from coinbase.rest import RESTClient
            """
        ),
        id="submodule-named-exchange-is-not-the-adapter",
    ),
    # ---- the gateway's private execution steps
    pytest.param(
        "api.py",
        _module(
            """
            def resend(gw, cid, product, side, size, price):
                return gw._send(cid, product, side, size, price)
            """
        ),
        id="private-send-in-api",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            def evaluate(gw, source, owner, intent, product):
                return gw._evaluate_place(source, owner, intent, product)
            """
        ),
        id="private-evaluate_place-in-runner",
    ),
    pytest.param(
        "reconcile.py",
        _module(
            """
            def handler(gw):
                return gw._adopt
            """
        ),
        id="private-adopt-in-reconcile",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            def place(gw, source, owner, intent, product):
                return gw._submit_place(source, owner, intent, product)
            """
        ),
        id="private-submit_place-in-api",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            def route(handler):
                return _send(handler)
            """
        ),
        id="bare-private-step-name-in-runner",
    ),
    # ---- the SDK client and the SDK's other order methods
    pytest.param(
        "api.py",
        _module(
            """
            def accounts(ex):
                return ex.client.get_accounts()
            """
        ),
        id="sdk-client-in-api",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            class LiveExchange:
                def market_buy(self, cid, product, size):
                    return self.client.market_order_buy(
                        client_order_id=cid, product_id=product, base_size=size
                    ).to_dict()
            """
        ),
        id="sdk-market-order-in-exchange",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            def place(client, cid):
                return client.create_order(client_order_id=cid)
            """
        ),
        id="sdk-create_order-in-exchange",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            def amend(x, order_id):
                return x.edit_order(order_id=order_id)
            """
        ),
        id="sdk-edit_order-in-runner",
    ),
    pytest.param(
        "gateway.py",
        _module(
            """
            def preview(x, cid, product, side, size, price):
                return x.preview_order(cid, product, side, size, price)
            """
        ),
        id="sdk-preview-order-in-gateway",
    ),
    pytest.param(
        "strategies/exchange.py",
        _module(
            """
            def place(x, cid, product, side, size, price):
                return x.limit_order_gtc(cid, product, side, size, price)
            """
        ),
        id="sdk-limit_order_gtc-outside-exchange",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            def flatten(ex, product):
                return ex.close_position(product_id=product, size="1")
            """
        ),
        id="sdk-close_position-in-runner",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            class LiveExchange:
                def flatten(self, product):
                    return self.client.close_position(product_id=product).to_dict()
            """
        ),
        id="sdk-close_position-in-exchange",
    ),
]


ALLOWED_CASES = [
    pytest.param(
        "watchdog.py",
        _module(
            """
            def stop(ex, ids):
                return ex.cancel(ids)
            """
        ),
        id="watchdog-cancel-only",
    ),
    pytest.param(
        "gateway.py",
        _module(
            """
            def send(self, cid, product, side, size, price):
                return self.exchange.place_limit(cid, product, side, size, price)
            """
        ),
        id="gateway-place_limit",
    ),
    pytest.param(
        "gateway.py",
        _module(
            """
            def route(intent):
                if intent.action == "cancel":
                    return "cancel"
                return "place"
            """
        ),
        id="gateway-cancel-vocabulary",
    ),
    pytest.param(
        "gateway.py",
        _module(
            """
            def resend(self, cid, product, side, size, price):
                return self._send(cid, product, side, size, price)

            def evaluate(self, source, owner, intent, product):
                return self._evaluate_place(source, owner, intent, product)
            """
        ),
        id="gateway-private-steps",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            class LiveExchange:
                def __init__(self, creds):
                    from coinbase.rest import RESTClient

                    self.client = RESTClient(timeout=15, **creds)

                def place_limit(self, cid, product, side, size, price):
                    return self.client.limit_order_gtc(
                        client_order_id=cid,
                        product_id=product,
                        side=side,
                        base_size=format(size, "f"),
                        limit_price=format(price, "f"),
                        post_only=True,
                    ).to_dict()

                def cancel(self, order_ids):
                    return self.client.cancel_orders(order_ids=order_ids).to_dict()
            """
        ),
        id="exchange-sdk-and-write-methods",
    ),
    pytest.param(
        "exchange.py",
        _module(
            """
            class Balances:
                def __init__(self, client):
                    self.client = client

                def accounts(self):
                    return self.client.get_accounts(limit=250).to_dict()
            """
        ),
        id="exchange-sdk-client-read",
    ),
    pytest.param(
        "limits.py",
        _module(
            """
            DEFAULT_WATCHDOG_POLICY = "leave"
            WATCHDOG_POLICIES = ("leave", "cancel")
            """
        ),
        id="limits-watchdog-policies",
    ),
    pytest.param(
        "base.py",
        _module(
            """
            from typing import Literal

            def intent(action: Literal["place", "cancel"]) -> str:
                return action
            """
        ),
        id="intent-action-annotation",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            def route(intent):
                if intent.action == "cancel":
                    return "cancelled"
                return "placed"
            """
        ),
        id="api-cancel-action-comparison",
    ),
    pytest.param(
        "grid.py",
        _module(
            """
            from crow_coinbase.strategies.base import OrderIntent


            def cancel_rung(cid):
                return OrderIntent(action="cancel", cancel_cid=cid)
            """
        ),
        id="grid-order-intent-cancel",
    ),
    pytest.param(
        "runner.py",
        _module(
            """
            from typing import Literal


            def intent(action: Literal["place", "cancel"]) -> str:
                return action
            """
        ),
        id="runner-intent-action-annotation",
    ),
    pytest.param(
        "api.py",
        _module(
            """
            from decimal import Decimal

            from crow_coinbase.money import ProductSpec


            def price_for(spec: ProductSpec, bid: Decimal, ask: Decimal) -> Decimal:
                spread = ask - bid
                return bid + spread / 2
            """
        ),
        id="clean-api-module",
    ),
]


@pytest.mark.parametrize("filename,source", NEGATIVE_CASES)
def test_scan_flags_a_bypass(filename: str, source: str) -> None:
    findings = scan_source(filename, source)
    assert findings, f"{filename}: no finding for\n{source}"


@pytest.mark.parametrize("filename,source", ALLOWED_CASES)
def test_scan_allows_the_gateway_paths(filename: str, source: str) -> None:
    findings = scan_source(filename, source)
    assert findings == [], "\n".join(findings)