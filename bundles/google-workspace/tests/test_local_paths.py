"""GWS_FILES_DIR, and the folders no local path may ever touch (local_paths.py).

The point of every refusal below: the path is decided BEFORE any Google client is
built, so a refused local path makes no API call at all — and the sign-in folder
(the OAuth token and credentials), ~/.ssh and ~/.gnupg are refused whatever else is
configured. The service objects are mocks, so nothing leaves the process.

Every scratch path lives under a temporary folder; the tests that go through the
tools point HOME and the two sign-in variables at it too, so no real home path is
ever resolved, let alone read.

Run with:
    python -m unittest discover -s tests -v
"""

import asyncio
import contextlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from googleapiclient.http import MediaIoBaseUpload  # noqa: E402

from google_workspace_mcp import docs as docs_mod  # noqa: E402
from google_workspace_mcp import drive, local_paths, slides  # noqa: E402

FOLDER = "folder-1"
TOKEN_NAME = "token.json"
CREDENTIALS_NAME = "credentials.json"


# --- fixtures --------------------------------------------------------------


@contextlib.contextmanager
def scratch():
    """A scratch home with a files folder, a sign-in folder and a file outside both.

    ``home/files`` is the files folder, ``home/.config/google-workspace-mcp`` holds
    the token and credentials, ``home/elsewhere`` is a plain folder the tools may
    reach only with no files folder set (the pre-existing behaviour), and
    ``home/.ssh`` / ``home/.gnupg`` exist so the always-refused rules can be tested.
    """
    with tempfile.TemporaryDirectory() as tmp:
        home = os.path.realpath(tmp)
        files = os.path.join(home, "files")
        signin = os.path.join(home, ".config", "google-workspace-mcp")
        elsewhere = os.path.join(home, "elsewhere")
        for path in (
            files,
            signin,
            elsewhere,
            os.path.join(home, ".ssh"),
            os.path.join(home, ".gnupg"),
        ):
            os.makedirs(path, exist_ok=True)
        token = os.path.join(signin, TOKEN_NAME)
        credentials = os.path.join(signin, CREDENTIALS_NAME)
        for path in (token, credentials):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"installed": "client"}')
        with open(os.path.join(elsewhere, "note.txt"), "w", encoding="utf-8") as fh:
            fh.write("outside")
        with open(os.path.join(home, ".ssh", "id_ed25519"), "w", encoding="utf-8") as fh:
            fh.write("k")
        with open(os.path.join(home, ".gnupg", "pubring.gpg"), "w", encoding="utf-8") as fh:
            fh.write("k")
        yield {
            "home": home,
            "files": files,
            "signin": signin,
            "token": token,
            "credentials": credentials,
            "elsewhere": elsewhere,
        }


def env_for(paths, **values):
    """A hermetic env mapping: the scratch tree, no ambient guard, no real paths.

    ``home`` is passed separately to every call (``local_paths`` takes both), so the
    ``~`` this module expands is the scratch home and never the process owner's.
    """
    env = {
        "GOOGLE_TOKEN_FILE": paths["token"],
        "GOOGLE_CREDENTIALS_FILE": paths["credentials"],
    }
    for key, value in values.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def resolve(paths, target, mode=local_paths.READ, what="this tool call", **values):
    return local_paths.resolve(
        target, mode, what, env=env_for(paths, **values), home=paths["home"]
    )


def open_read(paths, target, what="reading a local file", **values):
    return local_paths.open_read(
        target, what, env=env_for(paths, **values), home=paths["home"]
    )


def open_write(paths, target, what="writing a local file", **values):
    return local_paths.open_write(
        target, what, env=env_for(paths, **values), home=paths["home"]
    )


def default_path(paths, ident, extension, **values):
    return local_paths.default_path(
        ident, extension, env=env_for(paths, **values), home=paths["home"]
    )


@contextlib.contextmanager
def tool_env(paths, **values):
    """Pin the process env for a test that goes through a tool (it reads os.environ)."""
    pinned = {"GWS_FILES_DIR": "", "GWS_OUTBOUND_GUARD": ""}
    pinned.update(
        {
            "HOME": paths["home"],
            "GOOGLE_TOKEN_FILE": paths["token"],
            "GOOGLE_CREDENTIALS_FILE": paths["credentials"],
        }
    )
    with mock.patch.dict(os.environ, pinned):
        os.environ.update({k: v for k, v in values.items() if v is not None})
        yield


