"""GWS_FILES_DIR: the one folder of yours a tool may read a file from or write a
file to, and the folders it never touches.

Six tools take a LOCAL path — ``gdrive_upload_file``, ``gdrive_upload_new_version``
(the read side), ``gdrive_download_file``, ``gdrive_export``, ``gslides_export``
(the write side) and the local-image form of ``gdocs_insert_image`` (read). Before
this module the path was whatever the caller said: an assistant talked into
uploading ``~/.config/google-workspace-mcp/token.json`` to Drive (and sharing it)
had the owner's OAuth token, and one talked into exporting a document over that
same file could destroy the sign-in. A local path is a capability, so it is
decided here and nowhere else.

Three rules, in the order they are checked:

1. **The sign-in folder is never a local path.** Always — guard on or off, files
   folder set or not. The real and the named parent folders of
   ``GOOGLE_TOKEN_FILE`` and ``GOOGLE_CREDENTIALS_FILE``, the operator's own
   credential folders and files (``~/.ssh``, ``~/.gnupg``, ``~/.config/gcloud``,
   ``~/.aws``, ``~/.azure``, ``~/.kube``, ``~/.config/gh``, ``~/.terraform.d`` and
   ``~/.docker/config.json``, ``~/.netrc``, ``~/.npmrc``, ``~/.pgpass``,
   ``~/.config/containers/auth.json`` — the same set Crow's bot sandbox and add-on
   wall use) and any ``~/.config/google-workspace-mcp*`` sibling are refused, and
   so are the token and credentials files themselves (they are inside those
   folders). Every
   one of them is compared after ``os.path.realpath``, so a symlink pointing into
   them is refused too, and a file opened for reading is compared by
   ``(st_dev, st_ino)`` with both files, so a hard link to the token is refused as
   well. If a protected folder cannot be resolved, nothing is allowed at all:
   unknown fails closed, never open.

2. **With no files folder set**, the outbound guard (``GWS_OUTBOUND_GUARD``)
   decides. On, every local path is refused — an install that means to wall the
   assistant in gets no local file at all until the owner names a folder. Off, an
   install that upgrades may still use any path it is handed (outside the always-
   refused folders), so nothing that worked stops working — but "off" removes only
   the folder requirement, not the file handling: a write still never overwrites an
   existing file, a default output name is unique (repeated exports create new
   files), a missing parent folder is refused, a non-regular file is refused for
   reading, a local image's first bytes must really be an image, and the sign-in
   folder and every one of the operator's own credential folders and files are
   refused always.

3. **With a files folder set**, a path must land *strictly inside* it after
   ``os.path.realpath`` — never on the folder itself. A relative path is relative
   to the folder; a leading ``~`` is the owner's home. ``..``, an absolute path
   elsewhere and a symlink pointing out all resolve outside and are refused.

Writes are the harder direction, so they get more than a resolved path: the file
is created with ``O_CREAT|O_EXCL|O_NOFOLLOW`` (never overwriting anything, never
through a symlink) at mode 0600, opened relative to its parent directory's own fd
where the platform allows it. The tools here have no overwrite flag, so a target
that already exists is always refused. Reads are opened ``O_NOFOLLOW`` and must be
a regular file; the local-image insert also checks the first bytes really are a
PNG, JPEG, GIF or WebP.

A resolved path is not the last word: after the kernel opens the file — and, for a
write, the parent directory — the location it reports for that descriptor is run
through the same two checks again, so a directory swapped for a symlink between
``resolve`` and the open is caught and refused (and a just-created file removed).
A file opened for reading with more than one link is compared by
``(st_dev, st_ino)`` with the token and credentials files, which is what refuses a
hard link that is otherwise a plain file inside the folder.

Default output names are built from Google ids, which arrive as caller input: every
character outside ``[A-Za-z0-9._-]`` is replaced, so an id can never smuggle in a
path separator (and a value that is only dots becomes ``file``), which keeps the
write inside the folder it was resolved against. A default name also carries a UTC
timestamp (and ``-2``, ``-3``… on an ``O_EXCL`` collision), so a repeated export
with no path creates a new file instead of being refused. The default location is
the files folder when one is set, and ``/tmp`` only for an install with neither a
folder nor the guard (the old behaviour) — with the guard on there is no default to
fall back to, because ``resolve`` refuses first.

Pure apart from the filesystem reads it needs, and every entry point takes ``env``
and ``home`` so the tests run in a scratch tree.
"""

