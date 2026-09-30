import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


class EventLog:
    """Per-call append-only event log, persisted so the gateway can re-pull after restarts."""

    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA busy_timeout=5000")
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS events (call_id TEXT, seq INTEGER, type TEXT, data TEXT, at TEXT, PRIMARY KEY (call_id, seq))"
            )
            self._db.commit()

    def append(self, call_id: str, type_: str, data: dict) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT COALESCE(MAX(seq), 0) FROM events WHERE call_id = ?", (call_id,)
            ).fetchone()
            seq = row[0] + 1
            self._db.execute(
                "INSERT INTO events (call_id, seq, type, data, at) VALUES (?, ?, ?, ?, ?)",
                (
                    call_id,
                    seq,
                    type_,
                    json.dumps(data),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            self._db.commit()
            return seq

    def since(self, call_id: str, seq: int) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT seq, type, data, at FROM events WHERE call_id = ? AND seq > ? ORDER BY seq",
                (call_id, int(seq)),
            ).fetchall()
        return [
            {"seq": s, "type": t, "data": json.loads(d), "at": a} for s, t, d, a in rows
        ]

    def done(self, call_id: str) -> bool:
        with self._lock:
            return (
                self._db.execute(
                    "SELECT 1 FROM events WHERE call_id = ? AND type = 'result' LIMIT 1",
                    (call_id,),
                ).fetchone()
                is not None
            )
