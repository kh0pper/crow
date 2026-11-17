# SPDX-License-Identifier: GPL-3.0-or-later
"""Pose BodyParts3D part meshes with our own 16-bone armature.

The armature is described by rig.json: one bone per entry, head and tail taken
from landmarks.json, target head and tail taken from the pose's solved joints.
Each bone is hinged about the lateral Y axis through its rest head, scaled
along its own rest axis so its tail lands on the target tail, and finally
translated so its head lands on the target head; the mesh then follows the
same joint angles figure.cjs already draws with.

Skinning is linear blend skinning: every vertex is weighted by its distance to
each candidate bone's rest segment, w = (d / radiusMm) ** -p, normalised.

Two engines produce the same vertices:

* ``blender`` — a real armature, one mesh per id with vertex groups and an
  Armature modifier, read back from the evaluated depsgraph. Needs ``bpy``.
* ``numpy`` — :func:`apply_lbs` on the matrices. Runs under plain python3.

The numpy half (:func:`bone_matrices`, :func:`skin_weights`,
:func:`apply_lbs`) imports and runs without Blender. Run it here:

    python3 -I bpy_pose.py --cache DIR --vocab FILE --rig FILE \
        --landmarks FILE --pose FILE --out DIR --engine numpy

Inside Blender (everything after ``--`` is ours):

    blender -b --factory-startup --python bpy_pose.py -- ARGS

The side-view frame is X forward, Y toward the viewer (anatomical right near),
Z up, millimetres, floor at Z = 0. Work happens in it directly: millimetres
throughout, no unit scaling.
"""

import argparse
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bp3d  # noqa: E402  (after the sys.path insert: `python3 -I` drops the script directory)

#: Weight falloff sharpness, w = (d / radiusMm) ** -WEIGHT_POWER. Tunable, unverified.
WEIGHT_POWER = 4
#: Weights below this are dropped and the rest renormalised.
MIN_WEIGHT = 0.02
#: Floor of the distance/radius ratio, so a vertex on a bone axis stays finite.
MIN_FALLOFF = 0.35
#: A one-sided bone only reaches this far across the midline.
SIDE_BAND_MM = 15.0
#: A bone shorter than this is degenerate; it gets a 1 mm stand-in direction.
ZERO_LENGTH_MM = 1.0
STANDIN_DIRECTION = (0.0, 0.0, 1.0)
#: Range the per-bone length scale is clamped to; 1.0 is the rest length.
SCALE_MIN = 0.3
SCALE_MAX = 3.0
SIDES = ("right", "left", "mid")


# -- side-view frame ------------------------------------------------------


def to_side_view(vertices, floor_z):
    """Raw BodyParts3D vertices -> side-view frame (X=-y, Y=-x, Z=z-floorZ)."""
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    return np.column_stack((-verts[:, 1], -verts[:, 0], verts[:, 2] - float(floor_z)))


# -- bones ----------------------------------------------------------------


def _point(points, name, label):
    try:
        value = points[name]
    except (KeyError, TypeError):
        raise ValueError("%s has no point %r" % (label, name))
    return np.asarray(value, dtype=np.float64).reshape(3)


def _joint(joints, name):
    try:
        joint = joints[name]
    except (KeyError, TypeError):
        raise ValueError("pose joints have no %r" % name)
    if not isinstance(joint, dict) or "x" not in joint or "z" not in joint:
        raise ValueError("pose joint %r needs numeric x and z" % name)
    return float(joint["x"]), float(joint["z"])


def _direction_xz(vector):
    """The (X, Z) part of a direction, with the 1 mm zero-length stand-in."""
    dx = float(vector[0])
    dz = float(vector[2])
    if math.hypot(dx, dz) < ZERO_LENGTH_MM:
        return STANDIN_DIRECTION[0], STANDIN_DIRECTION[2]
    return dx, dz