import datetime
import glob
import mimetypes
import os
import re
import stat
from typing import IO, Mapping, Optional, Tuple

from . import outbound_guard

#: Read a local file (upload, insert).
READ = "read"
#: Write a local file (download, export).
WRITE = "write"

#: The setting itself.
FILES_DIR_VAR = "GWS_FILES_DIR"

# The default sign-in folder and file names, resolved by signin_file() for both
# auth.py and this module, so the file auth.py reads is the file protected here.
_DEFAULT_SIGNIN_DIR = (".config", "google-workspace-mcp")
_DEFAULT_SIGNIN_FILES = {
    "GOOGLE_TOKEN_FILE": "token.json",
    "GOOGLE_CREDENTIALS_FILE": "credentials.json",
}

# Folders and FILES that are never a local path, whatever else is configured. The
# pattern covers a sibling sign-in directory (`google-workspace-mcp-old`, a second
# account's copy) as well as the one the defaults name. `~/.config/gcloud` is the
# Google Cloud CLI's credential folder (`application_default_credentials.json`,
# `credentials.db`, `access_tokens.db`, `legacy_credentials/`): a service-account
# key and an application-default credential both live there, so a tool call must
# never be handed a path inside it.
#
# This tuple MIRRORS Crow's own list, OPERATOR_SECRET_PATHS in
# servers/shared/operator-secret-paths.js (the bot sandbox, the contain tier, the
# add-on wall, the file history and the isolation report all read that one). It is
# repeated here because this server runs in another language, inside its own
# bundle, and must refuse a path even when it is not walled. A JS test parses these
# entries and holds the two lists in step (tests/pibot-hidden-files.test.js, "the
# Python guard mirrors the operator list"), so add an entry in BOTH places, and
# bump this bundle's `version` when you do.
#
# A folder (`~/.ssh`, `~/.aws`, …) protects everything below it; a file (`~/.netrc`,
# …) protects exactly itself.
_PRIVATE_PATTERNS = (
    ("~/.ssh", "~/.ssh"),
    ("~/.gnupg", "~/.gnupg"),
    ("~/.config/gcloud", "~/.config/gcloud"),
    ("~/.aws", "~/.aws"),
    ("~/.azure", "~/.azure"),
    ("~/.kube", "~/.kube"),
    ("~/.config/gh", "~/.config/gh"),
    ("~/.terraform.d", "~/.terraform.d"),
    ("~/.docker/config.json", "~/.docker/config.json"),
    ("~/.netrc", "~/.netrc"),
    ("~/.npmrc", "~/.npmrc"),
    ("~/.pgpass", "~/.pgpass"),
    ("~/.config/containers/auth.json", "~/.config/containers/auth.json"),
    ("~/.config/google-workspace-mcp*", "~/.config/google-workspace-mcp* (a sign-in folder)"),
)

#: What every refusal about a protected folder calls it.
_SIGNIN_LABEL = "the Google sign-in folder (the OAuth token and credentials live there)"

#: How the "cannot be resolved" refusals summarise the protected set.
_PROTECTED_SUMMARY = ("the Google sign-in folder, ~/.ssh, ~/.gnupg, ~/.config/gcloud "
                      "and the operator's other credential folders and files")

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")

#: The shape of a Drive file id: a bare token with no path separator. Used only to
#: tell a Drive id apart from a local image name (see ``image_is_local``).
_DRIVE_ID = re.compile(r"[A-Za-z0-9_-]{20,}\Z")

_IMAGE_MAGIC = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
)


class PathRefused(Exception):
    """A local path this server will not touch. ``str(exc)`` is the user-facing why.

    The message always says what to do about it, so a tool can hand it straight
    back as its ``error`` value: a refusal is a normal answer here, not a crash.
    """


# --- small helpers ---------------------------------------------------------


def _home(home: Optional[str]) -> str:
    """``home`` as a real absolute path (the tests pass a scratch one)."""
    value = home if home else os.path.expanduser("~")
    return _resolved(value) or os.path.abspath(value)


