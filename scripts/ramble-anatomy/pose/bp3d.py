# SPDX-License-Identifier: GPL-3.0-or-later
"""BodyParts3D part lookup and OBJ reading for the Ramble anatomy pipeline.

BodyParts3D (Database Center for Life Science) ships two part hierarchies,
``isa`` and ``partof``. Each has a parts list (concept id, representation id,
english name) and an element-parts list (concept id, name, element file id).
The meshes are one OBJ per element file id; they are not part of this
repository, so every entry point is handed a cache directory instead:

    <cache>/isa_parts_list_e.txt        <cache>/isa_element_parts.txt
    <cache>/partof_parts_list_e.txt     <cache>/partof_element_parts.txt
    <cache>/isa/isa_BP3D_4.0_obj_99/<elementId>.obj
    <cache>/src/partof_BP3D_4.0_obj_99/<elementId>.obj

Raw BodyParts3D frame: millimetres, +x = the subject's LEFT, -y = FORWARD,
+z = up, so anatomical RIGHT parts have x < 0. The side-view frame used after
the landmarks stage is X = -y_raw (forward), Y = -x_raw (toward the viewer,
right side near), Z = z_raw - floorZ.

numpy only; nothing here needs Blender.
"""

import collections
import json
import os

import numpy as np

#: Hierarchies, in lookup order. ``isa`` wins; ``partof`` is the fallback.
SOURCE_ORDER = ("isa", "partof")

PARTS_LIST_FILES = {
    "isa": "isa_parts_list_e.txt",
    "partof": "partof_parts_list_e.txt",
}
ELEMENT_PARTS_FILES = {
    "isa": "isa_element_parts.txt",
    "partof": "partof_element_parts.txt",
}
OBJ_SUBDIRS = {
    "isa": os.path.join("isa", "isa_BP3D_4.0_obj_99"),
    "partof": os.path.join("src", "partof_BP3D_4.0_obj_99"),
}

#: A part whose centroid x is further than this from the midline is one-sided.
SIDE_MIDLINE_MM = 25.0

#: The whole-body mesh that defines the floor and the body height.
SKIN_NAME = "skin"

#: ``vocab_parts`` returns both halves: the drawable ids and the unresolvable ones.
VocabParts = collections.namedtuple("VocabParts", "entries missing")


def _read_tsv(path):
    """Tab-separated rows of a BodyParts3D index file, header line dropped."""
    if not os.path.isfile(path):
        raise FileNotFoundError("BodyParts3D cache file not found: %s" % path)
    rows = []
    header_seen = False
    with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
        for line in handle:
            line = line.rstrip("\r\n")
            if not line.strip():
                continue
            if not header_seen:
                header_seen = True
                continue
            rows.append(line.split("\t"))
    return rows


def _read_parts_list(path):
    """english name (lower case) -> ordered list of concept ids."""
    table = collections.OrderedDict()
    for row in _read_tsv(path):
        if len(row) < 3:
            continue
        concept = row[0].strip()
        name = row[2].strip().lower()
        if not concept or not name:
            continue
        bucket = table.setdefault(name, [])
        if concept not in bucket:
            bucket.append(concept)
    return table


def _read_element_parts(path):
    """concept id -> ordered list of element file ids."""
    table = collections.OrderedDict()
    for row in _read_tsv(path):
        if len(row) < 3:
            continue
        concept = row[0].strip()
        element_id = row[2].strip()
        if not concept or not element_id:
            continue
        bucket = table.setdefault(concept, [])
        if element_id not in bucket:
            bucket.append(element_id)
    return table


class Bp3d:
    """Look up parts by english name and read their element meshes."""

    def __init__(self, cache_dir):
        self.cache_dir = os.path.abspath(os.fspath(cache_dir))
        self._names = {}
        self._elements = {}
        for source in SOURCE_ORDER:
            self._names[source] = _read_parts_list(os.path.join(self.cache_dir, PARTS_LIST_FILES[source]))
            self._elements[source] = _read_element_parts(
                os.path.join(self.cache_dir, ELEMENT_PARTS_FILES[source])
            )
        self._objects = {}

    # -- lookup -----------------------------------------------------------

    def obj_path(self, source, element_id):
        return os.path.join(self.cache_dir, OBJ_SUBDIRS[source], element_id + ".obj")

    def _lookup(self, names):
        """First hierarchy that has element files for any name wins."""
        for source in SOURCE_ORDER:
            found = []
            seen = set()
            for name in names:
                for concept in self._names[source].get(name, ()):
                    for element_id in self._elements[source].get(concept, ()):
                        if element_id in seen:
                            continue
                        seen.add(element_id)
                        found.append((source, element_id, self.obj_path(source, element_id)))
            if found:
                return found
        return []

    def resolve(self, name):
        """Parts for ``name`` as plain, right and left variants, deduplicated."""
        label = (name or "").strip().lower()
        if not label:
            return []
        return self._lookup([label, "right " + label, "left " + label])

    def resolve_exact(self, name, side=None):
        """Parts for exactly ``[side ]name`` — no side variants are added."""
        label = (name or "").strip().lower()
        if not label:
            return []
        if side:
            label = side.strip().lower() + " " + label
        return self._lookup([label])

    # -- meshes -----------------------------------------------------------

    def read(self, path):
        """``read_obj`` with a per-instance cache (an element is often reused)."""
        mesh = self._objects.get(path)
        if mesh is None:
            mesh = read_obj(path)
            self._objects[path] = mesh
        return mesh


