#!/usr/bin/env python3
"""Writes the Chromium managed policy for the Crow kiosk.

  chromium_policy.py --crow-url https://crow.example.ts.net:8444 [--allow-frame-origin https://...]...

Every policy name below exists in Chromium's policies.yaml; LoopbackNetworkAllowedForUrls is supported
from Chromium 146.
Since Chromium 147 the page's WebSocket to ws://127.0.0.1:8770 (the kiosk agent) needs a Local Network
Access grant; on an unattended kiosk nobody can answer the prompt, so the policy grants loopback only,
to the Crow origin only.

URLBlocklist/URLAllowlist: the kiosk may load only the Crow origin plus any frame origins named with
--allow-frame-origin (window-manager spec amendment A3: frames are fenced by the page's CSP frame-src;
the browser policy is the outer fence and must list them too, because the blocklist is not limited to
top-level navigation as far as we can tell; the bring-up check in the plan settles it on the Pi).
"""

import argparse
import json
import sys
from urllib.parse import urlsplit


def origin(url):
    p = urlsplit(url)
    if (
        p.scheme != "https"
        or not p.hostname
        or p.path not in ("", "/")
        or p.query
        or p.fragment
        or p.username
        or p.password
    ):
        raise ValueError(f"expected an https origin with no path: {url!r}")
    port = f":{p.port}" if p.port and p.port != 443 else ""
    return f"https://{p.hostname.lower()}{port}"


def build_policy(crow_url, frame_origins=()):
    crow = origin(crow_url)
    frames = sorted({origin(o) for o in frame_origins} - {crow})
    return {
        # navigation fence
        "URLBlocklist": ["*", "chrome://*", "file://*", "javascript://*", "view-source:*"],
        # navigations and frames only (not fetch/WebSocket): the page, its pairing and assets keep working
        "URLAllowlist": [f"{crow}/display", *frames],
        # mic + autoplay for the Crow page only, no prompts
        "AudioCaptureAllowed": True,
        "AudioCaptureAllowedUrls": [crow],
        "VideoCaptureAllowed": False,
        "ScreenCaptureAllowed": False,
        "AutoplayAllowed": False,
        "AutoplayAllowlist": [crow],
        # the agent socket on loopback only (LocalNetworkAccessAllowedForUrls would also open the LAN)
        "LoopbackNetworkAllowedForUrls": [crow],
        # no tools, no escape hatches
        "DeveloperToolsAvailability": 2,
        "TaskManagerEndProcessEnabled": False,
        "IncognitoModeAvailability": 1,
        "BrowserGuestModeEnabled": False,
        "BrowserAddPersonEnabled": False,
        "BrowserSignin": 0,
        "SyncDisabled": True,
        "ExtensionInstallBlocklist": ["*"],
        "AllowFileSelectionDialogs": False,
        "DownloadRestrictions": 3,
        "PrintingEnabled": False,
        "DefaultPopupsSetting": 2,
        "DefaultNotificationsSetting": 2,
        "DefaultGeolocationSetting": 2,
        "PasswordManagerEnabled": False,
        "AutofillAddressEnabled": False,
        "AutofillCreditCardEnabled": False,
        "TranslateEnabled": False,
        "SpellcheckEnabled": False,
        "SearchSuggestEnabled": False,
        "MetricsReportingEnabled": False,
        "BackgroundModeEnabled": False,
        "DefaultBrowserSettingEnabled": False,
        "CommandLineFlagSecurityWarningsEnabled": False,
        "HardwareAccelerationModeEnabled": True,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--crow-url", required=True)
    ap.add_argument("--allow-frame-origin", action="append", default=[])
    a = ap.parse_args(argv)
    try:
        json.dump(
            build_policy(a.crow_url, a.allow_frame_origin),
            sys.stdout,
            indent=2,
            sort_keys=True,
        )
    except ValueError as e:
        print(f"chromium_policy: {e}", file=sys.stderr)
        return 2
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
