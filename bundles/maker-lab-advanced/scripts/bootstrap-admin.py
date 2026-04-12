#!/usr/bin/env python3
"""
Bootstrap the initial admin account for Maker Lab Advanced.

Runs inside the JupyterHub container on every startup. Idempotent:
- If MLA_ADMIN_USER / MLA_ADMIN_PASSWORD are unset, exits 0 (noop).
- If the admin's UserInfo row already exists, exits 0 without touching it
  (password is NOT reset — operators rotate passwords via the UI).
- Otherwise, creates the row with a bcrypt-hashed password and
  is_authorized=True so the admin can log in on first launch.

Uses NativeAuthenticator's own ORM so the schema stays in lock-step with
whatever version pip just installed. The hub DB file lives at
/srv/jupyterhub/jupyterhub.sqlite (see jupyterhub_config.py).
"""

import os
import sys


def main() -> int:
    admin_user = os.environ.get("MLA_ADMIN_USER", "").strip()
    admin_password = os.environ.get("MLA_ADMIN_PASSWORD", "")

    if not admin_user or not admin_password:
        print("[bootstrap-admin] MLA_ADMIN_USER/PASSWORD unset; skipping.", flush=True)
        return 0

    try:
        import bcrypt
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from nativeauthenticator.orm import Base, UserInfo
    except Exception as exc:  # noqa: BLE001
        print(f"[bootstrap-admin] import failed ({exc}); skipping.", flush=True)
        return 0

    db_path = "/srv/jupyterhub/jupyterhub.sqlite"
    engine = create_engine(f"sqlite:///{db_path}")
    # NativeAuthenticator normally creates its tables at hub startup, but
    # we need them now. create_all is a no-op for existing tables.
    Base.metadata.create_all(engine)

    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        existing = UserInfo.find(session, admin_user)
        if existing is not None:
            print(f"[bootstrap-admin] user '{admin_user}' already present; no changes.", flush=True)
            return 0

        hashed = bcrypt.hashpw(admin_password.encode(), bcrypt.gensalt())
        user = UserInfo(
            username=admin_user,
            password=hashed,
            is_authorized=True,
        )
        session.add(user)
        session.commit()
        print(f"[bootstrap-admin] seeded admin '{admin_user}' (authorized).", flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        print(f"[bootstrap-admin] seeding failed ({exc}); admin can still use /hub/signup.", flush=True)
        return 0
    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())
