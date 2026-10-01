import asyncio
import hmac
import os
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from .brain import TOOLS, OpenAIBrain, system_prompt
from .controller import CallController
from .events import EventLog
from .line import InteractiveFakeLine


class StartBody(BaseModel):
    call_id: str
    token: str
    owner_name: str = ""
    line: str = "interactive"
    plan: dict
    model: dict


class FarendBody(BaseModel):
    text: str


def make_app(
    secret=None,
    data_dir=None,
    brain_factory=None,
    verify_factory=None,
    line_factory=None,
) -> FastAPI:
    secret = secret if secret is not None else os.environ.get("PHONE_RUNNER_SECRET", "")
    data_dir = Path(data_dir or os.environ.get("PHONE_DATA_DIR", "/data"))
    gateway = os.environ.get(
        "PHONE_GATEWAY_URL", "http://127.0.0.1:3001"
    ).rstrip("/")
    log = EventLog(data_dir / "events.db")
    # A call that was running when the runner died can never finish now: close it
    # so the gateway stops waiting on it (it would otherwise hold the slot).
    for orphan in log.unfinished():
        log.append(
            orphan,
            "result",
            {"outcome": "failed", "booking": None, "summary": "", "do_not_call": False, "error": "runner restarted"},
        )
    app = FastAPI(title="crow-phone-runner")
    state = {"task": None, "ctrl": None, "line": None, "call_id": None}

    def auth(authorization: str = Header(default="")):
        if not secret or not hmac.compare_digest(authorization.encode(), f"Bearer {secret}".encode()):
            raise HTTPException(status_code=401, detail="unauthorized")

    def default_verify_factory(call_id, token):
        async def verify():
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(
                    f"{gateway}/api/phone/verify",
                    json={"call_id": call_id, "token": token},
                    headers={"Authorization": f"Bearer {secret}"},
                )
                return r.status_code == 200 and r.json().get("ok") is True

        return verify

    brain_factory = brain_factory or (
        lambda m: OpenAIBrain(m["base_url"], m.get("api_key") or "none", m["model"])
    )
    verify_factory = verify_factory or default_verify_factory
    line_factory = line_factory or (lambda kind: InteractiveFakeLine())

    def busy():
        return state["task"] is not None and not state["task"].done()

    async def run_safe(call_id, ctrl, line):
        try:
            await ctrl.run()
        except Exception as e:  # never leave a call without a result
            if not log.done(call_id):
                log.append(
                    call_id,
                    "result",
                    {
                        "outcome": "failed",
                        "booking": None,
                        "summary": "",
                        "do_not_call": False,
                        "error": f"runner error: {e}",
                    },
                )
            try:
                await line.hangup()
            except Exception:
                pass

    async def run_call(call_id, ctrl, line, brain, body):
        try:
            await brain.warmup(system_prompt(body.plan, body.owner_name), TOOLS)
        except Exception as e:
            log.append(
                call_id,
                "result",
                {
                    "outcome": "not_admissible",
                    "booking": None,
                    "summary": "",
                    "do_not_call": False,
                    "error": f"model warm-up failed: {e}",
                },
            )
            return
        await run_safe(call_id, ctrl, line)

    @app.get("/health")
    async def health():
        return {"ok": True, "busy": busy()}

    @app.post("/calls/{call_id}/start", dependencies=[Depends(auth)])
    async def start(call_id: str, body: StartBody):
        if body.call_id != call_id:
            raise HTTPException(400, "call_id mismatch")
        if busy():
            raise HTTPException(409, "a call is already running")
        if log.since(call_id, 0):
            raise HTTPException(409, "call already started")
        brain = brain_factory(body.model)
        line = line_factory(body.line)
        ctrl = CallController(
            call_id,
            body.plan,
            body.owner_name,
            line,
            brain,
            lambda t, d: log.append(call_id, t, d),
            verify_factory(call_id, body.token),
        )
        state.update(
            ctrl=ctrl,
            line=line,
            call_id=call_id,
            task=asyncio.create_task(run_call(call_id, ctrl, line, brain, body)),
        )
        return {"ok": True, "started": True}

    @app.post("/calls/{call_id}/stop", dependencies=[Depends(auth)])
    async def stop(call_id: str):
        if state["call_id"] == call_id and busy():
            state["ctrl"].request_stop()
        return {"ok": True}

    @app.post("/calls/{call_id}/farend", dependencies=[Depends(auth)])
    async def farend(call_id: str, body: FarendBody):
        if (
            state["call_id"] != call_id
            or not busy()
            or not hasattr(state["line"], "push")
        ):
            raise HTTPException(409, "no interactive call running")
        state["line"].push(body.text[:1000])
        return {"ok": True}

    @app.get("/calls/{call_id}/events", dependencies=[Depends(auth)])
    async def events(call_id: str, since: int = 0):
        done = log.done(call_id)
        active = state["call_id"] == call_id and busy() and not done
        return {"events": log.since(call_id, since), "done": done, "active": active}

    return app
