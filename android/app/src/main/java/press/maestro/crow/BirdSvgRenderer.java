package press.maestro.crow;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The bird's SVG, parsed into a small display list — pure Java, no Android imports, so
 * BirdSvgRendererTest runs exactly the same code the phone runs.
 *
 * WHY THIS EXISTS: the gateway hands the widget the FULL drawing of the owner's own bird
 * (GET /dashboard/widgets-api/bird -> `svg`, the same string the profile picture is made of:
 * outfit applied, current decayed mood, walk badge). Android has no SVG decoder, so this reads
 * exactly the subset bundles/ramble/server/bird-svg.cjs draws:
 *
 *   g (transform, fill, stroke, stroke-width, stroke-linecap, opacity, fill-opacity, style)
 *   circle, ellipse, rect, path (d), text
 *   transform functions translate / scale / rotate / matrix / skewX / skewY, nested
 *
 * ROBUSTNESS IS THE POINT (review focus 1: an element the renderer does not know must cost that
 * element and never the widget):
 *  - an unknown ELEMENT (or attribute) is skipped, with its subtree, and never throws;
 *  - a malformed NUMBER (or a malformed transform list, or unusable path data) skips that element —
 *    and, for a group, everything under it, because a group whose transform cannot be read would
 *    put its children in the wrong place;
 *  - a document that makes no sense comes back as an empty Drawing, so the caller falls back to the
 *    app icon instead of drawing nonsense;
 *  - the work is BOUNDED (MAX_SVG_CHARS, MAX_DEPTH, MAX_OPS, MAX_PATH_CHARS): a hostile or broken
 *    answer costs a redraw its milliseconds, never the widget's frame budget or its memory.
 *
 * The output carries RESOLVED numbers: every op has its absolute transform (parent transforms
 * composed), and its fill/stroke already include the inherited opacity, as ARGB ints. Colours are
 * #rgb, #rrggbb, rgb(...), "none"/"transparent" and a small named table; anything else is ignored
 * (the property inherits, as SVG says).
 */
public final class BirdSvgRenderer {

    /** What a paint with no colour is: nothing is drawn. */
    public static final int NO_PAINT = 0;

    /** The identity transform, {a, b, c, d, e, f}: x' = a x + c y + e, y' = b x + d y + f. */
    public static final float[] IDENTITY = {1f, 0f, 0f, 1f, 0f, 0f};

    /** Past this a document is not a bird drawing: it is refused before a character of it is read. */
    public static final int MAX_SVG_CHARS = 256 * 1024;

    /** How deeply elements may nest. Deeper, an element and its whole subtree are dropped unread. */
    public static final int MAX_DEPTH = 32;

    /** How many ops a drawing may carry. Past this the walk stops: nothing more is added or read. */
    public static final int MAX_OPS = 2000;

    /** How long one path's `d` may be. A longer path is skipped; the rest of the bird is drawn. */
    public static final int MAX_PATH_CHARS = 32 * 1024;

    /** The engine's "walked today" badge group: class="rb-walk-badge" (bird-svg.cjs drawWalkBadge). */
    private static final String WALK_BADGE_CLASS = "rb-walk-badge";

    /** The shapes this subset has, and the text. */
    public enum Kind { CIRCLE, ELLIPSE, RECT, PATH, TEXT }

    /** One drawn thing: geometry plus the paint and transform it inherits and its own. */
    public static final class Op {
        public Kind kind;
        /** The absolute transform: this element's own, composed with every enclosing group's. */
        public float[] transform = IDENTITY;
        /** Fill as ARGB (opacity folded in), or {@link #NO_PAINT}. */
        public int fill = NO_PAINT;
        /** Stroke as ARGB (opacity folded in), or {@link #NO_PAINT}. */
        public int stroke = NO_PAINT;
        public float strokeWidth = 1f;
        public boolean roundCap;

        // CIRCLE: cx/cy/rx (ry == rx). ELLIPSE: cx/cy/rx/ry. RECT: x/y/w/h/cornerRx.
        public float cx;
        public float cy;
        public float rx;
        public float ry;
        public float x;
        public float y;
        public float w;
        public float h;
        public float cornerRx;

        /** PATH: the `d` exactly as the engine wrote it (BirdBitmap hands it to PathParser). */
        public String pathData;

        /** TEXT: the run, where it starts, and its size/weight. */
        public String text;
        public float fontSize = 16f;
        public boolean bold;
    }

