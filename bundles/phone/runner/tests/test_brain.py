import json
import httpx
from crow_phone.brain import OpenAIBrain, TOOLS


def mk(handler):
    return OpenAIBrain("http://x/v1", "k", "m", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def completion(msg):
    return httpx.Response(200, json={"choices": [{"message": msg}]})


async def test_reply_body_and_tool_call_parsing():
    bodies = []
    def h(req):
        bodies.append(json.loads(req.content))
        return completion({"content": "hi", "tool_calls": [{"function": {"name": "press_digits", "arguments": '{"digits":"2"}'}}]})
    r = await mk(h).reply([{"role": "user", "content": "x"}], TOOLS)
    b = bodies[0]
    assert b["chat_template_kwargs"]["enable_thinking"] is False and b["tools"] == TOOLS and b["model"] == "m"
    assert r.text == "hi" and r.tool_calls[0].name == "press_digits" and r.tool_calls[0].args == {"digits": "2"}


async def test_invalid_or_non_dict_arguments_become_empty():
    for bad in ("{not json", "[1]", '"s"'):
        r = await mk(lambda req, bad=bad: completion({"content": None, "tool_calls": [{"function": {"name": "end_call", "arguments": bad}}]})).reply([], TOOLS)
        assert r.tool_calls[0].args == {}


async def test_warmup_sends_max_tokens_1():
    bodies = []
    def h(req):
        bodies.append(json.loads(req.content))
        return completion({"content": "ok"})
    assert await mk(h).warmup("sys", TOOLS) is True
    assert bodies[0]["max_tokens"] == 1