def hinge_angle(rest_vector, target_vector):
    """Angle that turns the rest (X, Z) direction onto the target one."""
    rest_x, rest_z = _direction_xz(rest_vector)
    target_x, target_z = _direction_xz(target_vector)
    dot = rest_x * target_x + rest_z * target_z
    cross = rest_x * target_z - rest_z * target_x
    if dot == 0.0 and cross == 0.0:
        return 0.0
    return math.atan2(cross, dot)


def _xz_length(vector):
    """Length of a vector's forward/up (X, Z) components."""
    return math.hypot(float(vector[0]), float(vector[2]))


def _rest_axis(vector):
    """Unit 3D direction of a rest bone, with the stand-in when it is degenerate."""
    vector = np.asarray(vector, dtype=np.float64).reshape(3)
    length = float(np.linalg.norm(vector))
    if length < ZERO_LENGTH_MM:
        return np.asarray(STANDIN_DIRECTION, dtype=np.float64)
    return vector / length


def scale_factor(rest_vector, target_vector):
    """How far the bone must stretch along its axis to reach the target tail.

    The factor is the ratio of the target's (X, Z) length to the rest one's,
    clamped to [:data:`SCALE_MIN`, :data:`SCALE_MAX`]; a rest bone with no
    (X, Z) extent gets 1. Returns ``(scale, clamped)``, where ``clamped`` says
    whether the clamp actually fired.
    """
    rest_xz = _xz_length(rest_vector)
    if rest_xz <= ZERO_LENGTH_MM:
        return 1.0, False
    scale = _xz_length(target_vector) / rest_xz
    clamped = scale < SCALE_MIN or scale > SCALE_MAX
    return min(max(scale, SCALE_MIN), SCALE_MAX), clamped


def axis_scale_matrix(unit, scale):
    """3x3 S = I + (s - 1) u u^T: stretch along ``u`` only, nothing across it."""
    unit = np.asarray(unit, dtype=np.float64).reshape(3)
    return np.eye(3, dtype=np.float64) + (float(scale) - 1.0) * np.outer(unit, unit)


def bone_transform(head, tail, theta, scale, target_head):
    """4x4 per-bone transform: T(target head) . R(theta about Y) . S . T(-head).

    The hinge about the lateral Y axis turns the rest (X, Z) direction onto the
    target one, a vector (dx, dz) mapping to (dx*cos - dz*sin, dx*sin + dz*cos).
    ``S`` then stretches the bone along its own rest axis (``tail - head``) by
    ``scale``, so the tail lands on the target tail instead of falling short or
    overshooting; nothing is scaled across the axis. Finally the head is moved
    onto the target head's (X, Z) while its Y stays at the rest value.

    The bone-local Y axis follows the rest axis, so ``S`` is a plain bone-local
    Y scale for the Blender armature.
    """
    head = np.asarray(head, dtype=np.float64).reshape(3)
    target_head = np.asarray(target_head, dtype=np.float64).reshape(3)
    cos, sin = math.cos(theta), math.sin(theta)
    rotation = np.array(
        [[cos, 0.0, -sin], [0.0, 1.0, 0.0], [sin, 0.0, cos]], dtype=np.float64
    )
    linear = rotation @ axis_scale_matrix(_rest_axis(tail - head), scale)
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = linear
    matrix[:3, 3] = target_head - linear @ head
    return matrix