    /** A whole parsed document: the ops in drawing order, and the viewBox they are laid out in. */
    public static final class Drawing {
        public final List<Op> ops = new ArrayList<>();
        /** {minX, minY, width, height}; only meaningful when {@link #hasViewBox}. */
        public final float[] viewBox = {0f, 0f, 0f, 0f};
        public boolean hasViewBox;
    }

    /** Inherited state while walking the document. */
    private static final class State {
        float[] transform = IDENTITY;
        int fill = 0xFF000000; // SVG's default fill: black
        int stroke = NO_PAINT;
        float strokeWidth = 1f;
        float opacity = 1f;
        float fillOpacity = 1f;
        float strokeOpacity = 1f;
        boolean roundCap;
        /** Set when this element (or an enclosing one) could not be read: nothing inside is drawn. */
        boolean dropped;
    }

    private static final class Tag {
        String name;
        final Map<String, String> attrs = new HashMap<>();
        boolean closing;
        boolean selfClosing;
    }

    private static final Map<String, Integer> NAMED = namedColours();

    /** The empty elements this subset draws: an unknown element is skipped along with its subtree. */
    private static final List<String> KNOWN_LEAVES =
            java.util.Arrays.asList("circle", "ellipse", "rect", "path");

    private BirdSvgRenderer() {
    }

    /**
     * Parse a document. Never throws: an unreadable document is an empty Drawing (no ops), which the
     * caller treats as "cannot draw" and falls back to the app icon.
     */
    public static Drawing parse(String svg) {
        return parse(svg, true);
    }

    /**
     * Parse a document, optionally without the "walked today" badge.
     *
     * @param keepWalkBadge false drops the engine's badge group (class="rb-walk-badge") and its
     *     contents: a host that draws on the keyguard shows the bird with walked=false, so it is never
     *     told how far its owner walked today. Never throws, exactly as {@link #parse(String)}.
     */
    public static Drawing parse(String svg, boolean keepWalkBadge) {
        Drawing out = new Drawing();
        if (svg == null || svg.isEmpty()) return out;
        // Too big to be a bird drawing: refuse it outright, before reading any of it.
        if (svg.length() > MAX_SVG_CHARS) return out;
        try {
            walk(svg, out, keepWalkBadge);
        } catch (RuntimeException e) {
            // Belt and braces: the walk is written not to throw, but a widget update must never die
            // because of a drawing. Keep whatever was read so far.
        }
        return out;
    }