def write_file(path, data=b"x"):
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def png_bytes(width=16, height=9):
    """A PNG header with a readable width/height."""
    return (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
    )


# --- the three rules -------------------------------------------------------


class InsideTheFolderTests(unittest.TestCase):
    def test_a_file_in_the_folder_is_allowed_for_reading(self):
        with scratch() as paths:
            target = write_file(os.path.join(paths["files"], "note.txt"), b"hello")
            env = env_for(paths, GWS_FILES_DIR=paths["files"])
            self.assertEqual(
                local_paths.files_dir(env, home=paths["home"]),
                os.path.realpath(paths["files"]),
            )
            self.assertEqual(
                resolve(paths, target, GWS_FILES_DIR=paths["files"]),
                os.path.realpath(target),
            )

    def test_a_new_file_in_the_folder_is_created_at_mode_0600(self):
        with scratch() as paths:
            real, handle = open_write(
                paths,
                os.path.join(paths["files"], "out.pdf"),
                GWS_FILES_DIR=paths["files"],
            )
            try:
                handle.write(b"pdf")
            finally:
                handle.close()
            self.assertEqual(
                real, os.path.join(os.path.realpath(paths["files"]), "out.pdf")
            )
            with open(real, "rb") as fh:
                self.assertEqual(fh.read(), b"pdf")
            self.assertEqual(os.stat(real).st_mode & 0o777, 0o600, "created private")

    def test_a_relative_path_is_relative_to_the_folder(self):
        with scratch() as paths:
            write_file(os.path.join(paths["files"], "note.txt"))
            self.assertEqual(
                resolve(paths, "note.txt", GWS_FILES_DIR=paths["files"]),
                os.path.join(os.path.realpath(paths["files"]), "note.txt"),
            )

    def test_a_leading_tilde_is_the_home_this_module_was_given(self):
        with scratch() as paths:
            self.assertEqual(
                resolve(paths, "~/elsewhere/note.txt"),
                os.path.realpath(os.path.join(paths["elsewhere"], "note.txt")),
            )


class OutsideTheFolderTests(unittest.TestCase):
    def test_a_dot_dot_escape_is_refused(self):
        with scratch() as paths:
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(
                    paths,
                    os.path.join(paths["files"], "..", "elsewhere", "note.txt"),
                    what="uploading a local file",
                    GWS_FILES_DIR=paths["files"],
                )
            self.assertIn("files folder", str(caught.exception))
            self.assertIn("GWS_FILES_DIR", str(caught.exception))

    def test_an_absolute_path_elsewhere_is_refused(self):
        with scratch() as paths:
            for outside in (os.path.join(paths["elsewhere"], "note.txt"), "/etc/hostname"):
                with self.subTest(path=outside):
                    with self.assertRaises(local_paths.PathRefused):
                        resolve(paths, outside, GWS_FILES_DIR=paths["files"])

    def test_the_folder_itself_is_not_a_file(self):
        with scratch() as paths:
            with self.assertRaises(local_paths.PathRefused):
                resolve(paths, paths["files"], local_paths.WRITE, GWS_FILES_DIR=paths["files"])

    def test_a_symlink_pointing_out_of_the_folder_is_refused(self):
        with scratch() as paths:
            link = os.path.join(paths["files"], "link.txt")
            os.symlink(os.path.join(paths["elsewhere"], "note.txt"), link)
            with self.assertRaises(local_paths.PathRefused):
                open_read(paths, link, GWS_FILES_DIR=paths["files"])
            with self.assertRaises(local_paths.PathRefused):
                open_write(paths, link, GWS_FILES_DIR=paths["files"])

    def test_a_symlink_to_the_token_file_is_refused_even_inside_the_folder(self):
        with scratch() as paths:
            # The files folder is the home here, so the token file is "inside" it and
            # is still refused: the sign-in folder outranks the folder grant.
            link = os.path.join(paths["home"], "innocent.png")
            os.symlink(paths["token"], link)
            with self.assertRaises(local_paths.PathRefused) as caught:
                open_read(paths, link, GWS_FILES_DIR=paths["home"])
            self.assertIn("sign-in folder", str(caught.exception))