def _expand(value: str, home: str) -> str:
    """Expand one leading ``~`` against ``home``; everything else is left alone.

    Deliberately not ``os.path.expanduser``: the tests (and a service running with a
    different HOME) must see the home they were given, not the process's.
    """
    if value == "~":
        return home
    if value.startswith("~/"):
        return os.path.join(home, value[2:])
    return value


def signin_file(name: str, env: Optional[Mapping[str, str]] = None,
                home: Optional[str] = None) -> str:
    """The configured path of the token or credentials file, or its default.

    The one resolver ``auth.py`` and this module share, so they can never disagree:
    a leading ``~`` is expanded against ``home`` (the process owner's when not
    given) and an empty value counts as unset, which yields the same default both
    read and protected here.
    """
    if name not in _DEFAULT_SIGNIN_FILES:
        raise ValueError(f"not a Google sign-in file setting: {name}")
    env = os.environ if env is None else env
    home_path = _home(home)
    raw = (env.get(name) or "").strip()
    if not raw:
        return os.path.join(home_path, *_DEFAULT_SIGNIN_DIR, _DEFAULT_SIGNIN_FILES[name])
    return _expand(raw, home_path)


def _resolved(path: str) -> Optional[str]:
    """``os.path.realpath``, or None when the path cannot be resolved.

    ``realpath`` is asked not to raise (``strict=False``, the default), and a symlink
    that points at itself comes back *unresolved* — still a symlink — which is how a
    loop is recognised here. A path that could not be resolved is never trusted, so
    the caller fails closed rather than falling back to the no-folder behaviour.
    """
    try:
        real = os.path.realpath(path)
    except OSError:
        return None
    return None if os.path.islink(real) else real


def _real(path: str, shown: str, what: str) -> str:
    """``_resolved`` or a refusal (a link loop is not a path we trust)."""
    real = _resolved(path)
    if real is None:
        raise PathRefused(
            f"{what} is refused — the real location of {shown} cannot be determined "
            f"(a symbolic link loop, perhaps), so it is not touched. Move the file "
            f"into your files folder (GWS_FILES_DIR) as a plain file and try again."
        )
    return real


def _at_or_inside(path: str, folder: str) -> bool:
    """True when ``path`` is ``folder`` or below it (both already real paths)."""
    if path == folder:
        return True
    root = folder.rstrip(os.sep)
    return path.startswith(root + os.sep)


def _strictly_inside(path: str, folder: str) -> bool:
    """True when ``path`` is below ``folder`` — the folder itself is not a file."""
    return path != folder and _at_or_inside(path, folder)


def _refuse(what: str, problem: str, hint: str) -> PathRefused:
    return PathRefused(f"{what} is refused — {problem}. {hint}")


def _refuse_protected(what: str, shown: str, protected_path: str,
                      label: str, home: str) -> PathRefused:
    """The refusal for a protected path; a home sign-in file gets its own reason."""
    if protected_path == home and label == _SIGNIN_LABEL:
        return PathRefused(
            f"{what} is refused — the sign-in file is directly in your home folder, so "
            f"Crow can't keep local files away from it — move it into its own folder "
            f"(for example ~/.config/google-workspace-mcp/) and point GOOGLE_TOKEN_FILE "
            f"and GOOGLE_CREDENTIALS_FILE there, then try again."
        )
    return _refuse(
        what,
        f"{shown} is in {label}, which this server never reads or writes for a tool call",
        "Put the file in your files folder (GWS_FILES_DIR) instead.",
    )


# --- the three rules -------------------------------------------------------


def _files_dir_setting(env: Mapping[str, str]) -> str:
    """``GWS_FILES_DIR`` as the owner typed it, or "" when it is not set."""
    return (env.get(FILES_DIR_VAR) or "").strip()


def files_dir(env: Optional[Mapping[str, str]] = None,
              home: Optional[str] = None) -> Optional[str]:
    """The owner's files folder as a real path, or None when it is unset.

    None also covers a folder whose real path cannot be computed (a symlink loop);
    ``resolve`` treats that as a refusal rather than as "unset", so a broken setting
    never falls back to the no-folder behaviour.
    """
    env = os.environ if env is None else env
    raw = _files_dir_setting(env)
    if not raw:
        return None
    home_path = _home(home)
    return _resolved(_expand(raw, home_path))


