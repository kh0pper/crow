"""`rookery-manifest` CLI — assemble an OpenScience reviewer workspace.

The `exp` subcommand encodes the pi-lab convention: a phase's evidence is
`<data-dir>/rounds.jsonl` (the append-only ground-truth round rows) and
`<data-dir>/SCORE-<phase>.md` (the generated score table).
"""

import argparse
import os
import sys

from .assemble import Evidence, assemble_workspace


def cmd_exp(args: argparse.Namespace) -> int:
    data = os.path.expanduser(args.data_dir)
    report = os.path.expanduser(args.report)
    rounds = os.path.join(data, "rounds.jsonl")
    scores = [(phase, os.path.join(data, f"SCORE-{phase}.md")) for phase in args.phase]

    for p in [report, rounds] + [path for _, path in scores]:
        if not os.path.exists(p):
            print(f"ERROR: missing input: {p}", file=sys.stderr)
            return 2

    evidence = [
        Evidence(
            src=rounds,
            script="zoo-round.sh",
            args={
                "phases": args.phase,
                "note": "append-only ground-truth round rows; the file spans all phases",
            },
        ),
    ] + [
        Evidence(src=path, script="zoo-score.py", args={"--phase": phase})
        for phase, path in scores
    ]
    ws = assemble_workspace(report, evidence, os.path.expanduser(args.workspace))
    print(ws)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="rookery-manifest")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser(
        "exp", help="Assemble a reviewer workspace for a pi-lab EXP report"
    )
    e.add_argument(
        "--report", required=True, help="Path to the EXP write-up under review"
    )
    e.add_argument(
        "--data-dir", required=True, help="Dir holding rounds.jsonl + SCORE-<phase>.md"
    )
    e.add_argument(
        "--phase",
        required=True,
        action="append",
        help="Phase label, repeatable (one SCORE-<phase>.md per value), "
        "e.g. --phase exp-j1.1b --phase exp-j1.1",
    )
    e.add_argument("--workspace", required=True, help="Target workspace dir to create")
    e.set_defaults(func=cmd_exp)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
