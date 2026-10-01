from crow_phone.events import EventLog


def test_append_since_done_and_persistence(tmp_path):
    p = tmp_path / "events.db"
    log = EventLog(p)
    assert log.append("c1", "farend", {"text": "Hi"}) == 1
    assert log.append("c1", "agent", {"text": "Hello"}) == 2
    assert log.append("c2", "farend", {"text": "x"}) == 1
    assert [e["seq"] for e in log.since("c1", 0)] == [1, 2]
    assert [e["seq"] for e in log.since("c1", 1)] == [2]
    assert not log.done("c1")
    log.append("c1", "result", {"outcome": "info_gathered"})
    assert log.done("c1")
    again = EventLog(p)  # survives a runner restart
    assert [e["type"] for e in again.since("c1", 0)] == ["farend", "agent", "result"]