    private static void walk(String svg, Drawing out, boolean keepWalkBadge) {
        List<String> names = new ArrayList<>();
        List<State> states = new ArrayList<>();
        names.add("");
        states.add(new State());

        int n = svg.length();
        int i = 0;
        while (i < n) {
            // Past the op cap this is not the bird any more: stop reading rather than walk on.
            if (out.ops.size() >= MAX_OPS) break;
            int lt = svg.indexOf('<', i);
            if (lt < 0) break;
            if (svg.startsWith("<!--", lt)) {
                int end = svg.indexOf("-->", lt + 4);
                i = end < 0 ? n : end + 3;
                continue;
            }
            if (svg.startsWith("<![CDATA[", lt)) {
                int end = svg.indexOf("]]>", lt + 9);
                i = end < 0 ? n : end + 3;
                continue;
            }
            if (svg.startsWith("<?", lt)) {
                int end = svg.indexOf("?>", lt + 2);
                i = end < 0 ? n : end + 2;
                continue;
            }
            if (svg.startsWith("<!", lt)) {
                int end = svg.indexOf('>', lt + 2);
                i = end < 0 ? n : end + 1;
                continue;
            }
            int gt = tagEnd(svg, lt);
            if (gt < 0) break;
            Tag tag = parseTag(svg.substring(lt + 1, gt));
            int after = gt + 1;
            if (tag == null || tag.name.isEmpty()) {
                i = after;
                continue;
            }

            if (tag.closing) {
                // Tolerant close: pop to the matching open element, ignore an unmatched one. The
                // search is the STACK's length, never the document's, and the stack is capped at
                // MAX_DEPTH below — so a flood of unmatched closing tags costs a few comparisons
                // each instead of a rescan of the text.
                for (int k = names.size() - 1; k >= 1; k--) {
                    if (names.get(k).equals(tag.name)) {
                        while (names.size() > k) {
                            names.remove(names.size() - 1);
                            states.remove(states.size() - 1);
                        }
                        break;
                    }
                }
                i = after;
                continue;
            }

            // Deeper than MAX_DEPTH: drop this element and everything under it, and push no state,
            // so a document of nested tags costs one linear skip and not one state per level.
            if (names.size() > MAX_DEPTH) {
                i = tag.selfClosing ? after : skipSubtree(svg, after);
                continue;
            }

            State parent = states.get(states.size() - 1);
            State st = derive(parent, tag.attrs);

            if ("svg".equals(tag.name)) {
                readViewBox(out, tag.attrs);
                if (!tag.selfClosing) {
                    names.add(tag.name);
                    states.add(st);
                }
                i = after;
                continue;
            }
            if ("g".equals(tag.name)) {
                if (!tag.selfClosing) {
                    // A keyguard host gets the bird WITHOUT the walk badge: drop that group's
                    // subtree, exactly as an unknown element's is dropped.
                    if (!keepWalkBadge && isWalkBadge(tag.attrs)) {
                        i = skipSubtree(svg, after);
                        continue;
                    }
                    names.add(tag.name);
                    states.add(st);
                }
                i = after;
                continue;
            }
            if ("text".equals(tag.name)) {
                int close = svg.indexOf("</text", after);
                int textEnd = close < 0 ? n : close;
                if (!st.dropped) addText(out, st, tag.attrs, svg.substring(after, textEnd));
                if (close < 0) {
                    i = n;
                } else {
                    int closeGt = svg.indexOf('>', close);
                    i = closeGt < 0 ? n : closeGt + 1;
                }
                continue;
            }

            // Leaf shapes. Anything else is an unknown element: skipped, subtree and all (a dropped
            // frame, so a <defs> or <style> full of shapes is not drawn as part of the picture).
            if (!st.dropped) {
                if ("circle".equals(tag.name)) addCircle(out, st, tag.attrs);
                else if ("ellipse".equals(tag.name)) addEllipse(out, st, tag.attrs);
                else if ("rect".equals(tag.name)) addRect(out, st, tag.attrs);
                else if ("path".equals(tag.name)) addPath(out, st, tag.attrs);
            }
            if (!tag.selfClosing && !KNOWN_LEAVES.contains(tag.name)) {
                State dropped = new State();
                dropped.transform = st.transform;
                dropped.dropped = true;
                names.add(tag.name);
                states.add(dropped);
            }
            i = after;
        }
    }

    /**
     * Skip the subtree of a dropped element: {@code from} is the index just past its opening tag, and
     * the result is the index just past its matching closing tag (or the end of the document).
     *
     * LINEAR BY CONSTRUCTION: one pass counting nest depth, never a search for a name, so 100,000
     * nested tags cost one scan of the text — the same order as reading it.
     */
    private static int skipSubtree(String svg, int from) {
        int n = svg.length();
        int depth = 1;
        int i = from;
        while (i < n) {
            int lt = svg.indexOf('<', i);
            if (lt < 0) return n;
            if (svg.startsWith("<!--", lt)) {
                int end = svg.indexOf("-->", lt + 4);
                i = end < 0 ? n : end + 3;
                continue;
            }
            if (svg.startsWith("<![CDATA[", lt)) {
                int end = svg.indexOf("]]>", lt + 9);
                i = end < 0 ? n : end + 3;
                continue;
            }
            if (svg.startsWith("<?", lt)) {
                int end = svg.indexOf("?>", lt + 2);
                i = end < 0 ? n : end + 2;
                continue;
            }
            if (svg.startsWith("<!", lt)) {
                int end = svg.indexOf('>', lt + 2);
                i = end < 0 ? n : end + 1;
                continue;
            }
            int gt = tagEnd(svg, lt);
            if (gt < 0) return n;
            int p = lt + 1;
            while (p < gt && isSpace(svg.charAt(p))) p++;
            if (p < gt && svg.charAt(p) == '/') {
                depth--; // a closing tag, whatever name it carries
            } else {
                int q = gt - 1;
                while (q > lt && isSpace(svg.charAt(q))) q--;
                if (svg.charAt(q) != '/') depth++; // a self-closing element does not nest
            }
            i = gt + 1;
            if (depth <= 0) return i;
        }
        return n;
    }

    /** Whether a group is the engine's walk badge: a `class` list holding "rb-walk-badge". */
    private static boolean isWalkBadge(Map<String, String> attrs) {
        String cls = attrs.get("class");
        if (cls == null) return false;
        for (String token : cls.trim().split("\\s+")) {
            if (WALK_BADGE_CLASS.equals(token)) return true;
        }
        return false;
    }

