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
   folder set or not. The parent folders of ``GOOGLE_TOKEN_FILE`` and
   ``GOOGLE_CREDENTIALS_FILE``, ``~/.ssh``, ``~/.gnupg`` and any
   ``~/.config/google-workspace-mcp*`` sibling are refused, and so are the token
   and credentials files themselves (they are inside those folders). Every one of
   them is compared after ``os.path.realpath``, so a symlink pointing into them is
   refused too. If a protected folder cannot be resolved, nothing is allowed at
   all: unknown fails closed, never open.

2. **With no files folder set**, the outbound guard (``GWS_OUTBOUND_GUARD``)
   decides. On, every local path is refused — an install that means to wall the
   assistant in gets no local file at all until the owner names a folder. Off, an
   install that upgrades keeps behaving exactly as it did (any path it was handed),
   which is what lets this ship without breaking anyone.

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

Default output names are built from Google ids, which arrive as caller input: every
character outside ``[A-Za-z0-9._-]`` is replaced, so an id can never smuggle in a
path separator (and a value that is only dots becomes ``file``), which keeps the
write inside the folder it was resolved against. The default location is the files
folder when one is set, and ``/tmp`` only for an install with neither a folder nor
the guard (the old behaviour) — with the guard on there is no default to fall back
to, because ``resolve`` refuses first.

Pure apart from the filesystem reads it needs, and every entry point takes ``env``
and ``home`` so the tests run in a scratch tree.
"""

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

# The one default of the sign-in files this module mirrors from auth.py, used only
# to protect the folder they live in when the owner has not pointed the variables
# anywhere else (the folder is refused either way, see _PRIVATE_PATTERNS).
_DEFAULT_SIGNIN_DIR = (".config", "google-workspace-mcp")
_DEFAULT_SIGNIN_FILES = {
    "GOOGLE_TOKEN_FILE": "token.json",
    "GOOGLE_CREDENTIALS_FILE": "credentials.json",
}

# Folders that are never a files folder, whatever else is configured. The pattern
# covers a sibling sign-in directory (`google-workspace-mcp-old`, a second
# account's copy) as well as the one the defaults name.
_PRIVATE_PATTERNS = (
    ("~/.ssh", "~/.ssh"),
    ("~/.gnupg", "~/.gnupg"),
    ("~/.config/google-workspace-mcp*", "~/.config/google-workspace-mcp* (a sign-in folder)"),
)

#: What every refusal about a protected folder calls it.
_SIGNIN_LABEL = "the Google sign-in folder (the OAuth token and credentials live there)"

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")

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


def _protected_dirs(env: Mapping[str, str], home: str) -> list[tuple[str, str]]:
    """``[(dir, label)]`` no tool call may read or write, resolved.

    Fail closed: a protected folder whose real path cannot be computed refuses every
    local path, because the check itself would be blind.
    """
    candidates: list[tuple[str, str]] = []
    for name in ("GOOGLE_TOKEN_FILE", "GOOGLE_CREDENTIALS_FILE"):
        raw = (env.get(name) or "").strip()
        if raw:
            path = _expand(raw, home)
        else:
            path = os.path.join(home, *_DEFAULT_SIGNIN_DIR, _DEFAULT_SIGNIN_FILES[name])
        candidates.append((os.path.dirname(os.path.abspath(path)), _SIGNIN_LABEL))
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
                f"This tool call is refused — the folders this server protects (the "
                f"Google sign-in folder, ~/.ssh, ~/.gnupg) cannot be resolved right "
                f"now, so no local path is allowed. Fix the filesystem (a broken "
                f"symbolic link can cause this) and try again."
            )
        if (real, label) in seen:
            continue
        seen.add((real, label))
        out.append((real, label))
    return out


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
    protected = _protected_dirs(env, home_path)
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

    for protected_dir, label in protected:
        if _at_or_inside(real, protected_dir):
            raise _refuse(
                what,
                f"{shown} is in {label}, which this server never reads or writes for a "
                f"tool call",
                "Put the file in your files folder (GWS_FILES_DIR) instead.",
            )

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


def open_read(path: Optional[str], what: str = "reading a local file",
              env: Optional[Mapping[str, str]] = None,
              home: Optional[str] = None) -> Tuple[str, IO[bytes]]:
    """``(real path, binary handle)`` for a local file this server may read.

    The handle is opened ``O_NOFOLLOW`` on the final component (the path is already
    resolved, so this is the second half of the same guarantee) and must be a
    regular file: a directory, a device, a FIFO or a socket is refused.
    """
    real = resolve(path, READ, what, env=env, home=home)
    shown = "" if path is None else str(path).strip()
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
        raise _refuse(
            what,
            f"{shown} cannot be opened ({e.strerror or e})",
            "Pass a plain file inside your files folder (GWS_FILES_DIR).",
        )
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise _refuse(
                what,
                f"{shown} is not a regular file (a folder, a device or a pipe)",
                "Pass a plain file inside your files folder (GWS_FILES_DIR).",
            )
        return real, os.fdopen(fd, "rb")
    except PathRefused:
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
    """
    env = os.environ if env is None else env
    home_path = _home(home)
    real = resolve(path, WRITE, what, env=env, home=home_path)
    shown = "" if path is None else str(path).strip()

    # The un-resolved target: a symlink here is refused by name, which reads better
    # than the "already exists" the O_EXCL open would give (it is the same refusal).
    candidate = _candidate(shown, files_dir(env, home_path), home_path)
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
        dir_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError as e:
        raise _refuse(
            what,
            f"the folder {parent} does not exist or cannot be opened "
            f"({e.strerror or e})",
            "Create that folder inside your files folder (GWS_FILES_DIR), or pass a "
            "name directly in it.",
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
    finally:
        os.close(dir_fd)
    try:
        os.fchmod(fd, 0o600)
    except OSError:
        pass  # the mode above is already 0600 minus the umask
    return real, os.fdopen(fd, "wb")


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
                 home: Optional[str] = None) -> str:
    """Where a write with no path given lands: the files folder, else ``/tmp``.

    The files folder when one is set (the only place the guard lets a write go);
    ``/tmp`` only for an install with neither a folder nor the guard, which is what
    that install did before. With the guard on and no folder, ``resolve`` refuses
    the result, so nothing is written at all.
    """
    folder = files_dir(env, home)
    name = f"{safe_name(ident)}.{safe_name(extension, 'bin')}"
    return os.path.join(folder if folder else "/tmp", name)


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