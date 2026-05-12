"""
Generalized bootstrap of bot/<id> + bot/<id>/processed Gmail labels and the
to:kevin.hopper+<id>@maestro.press routing filter. Idempotent on labels;
filters are created unconditionally so re-running may produce duplicates
(Gmail filter API has no upsert).
"""
import asyncio, json, os, sys

os.environ["GOOGLE_CREDENTIALS_FILE"] = "/home/kh0pp/.config/google-workspace-mcp-mpa/credentials.json"
os.environ["GOOGLE_TOKEN_FILE"] = "/home/kh0pp/.config/google-workspace-mcp-mpa/gws-token.json"
sys.path.insert(0, "/home/kh0pp/spring-2026/google-workspace-mcp")

from src import gmail

BOT_IDS = sys.argv[1:] or ["job-search", "pir-management"]

async def setup_one(bot_id):
    alias = f"kevin.hopper+{bot_id}@maestro.press"
    parent = await gmail.gmail_create_label(f"bot/{bot_id}")
    child = await gmail.gmail_create_label(f"bot/{bot_id}/processed")
    flt = await gmail.gmail_create_filter(to_address=alias, add_labels=[f"bot/{bot_id}"])
    return {"bot_id": bot_id, "alias": alias, "parent_label": parent, "processed_label": child, "filter": flt}

async def main():
    results = []
    for bot_id in BOT_IDS:
        print(f"\n=== {bot_id} ===")
        r = await setup_one(bot_id)
        results.append(r)
        print(json.dumps(r, indent=2))
    print("\n=== summary ===")
    for r in results:
        bid = r["bot_id"]
        flt_id = r["filter"].get("data", {}).get("id", "(err)")
        parent_id = r["parent_label"].get("data", {}).get("id", "(err)")
        processed_id = r["processed_label"].get("data", {}).get("id", "(err)")
        print(f"  {bid:20s}  parent={parent_id:10s}  processed={processed_id:10s}  filter={flt_id}")

asyncio.run(main())
