# scrub-env.sh — defense-in-depth env scrub, sourced by entrypoint.sh right
# before OpenScience starts. POSIX sh.
#
# This is a DENYLIST and therefore only belt-and-suspenders (a denylist is
# exactly what upstream's own sandboxing plan warns against): the allowlist
# wrapper-exec.sh is THE mechanism protecting MCP children. The scrub
# additionally keeps credential-shaped vars out of the OpenScience process
# itself (and any child the wrapper doesn't cover).
#
# MODEL_BASE_URL / MODEL_API_KEY have already landed in the generated
# openscience.json by the time this runs, so dropping them costs nothing.
#
# Sourced, not executed — `unset` must affect the caller's environment.

for _scrub_v in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
  case $_scrub_v in
    HOME|PATH|XDG_CONFIG_HOME|PWD|SHLVL|_|HOSTNAME|TERM)
      ;;  # required by the shell / the app
    *_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_CREDENTIAL|*_CREDENTIALS|\
    THK_*|CROW_*|ANTHROPIC_*|OPENAI_*|AWS_*|GH_*|GITHUB_*|NTFY_*|\
    MODEL_BASE_URL)
      unset "$_scrub_v" 2>/dev/null || true
      ;;
  esac
done
unset _scrub_v
