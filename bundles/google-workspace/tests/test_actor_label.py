"""Tests for the bot actor label on Drive comments and replies.

Run with:
    python -m unittest discover -s tests -v
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.types import RequestParams  # noqa: E402

from google_workspace_mcp import comments  # noqa: E402
from google_workspace_mcp.actor_label import label_text, resolve_actor  # noqa: E402

BOT = {"kind": "bot", "id": "b1", "name": "hank"}
PREFIX = "\U0001F916 hank (bot): "


class LabelTextTests(unittest.TestCase):
    def test_bot_actor_prefixes(self):
        self.assertEqual(label_text("hi", BOT), PREFIX + "hi")

    def test_no_actor_unchanged(self):
        self.assertEqual(label_text("hi", None), "hi")

    def test_not_doubled(self):
        self.assertEqual(label_text(PREFIX + "hi", BOT), PREFIX + "hi")

    def test_empty_text_unchanged(self):
        self.assertEqual(label_text("", BOT), "")


class ResolveActorTests(unittest.TestCase):
    def test_env_bot(self):
        env = {"CROW_ACTOR_KIND": "bot", "CROW_ACTOR_BOT_ID": "b1", "CROW_ACTOR_BOT_NAME": "hank"}
        self.assertEqual(resolve_actor(env, None), BOT)

    def test_name_sanitized_of_newline_and_bidi(self):
        env = {"CROW_ACTOR_KIND": "bot", "CROW_ACTOR_BOT_ID": "b1",
               "CROW_ACTOR_BOT_NAME": "ha\nnk‮​ "}
        self.assertEqual(resolve_actor(env, None)["name"], "hank")
        self.assertEqual(label_text("x", resolve_actor(env, None)), PREFIX + "x")

    def test_name_capped_and_falls_back_to_id(self):
        env = {"CROW_ACTOR_KIND": "bot", "CROW_ACTOR_BOT_ID": "b1", "CROW_ACTOR_BOT_NAME": "a" * 60}
        self.assertEqual(len(resolve_actor(env, None)["name"]), 40)
        env["CROW_ACTOR_BOT_NAME"] = "\n​"
        self.assertEqual(resolve_actor(env, None)["name"], "b1")

    def test_env_wins_over_meta(self):
        env = {"CROW_ACTOR_KIND": "bot", "CROW_ACTOR_BOT_ID": "e", "CROW_ACTOR_BOT_NAME": "envbot"}
        meta = RequestParams.Meta(**{"crow/actor": {"kind": "bot", "id": "m", "name": "metabot"}})
        self.assertEqual(resolve_actor(env, meta)["name"], "envbot")

    def test_meta_bot_from_real_meta_object(self):
        meta = RequestParams.Meta(**{"crow/actor": {"kind": "bot", "id": "m", "name": "alex"}})
        self.assertEqual(resolve_actor({}, meta), {"kind": "bot", "id": "m", "name": "alex"})

    def test_meta_owner_ignored(self):
        meta = RequestParams.Meta(**{"crow/actor": {"kind": "owner", "name": "someone"}})
        self.assertIsNone(resolve_actor({}, meta))

    def test_no_sources(self):
        self.assertIsNone(resolve_actor({}, None))
        self.assertIsNone(resolve_actor({}, RequestParams.Meta()))
        self.assertIsNone(resolve_actor({}, {"crow/actor": "junk"}))


def _fake_drive(comment=None):
    drive = mock.MagicMock()
    drive.comments().create().execute.return_value = {"id": "c1", "content": ""}
    drive.replies().create().execute.return_value = {"id": "r1", "content": ""}
    drive.comments().get().execute.return_value = comment or {}
    return drive


def _sent_bodies(drive, kind):
    fn = getattr(drive, kind)().create
    return [c.kwargs["body"] for c in fn.call_args_list if "body" in c.kwargs]


class WriteSiteTests(unittest.TestCase):
    def run_with(self, drive, coro_fn):
        with mock.patch.object(comments, "get_drive_service", return_value=drive):
            return asyncio.run(coro_fn())

    def test_add_comment_labelled(self):
        d = _fake_drive()
        self.run_with(d, lambda: comments.gdocs_add_comment("f", "note", actor=BOT))
        self.assertEqual(_sent_bodies(d, "comments")[-1]["content"], PREFIX + "note")

    def test_add_comment_unlabelled_without_actor(self):
        d = _fake_drive()
        self.run_with(d, lambda: comments.gdocs_add_comment("f", "note"))
        self.assertEqual(_sent_bodies(d, "comments")[-1]["content"], "note")

    def test_reply_labelled(self):
        d = _fake_drive()
        self.run_with(d, lambda: comments.gdocs_reply_comment("f", "c", "ok", actor=BOT))
        self.assertEqual(_sent_bodies(d, "replies")[-1]["content"], PREFIX + "ok")

    def test_resolve_left_alone(self):
        d = _fake_drive()
        self.run_with(d, lambda: comments.gdocs_resolve_comment("f", "c"))
        self.assertEqual(_sent_bodies(d, "replies")[-1], {"content": "", "action": "resolve"})

    def _apply(self, d, docs_res, actor):
        docs = mock.MagicMock()
        docs.documents().batchUpdate().execute.return_value = docs_res
        with mock.patch("google_workspace_mcp.auth.get_docs_service", return_value=docs):
            return self.run_with(
                d, lambda: comments.gdocs_apply_comment_edit("f", "c", "new", "did it", actor=actor)
            )

    def test_apply_edit_summary_labelled_resolve_untouched(self):
        d = _fake_drive({"quotedFileContent": {"value": "old"}, "resolved": False})
        self._apply(d, {"replies": [{"replaceAllText": {"occurrencesChanged": 1}}]}, BOT)
        bodies = _sent_bodies(d, "replies")[-2:]
        self.assertEqual(bodies[0]["content"], PREFIX + "did it")
        self.assertEqual(bodies[1], {"content": "", "action": "resolve"})

    def test_apply_edit_failure_reply_labelled(self):
        d = _fake_drive({"quotedFileContent": {"value": "old"}, "resolved": False})
        self._apply(d, {"replies": [{"replaceAllText": {"occurrencesChanged": 0}}]}, BOT)
        content = _sent_bodies(d, "replies")[-1]["content"]
        self.assertTrue(content.startswith(PREFIX + "I could not locate"))

    def test_apply_edit_unlabelled_without_actor(self):
        d = _fake_drive({"quotedFileContent": {"value": "old"}, "resolved": False})
        self._apply(d, {"replies": [{"replaceAllText": {"occurrencesChanged": 1}}]}, None)
        self.assertEqual(_sent_bodies(d, "replies")[-2]["content"], "did it")


if __name__ == "__main__":
    unittest.main()
