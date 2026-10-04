package press.maestro.crow;

import java.net.URI;
import java.util.Locale;

/**
 * Pure origin helpers for the native bridges (no Android imports, so it can be
 * unit-tested on a plain JVM). An origin is scheme + host + port, compared
 * EXACTLY: same host on another port (Nextcloud :8456, ONLYOFFICE :8457, ...)
 * is a different origin, and so is every other host on the tailnet.
 *
 * Security fix 2026-10-04 (Ramble steps, spec §10 "Exposure").
 */
final class OriginCheck {

    private OriginCheck() { }

    /**
     * Canonical "scheme://host:port" for an http(s) URL or origin string, with
     * the scheme and host lowercased and a missing port filled in (443 for
     * https, 80 for http). Null for anything else: other schemes, no host,
     * an opaque "null" origin, junk.
     */
    static String canonical(String url) {
        if (url == null) return null;
        String s = url.trim();
        if (s.isEmpty()) return null;
        URI u;
        try {
            u = new URI(s);
        } catch (Exception e) {
            return null;
        }
        String scheme = u.getScheme();
        String host = u.getHost();
        if (scheme == null || host == null || host.isEmpty()) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        int def;
        if (scheme.equals("https")) def = 443;
        else if (scheme.equals("http")) def = 80;
        else return null;
        int port = u.getPort();
        if (port == -1) port = def;
        if (port < 1 || port > 65535) return null;
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
    }

    /** True only when both parse and name exactly the same scheme, host and port. */
    static boolean sameOrigin(String a, String b) {
        String ca = canonical(a);
        return ca != null && ca.equals(canonical(b));
    }

    /**
     * The origin in the form WebViewCompat.addWebMessageListener's
     * allowedOriginRules expects: "scheme://host" with the port only when it
     * is not the scheme default. Null when the URL is not a usable origin.
     */
    static String allowedOriginRule(String url) {
        String c = canonical(url);
        if (c == null) return null;
        int colon = c.lastIndexOf(':');
        String base = c.substring(0, colon);
        int port = Integer.parseInt(c.substring(colon + 1));
        boolean https = c.startsWith("https://");
        if ((https && port == 443) || (!https && port == 80)) return base;
        return c;
    }
}