def bone_matrices(rig, landmarks, pose):
    """Per-bone rest segments and 4x4 side-view transforms.

    Each transform rotates the bone onto its target direction and scales it
    along its own axis (see :func:`bone_transform`).

    Returns ``(bones, matrices)``: ``bones`` is a list of dicts with ``name``,
    ``side``, ``head``, ``tail``, ``radiusMm`` and the diagnostics
    ``thetaDeg``/``scale``/``scaleClamped``/``tailErrorMm``; ``matrices`` is a
    (B, 4, 4) array. Feed them to :func:`skin_weights` and :func:`apply_lbs` in
    that order.
    """
    points = landmarks["points"]
    joints = pose["joints"]
    bones = []
    matrices = []
    for spec in rig["bones"]:
        head = _point(points, spec["lmFrom"], "landmarks")
        tail = _point(points, spec["lmTo"], "landmarks")
        fig_from = _joint(joints, spec["figFrom"])
        fig_to = _joint(joints, spec["figTo"])
        target_head = np.array([fig_from[0], head[1], fig_from[1]], dtype=np.float64)
        target_tail = np.array([fig_to[0], tail[1], fig_to[1]], dtype=np.float64)

        rest_vector = tail - head
        target_vector = target_tail - target_head
        theta = hinge_angle(rest_vector, target_vector)
        scale, scale_clamped = scale_factor(rest_vector, target_vector)
        matrix = bone_transform(head, tail, theta, scale, target_head)
        moved_tail = matrix[:3, :3] @ tail + matrix[:3, 3]

        bones.append(
            {
                "name": spec["name"],
                "side": spec["side"],
                "head": head,
                "tail": tail,
                "radiusMm": float(spec["radiusMm"]),
                "thetaDeg": math.degrees(theta),
                "scale": scale,
                "scaleClamped": scale_clamped,
                "tailErrorMm": float(np.linalg.norm(moved_tail - target_tail)),
            }
        )
        matrices.append(matrix)
    stacked = np.asarray(matrices, dtype=np.float64).reshape(-1, 4, 4)
    return bones, stacked


# -- skinning -------------------------------------------------------------


def _segment_distance(points, head, tail):
    """Distance from every point to the segment [head, tail] (3D)."""
    head = np.asarray(head, dtype=np.float64)
    tail = np.asarray(tail, dtype=np.float64)
    segment = tail - head
    length_squared = float(segment @ segment)
    if length_squared <= 0.0:
        return np.linalg.norm(points - head, axis=1)
    t = np.clip(((points - head) @ segment) / length_squared, 0.0, 1.0)
    return np.linalg.norm(points - (head + t[:, None] * segment), axis=1)


def side_allowed(vertex_y, bones):
    """Per vertex and bone: may this bone influence this vertex?

    Centre bones always may; a right-side bone only where the vertex is on the
    near half (Y > -15) and a left-side bone only where it is on the far half
    (Y < 15).
    """
    allowed = np.ones((len(vertex_y), len(bones)), dtype=bool)
    sides = np.array([str(bone.get("side", "C")) for bone in bones])
    near = np.asarray(vertex_y, dtype=np.float64) > -SIDE_BAND_MM
    far = np.asarray(vertex_y, dtype=np.float64) < SIDE_BAND_MM
    allowed &= ~((sides == "R")[None, :] & ~near[:, None])
    allowed &= ~((sides == "L")[None, :] & ~far[:, None])
    return allowed


def skin_weights(vertices, bones, p=WEIGHT_POWER):
    """(N, B) blend weights for a whole mesh at once.

    Distance to each candidate bone's rest segment, scaled by that bone's
    radius, raised to ``-p``, masked to the allowed sides, normalised, then
    thresholded at :data:`MIN_WEIGHT` and renormalised. A vertex's largest
    weight always survives the threshold.
    """
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    count = len(verts)
    bone_count = len(bones)
    if count == 0 or bone_count == 0:
        return np.zeros((count, bone_count), dtype=np.float64)

    distance = np.empty((count, bone_count), dtype=np.float64)
    for index, bone in enumerate(bones):
        distance[:, index] = _segment_distance(verts, bone["head"], bone["tail"])
    radius = np.maximum(np.array([float(bone["radiusMm"]) for bone in bones], dtype=np.float64), ZERO_LENGTH_MM)
    ratio = distance / radius[None, :]
    allowed = side_allowed(verts[:, 1], bones)

    scaled = np.maximum(ratio, MIN_FALLOFF)
    weights = np.where(allowed, scaled ** (-float(p)), 0.0)

    totals = weights.sum(axis=1)
    stranded = totals <= 0.0
    if stranded.any():
        # Every bone was masked out for this vertex: hand it to the nearest one.
        cost = np.where(allowed, ratio, np.inf)
        rows = np.nonzero(stranded)[0]
        nearest = np.argmin(cost[rows], axis=1)
        weights[rows, nearest] = 1.0
        totals = weights.sum(axis=1)

    weights = weights / totals[:, None]
    largest = np.argmax(weights, axis=1)
    keep = weights >= MIN_WEIGHT
    keep[np.arange(count), largest] = True
    weights = np.where(keep, weights, 0.0)
    return weights / weights.sum(axis=1)[:, None]


