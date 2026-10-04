import asyncio
import time
from fastapi.testclient import TestClient
from crow_phone.app import make_app
from crow_phone.brain import ScriptedBrain, BrainReply
from crow_phone.markup import ToolCall
from crow_phone.line import InteractiveFakeLine

H = {"Authorization": "Bearer s3cret"}
PLAN = {
    "business_name": "Smile Dental",
    "number_e164": "+15125550101",
    "goal": "Ask opening hours",
    "language": "en",
    "limits": {},
    "shareable": {},
    "notes": None,
}


def body(call_id="c1"):
    return {
        "call_id": call_id,
        "token": "t",
        "owner_name": "Casey",
        "line": "interactive",
        "plan": PLAN,
        "model": {"base_url": "http://m", "api_key": "k", "model": "x"},
    }


class FailingWarmup(ScriptedBrain):
    async def warmup(self, system, tools):
        raise RuntimeError("model down")


def app_with(tmp_path, brain=None, verified=True):
    async def ok():
        return verified

    return make_app(
        secret="s3cret",
        data_dir=tmp_path,
        brain_factory=lambda m: (
            brain
            or ScriptedBrain(
                [
                    BrainReply("What are your opening hours on Saturday?"),
                    BrainReply(
                        "",
                        [
                            ToolCall(
                                "end_call",
                                {"outcome": "info_gathered", "summary": "Sat 9-1"},
                            )
                        ],
                    ),
                ]
            )
        ),
        verify_factory=lambda cid, tok: ok,
        line_factory=lambda kind: InteractiveFakeLine(),
    )


