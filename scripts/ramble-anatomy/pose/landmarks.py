# SPDX-License-Identifier: GPL-3.0-or-later
"""Joint landmarks from BodyParts3D meshes, written as landmarks.json.

Every point is produced from named bones and from the whole-body skin; the
skin also fixes the floor (its lowest z) and the body height. Points leave
this module in the side-view frame the rest of the pipeline uses:

    X = -y_raw (forward, screen right), Y = -x_raw (toward the viewer, the
    anatomical RIGHT side is near), Z = z_raw - floorZ, all millimetres.

Command line (``-I`` keeps it isolated, hence the explicit sys.path insert):

    python3 -I landmarks.py --cache DIR --out landmarks.json

numpy only; nothing here needs Blender.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bp3d  # noqa: E402  (imported after the sys.path insert: `-I` drops the script directory)

# Region sizes used to pick a landmark out of a mesh: the prototype's
# millimetre windows for one adult reference body. Tunable, unverified.
FEMORAL_HEAD_TOP_MM = 75.0
FEMORAL_HEAD_MEDIAL_MM = 50.0
HUMERAL_HEAD_TOP_MM = 55.0
HUMERAL_HEAD_MEDIAL_MM = 45.0
KNEE_BAND_MM = 60.0
ELBOW_BAND_MM = 45.0
WRIST_BAND_MM = 25.0
SOLE_BAND_MM = 30.0
CHIN_BAND_MM = 10.0
CROWN_TOP_VERTICES = 2000
MIN_SPHERE_POINTS = 4

VERSION = 1
SOURCE = "BodyParts3D 4.0"
FRAME = "X forward, Y toward viewer (right side near), Z up; mm; floor Z=0"

SIDES = ("right", "left")
LIMB_SEGMENTS = (
    ("upperArm", "shoulder", "elbow"),
    ("forearm", "elbow", "wrist"),
    ("hand", "wrist", "hand"),
    ("thigh", "hip", "knee"),
    ("shank", "knee", "ankle"),
)

#: Segment keys in the order figure.cjs SEGMENTS lists them.
SEGMENT_ORDER = (
    "neck",
    "head",
    "trunk",
    "upperArm",
    "forearm",
    "hand",
    "thigh",
    "shank",
    "foot",
    "footHeight",
)

#: Meshes a side's limb landmarks are read from.
SIDE_PARTS = (
    "femur",
    "tibia",
    "talus",
    "calcaneus",
    "humerus",
    "radius",
    "ulna",
    "hand",
    "foot",
)


# -- mesh helpers ---------------------------------------------------------


def part_vertices(bp, name, side=None):
    """All vertices of ``[side ]name`` (raw frame), or None when it has none."""
    entries = bp.resolve_exact(name, side) if side else bp.resolve(name)
    chunks = [bp.read(path)[0] for _source, _element, path in entries]
    chunks = [chunk for chunk in chunks if len(chunk)]
    if not chunks:
        return None
    return np.vstack(chunks)


def require_vertices(bp, name, side=None):
    verts = part_vertices(bp, name, side)
    if verts is None:
        label = name if side is None else "%s %s" % (side, name)
        raise SystemExit("landmarks: no BodyParts3D mesh for %r in the cache" % label)
    return verts


def _region(points, mask):
    """Points chosen by ``mask``; too few for a fit falls back to the whole mesh."""
    selected = points[mask]
    if len(selected) < MIN_SPHERE_POINTS:
        return points
    return selected


def sphere_fit(points):
    """Least-squares sphere through ``points``: (centre, radius, mean residual)."""
    cloud = np.asarray(points, dtype=np.float64)
    design = np.column_stack([2.0 * cloud, np.ones(len(cloud))])
    targets = (cloud ** 2).sum(axis=1)
    solution = np.linalg.lstsq(design, targets, rcond=None)[0]
    centre = solution[:3]
    radius_squared = float(solution[3] + centre @ centre)
    radius = math.sqrt(radius_squared) if radius_squared > 0.0 else 0.0
    residual = float(np.abs(np.linalg.norm(cloud - centre, axis=1) - radius).mean())
    return centre, radius, residual


def _box_centre(points):
    return 0.5 * (points.min(axis=0) + points.max(axis=0))


def _to_side_view(point, floor_z):
    x, y, z = float(point[0]), float(point[1]), float(point[2])
    return [-y, -x, z - floor_z]


def _dist(a, b):
    return float(np.linalg.norm(np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)))


def _mean2(first, second):
    return 0.5 * (float(first) + float(second))


# -- landmark extraction --------------------------------------------------


def _femoral_head(femur):
    """Sphere at the top, medial end of the femur."""
    towards_midline = -np.sign(float(femur[:, 0].mean())) or 1.0
    medial = femur[:, 0] * towards_midline
    top = femur[:, 2].max() - FEMORAL_HEAD_TOP_MM
    mask = (femur[:, 2] > top) & (medial > medial.max() - FEMORAL_HEAD_MEDIAL_MM)
    return sphere_fit(_region(femur, mask))


def _humeral_head(humerus):
    """Sphere at the top, medial end of the humerus."""
    towards_midline = -np.sign(float(humerus[:, 0].mean())) or 1.0
    medial = humerus[:, 0] * towards_midline
    top = humerus[:, 2].max() - HUMERAL_HEAD_TOP_MM
    mask = (humerus[:, 2] > top) & (medial > medial.max() - HUMERAL_HEAD_MEDIAL_MM)
    return sphere_fit(_region(humerus, mask))


def side_landmarks(bp, side):
    """Raw-frame landmark points for one anatomical side, plus sphere fits."""
    parts = {name: require_vertices(bp, name, side) for name in SIDE_PARTS}
    femur = parts["femur"]
    tibia = parts["tibia"]
    humerus = parts["humerus"]

    hip, hip_radius, hip_residual = _femoral_head(femur)
    shoulder, shoulder_radius, shoulder_residual = _humeral_head(humerus)

    low_femur = femur[femur[:, 2] < femur[:, 2].min() + KNEE_BAND_MM]
    knee = np.array(
        [
            0.5 * (low_femur[:, 0].min() + low_femur[:, 0].max()),
            0.5 * (low_femur[:, 1].min() + low_femur[:, 1].max()),
            0.5 * (femur[:, 2].min() + tibia[:, 2].max()),
        ]
    )
    ankle = _box_centre(parts["talus"])

    low_humerus = humerus[humerus[:, 2] < humerus[:, 2].min() + ELBOW_BAND_MM]
    elbow = _box_centre(low_humerus)

    forearm_bones = np.vstack([parts["radius"], parts["ulna"]])
    low_forearm = forearm_bones[forearm_bones[:, 2] < forearm_bones[:, 2].min() + WRIST_BAND_MM]
    wrist = _box_centre(low_forearm)

    hand_mesh = parts["hand"]
    hand = hand_mesh[np.argmax(np.linalg.norm(hand_mesh - wrist, axis=1))]

    foot_mesh = parts["foot"]
    sole = foot_mesh[foot_mesh[:, 2] < foot_mesh[:, 2].min() + SOLE_BAND_MM]
    toe = sole[np.argmin(sole[:, 1])]

    return {
        "hip": hip,
        "shoulder": shoulder,
        "knee": knee,
        "ankle": ankle,
        "elbow": elbow,
        "wrist": wrist,
        "hand": hand,
        "toe": toe,
        "heelRearY": float(parts["calcaneus"][:, 1].max()),
        "femoralHeadRadius": float(hip_radius),
        "femoralHeadResidual": float(hip_residual),
        "humeralHeadRadius": float(shoulder_radius),
        "humeralHeadResidual": float(shoulder_residual),
    }


def axial_landmarks(bp):
    """Chin (mandible) and crown (skull), raw frame, both on the midline."""
    skull = require_vertices(bp, "skull")
    mandible = require_vertices(bp, "mandible")

    highest = np.argsort(skull[:, 2])[::-1][:CROWN_TOP_VERTICES]
    crown = np.array([0.0, float(skull[highest, 1].mean()), float(skull[:, 2].max())])

    lowest = mandible[mandible[:, 2] < mandible[:, 2].min() + CHIN_BAND_MM]
    chin = np.array([0.0, float(lowest[:, 1].mean()), float(lowest[:, 2].mean())])
    return chin, crown


def skin_extent(bp):
    """(floorZ, heightMm) from the whole-body skin mesh."""
    skin = require_vertices(bp, bp3d.SKIN_NAME)
    floor_z = float(skin[:, 2].min())
    return floor_z, float(skin[:, 2].max()) - floor_z


# -- assembly -------------------------------------------------------------


def _foot_length(toe, heel_rear_y):
    """Calcaneus rear to toe along X (forward), millimetres."""
    return float(toe[0]) - (-float(heel_rear_y))


def _ordered_segments(segments):
    """Every figure.cjs segment key, in a fixed order."""
    missing = [key for key in SEGMENT_ORDER if key not in segments]
    if missing:
        raise SystemExit("landmarks: segment(s) never computed: %s" % ", ".join(missing))
    return {key: float(segments[key]) for key in SEGMENT_ORDER}


def compute(bp):
    """The landmarks.json document for a loaded BodyParts3D cache."""
    floor_z, height_mm = skin_extent(bp)
    if not height_mm > 0.0:
        raise SystemExit("landmarks: the skin mesh has no height")

    sides = {side: side_landmarks(bp, side) for side in SIDES}
    chin, crown = axial_landmarks(bp)

    hip_mid = 0.5 * (sides["right"]["hip"] + sides["left"]["hip"])
    shoulder_mid = 0.5 * (sides["right"]["shoulder"] + sides["left"]["shoulder"])
    waist_mid = 0.5 * (hip_mid + shoulder_mid)

    raw = {}
    for name in ("hip", "knee", "ankle", "toe", "shoulder", "elbow", "wrist", "hand"):
        raw[name + "R"] = sides["right"][name]
        raw[name + "L"] = sides["left"][name]
    raw["hipMid"] = hip_mid
    raw["waistMid"] = waist_mid
    raw["shoulderMid"] = shoulder_mid
    raw["chin"] = chin
    raw["crown"] = crown

    points = {name: _to_side_view(value, floor_z) for name, value in raw.items()}

    side_lengths = {}
    for key, first, second in LIMB_SEGMENTS:
        side_lengths[key] = {
            "right": _dist(points[first + "R"], points[second + "R"]),
            "left": _dist(points[first + "L"], points[second + "L"]),
        }
    side_lengths["foot"] = {
        "right": _foot_length(points["toeR"], sides["right"]["heelRearY"]),
        "left": _foot_length(points["toeL"], sides["left"]["heelRearY"]),
    }

    segments = {key: _mean2(value["right"], value["left"]) for key, value in side_lengths.items()}
    segments["neck"] = _dist(points["shoulderMid"], points["chin"])
    segments["head"] = _dist(points["chin"], points["crown"])
    segments["trunk"] = _dist(points["hipMid"], points["shoulderMid"])
    segments["footHeight"] = _mean2(points["ankleR"][2], points["ankleL"][2])

    ordered_segments = _ordered_segments(segments)
    ratios = {key: value / height_mm for key, value in ordered_segments.items()}

    asymmetry = {}
    for key, value in side_lengths.items():
        middle = _mean2(value["right"], value["left"])
        asymmetry[key] = {
            "rightMm": value["right"],
            "leftMm": value["left"],
            "diffPct": 0.0 if middle == 0.0 else 100.0 * (value["left"] - value["right"]) / middle,
        }

    diagnostics = {
        "sphereFit": {
            "femoralHead": {
                side: {
                    "radiusMm": sides[side]["femoralHeadRadius"],
                    "residualMm": sides[side]["femoralHeadResidual"],
                }
                for side in SIDES
            },
            "humeralHead": {
                side: {
                    "radiusMm": sides[side]["humeralHeadRadius"],
                    "residualMm": sides[side]["humeralHeadResidual"],
                }
                for side in SIDES
            },
        },
        "limbAsymmetry": asymmetry,
    }

    return {
        "version": VERSION,
        "source": SOURCE,
        "frame": FRAME,
        "heightMm": height_mm,
        "floorZ": floor_z,
        "points": points,
        "segmentsMm": ordered_segments,
        "ratios": ratios,
        "diagnostics": diagnostics,
    }


# -- command line ---------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="landmarks.py",
        description="Compute landmarks.json from a BodyParts3D cache.",
    )
    parser.add_argument("--cache", required=True, help="BodyParts3D cache directory")
    parser.add_argument("--out", required=True, help="output landmarks.json")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.cache):
        raise SystemExit("landmarks: cache directory not found: %s" % args.cache)

    try:
        document = compute(bp3d.Bp3d(args.cache))
    except (OSError, KeyError, ValueError) as exc:
        raise SystemExit("landmarks: %s" % exc)

    out_path = os.path.abspath(args.out)
    parent = os.path.dirname(out_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")

    print(
        "landmarks: wrote %s (%d points, height %.1f mm, floor %.1f mm)"
        % (args.out, len(document["points"]), document["heightMm"], document["floorZ"])
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())