def _protected(env: Mapping[str, str], home: str
               ) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """``([(path, label)], [(sign-in file, label)])`` no tool call may touch.

    The folders come from each sign-in FILE after ``realpath``: both the folder it
    really lives in and the folder it was named in are protected (a symlinked token
    protects both ends), and so is the file itself. Fail closed: a protected path
    whose real location cannot be computed refuses every local path, because the
    check itself would be blind. The second list is what the hard-link check in
    ``open_read`` compares against.
    """
    candidates: list[tuple[str, str]] = []
    files: list[tuple[str, str]] = []
    for name in ("GOOGLE_TOKEN_FILE", "GOOGLE_CREDENTIALS_FILE"):
        given = os.path.abspath(signin_file(name, env, home))
        real_file = _resolved(given)
        if real_file is None:
            raise PathRefused(
                f"This tool call is refused — the folders this server protects ({_PROTECTED_SUMMARY}) "
                f"cannot be resolved right now, so no local path is allowed. Fix the "
                f"filesystem (a broken symbolic link can cause this) and try again."
            )
        files.append((real_file, _SIGNIN_LABEL))
        candidates.append((os.path.dirname(given), _SIGNIN_LABEL))
        candidates.append((os.path.dirname(real_file) or os.sep, _SIGNIN_LABEL))
        candidates.append((real_file, _SIGNIN_LABEL))
    for pattern, label in _PRIVATE_PATTERNS:
        expanded = _expand(pattern, home)
        if "*" not in pattern:
            candidates.append((expanded, label))
            continue
        # One glob, for the sibling sign-in folders. The fixed part is escaped so a
        # home containing glob characters (a bracket in a user name) still matches.
        fixed, tail = os.path.split(expanded)
        matches = sorted(glob.glob(os.path.join(glob.escape(fixed), tail)))
        for match in matches or [expanded.replace("*", "")]:
            candidates.append((match, label))

    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for path, label in candidates:
        real = _resolved(path)
        if real is None:
            raise PathRefused(
                f"This tool call is refused — the folders this server protects ({_PROTECTED_SUMMARY}) "
                f"cannot be resolved right now, so no local path is allowed. Fix the "
                f"filesystem (a broken symbolic link can cause this) and try again."
            )
        if (real, label) in seen:
            continue
        seen.add((real, label))
        out.append((real, label))
    return out, files


def _candidate(path: str, folder: Optional[str], home: str) -> str:
    """The path to resolve: ``~`` expanded, a relative one under the files folder."""
    value = _expand(path.strip(), home)
    if folder is not None and not os.path.isabs(value):
        return os.path.join(folder, value)
    return value


def resolve(path: Optional[str], mode: str = READ, what: str = "this tool call",
            env: Optional[Mapping[str, str]] = None,
            home: Optional[str] = None) -> str:
    """The real path a tool may use for ``path`` in ``mode``, or ``PathRefused``.

    ``what`` names the action in the refusal ("uploading a local file", ...) so the
    message reads as a sentence about the call that was refused. ``mode`` is READ or
    WRITE; it decides the wording and, for a write, nothing else here — the open
    itself is ``open_write`` below.
    """
    env = os.environ if env is None else env
    home_path = _home(home)
    shown = "" if path is None else str(path).strip()
    if not shown:
        raise _refuse(
            what,
            "no path was given",
            "Pass the name of a file inside your files folder (GWS_FILES_DIR).",
        )
    # Rule 1 always, before anything else can allow it.
    protected, _protected_files = _protected(env, home_path)
    folder = files_dir(env, home_path)
    if folder is None and _files_dir_setting(env):
        raise _refuse(
            what,
            f"your files folder (GWS_FILES_DIR) cannot be resolved — the setting is "
            f"{_files_dir_setting(env)!r}, which does not name a usable path",
            "Point GWS_FILES_DIR at a folder that exists (a broken symbolic link is "
            "refused) and try again.",
        )
    real = _real(_candidate(shown, folder, home_path), shown, what)

    for protected_path, label in protected:
        if _at_or_inside(real, protected_path):
            raise _refuse_protected(what, shown, protected_path, label, home_path)

    # Rule 2: no folder set.
    if folder is None:
        if outbound_guard.guard_enabled(env):
            raise _refuse(
                what,
                "this server has no files folder set (GWS_FILES_DIR) and its outbound "
                "guard (GWS_OUTBOUND_GUARD) is on, so it may not touch a local file at "
                "all",
                "Set GWS_FILES_DIR to the one folder the assistant may use, and put "
                "the file in it.",
            )
        return real

    # Rule 3: strictly inside the owner's folder.
    if not _strictly_inside(real, folder):
        raise _refuse(
            what,
            f"{shown} is not inside your files folder ({folder})",
            "Put the file in your files folder (GWS_FILES_DIR) and pass its path "
            "inside that folder (or a name relative to it).",
        )
    return real


