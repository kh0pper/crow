package press.maestro.crow;

import java.util.ArrayList;
import java.util.List;

/**
 * What the "What needs me" home-screen widget draws, as data: the gateway's summary plus the
 * keyguard state in, a small model of a headline, rows and buttons out.
 *
 * Pure Java, no Android imports, so the JVM unit tests (NeedsMeRendererTest) exercise exactly what
 * the phone runs. The JSON itself is parsed in NeedsMeJson, on the device only.
 *
 * The rules the widget may never break (widgets phase 1):
 *  - a LOCKED phone draws a headline alone — a count and a neutral label, never an item's title,
 *    project or a button;
 *  - signed out draws the sign-in line, and nothing else;
 *  - a plan row (or a message row) has no buttons: the summary gives them none, and none is invented;
 *  - a row's href is a same-origin path or the Board: safeHref() refuses anything else, so a tap can
 *    never open a javascript: or //host URL.
 */
public final class NeedsMeRenderer {

    /** The widget shows at most this many rows (the server caps the summary there too). */
    public static final int MAX_ROWS = 5;
    /** A row keeps at most this many buttons — the layout has three button slots. */
    public static final int MAX_BUTTONS = 3;
    /** At most this many "your bots are working on" lines. */
    public static final int MAX_DOING = 3;
    /** Where a row's tap goes when the item's href is missing or not a path. */
    public static final String FALLBACK_HREF = "/dashboard/bot-board";
    /** The last-resort headline when the summary carries none (the title, normally). */
    public static final String FALLBACK_TITLE = "What needs me";

    private static final String STATE_EMPTY = "empty";
    private static final String STATE_ERROR = "error";
    private static final String LOCK_SUFFIX = " waiting";

    private NeedsMeRenderer() {
    }

    /** Which headline the provider should draw: a literal one, or one of its own strings. */
    public enum Headline {
        /** Draw {@link RenderModel#headline} as it is. */
        SUMMARY,
        /** Signed out: the provider's "Open Crow to sign in". */
        SIGN_IN,
        /** The summary could not be loaded: the provider's "Couldn't load what needs you". */
        ERROR,
        /** Locked: draw {@link RenderModel#headline} — a count and a neutral label only. */
        LOCKED
    }

    public static final class Action {
        public String id;
        public String label;
        public String style;

        public Action() {
        }

        public Action(String id, String label, String style) {
            this.id = id;
            this.label = label;
            this.style = style;
        }
    }

    public static final class Item {
        public String key;
        public String kind;
        public String title;
        public String project;
        public String href;
        public String nonce;
        public List<Action> actions = new ArrayList<>();

        public Item() {
        }

        public Item(String key, String kind, String title, String project, String href, String nonce,
                    List<Action> actions) {
            this.key = key;
            this.kind = kind;
            this.title = title;
            this.project = project;
            this.href = href;
            this.nonce = nonce;
            if (actions != null) this.actions = actions;
        }
    }

    /** The summary the gateway serves (servers/gateway/widgets/needs-me.js), as plain fields. */
    public static final class Summary {
        public String state;
        public String title;
        public String headline;
        public String moreHref;
        public List<Item> items = new ArrayList<>();
        public List<String> doing = new ArrayList<>();
        public int lockCount;
        public String lockLabel;
    }

    /** One drawn row: an item's text, its safe href and the buttons it offers. */
    public static final class Row {
        public final String key;
        public final String title;
        public final String project;
        public final String href;
        public final String nonce;
        public final List<Action> buttons;

        Row(String key, String title, String project, String href, String nonce, List<Action> buttons) {
            this.key = key;
            this.title = title;
            this.project = project;
            this.href = href;
            this.nonce = nonce;
            this.buttons = buttons;
        }
    }

    /** Everything the draw needs, decided here so the provider only maps it onto views. */
    public static final class RenderModel {
        public final Headline kind;
        /** The literal headline for SUMMARY and LOCKED; null when the provider's own string is used. */
        public final String headline;
        public final List<Row> rows;
        public final List<String> doing;
        public final boolean signIn;
        public final String moreHref;