class AlwaysRefusedTests(unittest.TestCase):
    def test_the_token_folder_is_refused_with_the_guard_off_and_no_files_folder(self):
        with scratch() as paths:
            for target in (
                paths["token"],
                paths["credentials"],
                os.path.join(paths["signin"], "anything.txt"),
            ):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(
                            paths,
                            target,
                            what="uploading a local file",
                        )
                    self.assertIn("sign-in folder", str(caught.exception))
                    self.assertIn("GWS_FILES_DIR", str(caught.exception))

    def test_a_sibling_signin_folder_is_refused_too(self):
        with scratch() as paths:
            sibling = os.path.join(paths["home"], ".config", "google-workspace-mcp-old")
            os.makedirs(sibling, exist_ok=True)
            target = write_file(os.path.join(sibling, "token.json"), b"{}")
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(paths, target)
            self.assertIn("sign-in folder", str(caught.exception))

    def test_ssh_and_gnupg_are_refused(self):
        with scratch() as paths:
            for target in (
                os.path.join(paths["home"], ".ssh", "id_ed25519"),
                os.path.join(paths["home"], ".gnupg", "pubring.gpg"),
            ):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target)
                    self.assertIn("never reads or writes", str(caught.exception))

    def test_the_signin_folder_wins_over_a_files_folder_that_contains_it(self):
        with scratch() as paths:
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(paths, paths["token"], GWS_FILES_DIR=paths["home"])
            self.assertIn("sign-in folder", str(caught.exception))

    def test_a_protected_folder_that_cannot_be_resolved_refuses_everything(self):
        with scratch() as paths:
            # A symlink loop where the sign-in folder should be: the check is blind,
            # so it must fail closed rather than allow the path.
            loop = os.path.join(paths["home"], "loop")
            os.symlink(loop, loop)
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(
                    paths,
                    os.path.join(paths["elsewhere"], "note.txt"),
                    GOOGLE_TOKEN_FILE=os.path.join(loop, "token.json"),
                )
            self.assertIn("cannot be resolved", str(caught.exception))

    def test_a_files_folder_that_cannot_be_resolved_refuses_rather_than_falling_back(self):
        with scratch() as paths:
            loop = os.path.join(paths["home"], "loop")
            os.symlink(loop, loop)
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(
                    paths,
                    os.path.join(paths["elsewhere"], "note.txt"),
                    GWS_FILES_DIR=loop,
                )
            self.assertIn("cannot be resolved", str(caught.exception))


class GuardWithoutAFolderTests(unittest.TestCase):
    def test_the_guard_on_refuses_every_local_path_with_no_files_folder(self):
        with scratch() as paths:
            for target in (
                os.path.join(paths["elsewhere"], "note.txt"),
                os.path.join(paths["files"], "note.txt"),
                "/tmp/whatever.txt",
            ):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(
                            paths,
                            target,
                            what="uploading a local file",
                            GWS_OUTBOUND_GUARD="1",
                        )
                    self.assertIn("GWS_FILES_DIR", str(caught.exception))
                    self.assertIn("no files folder", str(caught.exception))

    def test_the_guard_off_keeps_the_old_behaviour_for_a_normal_path(self):
        with scratch() as paths:
            target = os.path.join(paths["elsewhere"], "note.txt")
            self.assertEqual(
                resolve(paths, target), os.path.realpath(target)
            )
            real, handle = open_read(paths, target)
            try:
                self.assertEqual(handle.read(), b"outside")
            finally:
                handle.close()

    def test_a_files_folder_wins_over_the_guard_off_legacy_behaviour(self):
        with scratch() as paths:
            with self.assertRaises(local_paths.PathRefused):
                resolve(
                    paths,
                    os.path.join(paths["elsewhere"], "note.txt"),
                    GWS_FILES_DIR=paths["files"],
                )


