"""GWS_FILES_DIR, and the folders no local path may ever touch (local_paths.py).

The point of every refusal below: the path is decided BEFORE any Google client is
built, so a refused local path makes no API call at all — and the sign-in folder
(the OAuth token and credentials) and the operator's own credential folders and
files (~/.ssh, ~/.gnupg, ~/.config/gcloud, ~/.aws, ~/.azure, ~/.kube,
~/.config/gh, ~/.terraform.d, ~/.docker/config.json, ~/.netrc, ~/.npmrc,
~/.pgpass, ~/.config/containers/auth.json) are refused whatever else is
configured. The service objects are mocks, so nothing
leaves the process.

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
from google_workspace_mcp import auth, drive, local_paths, slides  # noqa: E402

FOLDER = "folder-1"
TOKEN_NAME = "token.json"
CREDENTIALS_NAME = "credentials.json"


# --- fixtures --------------------------------------------------------------


@contextlib.contextmanager
def scratch():
    """A scratch home with a files folder, a sign-in folder and a file outside both.

    ``home/files`` is the files folder, ``home/.config/google-workspace-mcp`` holds
    the token and credentials, ``home/elsewhere`` is a plain folder the tools may
    reach only with no files folder set (the pre-existing behaviour), and every
    one of the operator's credential folders and files (``home/.ssh``,
    ``home/.gnupg``, ``home/.config/gcloud``, ``home/.aws``, … and
    ``home/.netrc``, …) exists with one fake credential in it, so the
    always-refused rules can be tested from the same tree.
    """
    with tempfile.TemporaryDirectory() as tmp:
        home = os.path.realpath(tmp)
        files = os.path.join(home, "files")
        signin = os.path.join(home, ".config", "google-workspace-mcp")
        gcloud = os.path.join(home, ".config", "gcloud")
        elsewhere = os.path.join(home, "elsewhere")
        for path in (
            files,
            signin,
            elsewhere,
        ):
            os.makedirs(path, exist_ok=True)
        token = os.path.join(signin, TOKEN_NAME)
        credentials = os.path.join(signin, CREDENTIALS_NAME)
        for path in (token, credentials):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"installed": "client"}')
        with open(os.path.join(elsewhere, "note.txt"), "w", encoding="utf-8") as fh:
            fh.write("outside")
        # One fake credential per always-refused entry of Crow's own list
        # (servers/shared/operator-secret-paths.js), so each one can be pointed at.
        protected = []
        for pattern, body in (
            ("~/.ssh", None),
            ("~/.gnupg", None),
            ("~/.config/gcloud", None),
            ("~/.aws", ".aws/credentials"),
            ("~/.azure", ".azure/msal_token_cache.json"),
            ("~/.kube", ".kube/config"),
            ("~/.config/gh", ".config/gh/hosts.yml"),
            ("~/.terraform.d", ".terraform.d/credentials.tfrc.json"),
            ("~/.docker/config.json", ".docker/config.json"),
            ("~/.netrc", ".netrc"),
            ("~/.npmrc", ".npmrc"),
            ("~/.pgpass", ".pgpass"),
            ("~/.config/containers/auth.json", ".config/containers/auth.json"),
        ):
            rel = body or (pattern[2:] + ("/pubring.gpg" if pattern == "~/.gnupg"
                                         else "/id_ed25519" if pattern == "~/.ssh"
                                         else "/application_default_credentials.json"))
            path = os.path.join(home, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"fake": "credential"}')
            protected.append((pattern, path))
        yield {
            "home": home,
            "files": files,
            "signin": signin,
            "gcloud": gcloud,
            "token": token,
            "credentials": credentials,
            "elsewhere": elsewhere,
            "protected": protected,
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


class RaceAndHardLinkTests(unittest.TestCase):
    """The path that was resolved is checked again on the fd the kernel opened."""

    def test_a_folder_swapped_for_a_symlink_before_the_read_open_is_refused(self):
        with scratch() as paths:
            sub = os.path.join(paths["files"], "sub")
            os.makedirs(sub)
            target = write_file(os.path.join(sub, "note.txt"), b"innocent")
            write_file(os.path.join(paths["signin"], "note.txt"), b'{"token": "secret"}')
            # The reviewer's probe: resolve() has already answered with the old path,
            # and only now is the directory it named replaced by a link to the sign-in
            # folder. O_NOFOLLOW does not cover this component.
            os.remove(target)
            os.rmdir(sub)
            os.symlink(paths["signin"], sub)
            with mock.patch.object(local_paths, "resolve", return_value=target):
                with self.assertRaises(local_paths.PathRefused) as caught:
                    open_read(paths, target, GWS_FILES_DIR=paths["files"])
            self.assertIn("sign-in folder", str(caught.exception))

    def test_a_folder_swapped_for_a_symlink_before_the_write_open_is_refused(self):
        with scratch() as paths:
            sub = os.path.join(paths["files"], "sub")
            os.makedirs(sub)
            target = os.path.join(sub, "out.txt")
            os.rmdir(sub)
            os.symlink(paths["signin"], sub)
            real_open = os.open

            def without_nofollow(path, flags, *args, **kwargs):
                # Proves the post-open check catches this on its own: the same swap
                # with O_NOFOLLOW stripped must still be refused, and leave nothing.
                return real_open(
                    path, flags & ~getattr(os, "O_NOFOLLOW", 0), *args, **kwargs
                )

            with mock.patch.object(local_paths, "resolve", return_value=target), \
                    mock.patch.object(local_paths.os, "open", side_effect=without_nofollow):
                with self.assertRaises(local_paths.PathRefused) as caught:
                    open_write(paths, target, GWS_FILES_DIR=paths["files"])
            self.assertIn("sign-in folder", str(caught.exception))
            self.assertFalse(
                os.path.exists(os.path.join(paths["signin"], "out.txt")),
                "nothing is left behind in the sign-in folder",
            )

    def test_a_hard_link_to_the_token_file_is_refused_for_reading(self):
        with scratch() as paths:
            link = os.path.join(paths["files"], "innocent.png")
            os.link(paths["token"], link)
            with self.assertRaises(local_paths.PathRefused) as caught:
                open_read(paths, link, GWS_FILES_DIR=paths["files"])
            self.assertIn("hard link", str(caught.exception))
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

    def test_the_gcloud_config_folder_is_refused(self):
        # The Google Cloud CLI keeps application-default credentials and service
        # account keys here, so an unwalled add-on must never be handed a path in
        # it — with the guard off, with no folder, and even when the files folder
        # is the home that contains it.
        with scratch() as paths:
            for target in (
                os.path.join(paths["gcloud"], "application_default_credentials.json"),
                os.path.join(paths["gcloud"], "anything.txt"),
            ):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target)
                    self.assertIn("~/.config/gcloud", str(caught.exception))
                    self.assertIn("never reads or writes", str(caught.exception))
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(
                    paths,
                    os.path.join(paths["gcloud"], "application_default_credentials.json"),
                    GWS_FILES_DIR=paths["home"],
                )
            self.assertIn("~/.config/gcloud", str(caught.exception))

    def test_every_operator_credential_entry_is_refused(self):
        # The Python guard mirrors Crow's own list
        # (servers/shared/operator-secret-paths.js, used by the bot sandbox, the
        # contain tier, the add-on wall and the file history). A folder protects
        # everything inside it, a file protects itself. A JS test parses
        # _PRIVATE_PATTERNS and holds the two lists in step, so an entry added to
        # only one side fails there.
        with scratch() as paths:
            for pattern, target in paths["protected"]:
                with self.subTest(entry=pattern):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target)
                    self.assertIn("never reads or writes", str(caught.exception))
                    self.assertIn(pattern, str(caught.exception))
                    # Even when the files folder is the home that contains it.
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target, GWS_FILES_DIR=paths["home"])
                    self.assertIn(pattern, str(caught.exception))
            # A bare name that only LOOKS like one of those files is ordinary
            # content: only the exact path (or everything below a folder) is
            # refused.
            for name in ("config.json", "auth.json", "credentials", "hosts.yml"):
                plain = write_file(os.path.join(paths["files"], name), b"{}")
                with self.subTest(name=name):
                    self.assertEqual(resolve(paths, plain), os.path.realpath(plain))

    def test_a_symlinked_operator_credential_folder_protects_both_ends(self):
        # ~/.aws behind a link: the tool is refused whether it is handed the link
        # spelling or the folder the link really is.
        with scratch() as paths:
            real = os.path.join(paths["home"], "real-aws")
            os.makedirs(real)
            write_file(os.path.join(real, "credentials"), b"[default]")
            aws = os.path.join(paths["home"], ".aws")
            os.remove(os.path.join(aws, "credentials"))
            os.rmdir(aws)
            os.symlink(real, aws)
            for target in (os.path.join(real, "credentials"), os.path.join(aws, "credentials")):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target)
                    self.assertIn("~/.aws", str(caught.exception))

    def test_a_symlinked_gcloud_config_folder_protects_both_ends(self):
        with scratch() as paths:
            real = os.path.join(paths["home"], "real-gcloud")
            os.makedirs(real)
            write_file(os.path.join(real, "access_tokens.db"), b"fake")
            os.remove(os.path.join(paths["gcloud"], "application_default_credentials.json"))
            os.rmdir(paths["gcloud"])
            os.symlink(real, paths["gcloud"])
            for target in (
                os.path.join(real, "access_tokens.db"),
                os.path.join(paths["gcloud"], "access_tokens.db"),
            ):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target)
                    self.assertIn("~/.config/gcloud", str(caught.exception))

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


    def test_a_symlinked_token_file_protects_both_folders_and_the_file(self):
        with scratch() as paths:
            target_dir = os.path.join(paths["home"], "real-signin")
            link_dir = os.path.join(paths["home"], "linked-signin")
            os.makedirs(target_dir)
            os.makedirs(link_dir)
            real_token = write_file(os.path.join(target_dir, "token.json"), b"{}")
            link = os.path.join(link_dir, "token.json")
            os.symlink(real_token, link)
            # realpath(file) and dirname(abspath(file)) are both protected, and the
            # file itself at its real location is protected too.
            for target in (
                os.path.join(target_dir, "anything.txt"),
                os.path.join(link_dir, "anything.txt"),
                real_token,
            ):
                with self.subTest(path=target):
                    with self.assertRaises(local_paths.PathRefused) as caught:
                        resolve(paths, target, GOOGLE_TOKEN_FILE=link)
                    self.assertIn("sign-in folder", str(caught.exception))

    def test_a_signin_file_directly_in_home_names_that_problem(self):
        with scratch() as paths:
            home_token = write_file(os.path.join(paths["home"], "token.json"), b"{}")
            with self.assertRaises(local_paths.PathRefused) as caught:
                resolve(
                    paths,
                    os.path.join(paths["files"], "note.txt"),
                    GWS_FILES_DIR=paths["files"],
                    GOOGLE_TOKEN_FILE=home_token,
                )
            message = str(caught.exception)
            self.assertIn("directly in your home folder", message)
            self.assertIn("move it into its own folder", message)


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

    def test_a_taken_default_name_is_retried_with_a_suffix(self):
        with scratch() as paths:
            env = env_for(paths, GWS_FILES_DIR=paths["files"])
            taken = write_file(os.path.join(paths["files"], "deck.pdf"), b"old")
            free = os.path.join(paths["files"], "deck-2.pdf")

            def fake_default(ident, extension, env=None, home=None, attempt=1):
                return taken if attempt == 1 else free

            with mock.patch.object(local_paths, "default_path", side_effect=fake_default):
                real, handle = local_paths.open_write_default(
                    "deck", "pdf", env=env, home=paths["home"]
                )
            try:
                handle.write(b"new")
            finally:
                handle.close()
            self.assertEqual(real, os.path.realpath(free))
            with open(free, "rb") as fh:
                self.assertEqual(fh.read(), b"new")
            with open(taken, "rb") as fh:
                self.assertEqual(fh.read(), b"old", "the taken name is not overwritten")

    def test_the_legacy_default_is_tmp_with_a_unique_name_without_a_folder(self):
        with scratch() as paths:
            default = default_path(paths, "pres-1", "pdf")
            self.assertEqual(os.path.dirname(default), "/tmp")
            self.assertTrue(os.path.basename(default).startswith("pres-1-"))
            self.assertTrue(default.endswith(".pdf"))

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


class SigninPathTests(unittest.TestCase):
    def test_auth_and_local_paths_resolve_the_signin_files_the_same_way(self):
        with scratch() as paths:
            home = paths["home"]
            env = env_for(
                paths,
                GOOGLE_TOKEN_FILE="~/somewhere/token.json",
                GOOGLE_CREDENTIALS_FILE="",
            )
            self.assertEqual(
                local_paths.signin_file("GOOGLE_TOKEN_FILE", env, home=home),
                os.path.join(home, "somewhere", "token.json"),
            )
            self.assertEqual(
                local_paths.signin_file("GOOGLE_CREDENTIALS_FILE", env, home=home),
                os.path.join(home, ".config", "google-workspace-mcp", "credentials.json"),
            )
            # auth.py goes through the same resolver: ~ is expanded and empty is the
            # same default, so the folder protected here is the folder it reads.
            with mock.patch.dict(os.environ, {
                "HOME": home,
                "GOOGLE_TOKEN_FILE": "~/somewhere/token.json",
                "GOOGLE_CREDENTIALS_FILE": "",
            }):
                self.assertEqual(
                    str(auth._get_token_file()),
                    os.path.join(home, "somewhere", "token.json"),
                )
                self.assertEqual(
                    str(auth._get_credentials_file()),
                    os.path.join(
                        home, ".config", "google-workspace-mcp", "credentials.json"
                    ),
                )


class ImageSourceTests(unittest.TestCase):
    def kind(self, paths, value, **values):
        return local_paths.image_is_local(
            value, env=env_for(paths, **values), home=paths["home"]
        )

    def test_a_bare_id_shaped_token_is_a_drive_id(self):
        with scratch() as paths:
            drive_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz"
            self.assertFalse(self.kind(paths, drive_id))
            self.assertFalse(self.kind(paths, drive_id, GWS_FILES_DIR=paths["files"]))

    def test_a_separator_or_a_dot_prefix_makes_it_local(self):
        with scratch() as paths:
            for value in (
                os.path.join(paths["elsewhere"], "pic.png"),
                "sub/pic.png",
                "sub\\pic.png",
                "~/pic.png",
                "./pic.png",
                "../pic.png",
            ):
                with self.subTest(value=value):
                    self.assertTrue(self.kind(paths, value, GWS_FILES_DIR=paths["files"]))
            self.assertTrue(self.kind(paths, "pic.png", GWS_FILES_DIR=paths["files"]))

    def test_an_id_shaped_name_inside_the_files_folder_is_local(self):
        with scratch() as paths:
            name = "a" * 24
            write_file(os.path.join(paths["files"], name), b"x")
            self.assertTrue(self.kind(paths, name, GWS_FILES_DIR=paths["files"]))


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

    def test_a_relative_image_name_resolves_inside_the_files_folder(self):
        with scratch() as paths:
            write_file(os.path.join(paths["files"], "shot.png"), b"not an image")
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                docs_mod, "get_docs_service"
            ) as docs_service, mock.patch.object(
                docs_mod, "get_drive_service"
            ) as drive_service_mock:
                result = asyncio.run(
                    docs_mod.gdocs_insert_image("doc-1", "shot.png", index=1)
                )
            self.assert_refused(result, "not a PNG, JPEG, GIF or WebP image")
            docs_service.assert_not_called()
            drive_service_mock.assert_not_called()

    def test_a_local_image_outside_the_folder_is_refused_whether_or_not_it_exists(self):
        with scratch() as paths:
            existing = os.path.join(paths["elsewhere"], "note.txt")
            missing = os.path.join(paths["elsewhere"], "missing.png")
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                docs_mod, "get_docs_service"
            ) as service:
                first = asyncio.run(
                    docs_mod.gdocs_insert_image("doc-1", existing, index=1)
                )
                second = asyncio.run(
                    docs_mod.gdocs_insert_image("doc-1", missing, index=1)
                )
            self.assert_refused(first, "files folder")
            self.assert_refused(second, "files folder")
            self.assertNotIn("not found", first["error"])
            self.assertNotIn("not found", second["error"])
            service.assert_not_called()

    def test_an_id_shaped_image_is_a_drive_id_not_a_local_path(self):
        with scratch() as paths:
            service = drive_service()
            service.permissions.return_value.list.return_value.execute.return_value = {
                "permissions": []
            }
            with tool_env(paths, GWS_OUTBOUND_GUARD="1"), mock.patch.object(
                docs_mod, "get_docs_service"
            ), mock.patch.object(docs_mod, "get_drive_service", return_value=service):
                result = asyncio.run(
                    docs_mod.gdocs_insert_image(
                        "doc-1", "1AbCdEfGhIjKlMnOpQrStUvWxYz", index=1
                    )
                )
            self.assertFalse(result["success"], result)
            self.assertNotIn("LOCAL image is disabled", result["error"])
            self.assertIn("anyone-with-the-link", result["error"])

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
            default = result["data"]["path"]
            self.assertEqual(os.path.dirname(default), os.path.realpath(paths["files"]))
            self.assertTrue(os.path.basename(default).startswith("pres-1-"))
            self.assertTrue(default.endswith(".pdf"))
            with open(default, "rb") as fh:
                self.assertEqual(fh.read(), b"exported")

    def test_repeated_default_exports_create_new_files(self):
        with scratch() as paths:
            service = drive_service()
            with tool_env(paths, GWS_FILES_DIR=paths["files"]), mock.patch.object(
                slides, "get_drive_service", return_value=service
            ):
                first = asyncio.run(slides.gslides_export("pres-1"))
                second = asyncio.run(slides.gslides_export("pres-1"))
            self.assertTrue(first["success"], first)
            self.assertTrue(second["success"], second)
            self.assertNotEqual(first["data"]["path"], second["data"]["path"])
            for result in (first, second):
                self.assertTrue(os.path.exists(result["data"]["path"]))

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