        RenderModel(Headline kind, String headline, List<Row> rows, List<String> doing, boolean signIn,
                    String moreHref) {
            this.kind = kind;
            this.headline = headline;
            this.rows = rows;
            this.doing = doing;
            this.signIn = signIn;
            this.moreHref = moreHref;
        }
    }

    /**
     * The model for one draw.
     *
     * @param s       the cached summary, or null when there is none
     * @param locked  true while the keyguard is up: the count-only view
     * @param signIn  true when the app is signed out (no session cookie, 401/403/404, a login redirect)
     */
    public static RenderModel render(Summary s, boolean locked, boolean signIn) {
        if (signIn) {
            return new RenderModel(Headline.SIGN_IN, null, new ArrayList<Row>(), new ArrayList<String>(), true,
                    FALLBACK_HREF);
        }
        // Nothing cached yet, or every source on the server failed: say so, draw nothing.
        if (s == null || STATE_ERROR.equals(s.state)) {
            return new RenderModel(Headline.ERROR, null, new ArrayList<Row>(), new ArrayList<String>(), false,
                    FALLBACK_HREF);
        }
        if (locked) {
            String label = trimmed(s.lockLabel);
            if (label == null) label = s.lockCount + LOCK_SUFFIX;
            // No rows, no doing lines, no item text of any kind: a locked phone learns only the count.
            return new RenderModel(Headline.LOCKED, label, new ArrayList<Row>(), new ArrayList<String>(), false,
                    safeHref(s.moreHref));
        }

        List<Row> rows = new ArrayList<>();
        if (s.items != null) {
            for (Item item : s.items) {
                if (rows.size() >= MAX_ROWS) break;
                if (item == null) continue;
                rows.add(rowOf(item));
            }
        }

        String headline = trimmed(s.headline);
        if (headline == null) headline = trimmed(s.title);
        if (headline == null) headline = FALLBACK_TITLE;

        // "Your bots are working on" belongs to the all-clear state (the server fills it only then).
        List<String> doing = STATE_EMPTY.equals(s.state) ? cleanLines(s.doing) : new ArrayList<String>();

        return new RenderModel(Headline.SUMMARY, headline, rows, doing, false, safeHref(s.moreHref));
    }

    /**
     * A row's tap target: a same-origin path, or the Board. Only a single leading "/" is accepted —
     * "//host/x" is another origin and "javascript:…" is not a path at all.
     */
    public static String safeHref(String href) {
        String h = trimmed(href);
        if (h == null) return FALLBACK_HREF;
        if (!h.startsWith("/") || h.startsWith("//") || h.length() < 2) return FALLBACK_HREF;
        for (int i = 0; i < h.length(); i++) {
            char c = h.charAt(i);
            if (c <= ' ' || c == '\\' || c == '\u007f') return FALLBACK_HREF;
        }
        return h;
    }

    private static Row rowOf(Item item) {
        List<Action> buttons = new ArrayList<>();
        if (item.actions != null) {
            for (Action a : item.actions) {
                if (buttons.size() >= MAX_BUTTONS) break;
                if (a == null) continue;
                String id = trimmed(a.id);
                // A button with no id could never be sent back, so it is not drawn.
                if (id == null) continue;
                String label = trimmed(a.label);
                buttons.add(new Action(id, label == null ? id : label, a.style == null ? "plain" : a.style));
            }
        }
        String title = item.title == null ? "" : item.title;
        return new Row(item.key, title, trimmed(item.project), safeHref(item.href), item.nonce, buttons);
    }

    private static List<String> cleanLines(List<String> lines) {
        List<String> out = new ArrayList<>();
        if (lines == null) return out;
        for (String line : lines) {
            if (out.size() >= MAX_DOING) break;
            String clean = trimmed(line);
            if (clean != null) out.add(clean);
        }
        return out;
    }

    /** The string without surrounding blanks, or null when it is null/blank. */
    private static String trimmed(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}