class WriteTests(unittest.TestCase):
    def test_a_download_never_overwrites_an_existing_file(self):
        with scratch() as paths:
            target = write_file(os.path.join(paths["files"], "out.txt"), b"keep me")
            with self.assertRaises(local_paths.PathRefused) as caught:
                open_write(paths, target, "downloading a Drive file", GWS_FILES_DIR=paths["files"])
            self.assertIn("already exists", str(caught.exception))
            with open(target, "rb") as fh:
                self.assertEqual(fh.read(), b"keep me", "the existing bytes are untouched")

    def test_a_write_never_follows_a_symlink_target(self):
        with scratch() as paths:
            link = os.path.join(paths["files"], "out.txt")
            os.symlink(os.path.join(paths["files"], "real.txt"), link)
            with self.assertRaises(local_paths.PathRefused) as caught:
                open_write(paths, link, GWS_FILES_DIR=paths["files"])
            self.assertIn("symbolic link", str(caught.exception))
            self.assertFalse(os.path.exists(os.path.join(paths["files"], "real.txt")))

    def test_a_write_into_a_missing_folder_is_refused_with_the_reason(self):
        with scratch() as paths:
            with self.assertRaises(local_paths.PathRefused) as caught:
                open_write(
                    paths,
                    os.path.join(paths["files"], "nope", "out.txt"),
                    GWS_FILES_DIR=paths["files"],
                )
            self.assertIn("does not exist", str(caught.exception))

    def test_the_default_path_is_the_files_folder_and_its_name_is_sanitized(self):
        with scratch() as paths:
            default = default_path(
                paths, "../..//etc/passwd", "pdf", GWS_FILES_DIR=paths["files"]
            )
            name = os.path.basename(default)
            self.assertEqual(os.path.dirname(default), os.path.realpath(paths["files"]))
            self.assertNotIn(os.sep, name)
            self.assertNotIn("/", name)
            self.assertTrue(name.endswith(".pdf"))
            self.assertNotIn(name, (".", "..", ".pdf"))

    def test_the_legacy_default_is_tmp_only_without_a_folder(self):
        with scratch() as paths:
            self.assertEqual(default_path(paths, "pres-1", "pdf"), "/tmp/pres-1.pdf")

    def test_safe_name_keeps_only_the_safe_characters(self):
        self.assertEqual(local_paths.safe_name("1AbC-_x.y"), "1AbC-_x.y")
        self.assertEqual(local_paths.safe_name("a/b\\c d"), "a_b_c_d")
        self.assertEqual(local_paths.safe_name(".."), "file")
        self.assertEqual(local_paths.safe_name(""), "file")
        self.assertEqual(local_paths.safe_name(None), "file")


class ImageMagicTests(unittest.TestCase):
    def check(self, paths, data, name):
        target = write_file(os.path.join(paths["files"], name), data)
        real, handle = open_read(paths, target, GWS_FILES_DIR=paths["files"])
        try:
            return local_paths.check_image(handle, shown=real)
        finally:
            handle.close()

    def test_the_four_image_formats_are_accepted(self):
        for data in (
            png_bytes(),
            b"\xff\xd8\xff\xe0" + b"\x00" * 12,
            b"GIF89a" + b"\x00" * 10,
            b"RIFF" + (8).to_bytes(4, "little") + b"WEBPVP8 ",
        ):
            with self.subTest(head=data[:4]):
                with scratch() as paths:
                    head = self.check(paths, data, "pic")
                    self.assertTrue(local_paths.is_image(head))

    def test_a_non_image_is_refused_whatever_it_is_named(self):
        for data in (b"#!/bin/sh\necho hi\n", b'{"installed": "client"}'):
            with self.subTest(data=data[:8]):
                with scratch() as paths:
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        self.check(paths, data, "shot.png")
                    self.assertIn("not a PNG, JPEG, GIF or WebP image", str(caught.exception))


# --- the tools, wired ------------------------------------------------------


def drive_service():
    """A Drive client that answers like Google without leaving the process."""
    service = mock.MagicMock()
    service.files.return_value.get.return_value.execute.return_value = {
        "id": "file-1",
        "name": "note.txt",
        "mimeType": "text/plain",
        "size": "3",
    }
    service.files.return_value.get_media.return_value.execute.return_value = b"raw"
    service.files.return_value.export.return_value.execute.return_value = b"exported"
    service.files.return_value.create.return_value.execute.return_value = {"id": "new-1"}
    service.files.return_value.update.return_value.execute.return_value = {"id": "file-1"}
    return service