# --- opening ------------------------------------------------------------------


def _fd_path(fd: int) -> Optional[str]:
    """Where the kernel says this descriptor points, or None.

    ``/proc/self/fd`` (Linux) and ``/dev/fd`` (the BSDs) are the same readlink; on
    macOS ``F_GETPATH`` is the equivalent. Asked *after* the open, so it reports the
    file that was actually opened, not the path resolved beforehand.
    """
    for prefix in ("/proc/self/fd", "/dev/fd"):
        try:
            return os.readlink(f"{prefix}/{fd}")
        except OSError:
            continue
    try:
        import array
        import fcntl

        buf = array.array("B", b"\0" * 4096)
        fcntl.fcntl(fd, fcntl.F_GETPATH, buf)
        return buf.tobytes().split(b"\0", 1)[0].decode("utf-8", "surrogateescape")
    except Exception:  # noqa: BLE001 - F_GETPATH is not on every platform
        return None


def _check_kernel_path(what: str, shown: str, fd_path: Optional[str],
                       folder: Optional[str], protected: list[tuple[str, str]],
                       *, strict: bool, home: str,
                       where: str = "the file") -> None:
    """Re-run the sign-in and files-folder checks on the kernel-reported path."""
    if fd_path is None:
        raise _refuse(
            what,
            f"the kernel could not report where {shown} really is, so it is not touched",
            "Pass a plain file inside your files folder (GWS_FILES_DIR).",
        )
    path = fd_path
    if path.endswith(" (deleted)"):
        path = path[: -len(" (deleted)")]
    if not os.path.isabs(path):
        raise _refuse(
            what,
            f"the kernel reported a location for {shown} this server cannot check "
            f"({fd_path!r}), so it is not touched",
            "Pass a plain file inside your files folder (GWS_FILES_DIR).",
        )
    for protected_path, label in protected:
        if _at_or_inside(path, protected_path):
            raise _refuse_protected(what, shown, protected_path, label, home)
    if folder is not None:
        if strict and not _strictly_inside(path, folder):
            raise _refuse(
                what,
                f"{shown} moved outside your files folder ({folder}) between the "
                f"check and the open",
                "Put the file in your files folder (GWS_FILES_DIR) and try again.",
            )
        if not strict and not _at_or_inside(path, folder):
            raise _refuse(
                what,
                f"{where} for {shown} moved outside your files folder ({folder}) "
                f"between the check and the open",
                "Put the file in your files folder (GWS_FILES_DIR) and try again.",
            )


def _refuse_hardlink(what: str, shown: str, info: os.stat_result,
                     protected_files: list[tuple[str, str]]) -> None:
    """Refuse a file that is the token or credentials under another name."""
    if info.st_nlink <= 1:
        return
    for protected_file, label in protected_files:
        try:
            target = os.stat(protected_file)
        except OSError:
            continue  # nothing to compare against, so this comparison is skipped
        if (target.st_dev, target.st_ino) == (info.st_dev, info.st_ino):
            raise _refuse(
                what,
                f"{shown} is a hard link to {label} — the same file on disk under "
                f"another name — which this server never reads for a tool call",
                "Put a copy of the file in your files folder (GWS_FILES_DIR) instead.",
            )