def read_obj(path):
    """Vertices (N x 3 float64, raw frame) and triangles (M x 3, zero based).

    Only ``v`` and ``f`` lines are read. Faces may be written as ``a``,
    ``a/b``, ``a//c`` or ``a/b/c``, indices may be negative (relative to the
    vertices seen so far), and polygons are fan-triangulated.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError("BodyParts3D element mesh not found: %s" % path)
    vertices = []
    triangles = []
    with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
        for line in handle:
            fields = line.split()
            if not fields:
                continue
            if fields[0] == "v":
                if len(fields) < 4:
                    continue
                vertices.append((float(fields[1]), float(fields[2]), float(fields[3])))
            elif fields[0] == "f":
                corners = []
                for token in fields[1:]:
                    head = token.split("/")[0]
                    if not head:
                        continue
                    index = int(head)
                    if index < 0:
                        index = len(vertices) + index + 1
                    corners.append(index - 1)
                for corner in range(1, len(corners) - 1):
                    triangles.append((corners[0], corners[corner], corners[corner + 1]))
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    if len(faces):
        inside = (faces >= 0).all(axis=1) & (faces < len(verts)).all(axis=1)
        faces = faces[inside]
    return verts, faces


def side_of(vertices):
    """'right' (centroid x < -25), 'left' (> 25) or 'mid' — raw frame."""
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    if len(verts) == 0:
        return "mid"
    centre_x = float(verts[:, 0].mean())
    if centre_x < -SIDE_MIDLINE_MM:
        return "right"
    if centre_x > SIDE_MIDLINE_MM:
        return "left"
    return "mid"


def _load_vocab(vocab_path):
    if not os.path.isfile(vocab_path):
        raise FileNotFoundError("vocabulary file not found: %s" % vocab_path)
    with open(vocab_path, "r", encoding="utf-8-sig") as handle:
        document = json.load(handle)
    entries = document.get("vocab") if isinstance(document, dict) else None
    return entries if isinstance(entries, list) else []


def _build_parts(bp, names):
    """One ``{file, side, vertices, faces}`` record per distinct element mesh."""
    parts = []
    seen = set()
    for name in names:
        for source, element_id, path in bp.resolve(name):
            key = (source, element_id)
            if key in seen:
                continue
            seen.add(key)
            verts, faces = bp.read(path)
            if len(verts) == 0:
                continue
            parts.append({"file": path, "side": side_of(verts), "vertices": verts, "faces": faces})
    return parts


def vocab_parts(bp, vocab_path):
    """Drawable side-view ids, ready to pose.

    Returns a ``VocabParts`` named tuple: ``entries`` is ``[{id, layer, area,
    parts}]`` starting with the skin, ``missing`` lists the ids whose names
    resolved to no mesh at all (never an error — a vocabulary entry may name a
    structure the local BodyParts3D copy does not carry).
    """
    entries = []
    missing = []

    skin_parts = _build_parts(bp, [SKIN_NAME])
    if skin_parts:
        entries.append({"id": SKIN_NAME, "layer": SKIN_NAME, "area": None, "parts": skin_parts})
    else:
        missing.append(SKIN_NAME)

    for item in _load_vocab(vocab_path):
        if not isinstance(item, dict) or not item.get("sideView"):
            continue
        names = [str(name).strip() for name in (item.get("bodyParts3D") or []) if str(name).strip()]
        if not names:
            continue
        parts = _build_parts(bp, names)
        entry_id = item.get("id")
        if not parts:
            missing.append(entry_id)
            continue
        entries.append(
            {"id": entry_id, "layer": item.get("layer"), "area": item.get("area"), "parts": parts}
        )
    return VocabParts(entries, missing)