class ToolRefusalTests(unittest.TestCase):
    """A refused local path: no Google call, and the message says what to do."""

    def assert_refused(self, result, *needles):
        self.assertFalse(result["success"], result)
        for needle in needles:
            self.assertIn(needle, result["error"])

    def test_upload_refuses_the_token_file_and_uploads_nothing(self):
        with scratch() as paths:
            with tool_env(paths), mock.patch.object(drive, "get_drive_service") as service:
                result = asyncio.run(drive.gdrive_upload_file(paths["token"], FOLDER))
            self.assert_refused(result, "sign-in folder", "GWS_FILES_DIR")
            service.assert_not_called()

    def test_upload_new_version_refuses_a_path_outside_the_folder(self):
        with scratch() as paths:
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                drive, "get_drive_service"
            ) as service:
                result = asyncio.run(
                    drive.gdrive_upload_new_version(
                        "file-1", os.path.join(paths["elsewhere"], "note.txt")
                    )
                )
            self.assert_refused(result, "files folder")
            service.assert_not_called()

    def test_download_refuses_an_escaping_path_before_reading_the_file(self):
        with scratch() as paths:
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                drive, "get_drive_service"
            ) as service:
                result = asyncio.run(
                    drive.gdrive_download_file(
                        "file-1", os.path.join(paths["files"], "..", "escape.txt")
                    )
                )
            self.assert_refused(result, "files folder")
            service.assert_not_called()

    def test_download_refuses_the_signin_folder_with_no_files_folder(self):
        with scratch() as paths:
            with tool_env(paths), mock.patch.object(drive, "get_drive_service") as service:
                result = asyncio.run(drive.gdrive_download_file("file-1", paths["token"]))
            self.assert_refused(result, "sign-in folder")
            service.assert_not_called()

    def test_export_refuses_the_signin_folder(self):
        with scratch() as paths:
            with tool_env(paths), mock.patch.object(drive, "get_drive_service") as service:
                result = asyncio.run(drive.gdrive_export("file-1", paths["credentials"]))
            self.assert_refused(result, "sign-in folder")
            service.assert_not_called()

    def test_slides_export_refuses_a_path_outside_the_folder(self):
        with scratch() as paths:
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                slides, "get_drive_service"
            ) as service:
                result = asyncio.run(
                    slides.gslides_export(
                        "pres-1", out_path=os.path.join(paths["elsewhere"], "deck.pdf")
                    )
                )
            self.assert_refused(result, "files folder")
            service.assert_not_called()

    def test_slides_export_under_the_guard_and_no_folder_writes_nothing(self):
        with scratch() as paths:
            with tool_env(paths, GWS_OUTBOUND_GUARD="1"), mock.patch.object(
                slides, "get_drive_service"
            ) as service:
                result = asyncio.run(slides.gslides_export("pres-1"))
            self.assert_refused(result, "GWS_FILES_DIR")
            service.assert_not_called()

    def test_a_local_image_insert_refuses_the_token_file(self):
        with scratch() as paths:
            with tool_env(paths), mock.patch.object(
                docs_mod, "get_docs_service"
            ) as docs_service, mock.patch.object(
                docs_mod, "get_drive_service"
            ) as drive_service_mock:
                result = asyncio.run(
                    docs_mod.gdocs_insert_image("doc-1", paths["token"], index=1)
                )
            self.assert_refused(result, "sign-in folder")
            docs_service.assert_not_called()
            drive_service_mock.assert_not_called()

    def test_a_local_image_insert_refuses_a_file_that_is_not_an_image(self):
        with scratch() as paths:
            fake = write_file(os.path.join(paths["files"], "shot.png"), b"not an image")
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                docs_mod, "get_docs_service"
            ) as docs_service, mock.patch.object(
                docs_mod, "get_drive_service"
            ) as drive_service_mock:
                result = asyncio.run(docs_mod.gdocs_insert_image("doc-1", fake, index=1))
            self.assert_refused(result, "not a PNG, JPEG, GIF or WebP image")
            docs_service.assert_not_called()
            drive_service_mock.assert_not_called()

    def test_download_refuses_to_overwrite_and_writes_nothing(self):
        with scratch() as paths:
            target = write_file(os.path.join(paths["files"], "out.txt"), b"keep me")
            service = drive_service()
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                drive, "get_drive_service", return_value=service
            ):
                result = asyncio.run(drive.gdrive_download_file("file-1", target))
            self.assert_refused(result, "already exists")
            with open(target, "rb") as fh:
                self.assertEqual(fh.read(), b"keep me")

    def test_upload_with_the_guard_on_and_no_folder_names_the_setting(self):
        with scratch() as paths:
            local = os.path.join(paths["elsewhere"], "note.txt")
            with tool_env(paths, GWS_OUTBOUND_GUARD="1"), mock.patch.object(
                drive, "get_drive_service"
            ) as service:
                result = asyncio.run(drive.gdrive_upload_file(local, FOLDER))
            self.assert_refused(result, "GWS_FILES_DIR")
            service.assert_not_called()


