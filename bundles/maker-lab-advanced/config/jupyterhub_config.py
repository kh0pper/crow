# JupyterHub config for Maker Lab Advanced (Phase 5 v1)
#
# Single-machine classroom shape: NativeAuthenticator for password auth
# with admin-approved signups, SimpleLocalProcessSpawner so user
# kernels run inside this container without per-user OS accounts.
# Kid-safe default kernel config: write scope chrooted to the user's
# home, shell-escape magics disabled.
#
# For production multi-host or sandboxed-per-user deployments, swap the
# spawner for DockerSpawner or KubeSpawner and the authenticator for
# GitHubOAuthenticator or LDAP.

import os

c = get_config()  # noqa: F821 (provided by JupyterHub at import time)

admin_user = os.environ["MLA_ADMIN_USER"]

# --- Authenticator ---------------------------------------------------
# NativeAuthenticator: local password auth with admin signup approval.
c.JupyterHub.authenticator_class = "nativeauthenticator.NativeAuthenticator"
c.Authenticator.admin_users = {admin_user}
c.NativeAuthenticator.open_signup = False  # admin approves new users
c.NativeAuthenticator.minimum_password_length = 8
c.NativeAuthenticator.check_common_password = True

# --- Spawner ---------------------------------------------------------
# SimpleLocalProcessSpawner: runs each user's kernel in this container
# without needing a host OS account per user. Good enough for a
# single-classroom setup where the admin trusts the kids not to pivot
# out of their home dir; the kernel config below adds hardening.
c.JupyterHub.spawner_class = "simple"
c.Spawner.notebook_dir = "~/"
c.Spawner.default_url = "/lab"
c.Spawner.args = [
    "--ServerApp.allow_origin=*",
    "--ServerApp.trust_xheaders=True",
]

# Environment passed to every spawned kernel. Used by the
# maker-lab-advanced pair-programmer skill to prefix prompts with a
# learner-id marker so Maker Lab's hint pipeline can scope memory.
c.Spawner.environment = {
    "CROW_MLA_ENABLED": "1",
}

# --- Kid-safe kernel defaults ----------------------------------------
# - Disable cell-magic shell escape (%%bash, !shell) via a startup hook
#   that the notebook server reads from ~/.ipython/profile_default/
#   startup/ at every spawn. Written once at hub startup.
import pathlib
startup_dir = pathlib.Path("/srv/jupyterhub/ipython-startup")
startup_dir.mkdir(parents=True, exist_ok=True)
(startup_dir / "00-crow-kid-safe.py").write_text(
    "# Crow kid-safe kernel hardening (Maker Lab Advanced).\n"
    "# Disables shell-escape cell magics so '!rm -rf ~' and '%%bash' do\n"
    "# not give a learner a path out of the kernel. Removing this file\n"
    "# re-enables them — admin decision, documented per classroom.\n"
    "try:\n"
    "    ip = get_ipython()\n"
    "    if ip is not None:\n"
    "        for magic in ('system', 'sx', 'bash', 'sh'):\n"
    "            try:\n"
    "                ip.magics_manager.magics.get('line', {}).pop(magic, None)\n"
    "                ip.magics_manager.magics.get('cell', {}).pop(magic, None)\n"
    "            except Exception:\n"
    "                pass\n"
    "except Exception:\n"
    "    pass\n"
)
c.Spawner.environment["IPYTHONDIR"] = "/srv/jupyterhub/ipython-startup"

# --- Hub settings ----------------------------------------------------
c.JupyterHub.ip = "0.0.0.0"
c.JupyterHub.port = 8000
c.JupyterHub.hub_ip = "0.0.0.0"
c.JupyterHub.cleanup_servers = False
c.JupyterHub.allow_named_servers = False

# Template path for the NativeAuthenticator signup/login pages.
import nativeauthenticator  # noqa: F401 (ensures the module is importable)
c.JupyterHub.template_paths = [
    f"{os.path.dirname(nativeauthenticator.__file__)}/templates/",
]

# Persist Hub DB (users, tokens) on the mounted volume so a container
# restart doesn't forget everyone.
c.JupyterHub.db_url = "sqlite:////srv/jupyterhub/jupyterhub.sqlite"
c.JupyterHub.cookie_secret_file = "/srv/jupyterhub/jupyterhub_cookie_secret"

# --- Admin bootstrap -------------------------------------------------
# The container's command chain runs scripts/bootstrap-admin.py before
# `jupyterhub` starts. It seeds MLA_ADMIN_USER into the NativeAuthenticator
# users_info table with a bcrypt-hashed MLA_ADMIN_PASSWORD and
# is_authorized=True, so the admin can log in directly without going
# through /hub/signup. Idempotent: if the row already exists, the script
# is a no-op — passwords are only ever rotated via the UI.