def apply_lbs(vertices, weights, matrices):
    """Linear blend skinning: sum of w_b * (M_b applied to v), per vertex."""
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    blend = np.asarray(weights, dtype=np.float64)
    transforms = np.asarray(matrices, dtype=np.float64).reshape(-1, 4, 4)
    if len(verts) == 0:
        return verts.copy()
    homogeneous = np.hstack([verts, np.ones((len(verts), 1))])
    posed = np.zeros_like(verts)
    for index in range(transforms.shape[0]):
        column = blend[:, index]
        active = column > 0.0
        if not active.any():
            continue
        posed[active] += column[active][:, None] * (homogeneous[active] @ transforms[index, :3, :].T)
    return posed


# -- meshes ---------------------------------------------------------------


def build_meshes(cache_dir, vocab_path, floor_z):
    """Load the drawable ids in the side-view frame; also return missing ids."""
    bp = bp3d.Bp3d(cache_dir)
    result = bp3d.vocab_parts(bp, vocab_path)
    meshes = []
    for entry in result.entries:
        parts = []
        for part in entry["parts"]:
            verts = to_side_view(part["vertices"], floor_z)
            if len(verts) == 0:
                continue
            parts.append(
                {
                    "side": part["side"],
                    "vertices": verts,
                    "faces": np.asarray(part["faces"], dtype=np.int64).reshape(-1, 3),
                }
            )
        if parts:
            meshes.append({"id": entry["id"], "layer": entry["layer"], "area": entry["area"], "parts": parts})
    return meshes, list(result.missing)


def stack_parts(parts):
    """One id's parts as (vertices, faces, spans) in one coordinate list."""
    chunks = []
    faces = []
    spans = []
    start = 0
    for part in parts:
        count = len(part["vertices"])
        spans.append({"side": part["side"], "start": start, "count": count})
        chunks.append(part["vertices"])
        faces.append(part["faces"] + start)
        start += count
    vertices = np.vstack(chunks)
    stacked_faces = np.vstack(faces) if faces else np.zeros((0, 3), dtype=np.int64)
    return vertices, stacked_faces.astype(np.int64), spans


def split_by_side(parts, spans, posed):
    """Group an id's posed vertices into right/left/mid objects for writing."""
    groups = []
    for side in SIDES:
        chunks = []
        faces = []
        offset = 0
        for part, span in zip(parts, spans):
            if span["side"] != side or span["count"] == 0:
                continue
            chunks.append(posed[span["start"] : span["start"] + span["count"]])
            faces.append(part["faces"] + offset)
            offset += span["count"]
        if not chunks:
            continue
        group_faces = np.vstack(faces) if faces else np.zeros((0, 3), dtype=np.int64)
        if len(group_faces) == 0:
            continue
        groups.append((side, np.vstack(chunks), group_faces))
    return groups


def write_posed_obj(path, groups, note):
    """One OBJ: up to three ``o`` objects, 1-based indices global in the file."""
    lines = ["# %s" % note] if note else []
    vertex_index = 1
    for side, vertices, faces in groups:
        lines.append("o " + side)
        for vertex in vertices:
            lines.append("v %.4f %.4f %.4f" % (float(vertex[0]), float(vertex[1]), float(vertex[2])))
        for face in faces:
            lines.append(
                "f %d %d %d" % (int(face[0]) + vertex_index, int(face[1]) + vertex_index, int(face[2]) + vertex_index)
            )
        vertex_index += len(vertices)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