class ToolWriteTests(unittest.TestCase):
    def test_download_writes_into_the_files_folder(self):
        with scratch() as paths:
            target = os.path.join(paths["files"], "note.txt")
            service = drive_service()
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                drive, "get_drive_service", return_value=service
            ):
                result = asyncio.run(drive.gdrive_download_file("file-1", target))
            self.assertTrue(result["success"], result)
            self.assertEqual(result["data"]["local_path"], os.path.realpath(target))
            with open(target, "rb") as fh:
                self.assertEqual(fh.read(), b"raw")

    def test_export_default_path_is_inside_the_files_folder(self):
        with scratch() as paths:
            service = drive_service()
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                slides, "get_drive_service", return_value=service
            ):
                result = asyncio.run(slides.gslides_export("pres-1"))
            self.assertTrue(result["success"], result)
            default = os.path.join(os.path.realpath(paths["files"]), "pres-1.pdf")
            self.assertEqual(result["data"]["path"], default)
            with open(default, "rb") as fh:
                self.assertEqual(fh.read(), b"exported")

    def test_a_slides_id_cannot_escape_the_folder_through_the_default_name(self):
        with scratch() as paths:
            service = drive_service()
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                slides, "get_drive_service", return_value=service
            ):
                result = asyncio.run(slides.gslides_export("../../escape", "pdf"))
            self.assertTrue(result["success"], result)
            written = result["data"]["path"]
            self.assertEqual(
                os.path.dirname(written),
                os.path.realpath(paths["files"]),
                "the name is sanitized: the file lands in the folder",
            )
            self.assertTrue(os.path.exists(written))

    def test_upload_sends_the_bytes_it_checked(self):
        # The uploader is handed the OPEN handle local_paths checked — not the path —
        # so the bytes that go up are the bytes that were allowed, and it is closed
        # afterwards whatever happens.
        captured = {}

        def fake_media(fd, mimetype=None, resumable=False):
            captured["fd"] = fd
            captured["mimetype"] = mimetype
            captured["resumable"] = resumable
            captured["closed_during"] = fd.closed
            captured["bytes"] = fd.read()
            fd.seek(0)
            return mock.MagicMock(name="media")

        with scratch() as paths:
            local = write_file(os.path.join(paths["files"], "note.txt"), b"payload")
            service = drive_service()
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                drive, "get_drive_service", return_value=service
            ), mock.patch.object(drive, "MediaIoBaseUpload", side_effect=fake_media):
                result = asyncio.run(drive.gdrive_upload_file(local, FOLDER))
            self.assertTrue(result["success"], result)
            self.assertEqual(service.files().create.call_args.kwargs["body"]["parents"], [FOLDER])
        self.assertEqual(captured["bytes"], b"payload", "the checked bytes are what goes up")
        self.assertEqual(captured["mimetype"], "text/plain", "guessed from the checked path")
        self.assertTrue(captured["resumable"])
        self.assertFalse(captured["closed_during"], "the uploader reads it while it is open")
        self.assertTrue(captured["fd"].closed, "and the tool closes it afterwards")


class UploaderHandleTests(unittest.TestCase):
    def test_googleapiclient_reads_the_handle_this_module_opens(self):
        # The tools hand MediaIoBaseUpload an OPEN handle, so the bytes that go up are
        # the bytes local_paths allowed. That only works if the library accepts a file
        # object and takes its size and bytes from it — proved here, with no network.
        # (MediaFileUpload would not do: it takes a FILENAME and opens it itself.)
        payload = b"hello upload"
        with scratch() as paths:
            target = write_file(os.path.join(paths["files"], "note.txt"), payload)
            real, handle = open_read(paths, target, GWS_FILES_DIR=paths["files"])
            try:
                media = MediaIoBaseUpload(
                    handle,
                    mimetype=local_paths.guess_mime_type(None, real),
                    resumable=True,
                )
                self.assertEqual(media.size(), len(payload))
                self.assertEqual(media.mimetype(), "text/plain")
                self.assertEqual(media.getbytes(0, len(payload)), payload)
            finally:
                handle.close()


if __name__ == "__main__":
    unittest.main()