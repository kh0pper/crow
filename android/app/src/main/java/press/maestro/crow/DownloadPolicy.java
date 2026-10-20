package press.maestro.crow;

import java.util.Base64;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Pure rules for WebView downloads (no Android imports, so it can be unit-tested on a plain
 * JVM). Keychain Export fix 2026-10-20: the app had no DownloadListener, so every download
 * the dashboard started was silently dropped.
 *
 * Only a URL on the paired gateway origin (exact scheme + host + port, OriginCheck) is fetched
 * with the WebView's session cookie; anything else on http(s) goes to the system browser with
 * no cookie; blob:, data: and every other scheme are refused (the app cannot fetch them).
 */
final class DownloadPolicy {

    private DownloadPolicy() { }

    enum Action { SAVE_WITH_SESSION, OPEN_EXTERNAL, REFUSE }

    /** Port message size cap (characters of text or base64). */
    static final int MAX_MESSAGE_CHARS = 12 * 1024 * 1024;
    /** Decoded payload cap. */
    static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9]{1,32}$");
    private static final Pattern MIME = Pattern.compile("^[a-z]+/[a-z0-9.+-]{1,64}$");
    private static final Pattern FILENAME_STAR = Pattern.compile("(?i)filename\\*\\s*=\\s*(?:UTF-8|ISO-8859-1)?''([^;]+)");
    private static final Pattern FILENAME = Pattern.compile("(?i)(?:^|;)\\s*filename\\s*=\\s*(\"([^\"]*)\"|[^;]+)");

    static Action decide(String url, String gatewayUrl) {
        if (url == null || gatewayUrl == null || OriginCheck.canonical(gatewayUrl) == null) return Action.REFUSE;
        String u = url.trim();
        String lower = u.toLowerCase(Locale.ROOT);
        // blob: and data: are page memory: the app cannot fetch them. A page that wants a blob saved
        // in the app posts it to window.CrowDownloadPort itself (the keychain Export does).
        if (lower.startsWith("blob:") || lower.startsWith("data:")) return Action.REFUSE;
        if (OriginCheck.canonical(u) == null) return Action.REFUSE; // data:, file:, javascript:, content:, junk
        if (u.indexOf('@') >= 0 && userInfo(u)) return Action.REFUSE;
        return OriginCheck.sameOrigin(u, gatewayUrl) ? Action.SAVE_WITH_SESSION : Action.OPEN_EXTERNAL;
    }

    /** True when the URL carries user:pass@ (never send the session cookie with one). */
    private static boolean userInfo(String url) {
        try {
            return new java.net.URI(url).getRawUserInfo() != null;
        } catch (Exception e) {
            return true;
        }
    }

    /**
     * A safe display/file name: the Content-Disposition filename (filename* first), else the
     * URL's last path segment, else "download". No path separators, no control characters,
     * no leading dots, at most 100 characters.
     */
    static String fileName(String contentDisposition, String url) {
        String name = null;
        if (contentDisposition != null) {
            java.util.regex.Matcher star = FILENAME_STAR.matcher(contentDisposition);
            if (star.find()) {
                try {
                    name = java.net.URLDecoder.decode(star.group(1).trim(), "UTF-8");
                } catch (Exception ignored) { }
            }
            if (name == null) {
                java.util.regex.Matcher m = FILENAME.matcher(contentDisposition);
                if (m.find()) name = m.group(2) != null ? m.group(2) : m.group(1).trim();
            }
        }
        if ((name == null || name.isEmpty()) && url != null) {
            String path = url;
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            int h = path.indexOf('#');
            if (h >= 0) path = path.substring(0, h);
            int slash = path.lastIndexOf('/');
            if (slash >= 0 && slash < path.length() - 1 && !path.substring(0, slash).endsWith("/")) name = path.substring(slash + 1);
        }
        return sanitize(name);
    }

    static String sanitize(String name) {
        if (name == null) return "download";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c < 0x20 || c == 0x7f || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') b.append('_');
            else b.append(c);
        }
        String s = b.toString().trim();
        while (s.startsWith(".")) s = s.substring(1);
        if (s.length() > 100) s = s.substring(0, 100);
        return s.isEmpty() ? "download" : s;
    }

    /**
     * The re-fetched response is the file the page meant: 2xx with Content-Disposition:
     * attachment. (onDownloadStart gives no method: a POST form download re-fetched as a GET
     * returns the page itself, which must never be saved as the file.)
     */
    static boolean isAttachment(int status, String contentDisposition) {
        if (status < 200 || status > 299 || contentDisposition == null) return false;
        String d = contentDisposition.trim().toLowerCase(Locale.ROOT);
        return d.equals("attachment") || d.startsWith("attachment;") || d.startsWith("attachment ");
    }

    private static final Pattern PEEK_ID = Pattern.compile("\"id\"\\s*:\\s*\"([A-Za-z0-9]{1,32})\"");

    /**
     * The request id of a port message that cannot be decoded or validated (too big, bad JSON),
     * read from its first 512 characters, so the page still hears "invalid" instead of waiting.
     * The page sends {"op","id",...} in that order. Null when there is none.
     */
    static String peekId(String data) {
        if (data == null) return null;
        java.util.regex.Matcher m = PEEK_ID.matcher(data.length() > 512 ? data.substring(0, 512) : data);
        return m.find() ? m.group(1) : null;
    }

    static String mime(String m) {
        if (m == null) return "application/octet-stream";
        String s = m.trim().toLowerCase(Locale.ROOT);
        int semi = s.indexOf(';');
        if (semi >= 0) s = s.substring(0, semi).trim();
        return MIME.matcher(s).matches() ? s : "application/octet-stream";
    }

    /** A validated {"op":"save"} port message. */
    static final class SaveRequest {
        final String id;
        final String name;
        final String mime;
        final byte[] bytes;

        SaveRequest(String id, String name, String mime, byte[] bytes) {
            this.id = id;
            this.name = name;
            this.mime = mime;
            this.bytes = bytes;
        }
    }

    /**
     * A {"op":"save"} port message, already decoded into its top-level fields (the caller uses
     * org.json, which a plain-JVM test cannot run): "id" 1-32 alnum, optional "name" and "mime",
     * and exactly one of "text" (string) or "b64" (base64, or a base64 data: URL). Null for
     * anything else, or when the payload is over MAX_BYTES.
     */
    static SaveRequest validateSave(java.util.Map<String, Object> o) {
        if (o == null || !"save".equals(o.get("op"))) return null;
        Object idv = o.get("id");
        if (!(idv instanceof String) || !ID.matcher((String) idv).matches()) return null;
        Object text = o.get("text");
        Object b64 = o.get("b64");
        if (o.containsKey("text") && !(text instanceof String)) return null;
        if (o.containsKey("b64") && !(b64 instanceof String)) return null;
        if ((text == null) == (b64 == null)) return null;
        Object mimev = o.get("mime");
        String mime = mime(mimev instanceof String ? (String) mimev : null);
        byte[] bytes;
        if (text != null) {
            if (((String) text).length() > MAX_MESSAGE_CHARS) return null;
            bytes = ((String) text).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } else {
            String s = (String) b64;
            if (s.length() > MAX_MESSAGE_CHARS) return null;
            if (s.startsWith("data:")) {
                int comma = s.indexOf(',');
                if (comma < 0 || !s.substring(0, comma).endsWith(";base64")) return null;
                if (!(mimev instanceof String)) mime = mime(s.substring(5, comma - 7));
                s = s.substring(comma + 1);
            }
            try {
                bytes = Base64.getDecoder().decode(s);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
        if (bytes.length > MAX_BYTES) return null;
        Object namev = o.get("name");
        return new SaveRequest((String) idv, sanitize(namev instanceof String ? (String) namev : null), mime, bytes);
    }
}