    /** The index of the '>' closing the tag that starts at {@code lt}, skipping quoted '>'. */
    private static int tagEnd(String s, int lt) {
        char quote = 0;
        for (int i = lt + 1; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quote != 0) {
                if (c == quote) quote = 0;
            } else if (c == '"' || c == '\'') {
                quote = c;
            } else if (c == '>') {
                return i;
            }
        }
        return -1;
    }

    /** `name a="1" b='2'` (with or without the trailing slash) -> a Tag; null when unreadable. */
    private static Tag parseTag(String body) {
        if (body == null) return null;
        String s = body;
        boolean closing = false;
        boolean selfClosing = false;
        if (s.startsWith("/")) {
            closing = true;
            s = s.substring(1);
        }
        int end = s.length();
        while (end > 0 && isSpace(s.charAt(end - 1))) end--;
        if (end > 0 && s.charAt(end - 1) == '/') {
            selfClosing = true;
            end--;
            while (end > 0 && isSpace(s.charAt(end - 1))) end--;
        }
        int i = 0;
        while (i < end && isSpace(s.charAt(i))) i++;
        int start = i;
        while (i < end && !isSpace(s.charAt(i))) i++;
        Tag tag = new Tag();
        tag.name = s.substring(start, i).toLowerCase(Locale.ROOT);
        tag.closing = closing;
        tag.selfClosing = selfClosing;
        if (closing) return tag;

        while (i < end) {
            while (i < end && (isSpace(s.charAt(i)) || s.charAt(i) == '/')) i++;
            if (i >= end) break;
            int nameStart = i;
            while (i < end && !isSpace(s.charAt(i)) && s.charAt(i) != '=' && s.charAt(i) != '/') i++;
            String name = s.substring(nameStart, i).toLowerCase(Locale.ROOT);
            while (i < end && isSpace(s.charAt(i))) i++;
            if (i < end && s.charAt(i) == '=') {
                i++;
                while (i < end && isSpace(s.charAt(i))) i++;
                String value;
                if (i < end && (s.charAt(i) == '"' || s.charAt(i) == '\'')) {
                    char quote = s.charAt(i);
                    i++;
                    int valueStart = i;
                    while (i < end && s.charAt(i) != quote) i++;
                    value = s.substring(valueStart, Math.min(i, end));
                    if (i < end) i++;
                } else {
                    int valueStart = i;
                    while (i < end && !isSpace(s.charAt(i))) i++;
                    value = s.substring(valueStart, i);
                }
                if (!name.isEmpty()) tag.attrs.put(name, value);
            } else if (!name.isEmpty()) {
                // A bare word (`disabled`-style): an unknown attribute, and skipped like one.
                tag.attrs.put(name, "");
            }
        }
        return tag;
    }

    /** The parent's state plus this element's own attributes (and its inline style, which wins). */
    private static State derive(State parent, Map<String, String> attrs) {
        State st = new State();
        st.transform = parent.transform;
        st.fill = parent.fill;
        st.stroke = parent.stroke;
        st.strokeWidth = parent.strokeWidth;
        st.opacity = parent.opacity;
        st.fillOpacity = parent.fillOpacity;
        st.strokeOpacity = parent.strokeOpacity;
        st.roundCap = parent.roundCap;
        st.dropped = parent.dropped;

        Map<String, String> all = attrs;
        String style = attrs.get("style");
        if (style != null) {
            all = new HashMap<>(attrs);
            for (String part : style.split(";")) {
                int colon = part.indexOf(':');
                if (colon <= 0) continue;
                String key = part.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = part.substring(colon + 1).trim();
                if (!key.isEmpty() && !value.isEmpty()) all.put(key, value);
            }
        }

        String transform = all.get("transform");
        if (transform != null) {
            float[] m = parseTransform(transform);
            if (m == null) {
                // A transform we cannot read would misplace everything inside it.
                st.dropped = true;
            } else {
                st.transform = multiply(parent.transform, m);
            }
        }

        Integer fill = paint(all.get("fill"));
        if (fill != null) st.fill = fill;
        Integer stroke = paint(all.get("stroke"));
        if (stroke != null) st.stroke = stroke;

        Float strokeWidth = number(all.get("stroke-width"));
        if (strokeWidth != null) st.strokeWidth = strokeWidth;

        Float opacity = number(all.get("opacity"));
        if (opacity != null) st.opacity = clamp01(st.opacity) * clamp01(opacity);

        Float fillOpacity = number(all.get("fill-opacity"));
        if (fillOpacity != null) st.fillOpacity = clamp01(fillOpacity);

        Float strokeOpacity = number(all.get("stroke-opacity"));
        if (strokeOpacity != null) st.strokeOpacity = clamp01(strokeOpacity);

        String cap = all.get("stroke-linecap");
        if (cap != null) st.roundCap = "round".equalsIgnoreCase(cap.trim());

        return st;
    }

    // ---- the shapes -------------------------------------------------------------

    private static void addCircle(Drawing out, State st, Map<String, String> attrs) {
        Float cx = number(attrs.get("cx"));
        Float cy = number(attrs.get("cy"));
        Float r = number(attrs.get("r"));
        if (bad(attrs, "cx", cx) || bad(attrs, "cy", cy) || r == null) return;
        Op op = shape(Kind.CIRCLE, st);
        op.cx = orZero(cx);
        op.cy = orZero(cy);
        op.rx = r;
        op.ry = r;
        out.ops.add(op);
    }

    private static void addEllipse(Drawing out, State st, Map<String, String> attrs) {
        Float cx = number(attrs.get("cx"));
        Float cy = number(attrs.get("cy"));
        Float rx = number(attrs.get("rx"));
        Float ry = number(attrs.get("ry"));
        if (bad(attrs, "cx", cx) || bad(attrs, "cy", cy) || rx == null || ry == null) return;
        Op op = shape(Kind.ELLIPSE, st);
        op.cx = orZero(cx);
        op.cy = orZero(cy);
        op.rx = rx;
        op.ry = ry;
        out.ops.add(op);
    }

    private static void addRect(Drawing out, State st, Map<String, String> attrs) {
        Float x = number(attrs.get("x"));
        Float y = number(attrs.get("y"));
        Float w = number(attrs.get("width"));
        Float h = number(attrs.get("height"));
        Float rx = number(attrs.get("rx"));
        if (bad(attrs, "x", x) || bad(attrs, "y", y) || bad(attrs, "rx", rx)) return;
        if (w == null || h == null) return;
        Op op = shape(Kind.RECT, st);
        op.x = orZero(x);
        op.y = orZero(y);
        op.w = w;
        op.h = h;
        op.cornerRx = orZero(rx);
        out.ops.add(op);
    }

    private static void addPath(Drawing out, State st, Map<String, String> attrs) {
        String d = attrs.get("d");
        if (d == null || d.trim().isEmpty()) return;
        // One enormous path is skipped; the rest of the bird is still drawn.
        if (d.length() > MAX_PATH_CHARS) return;
        if (!validPathData(d)) return;
        Op op = shape(Kind.PATH, st);
        op.pathData = d.trim();
        out.ops.add(op);
    }

    private static void addText(Drawing out, State st, Map<String, String> attrs, String raw) {
        String text = textOf(raw);
        if (text == null || text.isEmpty()) return;
        Float x = number(attrs.get("x"));
        Float y = number(attrs.get("y"));
        Float size = number(attrs.get("font-size"));
        if (bad(attrs, "x", x) || bad(attrs, "y", y) || bad(attrs, "font-size", size)) return;
        Op op = shape(Kind.TEXT, st);
        op.x = orZero(x);
        op.y = orZero(y);
        op.text = text;
        op.fontSize = size == null || size <= 0f ? 16f : size;
        op.bold = isBold(attrs.get("font-weight"));
        out.ops.add(op);
    }

    private static Op shape(Kind kind, State st) {
        Op op = new Op();
        op.kind = kind;
        op.transform = st.transform;
        op.fill = withOpacity(st.fill, st.opacity * st.fillOpacity);
        op.stroke = withOpacity(st.stroke, st.opacity * st.strokeOpacity);
        op.strokeWidth = st.strokeWidth;
        op.roundCap = st.roundCap;
        return op;
    }

    /** True when the attribute is present but its value could not be read ("malformed skips"). */
    private static boolean bad(Map<String, String> attrs, String name, Float value) {
        return value == null && attrs.get(name) != null;
    }

    private static float orZero(Float v) {
        return v == null ? 0f : v;
    }

    // ---- viewBox ----------------------------------------------------------------

    private static void readViewBox(Drawing out, Map<String, String> attrs) {
        // Attribute names are lower-cased when a tag is read: viewBox arrives as "viewbox".
        List<Float> vb = numbers(attrs.get("viewbox"));
        if (vb != null && vb.size() == 4 && vb.get(2) > 0f && vb.get(3) > 0f) {
            out.viewBox[0] = vb.get(0);
            out.viewBox[1] = vb.get(1);
            out.viewBox[2] = vb.get(2);
            out.viewBox[3] = vb.get(3);
            out.hasViewBox = true;
            return;
        }
        Float w = number(attrs.get("width"));
        Float h = number(attrs.get("height"));
        if (w != null && h != null && w > 0f && h > 0f) {
            out.viewBox[0] = 0f;
            out.viewBox[1] = 0f;
            out.viewBox[2] = w;
            out.viewBox[3] = h;
            out.hasViewBox = true;
        }
    }

    // ---- transforms -------------------------------------------------------------

    /** A transform list as one matrix; null when a number in it cannot be read. */
    private static float[] parseTransform(String raw) {
        float[] m = IDENTITY;
        int i = 0;
        int n = raw.length();
        while (i < n) {
            char c = raw.charAt(i);
            if (isSpace(c) || c == ',') {
                i++;
                continue;
            }
            int start = i;
            while (i < n && isLetter(raw.charAt(i))) i++;
            if (i == start) return null;
            String name = raw.substring(start, i).toLowerCase(Locale.ROOT);
            while (i < n && isSpace(raw.charAt(i))) i++;
            if (i >= n || raw.charAt(i) != '(') return null;
            int close = raw.indexOf(')', i);
            if (close < 0) return null;
            String args = raw.substring(i + 1, close);
            i = close + 1;
            if (!isKnownTransform(name)) continue; // an unknown function is skipped, like an attribute
            float[] t = transformFn(name, args);
            // A known function with arguments we cannot read makes the whole transform unreadable:
            // the element (and, for a group, its subtree) is skipped rather than misplaced.
            if (t == null) return null;
            m = multiply(m, t);
        }
        return m;
    }

    /** Whether a transform function is one this subset implements (unknown ones are ignored). */
    private static boolean isKnownTransform(String name) {
        return "translate".equals(name) || "scale".equals(name) || "rotate".equals(name)
                || "matrix".equals(name) || "skewx".equals(name) || "skewy".equals(name);
    }

    /** One transform function; null for an unreadable argument list. */
    private static float[] transformFn(String name, String args) {
        List<Float> v = numbers(args);
        if (v == null) return null;
        int count = v.size();
        if ("translate".equals(name)) {
            if (count == 1) return new float[]{1f, 0f, 0f, 1f, v.get(0), 0f};
            if (count == 2) return new float[]{1f, 0f, 0f, 1f, v.get(0), v.get(1)};
            return null;
        }
        if ("scale".equals(name)) {
            if (count == 1) return new float[]{v.get(0), 0f, 0f, v.get(0), 0f, 0f};
            if (count == 2) return new float[]{v.get(0), 0f, 0f, v.get(1), 0f, 0f};
            return null;
        }
        if ("rotate".equals(name)) {
            if (count == 1) return rotate(v.get(0), 0f, 0f);
            if (count == 3) return rotate(v.get(0), v.get(1), v.get(2));
            return null;
        }
        if ("matrix".equals(name)) {
            if (count != 6) return null;
            float[] m = new float[6];
            for (int k = 0; k < 6; k++) m[k] = v.get(k);
            return m;
        }
        if ("skewx".equals(name)) {
            if (count != 1) return null;
            return new float[]{1f, 0f, (float) Math.tan(Math.toRadians(v.get(0))), 1f, 0f, 0f};
        }
        if ("skewy".equals(name)) {
            if (count != 1) return null;
            return new float[]{1f, (float) Math.tan(Math.toRadians(v.get(0))), 0f, 1f, 0f, 0f};
        }
        // An unknown transform function is skipped like an unknown attribute.
        return null;
    }

    private static float[] rotate(float degrees, float cx, float cy) {
        double radians = Math.toRadians(degrees);
        float cos = (float) Math.cos(radians);
        float sin = (float) Math.sin(radians);
        // translate(cx,cy) rotate(a) translate(-cx,-cy)
        return new float[]{cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy};
    }

    private static float[] multiply(float[] a, float[] b) {
        return new float[]{
                a[0] * b[0] + a[2] * b[1],
                a[1] * b[0] + a[3] * b[1],
                a[0] * b[2] + a[2] * b[3],
                a[1] * b[2] + a[3] * b[3],
                a[0] * b[4] + a[2] * b[5] + a[4],
                a[1] * b[4] + a[3] * b[5] + a[5],
        };
    }

    // ---- path data --------------------------------------------------------------

    private static final String PATH_COMMANDS = "MmZzLlHhVvCcSsQqTtAa";

    /**
     * True when every token in a `d` is a known command letter or a number. The actual geometry is
     * parsed on the device by androidx's PathParser (BirdBitmap); this only refuses what would make
     * it fail, so one unreadable path is skipped and the rest of the bird is drawn.
     */
    static boolean validPathData(String d) {
        int i = 0;
        int n = d.length();
        while (i < n) {
            char c = d.charAt(i);
            if (isSpace(c) || c == ',') {
                i++;
                continue;
            }
            if (PATH_COMMANDS.indexOf(c) >= 0) {
                i++;
                continue;
            }
            int start = i;
            if (c == '+' || c == '-') i++;
            int digits = 0;
            while (i < n && isDigit(d.charAt(i))) {
                i++;
                digits++;
            }
            if (i < n && d.charAt(i) == '.') {
                i++;
                while (i < n && isDigit(d.charAt(i))) {
                    i++;
                    digits++;
                }
            }
            if (digits == 0) return false;
            if (i < n && (d.charAt(i) == 'e' || d.charAt(i) == 'E')) {
                i++;
                if (i < n && (d.charAt(i) == '+' || d.charAt(i) == '-')) i++;
                int exponent = 0;
                while (i < n && isDigit(d.charAt(i))) {
                    i++;
                    exponent++;
                }
                if (exponent == 0) return false;
            }
        }
        return true;
    }

    // ---- numbers and colours ----------------------------------------------------

    /** A number, or null when the text is not one (a trailing "px" is tolerated). */
    static Float number(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() > 2 && (s.endsWith("px") || s.endsWith("PX"))) {
            s = s.substring(0, s.length() - 2).trim();
        }
        if (!isNumber(s)) return null;
        try {
            return Float.valueOf(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static boolean isNumber(String s) {
        int n = s.length();
        if (n == 0) return false;
        int i = 0;
        char first = s.charAt(0);
        if (first == '+' || first == '-') {
            i++;
            if (i >= n) return false;
        }
        int digits = 0;
        while (i < n && isDigit(s.charAt(i))) {
            i++;
            digits++;
        }
        if (i < n && s.charAt(i) == '.') {
            i++;
            while (i < n && isDigit(s.charAt(i))) {
                i++;
                digits++;
            }
        }
        if (digits == 0) return false;
        if (i < n && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
            i++;
            if (i < n && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
            int exponent = 0;
            while (i < n && isDigit(s.charAt(i))) {
                i++;
                exponent++;
            }
            if (exponent == 0) return false;
        }
        return i == n;
    }

    /** Every number in a whitespace/comma separated list; null when one of them is not a number. */
    private static List<Float> numbers(String raw) {
        List<Float> out = new ArrayList<>();
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        int i = 0;
        int n = s.length();
        while (i < n) {
            char c = s.charAt(i);
            if (isSpace(c) || c == ',') {
                i++;
                continue;
            }
            int start = i;
            while (i < n && !isSpace(s.charAt(i)) && s.charAt(i) != ',') i++;
            Float v = number(s.substring(start, i));
            if (v == null) return null;
            out.add(v);
        }
        return out;
    }

    /** A colour value as ARGB, or null when it is not one this subset knows (the property inherits). */
    private static Integer paint(String raw) {
        if (raw == null) return null;
        String v = raw.trim().toLowerCase(Locale.ROOT);
        if (v.isEmpty()) return null;
        if ("none".equals(v) || "transparent".equals(v)) return Integer.valueOf(NO_PAINT);
        if (v.startsWith("#")) return hex(v);
        if (v.startsWith("rgb(") && v.endsWith(")")) return rgb(v.substring(4, v.length() - 1));
        return NAMED.get(v);
    }

    private static Integer hex(String v) {
        if (v.length() == 4) {
            int r = hexDigit(v.charAt(1));
            int g = hexDigit(v.charAt(2));
            int b = hexDigit(v.charAt(3));
            if (r < 0 || g < 0 || b < 0) return null;
            return Integer.valueOf(0xFF000000 | (r * 17) << 16 | (g * 17) << 8 | (b * 17));
        }
        if (v.length() == 7) {
            int r = hexPair(v.charAt(1), v.charAt(2));
            int g = hexPair(v.charAt(3), v.charAt(4));
            int b = hexPair(v.charAt(5), v.charAt(6));
            if (r < 0 || g < 0 || b < 0) return null;
            return Integer.valueOf(0xFF000000 | r << 16 | g << 8 | b);
        }
        return null;
    }

    private static Integer rgb(String body) {
        String[] parts = body.split(",");
        if (parts.length != 3) return null;
        int[] channels = new int[3];
        for (int i = 0; i < 3; i++) {
            String part = parts[i].trim();
            boolean percent = part.endsWith("%");
            if (percent) part = part.substring(0, part.length() - 1).trim();
            Float v = number(part);
            if (v == null) return null;
            float value = percent ? v / 100f * 255f : v;
            channels[i] = Math.max(0, Math.min(255, Math.round(value)));
        }
        return Integer.valueOf(0xFF000000 | channels[0] << 16 | channels[1] << 8 | channels[2]);
    }

    private static int hexPair(char hi, char lo) {
        int h = hexDigit(hi);
        int l = hexDigit(lo);
        if (h < 0 || l < 0) return -1;
        return h * 16 + l;
    }

    private static int hexDigit(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    private static Map<String, Integer> namedColours() {
        Map<String, Integer> m = new HashMap<>();
        m.put("black", Integer.valueOf(0xFF000000));
        m.put("white", Integer.valueOf(0xFFFFFFFF));
        m.put("red", Integer.valueOf(0xFFFF0000));
        m.put("green", Integer.valueOf(0xFF008000));
        m.put("blue", Integer.valueOf(0xFF0000FF));
        m.put("yellow", Integer.valueOf(0xFFFFFF00));
        m.put("orange", Integer.valueOf(0xFFFFA500));
        m.put("pink", Integer.valueOf(0xFFFFC0CB));
        m.put("purple", Integer.valueOf(0xFF800080));
        m.put("violet", Integer.valueOf(0xFFEE82EE));
        m.put("indigo", Integer.valueOf(0xFF4B0082));
        m.put("brown", Integer.valueOf(0xFFA52A2A));
        m.put("gray", Integer.valueOf(0xFF808080));
        m.put("grey", Integer.valueOf(0xFF808080));
        m.put("silver", Integer.valueOf(0xFFC0C0C0));
        m.put("gold", Integer.valueOf(0xFFFFD700));
        m.put("beige", Integer.valueOf(0xFFF5F5DC));
        m.put("ivory", Integer.valueOf(0xFFFFFFF0));
        m.put("khaki", Integer.valueOf(0xFFF0E68C));
        m.put("coral", Integer.valueOf(0xFFFF7F50));
        m.put("salmon", Integer.valueOf(0xFFFA8072));
        m.put("crimson", Integer.valueOf(0xFFDC143C));
        m.put("maroon", Integer.valueOf(0xFF800000));
        m.put("olive", Integer.valueOf(0xFF808000));
        m.put("navy", Integer.valueOf(0xFF000080));
        m.put("teal", Integer.valueOf(0xFF008080));
        m.put("aqua", Integer.valueOf(0xFF00FFFF));
        m.put("cyan", Integer.valueOf(0xFF00FFFF));
        m.put("lime", Integer.valueOf(0xFF00FF00));
        m.put("magenta", Integer.valueOf(0xFFFF00FF));
        m.put("fuchsia", Integer.valueOf(0xFFFF00FF));
        return m;
    }

    // ---- small helpers ----------------------------------------------------------

    private static int withOpacity(int argb, float factor) {
        if (argb == NO_PAINT) return NO_PAINT;
        int alpha = (argb >>> 24) & 0xFF;
        int scaled = Math.round(alpha * clamp01(factor));
        return (scaled << 24) | (argb & 0x00FFFFFF);
    }

    private static float clamp01(float v) {
        if (v < 0f) return 0f;
        if (v > 1f) return 1f;
        return v;
    }

    private static boolean isBold(String weight) {
        if (weight == null) return false;
        String w = weight.trim().toLowerCase(Locale.ROOT);
        if ("bold".equals(w) || "bolder".equals(w)) return true;
        Float numeric = number(w);
        return numeric != null && numeric >= 600f;
    }

    /** A text element's content: inner markup dropped, the five XML entities decoded. */
    private static String textOf(String raw) {
        if (raw == null) return null;
        StringBuilder sb = new StringBuilder();
        int i = 0;
        int n = raw.length();
        while (i < n) {
            char c = raw.charAt(i);
            if (c == '<') {
                int gt = raw.indexOf('>', i);
                if (gt < 0) break;
                i = gt + 1;
                continue;
            }
            sb.append(c);
            i++;
        }
        return decodeEntities(sb.toString()).trim();
    }

    private static String decodeEntities(String s) {
        if (s.indexOf('&') < 0) return s;
        return s.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'");
    }

    private static boolean isSpace(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f';
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    private static boolean isLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}