def open_read(path: Optional[str], what: str = "reading a local file",
              env: Optional[Mapping[str, str]] = None,
              home: Optional[str] = None) -> Tuple[str, IO[bytes]]:
    """``(real path, binary handle)`` for a local file this server may read.

    The handle is opened ``O_NOFOLLOW`` on the final component (the path is already
    resolved, so this is the second half of the same guarantee) and must be a
    regular file: a directory, a device, a FIFO or a socket is refused. After the
    open the kernel-reported path is checked again, and a multi-link file is
    compared with the sign-in files, so a swapped directory or a hard link cannot
    use the gap between ``resolve`` and the open.
    """
    env = os.environ if env is None else env
    home_path = _home(home)
    real = resolve(path, READ, what, env=env, home=home_path)
    shown = "" if path is None else str(path).strip()
    folder = files_dir(env, home_path)
    protected, protected_files = _protected(env, home_path)
    # O_NONBLOCK so a FIFO cannot block the call before the regular-file check below;
    # it changes nothing for a regular file.
    flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        fd = os.open(real, flags)
    except FileNotFoundError:
        raise PathRefused(
            f"Local file not found: {shown}. Put the file in your files folder "
            f"(GWS_FILES_DIR) and pass its path inside that folder."
        )
    except OSError as e:
        # O_NOFOLLOW refused the final component. If what is there now resolves into
        # a protected folder (or out of the files folder), name that reason instead.
        swapped = _resolved(real)
        if swapped is not None:
            for protected_path, label in protected:
                if _at_or_inside(swapped, protected_path):
                    raise _refuse_protected(
                        what, shown, protected_path, label, home_path
                    )
            if folder is not None and not _strictly_inside(swapped, folder):
                raise _refuse(
                    what,
                    f"{shown} is not inside your files folder ({folder})",
                    "Put the file in your files folder (GWS_FILES_DIR) and pass its "
                    "path inside that folder (or a name relative to it).",
                )
        raise _refuse(
            what,
            f"{shown} cannot be opened ({e.strerror or e})",
            "Pass a plain file inside your files folder (GWS_FILES_DIR).",
        )
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise _refuse(
                what,
                f"{shown} is not a regular file (a folder, a device or a pipe)",
                "Pass a plain file inside your files folder (GWS_FILES_DIR).",
            )
        _refuse_hardlink(what, shown, info, protected_files)
        _check_kernel_path(
            what, shown, _fd_path(fd), folder, protected, strict=True, home=home_path
        )
        return real, os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def open_write(path: Optional[str], what: str = "writing a local file",
               env: Optional[Mapping[str, str]] = None,
               home: Optional[str] = None) -> Tuple[str, IO[bytes]]:
    """Create ``path`` and return ``(real path, binary handle)``.

    Never overwrites: the file is created ``O_CREAT|O_EXCL|O_NOFOLLOW`` at mode 0600,
    so an existing file, a symlink and (on Linux) a file being created elsewhere at
    the same moment are all refusals. None of the tools that write a local file has
    an overwrite flag, so there is no path through this function that replaces one.
    The parent directory's kernel-reported path is checked before the create, and
    the new file's own path after it, so a directory swapped for a symlink between
    ``resolve`` and the open is refused (the empty file it created is removed).
    """
    env = os.environ if env is None else env
    home_path = _home(home)
    real = resolve(path, WRITE, what, env=env, home=home_path)
    shown = "" if path is None else str(path).strip()
    folder = files_dir(env, home_path)
    protected, _protected_files = _protected(env, home_path)

    # The un-resolved target: a symlink here is refused by name, which reads better
    # than the "already exists" the O_EXCL open would give (it is the same refusal).
    candidate = _candidate(shown, folder, home_path)
    if os.path.islink(candidate):
        raise _refuse(
            what,
            f"{shown} is a symbolic link, and this server never writes through one",
            "Pass the name of a plain file inside your files folder (GWS_FILES_DIR).",
        )
    if os.path.lexists(candidate):
        raise _refuse(
            what,
            f"{shown} already exists, and this server never overwrites a local file",
            "Choose a name that is not taken yet (or delete the old file first).",
        )

    parent = os.path.dirname(real) or os.sep
    base = os.path.basename(real)
    if not base:
        raise _refuse(
            what,
            f"{shown} does not name a file",
            "Pass the name of a file inside your files folder (GWS_FILES_DIR).",
        )
    try:
        dir_fd = os.open(
            parent,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as e:
        # O_NOFOLLOW refused a parent that is now a symlink. If the swap points into
        # a folder this server protects, name that instead of a bare ELOOP.
        swapped = _resolved(parent)
        if swapped is not None:
            for protected_path, label in protected:
                if _at_or_inside(swapped, protected_path):
                    raise _refuse_protected(
                        what, shown, protected_path, label, home_path
                    )
            if folder is not None and not _at_or_inside(swapped, folder):
                raise _refuse(
                    what,
                    f"the folder it would be created in for {shown} is not inside "
                    f"your files folder ({folder})",
                    "Put the file in your files folder (GWS_FILES_DIR) and try "
                    "again.",
                )
        raise _refuse(
            what,
            f"the folder {parent} does not exist or cannot be opened "
            f"({e.strerror or e})",
            "Create that folder inside your files folder (GWS_FILES_DIR), or pass a "
            "name directly in it.",
        )
    handle: Optional[IO[bytes]] = None
    try:
        # The directory the kernel actually opened — before anything is created in
        # it, so a swapped path can never leave a file in a protected folder.
        _check_kernel_path(
            what, shown, _fd_path(dir_fd), folder, protected,
            strict=False, home=home_path,
            where="the folder it would be created in",
        )
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            fd = os.open(base, flags, 0o600, dir_fd=dir_fd)
        except FileExistsError:
            raise _refuse(
                what,
                f"{shown} already exists, and this server never overwrites a local file",
                "Choose a name that is not taken yet (or delete the old file first).",
            )
        except OSError as e:
            raise _refuse(
                what,
                f"{shown} cannot be created ({e.strerror or e})",
                "Pass the name of a plain file inside your files folder (GWS_FILES_DIR).",
            )
        try:
            _check_kernel_path(
                what, shown, _fd_path(fd), folder, protected,
                strict=True, home=home_path,
            )
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass  # the mode above is already 0600 minus the umask
            handle = os.fdopen(fd, "wb")
        except BaseException:
            os.close(fd)
            try:
                os.unlink(base, dir_fd=dir_fd)  # O_EXCL: this call created it
            except OSError:
                pass
            raise
    finally:
        os.close(dir_fd)
    if handle is None:  # unreachable: the create above either returns or raises
        raise AssertionError("open_write created no handle")
    return real, handle


# --- names, defaults and images ------------------------------------------------


def safe_name(value: object, fallback: str = "file") -> str:
    """``value`` as one filename component: ``[A-Za-z0-9._-]`` only, never ``..``.

    Google ids reach a tool as caller input, so an id is not trusted to be an id.
    Anything else (a ``/``, a ``\\``, a NUL, a space) becomes ``_``, and a value that
    is only dots (``.``, ``..``) or empty becomes ``fallback``.
    """
    text = _UNSAFE_NAME.sub("_", str(value if value is not None else "").strip())
    text = text.strip(".")
    return text or fallback


def default_path(ident: object, extension: object,
                 env: Optional[Mapping[str, str]] = None,
                 home: Optional[str] = None, attempt: int = 1) -> str:
    """Where a write with no path given lands: a new, uniquely named file.

    The files folder when one is set (the only place the guard lets a write go);
    ``/tmp`` only for an install with neither a folder nor the guard, which is what
    that install did before. With the guard on and no folder, ``resolve`` refuses
    the result, so nothing is written at all.

    The name is the sanitized id, a UTC timestamp (microseconds) and, after an
    ``O_EXCL`` collision has been retried, ``-2``, ``-3``… — so a repeated export
    with no path creates a new file instead of being refused.
    """
    folder = files_dir(env, home)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    stem = f"{safe_name(ident)}-{stamp}"
    if attempt > 1:
        stem = f"{stem}-{attempt}"
    name = f"{stem}.{safe_name(extension, 'bin')}"
    return os.path.join(folder if folder else "/tmp", name)


def open_write_default(ident: object, extension: object,
                       what: str = "writing a local file", attempts: int = 100,
                       env: Optional[Mapping[str, str]] = None,
                       home: Optional[str] = None) -> Tuple[str, IO[bytes]]:
    """Create a new file under a default, unique name (see ``default_path``).

    A name that is already taken is retried with ``-2``, ``-3``… — the retry is safe
    because each attempt goes through ``open_write``'s ``O_EXCL`` create, so it is
    the kernel that refuses an existing name, never a check-then-create here.
    """
    for attempt in range(1, attempts + 1):
        path = default_path(ident, extension, env=env, home=home, attempt=attempt)
        try:
            return open_write(path, what, env=env, home=home)
        except PathRefused as refusal:
            message = str(refusal)
            taken = "already exists" in message or "symbolic link" in message
            if not taken or attempt >= attempts:
                raise
    raise PathRefused(
        f"{what} is refused — no free default file name was found after {attempts} tries."
    )


def image_is_local(image: object, env: Optional[Mapping[str, str]] = None,
                   home: Optional[str] = None) -> bool:
    """True when ``gdocs_insert_image``'s ``image`` is a local path, not a Drive id.

    Decided without asking whether an arbitrary path exists: a value with a path
    separator, or one starting with ``~`` or ``.``, is local; a bare token shaped
    like a Drive id (``[A-Za-z0-9_-]{20,}``) is a Drive id unless it resolves
    strictly inside the files folder, where a relative name wins. Everything else is
    local and goes through ``open_read``, so a refused or missing local path reads
    the same whether or not something exists outside the folder.
    """
    env = os.environ if env is None else env
    text = "" if image is None else str(image).strip()
    if not text:
        return True
    separators = {"/", "\\", os.sep}
    if os.altsep:
        separators.add(os.altsep)
    if any(sep and sep in text for sep in separators):
        return True
    if text.startswith("~") or text.startswith("."):
        return True
    if _DRIVE_ID.fullmatch(text) is None:
        return True
    folder = files_dir(env, home)
    if folder is None:
        return False
    real = _resolved(_candidate(text, folder, _home(home)))
    # Only a name that is really there in the owner's folder wins over the id shape;
    # a real Drive id is not a file merely because its name would fit in the folder.
    return real is not None and _strictly_inside(real, folder) and os.path.lexists(real)


def is_image(head: bytes) -> bool:
    """True when ``head`` (the first bytes of a file) is a PNG, JPEG, GIF or WebP."""
    if any(head.startswith(magic) for magic in _IMAGE_MAGIC):
        return True
    # WebP: "RIFF" + a 4-byte size + "WEBP".
    return head[:4] == b"RIFF" and head[8:12] == b"WEBP"


def check_image(handle: IO[bytes], what: str = "inserting a local image",
                shown: str = "the file") -> bytes:
    """Refuse unless the handle holds an image; return the bytes it looked at.

    The Docs API fetches whatever URL it is given, so a "local image" that is really
    the token file (renamed, or pointed at by a name the caller made up) would be
    uploaded to Drive before anyone noticed. The first bytes decide.
    """
    try:
        head = handle.read(32)
    except OSError as e:
        raise _refuse(
            what,
            f"{shown} cannot be read ({e.strerror or e})",
            "Pass an image file inside your files folder (GWS_FILES_DIR).",
        )
    try:
        handle.seek(0)
    except OSError:
        pass
    if not is_image(head):
        raise _refuse(
            what,
            f"{shown} is not a PNG, JPEG, GIF or WebP image (its first bytes are "
            f"{head[:8]!r})",
            "Pass an image file inside your files folder (GWS_FILES_DIR).",
        )
    return head


def guess_mime_type(mime_type: Optional[str], path: str) -> str:
    """The mime type to hand an uploader: the caller's, else guessed from the name.

    ``googleapiclient``'s ``MediaIoBaseUpload`` takes the mime type from its caller and
    these tools hand it an open handle (so the bytes it reads are the ones this module
    checked); a handle has no name to guess from — so the guess is made here from the
    path that was validated.
    """
    if mime_type:
        return mime_type
    return mimetypes.guess_type(path)[0] or "application/octet-stream"