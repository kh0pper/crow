"""Drive crow-browser (CDP) against an Austin GovQA portal request.

Credentials come from env (GOVQA_USER / GOVQA_PASS) and are NEVER written to
disk or logged. Reusable for the Crow GovQA skill.

Actions:
  recon  : login, open the request, dump page structure + screenshot (no writes)
  fill   : login, open the request, type the reply into --reply-selector (no submit)
  submit : login, open the request, type the reply, then click --submit-selector

Usage (creds inline so they stay env-only, not persisted):
  GOVQA_USER=... GOVQA_PASS=... uv run --with playwright python govqa_drive.py \
     --action recon --base https://austinisd.govqa.us --rid 2429
"""
import argparse
import os
import sys
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"


def get_page(browser):
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    pages = [p for p in ctx.pages if p.url != "about:blank"]
    return pages[0] if pages else (ctx.pages[0] if ctx.pages else ctx.new_page())


def is_logged_in(page):
    # logged-in GovQA shows a "Logout" / account link; login page shows the username field
    try:
        if page.locator("#ASPxFormLayout1_txtUsername_I").count() > 0:
            return False
        if page.get_by_text("Logout", exact=False).count() > 0:
            return True
    except Exception:
        pass
    return None


def login(page, base):
    user = os.environ["GOVQA_USER"]
    pwd = os.environ["GOVQA_PASS"]
    page.goto(base + "/WEBAPP/_rs/Login.aspx", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(1500)
    if page.locator("#ASPxFormLayout1_txtUsername_I").count() == 0:
        print("[login] no username field present; assuming already authenticated")
        return
    page.fill("#ASPxFormLayout1_txtUsername_I", user)
    page.fill("#ASPxFormLayout1_txtPassword_I", pwd)
    btn = page.locator("#ASPxFormLayout1_btnLogin_I")
    try:
        btn.click(timeout=4000)
    except Exception:
        btn.dispatch_event("click")  # overlay intercepts pointer; dispatch directly
    page.wait_for_load_state("domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    print("[login] post-login url:", page.url)


def open_request(page, base, rid):
    page.goto(f"{base}/WEBAPP/_rs/(S())/RequestEdit.aspx?rid={rid}",
              wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    print("[request] url:", page.url)
    print("[request] title:", page.title())


def recon(page, shot, click_first=None):
    if click_first:
        try:
            page.locator(click_first).click(timeout=5000)
        except Exception:
            page.locator(click_first).dispatch_event("click")
        for st in ("domcontentloaded", "networkidle"):
            try:
                page.wait_for_load_state(st, timeout=60000)
            except Exception:
                pass
        page.wait_for_timeout(5000)
        print("[recon] clicked-first:", click_first, "-> url:", page.url)
    # screenshot first (resilient to JS-context churn)
    try:
        page.screenshot(path=shot, full_page=True)
        print("screenshot:", shot)
    except Exception as e:
        print("screenshot failed:", e)
    # probe candidate editor/field/button selectors with auto-retrying locators
    candidates = [
        "textarea", "iframe",
        "#txtMessage", "[id*=Message]", "[id*=txtMessage]", "[name*=Message]",
        "[id*=Editor]", ".dxheIS", ".dxeHtmlEditor", "[id*=HtmlEditor]",
        "input[type=submit]", "input[type=button]",
        "#btnSendMessage_I", "[id*=Send]", "[id*=Submit]", "[id*=Save]",
    ]
    print("PROBE:")
    for sel in candidates:
        try:
            print(f"  {sel}: {page.locator(sel).count()}")
        except Exception as e:
            print(f"  {sel}: ERR {e}")
    # try to enumerate submit/button values via locator (no JS context)
    try:
        btns = page.locator("input[type=submit], input[type=button]")
        n = btns.count()
        print(f"BUTTONS ({n}):")
        for i in range(min(n, 25)):
            b = btns.nth(i)
            print(f"  id={b.get_attribute('id')!r} val={b.get_attribute('value')!r}")
    except Exception as e:
        print("button enum failed:", e)


def _safe_name(text, url):
    import os
    import re
    from urllib.parse import urlparse, unquote
    base = unquote(os.path.basename(urlparse(url).path)) if url else ""
    if not base or "." not in base:
        base = (text or "document").strip() or "document"
    base = re.sub(r"[\x00/\\]", "_", base)[:200]
    return base or "document"


def download(page, dest, shot):
    """Download produced/released records from the open request page into dest.

    Best-effort, fail-loud: enumerate candidate document links, fetch via the
    authenticated browser context (direct href) or capture a click download
    event, save into dest. If nothing downloads, exit non-zero (3) with a
    screenshot so the dispatcher routes the PIR to needs-human rather than
    silently reporting success. The released-records DOM varies by tenant and is
    NOT yet validated against a live produced-records request — the screenshot +
    the 'candidate' log lines are the recon aid for tuning the selectors.
    """
    import os
    import re
    from urllib.parse import urljoin

    os.makedirs(dest, exist_ok=True)
    try:
        page.screenshot(path=shot, full_page=True)
        print("[download] request-page screenshot:", shot)
    except Exception as e:
        print("[download] screenshot failed:", e)

    DOC_RX = re.compile(r"(download|getfile|getdocument|viewdocument|attachment|"
                        r"\.pdf|\.xlsx?|\.docx?|\.zip|\.csv|\.accdb|\.txt)", re.I)
    anchors = page.locator("a")
    n = anchors.count()
    candidates = []
    for i in range(n):
        a = anchors.nth(i)
        try:
            href = a.get_attribute("href") or ""
            text = (a.inner_text() or "").strip()
        except Exception:
            continue
        if DOC_RX.search(href) or DOC_RX.search(text):
            candidates.append((href, text, i))
    print(f"[download] {len(candidates)} candidate document link(s)")
    for href, text, _ in candidates:
        print(f"  - {text!r} -> {href[:120]!r}")

    ctx = page.context
    saved = []
    seen = set()
    for href, text, idx in candidates:
        try:
            url = href if href.startswith("http") else (urljoin(page.url, href) if href else "")
            postback = (not url) or "javascript:" in href.lower() or "__dopostback" in href.lower()
            if url and not postback:
                resp = ctx.request.get(url)
                if resp.ok:
                    fn = _safe_name(text, url)
                    if fn in seen:
                        fn = f"{len(saved) + 1}_{fn}"
                    with open(os.path.join(dest, fn), "wb") as f:
                        f.write(resp.body())
                    saved.append(fn)
                    seen.add(fn)
                    print("[download] saved (href):", fn)
                    continue
            # Fallback: click + capture the download event (JS/postback triggers)
            with page.expect_download(timeout=30000) as dl:
                try:
                    anchors.nth(idx).click(timeout=5000)
                except Exception:
                    anchors.nth(idx).dispatch_event("click")
            d = dl.value
            fn = d.suggested_filename or _safe_name(text, url)
            d.save_as(os.path.join(dest, fn))
            saved.append(fn)
            seen.add(fn)
            print("[download] saved (click):", fn)
        except Exception as e:
            print(f"[download] failed for {text or href!r}: {e}")

    if not saved:
        print("[download] NO FILES DOWNLOADED — released-records section not "
              "recognized. Needs human recon of the request page (see screenshot).")
        sys.exit(3)
    print(f"[download] {len(saved)} file(s) -> {dest}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--action", required=True, choices=["recon", "fill", "submit", "download"])
    ap.add_argument("--base", default="https://austinisd.govqa.us")
    ap.add_argument("--rid", required=True)
    ap.add_argument("--dest", help="download destination dir (for --action download)")
    ap.add_argument("--reply-file")
    ap.add_argument("--reply-selector")
    ap.add_argument("--submit-selector")
    ap.add_argument("--shot", default="/tmp/govqa_recon.png")
    ap.add_argument("--click-first")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        page = get_page(browser)
        login(page, args.base)
        open_request(page, args.base, args.rid)

        if args.action == "recon":
            recon(page, args.shot, click_first=args.click_first)
        elif args.action == "download":
            if not args.dest:
                print("FATAL: --dest is required for --action download")
                sys.exit(2)
            download(page, args.dest, args.shot)
        else:
            # open the compose form via "New Message"
            try:
                page.locator("#btnRespond_I").click(timeout=5000)
            except Exception:
                page.locator("#btnRespond_I").dispatch_event("click")
            for st in ("domcontentloaded", "networkidle"):
                try:
                    page.wait_for_load_state(st, timeout=60000)
                except Exception:
                    pass
            page.wait_for_timeout(9000)  # Dallas compose form renders slowly
            page.wait_for_selector(args.reply_selector, timeout=30000, state="visible")
            print("[compose] url:", page.url)
            reply = open(args.reply_file).read().strip()
            page.fill(args.reply_selector, reply)
            page.wait_for_timeout(800)
            # verify the field actually holds the full text
            got = page.locator(args.reply_selector).input_value()
            print(f"[compose] field length filled: {len(got)} chars (expected {len(reply)})")
            page.screenshot(path=args.shot, full_page=True)
            print("filled; screenshot:", args.shot)
            if args.action == "submit":
                sbtn = page.locator(args.submit_selector)
                try:
                    sbtn.click(timeout=5000)
                except Exception:
                    sbtn.dispatch_event("click")  # DevExpress child span intercepts pointer
                for st in ("domcontentloaded", "networkidle"):
                    try:
                        page.wait_for_load_state(st, timeout=60000)
                    except Exception:
                        pass
                page.wait_for_timeout(3000)
                page.screenshot(path=args.shot.replace(".png", "_after.png"), full_page=True)
                print("submitted; url:", page.url)


if __name__ == "__main__":
    main()