# -- blender engine -------------------------------------------------------


def _import_bpy():
    try:
        import bpy  # noqa: F401  (only the blender engine may touch it)
    except ImportError as exc:
        raise SystemExit("bpy_pose: the blender engine needs Blender's bundled python: %s" % exc)
    return bpy


def build_armature(bpy, bones):
    """Armature object whose bones are the rig, no parents, no connections."""
    data = bpy.data.armatures.new("ramble_rig")
    obj = bpy.data.objects.new("ramble_rig", data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for bone in bones:
        edit_bone = data.edit_bones.new(bone["name"])
        head = np.asarray(bone["head"], dtype=np.float64)
        tail = np.asarray(bone["tail"], dtype=np.float64)
        if float(np.linalg.norm(tail - head)) < ZERO_LENGTH_MM:
            tail = head + np.asarray(STANDIN_DIRECTION, dtype=np.float64)
        edit_bone.head = tuple(float(value) for value in head)
        edit_bone.tail = tuple(float(value) for value in tail)
        edit_bone.roll = 0.0
        edit_bone.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj, data


def build_mesh_object(bpy, mesh_id, stack, armature_object, bones):
    """Mesh object with one vertex group per bone and an Armature modifier."""
    mesh = bpy.data.meshes.new("ramble_" + str(mesh_id))
    verts = [tuple(float(value) for value in vertex) for vertex in stack["vertices"]]
    faces = [tuple(int(index) for index in face) for face in stack["faces"]]
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    obj = bpy.data.objects.new("ramble_" + str(mesh_id), mesh)
    bpy.context.scene.collection.objects.link(obj)

    weights = stack["weights"]
    for column, bone in enumerate(bones):
        group = obj.vertex_groups.new(name=bone["name"])
        column_weights = weights[:, column]
        for vertex_index in np.nonzero(column_weights)[0]:
            group.add([int(vertex_index)], float(column_weights[vertex_index]), "REPLACE")

    modifier = obj.modifiers.new(name="Armature", type="ARMATURE")
    modifier.object = armature_object
    modifier.use_deform_preserve_volume = False
    return obj


def blender_pose(stacks, bones, matrices):
    """Deform every id with a real armature; returns {id: posed vertices}.

    Each per-bone matrix already carries the rotation and the scale along the
    bone's own axis, so ``pb.matrix = M @ bone.matrix_local`` gives the pose
    bone a plain bone-local Y scale next to the rotation.
    """
    bpy = _import_bpy()
    from mathutils import Matrix

    armature_object, armature_data = build_armature(bpy, bones)
    objects = {}
    for mesh_id, stack in stacks.items():
        objects[mesh_id] = build_mesh_object(bpy, mesh_id, stack, armature_object, bones)

    for bone, matrix in zip(bones, matrices):
        pose_bone = armature_object.pose.bones[bone["name"]]
        pose_bone.rotation_mode = "QUATERNION"
        transform = Matrix([[float(value) for value in row] for row in matrix])
        rest = armature_data.bones[bone["name"]].matrix_local
        pose_bone.matrix = transform @ rest
    bpy.context.view_layer.update()

    depsgraph = bpy.context.evaluated_depsgraph_get()
    posed = {}
    for mesh_id, obj in objects.items():
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        coords = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.foreach_get("co", coords)
        posed[mesh_id] = coords.reshape(-1, 3).astype(np.float64)
        evaluated.to_mesh_clear()
    return posed


def verify_against_numpy(stacks, posed):
    """Largest absolute per-vertex difference between Blender and LBS."""
    per_id = {}
    for mesh_id, stack in stacks.items():
        expected = apply_lbs(stack["vertices"], stack["weights"], stack["matrices"])
        difference = np.abs(expected - posed[mesh_id])
        per_id[mesh_id] = float(difference.max()) if difference.size else 0.0
    return {
        "maxDiffMm": max(per_id.values()) if per_id else 0.0,
        "perIdMaxDiffMm": {key: round(value, 6) for key, value in per_id.items()},
    }


# -- command line ---------------------------------------------------------


def script_args(argv=None):
    """Our arguments: everything after the ``--`` Blender passes through."""
    args = list(sys.argv[1:] if argv is None else argv)
    if "--" in args:
        args = args[args.index("--") + 1 :]
    return args


def parse_args(args):
    parser = argparse.ArgumentParser(
        prog="bpy_pose.py",
        description="Pose BodyParts3D parts with the RAMBLE rig.",
    )
    parser.add_argument("--cache", required=True, help="BodyParts3D cache directory")
    parser.add_argument("--vocab", required=True, help="vocab.json")
    parser.add_argument("--rig", required=True, help="rig.json")
    parser.add_argument("--landmarks", required=True, help="landmarks.json")
    parser.add_argument("--pose", required=True, help="pose.json")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--only", default="", help="comma separated ids to pose")
    parser.add_argument("--engine", choices=("blender", "numpy"), default="blender")
    parser.add_argument("--verify", action="store_true", help="also run LBS and record the difference")
    parser.add_argument("--variant-note", default="", help="free text recorded in the manifest")
    return parser.parse_args(args)


def load_json(path, label):
    if not os.path.isfile(path):
        raise SystemExit("bpy_pose: missing %s file: %s" % (label, path))
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def progress(message):
    print("[pose] " + message, flush=True)


def select_meshes(meshes, only):
    """Meshes in the requested order; ids no mesh exists for go to ``unknown``."""
    if not only:
        return list(meshes), []
    by_id = {mesh["id"]: mesh for mesh in meshes}
    selected = []
    unknown = []
    for wanted in [item.strip() for item in only.split(",") if item.strip()]:
        if wanted in by_id:
            selected.append(by_id[wanted])
        else:
            unknown.append(wanted)
    return selected, unknown


def run(argv=None):
    """Resolve, weight, deform and write; returns the manifest it wrote."""
    args = parse_args(script_args(argv))
    started = time.perf_counter()

    rig = load_json(args.rig, "rig")
    landmark_data = load_json(args.landmarks, "landmarks")
    pose = load_json(args.pose, "pose")
    if not os.path.isdir(args.cache):
        raise SystemExit("bpy_pose: missing BodyParts3D cache directory: %s" % args.cache)
    if not os.path.isfile(args.vocab):
        raise SystemExit("bpy_pose: missing vocab file: %s" % args.vocab)
    try:
        floor_z = float(landmark_data["floorZ"])
    except (KeyError, TypeError):
        raise SystemExit("bpy_pose: landmarks file has no floorZ")
    if not rig.get("bones"):
        raise SystemExit("bpy_pose: rig file has no bones")
    load_seconds = time.perf_counter() - started
    progress(
        "load %.2fs bones=%d pose=%s#%s"
        % (load_seconds, len(rig["bones"]), pose.get("entry"), pose.get("position"))
    )

    stage = time.perf_counter()
    meshes, missing = build_meshes(args.cache, args.vocab, floor_z)
    resolve_seconds = time.perf_counter() - stage
    progress("resolve %.2fs ids=%d missing=%d" % (resolve_seconds, len(meshes), len(missing)))

    selected, unknown = select_meshes(meshes, args.only)
    if unknown:
        unresolved = [mesh_id for mesh_id in unknown if mesh_id in missing]
        absent = [mesh_id for mesh_id in unknown if mesh_id not in missing]
        if unresolved:
            progress("skip %d id(s) with no mesh: %s" % (len(unresolved), ",".join(unresolved)))
        if absent:
            raise SystemExit("bpy_pose: no such vocabulary id: %s" % ",".join(absent))

    stage = time.perf_counter()
    bones, matrices = bone_matrices(rig, landmark_data, pose)
    bones_seconds = time.perf_counter() - stage
    progress("bones %.2fs count=%d" % (bones_seconds, len(bones)))

    stage = time.perf_counter()
    stacks = {}
    for mesh in selected:
        vertices, faces, spans = stack_parts(mesh["parts"])
        stacks[mesh["id"]] = {
            "mesh": mesh,
            "vertices": vertices,
            "faces": faces,
            "spans": spans,
            "weights": skin_weights(vertices, bones, WEIGHT_POWER),
            "matrices": matrices,
        }
    total_vertices = sum(len(stack["vertices"]) for stack in stacks.values())
    weights_seconds = time.perf_counter() - stage
    progress("weights %.2fs vertices=%d" % (weights_seconds, total_vertices))

    stage = time.perf_counter()
    verify = None
    if args.engine == "blender":
        posed = blender_pose(stacks, bones, matrices)
        if args.verify:
            verify = verify_against_numpy(stacks, posed)
            progress("verify maxDiffMm=%.6f" % verify["maxDiffMm"])
    else:
        posed = {
            mesh_id: apply_lbs(stack["vertices"], stack["weights"], matrices)
            for mesh_id, stack in stacks.items()
        }
        if args.verify:
            progress("verify skipped: the numpy engine is the reference")
    deform_seconds = time.perf_counter() - stage
    progress("deform %.2fs engine=%s" % (deform_seconds, args.engine))

    stage = time.perf_counter()
    posed_dir = os.path.join(args.out, "posed")
    os.makedirs(posed_dir, exist_ok=True)
    ids_report = {}
    for mesh_id, stack in stacks.items():
        groups = split_by_side(stack["mesh"]["parts"], stack["spans"], posed[mesh_id])
        write_posed_obj(
            os.path.join(posed_dir, mesh_id + ".obj"),
            groups,
            "%s posed with the ramble rig (%s engine)" % (mesh_id, args.engine),
        )
        ids_report[mesh_id] = {
            "vertices": int(len(stack["vertices"])),
            "faces": int(len(stack["faces"])),
            "sides": {
                side: {"vertices": int(len(vertices)), "faces": int(len(faces))}
                for side, vertices, faces in groups
            },
        }
    write_seconds = time.perf_counter() - stage

    manifest = {
        "engine": args.engine,
        "ids": ids_report,
        "missing": missing,
        "bones": [
            {
                "name": bone["name"],
                "thetaDeg": round(bone["thetaDeg"], 4),
                "scale": round(bone["scale"], 6),
                "scaleClamped": bone["scaleClamped"],
                "tailErrorMm": round(bone["tailErrorMm"], 4),
            }
            for bone in bones
        ],
        "timingsSeconds": {
            "load": round(load_seconds, 3),
            "resolve": round(resolve_seconds, 3),
            "bones": round(bones_seconds, 3),
            "weights": round(weights_seconds, 3),
            "deform": round(deform_seconds, 3),
            "write": round(write_seconds, 3),
            "total": round(time.perf_counter() - started, 3),
        },
    }
    if verify is not None:
        manifest["verify"] = verify
    if args.variant_note:
        manifest["variantNote"] = args.variant_note

    manifest_path = os.path.join(posed_dir, "_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    progress("write %.2fs ids=%d manifest=%s" % (write_seconds, len(ids_report), manifest_path))
    progress("total %.2fs" % (time.perf_counter() - started))
    return manifest


def main(argv=None):
    try:
        run(argv)
    except (OSError, KeyError, TypeError, ValueError, AttributeError) as exc:
        raise SystemExit("bpy_pose: %s" % exc)


if __name__ == "__main__":
    main()