def wait_for(client, call_id, pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        ev = client.get(f"/calls/{call_id}/events?since=0", headers=H).json()
        if pred(ev):
            return ev
        time.sleep(0.05)
    raise AssertionError("timed out waiting for events")


def test_auth_required(tmp_path):
    with TestClient(app_with(tmp_path)) as c:
        assert c.get("/health").status_code == 200
        assert c.post("/calls/c1/start", json=body()).status_code == 401
        assert c.get("/calls/c1/events?since=0").status_code == 401


def test_full_interactive_call(tmp_path):
    with TestClient(app_with(tmp_path)) as c:
        assert (
            c.post("/calls/c1/start", json=body(), headers=H).json()["started"] is True
        )
        assert (
            c.post("/calls/c1/start", json=body(), headers=H).status_code == 409
        )  # one call at a time
        wait_for(
            c,
            "c1",
            lambda ev: any(
                e["type"] == "state" and e["data"]["state"] == "answered"
                for e in ev["events"]
            ),
        )
        c.post(
            "/calls/c1/farend",
            json={"text": "Smile Dental, how can I help?"},
            headers=H,
        )
        wait_for(
            c,
            "c1",
            lambda ev: any(
                e["type"] == "agent" and "Saturday" in e["data"]["text"]
                for e in ev["events"]
            ),
        )
        c.post("/calls/c1/farend", json={"text": "Saturdays 9 to 1."}, headers=H)
        ev = wait_for(c, "c1", lambda ev: ev["done"])
        types = [e["type"] for e in ev["events"]]
        assert types.index("agent") < types.index("result")
        result = [e for e in ev["events"] if e["type"] == "result"][0]["data"]
        assert result["outcome"] == "info_gathered"
        first_agent = [e for e in ev["events"] if e["type"] == "agent"][0]["data"][
            "text"
        ]
        assert first_agent.startswith("Hi, I'm an automated assistant")
        since = ev["events"][-1]["seq"]
        assert (
            c.get(f"/calls/c1/events?since={since}", headers=H).json()["events"] == []
        )


def test_warmup_failure_is_not_admissible(tmp_path):
    with TestClient(app_with(tmp_path, brain=FailingWarmup([]))) as c:
        assert c.post("/calls/c2/start", json=body("c2"), headers=H).json()["started"] is True
        ev = wait_for(c, "c2", lambda ev: ev["done"])
        assert ev["events"][-1]["data"]["outcome"] == "not_admissible"


class SlowWarmup(ScriptedBrain):
    async def warmup(self, system, tools):
        await asyncio.sleep(0.2)


def test_back_to_back_starts_second_is_409(tmp_path):
    with TestClient(app_with(tmp_path, brain=SlowWarmup([]))) as c:
        assert c.post("/calls/s1/start", json=body("s1"), headers=H).status_code == 200
        assert c.post("/calls/s2/start", json=body("s2"), headers=H).status_code == 409


def test_auth_variants(tmp_path):
    with TestClient(app_with(tmp_path)) as c:
        assert c.get("/calls/c1/events?since=0", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert c.post("/calls/c1/stop").status_code == 401
        assert c.post("/calls/c1/farend", json={"text": "x"}).status_code == 401
    app = make_app(secret="", data_dir=tmp_path / "e")
    with TestClient(app) as c:
        assert c.get("/calls/c1/events?since=0", headers={"Authorization": "Bearer "}).status_code == 401


def test_restart_of_existing_call_id_is_409(tmp_path):
    with TestClient(app_with(tmp_path, brain=FailingWarmup([]))) as c:
        c.post("/calls/d1/start", json=body("d1"), headers=H)
        wait_for(c, "d1", lambda ev: ev["done"])
        assert c.post("/calls/d1/start", json=body("d1"), headers=H).status_code == 409


def test_rejected_token_never_dials(tmp_path):
    with TestClient(app_with(tmp_path, verified=False)) as c:
        c.post("/calls/c3/start", json=body("c3"), headers=H)
        ev = wait_for(c, "c3", lambda ev: ev["done"])
        assert ev["events"][-1]["data"]["outcome"] == "failed"
        assert not any(
            e["type"] == "state" and e["data"]["state"] == "dialing"
            for e in ev["events"]
        )


def test_stop_is_immediate(tmp_path):
    with TestClient(app_with(tmp_path)) as c:
        c.post("/calls/c4/start", json=body("c4"), headers=H)
        wait_for(
            c,
            "c4",
            lambda ev: any(
                e["type"] == "state" and e["data"]["state"] == "answered"
                for e in ev["events"]
            ),
        )
        t0 = time.time()
        c.post("/calls/c4/stop", headers=H)
        ev = wait_for(c, "c4", lambda ev: ev["done"], timeout=3)
        assert time.time() - t0 < 2
        assert ev["events"][-1]["data"]["error"] == "stopped by owner"
        assert ev["events"][-1]["data"]["outcome"] == "stopped"


def test_controller_crash_still_emits_result(tmp_path):
    class Boom(ScriptedBrain):
        async def reply(self, messages, tools):
            raise RuntimeError("model 500")

    with TestClient(app_with(tmp_path, brain=Boom([]))) as c:
        c.post("/calls/c5/start", json=body("c5"), headers=H)
        wait_for(
            c,
            "c5",
            lambda ev: any(
                e["type"] == "state" and e["data"]["state"] == "answered"
                for e in ev["events"]
            ),
        )
        c.post("/calls/c5/farend", json={"text": "Hello?"}, headers=H)
        ev = wait_for(c, "c5", lambda ev: ev["done"])
        assert ev["events"][-1]["data"]["outcome"] == "failed"


def test_restart_closes_unfinished_calls(tmp_path):
    from crow_phone.events import EventLog
    log = EventLog(tmp_path / "events.db")
    log.append("orphan", "state", {"state": "dialing"})
    log.append("finished", "state", {"state": "dialing"})
    log.append("finished", "result", {"outcome": "info_gathered"})
    with TestClient(app_with(tmp_path)) as c:
        ev = c.get("/calls/orphan/events?since=0", headers=H).json()
        assert ev["done"] is True and ev["active"] is False
        res = [e for e in ev["events"] if e["type"] == "result"]
        assert len(res) == 1 and res[0]["data"]["outcome"] == "failed" and res[0]["data"]["error"] == "runner restarted"
        fin = c.get("/calls/finished/events?since=0", headers=H).json()
        assert [e["type"] for e in fin["events"]].count("result") == 1
    # a second restart does not append another result
    with TestClient(app_with(tmp_path)) as c:
        ev = c.get("/calls/orphan/events?since=0", headers=H).json()
        assert [e["type"] for e in ev["events"]].count("result") == 1


def test_events_report_active_only_for_the_running_call(tmp_path):
    with TestClient(app_with(tmp_path)) as c:
        unknown = c.get("/calls/nope/events?since=0", headers=H).json()
        assert unknown == {"events": [], "done": False, "active": False}
        assert c.post("/calls/c1/start", json=body(), headers=H).status_code == 200
        live = c.get("/calls/c1/events?since=0", headers=H).json()
        assert live["active"] is True and live["done"] is False
        c.post("/calls/c1/stop", headers=H)
        ev = wait_for(c, "c1", lambda e: e["done"])
        assert ev["active"] is False
