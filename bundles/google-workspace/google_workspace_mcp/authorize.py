"""
One-time OAuth authorization for the Google Workspace MCP server.

Run this once (per credentials directory) to sign in and create the token file
the server uses:

    google-workspace-mcp-authorize            # opens your browser automatically
    google-workspace-mcp-authorize --manual   # copy-paste flow for headless/remote machines

Credential and token locations come from the same env vars the server uses:
    GOOGLE_CREDENTIALS_FILE  (default: ~/.config/google-workspace-mcp/credentials.json)
    GOOGLE_TOKEN_FILE        (default: ~/.config/google-workspace-mcp/token.json)
    GOOGLE_OAUTH_LOCAL_PORT  (default: 8090; used by the browser flow)
"""

import argparse
import os
import sys
import urllib.parse

# Google may return granted scopes in a different order than requested; relaxing
# this check avoids a spurious "Scope has changed" error during the exchange.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: E402

from .auth import SCOPES, _get_credentials_file, _get_token_file  # noqa: E402


def _save_token(credentials, token_file) -> None:
    token_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(token_file) + ".tmp"
    with open(tmp, "w") as f:
        f.write(credentials.to_json())
    os.chmod(tmp, 0o600)
    os.replace(tmp, str(token_file))


def _browser_flow(flow, token_file) -> bool:
    """Open a local browser, capture the redirect automatically."""
    port = int(os.environ.get("GOOGLE_OAUTH_LOCAL_PORT", "8090"))
    creds = flow.run_local_server(
        port=port, open_browser=True, prompt="consent", access_type="offline"
    )
    _save_token(creds, token_file)
    return True


def _manual_flow(flow, token_file) -> bool:
    """Headless/remote: print a URL, read back the redirected address-bar URL.

    A single process keeps the PKCE verifier alive across authorization_url()
    and fetch_token(), so do NOT split this into two runs.
    """
    auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
    print("\n1) Open this URL in your browser and sign in:\n")
    print(auth_url)
    print(
        "\n2) After you approve, your browser will try to open a page at\n"
        "   http://localhost/?code=...  — it will say the site can't be reached.\n"
        "   That is expected. Copy the FULL address-bar URL (it contains 'code=').\n"
    )
    pasted = input("3) Paste that URL (or just the code) here: ").strip()
    code = pasted
    if "code=" in pasted:
        code = urllib.parse.parse_qs(
            urllib.parse.urlparse(pasted).query
        ).get("code", [pasted])[0]
    flow.fetch_token(code=code)
    _save_token(flow.credentials, token_file)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Authorize the Google Workspace MCP server (one-time)."
    )
    parser.add_argument(
        "--manual",
        action="store_true",
        help="Copy-paste flow for machines without a local browser (e.g. a remote server).",
    )
    args = parser.parse_args()

    credentials_file = _get_credentials_file()
    token_file = _get_token_file()

    if not credentials_file.exists():
        print(
            f"ERROR: OAuth client file not found at {credentials_file}\n"
            "Download it from Google Cloud Console (APIs & Services -> Credentials ->\n"
            "your Desktop OAuth client -> Download JSON) and save it there, or set\n"
            "GOOGLE_CREDENTIALS_FILE to its path.",
            file=sys.stderr,
        )
        return 1

    # Installed/Desktop OAuth clients accept a localhost redirect on any port.
    flow = InstalledAppFlow.from_client_secrets_file(
        str(credentials_file), SCOPES, redirect_uri="http://localhost",
    )

    try:
        if args.manual:
            _manual_flow(flow, token_file)
        else:
            try:
                _browser_flow(flow, token_file)
            except Exception as e:  # noqa: BLE001
                print(f"\nBrowser flow failed ({e}); falling back to manual copy-paste.\n")
                _manual_flow(flow, token_file)
    except Exception as e:  # noqa: BLE001
        print(f"Authorization failed: {e}", file=sys.stderr)
        return 2

    print(f"\nSuccess. Token saved to {token_file}")
    print("You can now start the MCP server (or connect it to your AI client).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
