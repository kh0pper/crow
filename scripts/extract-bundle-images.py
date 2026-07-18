#!/usr/bin/env python3
"""Extract the pullable docker images referenced by bundle compose files.

Used by .github/workflows/image-freshness.yml. Walks bundles/*/docker-compose.yml,
skips services with a build: section (their image: is a local tag, never pullable),
and resolves ${VAR} / ${VAR:-default} interpolation in image references against the
bundle's own .env file. A full `docker compose config` is deliberately NOT used:
many bundles require install-time env (${VAR:?} passwords, media paths) and fail
strict interpolation, but only the image field matters here.

Interpolation values come from the bundle's .env (local/operator runs) with
.env.example as fallback (the only one present in CI — bundles/*/.env is
gitignored), then inline ${VAR:-default} defaults. An image reference that
still contains an unresolvable variable is reported as a failure, NOT
silently dropped — a silent drop would hide exactly the untracked-default
misconfiguration this checker exists to catch.

Usage: extract-bundle-images.py <images-out> <failures-out>
  images-out    one image reference per line, sorted, de-duplicated
  failures-out  compose files that could not be parsed or whose image
                reference could not be resolved (those images are unchecked)
"""

import glob
import os
import re
import sys

import yaml

INTERP = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}")


def load_env(path):
    env = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def resolve(image, env):
    unresolved = []

    def sub(match):
        name, op, default = match.group(1), match.group(2), match.group(3)
        value = env.get(name, "")
        if not value and op in (":-", "-"):
            value = default or ""
        if not value:
            unresolved.append(name)
        return value

    resolved = INTERP.sub(sub, image).strip()
    return resolved, unresolved


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: extract-bundle-images.py <images-out> <failures-out>")
    images, failures = set(), []
    for compose in sorted(glob.glob("bundles/*/docker-compose.yml")):
        bundle_dir = os.path.dirname(compose)
        env = load_env(os.path.join(bundle_dir, ".env.example"))
        env.update(load_env(os.path.join(bundle_dir, ".env")))
        try:
            with open(compose, encoding="utf-8") as f:
                doc = yaml.safe_load(f)
            services = doc.get("services") or {}
            for service in services.values():
                if not isinstance(service, dict) or "build" in service:
                    continue
                image = service.get("image")
                if isinstance(image, str):
                    resolved, unresolved = resolve(image, env)
                    if unresolved:
                        failures.append(
                            f"{compose} (unresolvable image {image!r}: "
                            f"no value or default for {', '.join(unresolved)})"
                        )
                    elif resolved:
                        images.add(resolved)
        except Exception:
            failures.append(f"{compose} (compose parse failure)")
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        f.writelines(img + "\n" for img in sorted(images))
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.writelines(path + "\n" for path in failures)
    print(f"{len(images)} unique pullable images, {len(failures)} parse failures")


if __name__ == "__main__":
    main()
