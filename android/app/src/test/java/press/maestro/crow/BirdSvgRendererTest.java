package press.maestro.crow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The bird's SVG subset, on the JVM: what BirdSvgRenderer makes of the drawing the gateway sends
 * (widgets phase 3, GET /dashboard/widgets-api/bird -> `svg`).
 *
 * The rules under test are the widget's robustness rules (review focus 1): an element the renderer
 * does not know costs that element and nothing else, a malformed number costs its element (a
 * malformed GROUP transform costs its subtree, because its children would land in the wrong place),
 * and nothing throws. Plus: the real drawing the engine makes — a genuine bird-svg.cjs string — comes
 * out as the whole bird, with the outfit, the mood face and the walk badge.
 */
public class BirdSvgRendererTest {

    /**
     * The REAL output of bundles/ramble/server/bird-svg.cjs: crow, seed 123456, mood happy, walked
     * today (drawBird + drawWalkBadge inside the 200x200 viewBox), exactly as the gateway's
     * renderBirdSvg hands it to the phone.
     */
    private static final String REAL_BIRD =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 200\">"
            + "<g transform=\"translate(100.00 118.00) rotate(1.57) scale(1.02) translate(-100.00 -118.00)\">"
            + "<g stroke=\"#c98a3a\" stroke-width=\"4\" stroke-linecap=\"round\" fill=\"none\">"
            + "<path transform=\"translate(88.00 152.00)\" d=\"M0 0 v16 m-8 0 h16\"/>"
            + "<path transform=\"translate(112.00 152.00)\" d=\"M0 0 v16 m-8 0 h16\"/></g>"
            + "<path transform=\"translate(62.58 112.00) scale(1.00 1)\" d=\"M0 0 l-26 -14 l4 22 z\" fill=\"#1d1e32\"/>"
            + "<ellipse cx=\"100.00\" cy=\"118.00\" rx=\"43.42\" ry=\"42.00\" fill=\"#1d1e32\"/>"
            + "<ellipse cx=\"104.00\" cy=\"126.00\" rx=\"26.92\" ry=\"26.04\" fill=\"#21232e\" opacity=\".95\"/>"
            + "<ellipse cx=\"78.00\" cy=\"120.00\" rx=\"18\" ry=\"24\" fill=\"#1a1b35\" opacity=\".9\" transform=\"rotate(-12 78.00 120.00)\"/>"
            + "<circle cx=\"100.00\" cy=\"68.00\" r=\"30.00\" fill=\"#1d1e32\"/>"
            + "<path transform=\"translate(96.00 42.00) scale(1 0.60)\" d=\"M0 0 q6 -18 14 -6 q-6 4 -8 10 z\" fill=\"#1d1e32\"/>"
            + "<ellipse cx=\"94.00\" cy=\"78.00\" rx=\"7\" ry=\"4\" fill=\"#ff8fa3\" opacity=\".55\"/>"
            + "<circle cx=\"110.00\" cy=\"68.00\" r=\"7\" fill=\"#1a1a1a\"/>"
            + "<circle cx=\"112.50\" cy=\"65.50\" r=\"2.6\" fill=\"#fff\"/>"
            + "<path transform=\"translate(122.00 72.00)\" d=\"M0 0 l20 5 l-20 6 z\" fill=\"#d9a521\"/>"
            + "</g>"
            + "<g class=\"rb-walk-badge\" transform=\"translate(152 152)\">"
            + "<circle cx=\"18\" cy=\"18\" r=\"18\" fill=\"#fff8e6\" stroke=\"#2b2350\" stroke-width=\"3\"/>"
            + "<ellipse cx=\"12.5\" cy=\"21\" rx=\"4.2\" ry=\"6.4\" fill=\"#2b2350\" transform=\"rotate(-14 12.5 21)\"/>"
            + "<circle cx=\"11\" cy=\"11.2\" r=\"2.1\" fill=\"#2b2350\"/>"
            + "<ellipse cx=\"23.5\" cy=\"17\" rx=\"4.2\" ry=\"6.4\" fill=\"#2b2350\" transform=\"rotate(14 23.5 17)\"/>"
            + "<circle cx=\"25\" cy=\"7.2\" r=\"2.1\" fill=\"#2b2350\"/>"
            + "</g></svg>";

    private static BirdSvgRenderer.Op firstOf(BirdSvgRenderer.Drawing d, BirdSvgRenderer.Kind kind) {
        for (BirdSvgRenderer.Op op : d.ops) {
            if (op.kind == kind) return op;
        }
        return null;
    }

    /** A widget update gets a small slice of a frame budget; a parse may never come near 2 s. */
    private static final long MAX_PARSE_NANOS = 2_000_000_000L;

    /** Parse, and fail the test if it took 2 s or more (or threw — a throw fails it too). */
    private static BirdSvgRenderer.Drawing parseQuickly(String svg) {
        long start = System.nanoTime();
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(svg);
        long elapsed = System.nanoTime() - start;
        assertNotNull(d);
        assertTrue("parse took " + (elapsed / 1_000_000) + " ms", elapsed < MAX_PARSE_NANOS);
        return d;
    }

    @Test
    public void realBirdIsDrawnWhole() {
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(REAL_BIRD);
        assertTrue("the bird has an SVG viewBox", d.hasViewBox);
        assertEquals(0f, d.viewBox[0], 0.001f);
        assertEquals(0f, d.viewBox[1], 0.001f);
        assertEquals(200f, d.viewBox[2], 0.001f);
        assertEquals(200f, d.viewBox[3], 0.001f);

        // Two feet, a tail, a crest, a beak: five paths. Body, belly, wing, cheeks and the badge's two
        // footprints: six ellipses. Head, eye, catchlight and the badge's three dots: six circles.
        int paths = 0;
        int ellipses = 0;
        int circles = 0;
        for (BirdSvgRenderer.Op op : d.ops) {
            if (op.kind == BirdSvgRenderer.Kind.PATH) paths++;
            else if (op.kind == BirdSvgRenderer.Kind.ELLIPSE) ellipses++;
            else if (op.kind == BirdSvgRenderer.Kind.CIRCLE) circles++;
        }
        assertEquals(5, paths);
        assertEquals(6, ellipses);
        assertEquals(6, circles);
        assertEquals(17, d.ops.size());

        // The head: a circle of r=30 in the bird's colour, carrying the group's own transform (a bird
        // that ignored the enclosing <g> would draw at the top-left corner of the widget).
        BirdSvgRenderer.Op head = null;
        for (BirdSvgRenderer.Op op : d.ops) {
            if (op.kind == BirdSvgRenderer.Kind.CIRCLE && Math.abs(op.rx - 30f) < 0.01f) head = op;
        }
        assertNotNull("the head was parsed", head);
        assertEquals(0xFF1D1E32, head.fill);
        assertEquals(100f, head.cx, 0.01f);
        assertEquals(68f, head.cy, 0.01f);
        assertFalse("the enclosing group's transform was applied", head.transform[4] == 0f && head.transform[5] == 0f);

        // The feet: a group's fill="none" and stroke ARE inherited (a stroke-only path, no fill).
        BirdSvgRenderer.Op foot = d.ops.get(0);
        assertEquals(BirdSvgRenderer.Kind.PATH, foot.kind);
        assertEquals(BirdSvgRenderer.NO_PAINT, foot.fill);
        assertEquals(0xFFC98A3A, foot.stroke);
        assertEquals(4f, foot.strokeWidth, 0.01f);
        assertTrue("stroke-linecap=\"round\" is kept", foot.roundCap);

        // The walk badge: its own group, translated to the portrait's lower-right corner.
        BirdSvgRenderer.Op badgeRing = null;
        for (BirdSvgRenderer.Op op : d.ops) {
            if (op.kind == BirdSvgRenderer.Kind.CIRCLE && Math.abs(op.rx - 18f) < 0.01f) badgeRing = op;
        }
        assertNotNull("the badge's roundel was parsed", badgeRing);
        assertEquals(0xFF2B2350, badgeRing.stroke);
        assertEquals(3f, badgeRing.strokeWidth, 0.01f);
        assertEquals(152f, badgeRing.transform[4], 0.01f);
        assertEquals(152f, badgeRing.transform[5], 0.01f);

        // opacity=".55" on the cheeks is folded into the fill's alpha.
        BirdSvgRenderer.Op cheeks = null;
        for (BirdSvgRenderer.Op op : d.ops) {
            if (op.kind == BirdSvgRenderer.Kind.ELLIPSE && (op.fill & 0x00FFFFFF) == 0x00FF8FA3) cheeks = op;
        }
        assertNotNull("the cheeks were parsed", cheeks);
        int cheeksAlpha = (cheeks.fill >>> 24) & 0xFF;
        assertTrue("opacity .55 reached the alpha (" + cheeksAlpha + ")", cheeksAlpha > 100 && cheeksAlpha < 160);
    }

    @Test
    public void parsesTheShapesAndNestedGroupTransforms() {
        String svg = "<svg viewBox='0 0 10 10'>"
                + "<circle cx='1' cy='2' r='3' fill='#111'/>"
                + "<ellipse cx='4' cy='5' rx='6' ry='7' fill='#222'/>"
                + "<g transform='translate(10 20)'><g transform='scale(2)'>"
                + "<rect x='1' y='1' width='2' height='3' rx='0.5' fill='#333'/>"
                + "</g></g>"
                + "<path d='M0 0 L10 0 L10 10 Z' fill='#444'/>"
                + "<text x='7' y='8' font-size='26' font-weight='800' fill='#ef4444'>!</text>"
                + "</svg>";
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(svg);
        assertEquals(5, d.ops.size());

        BirdSvgRenderer.Op circle = d.ops.get(0);
        assertEquals(BirdSvgRenderer.Kind.CIRCLE, circle.kind);
        assertEquals(1f, circle.cx, 0.001f);
        assertEquals(2f, circle.cy, 0.001f);
        assertEquals(3f, circle.rx, 0.001f);
        assertEquals(0xFF111111, circle.fill);

        BirdSvgRenderer.Op ellipse = d.ops.get(1);
        assertEquals(BirdSvgRenderer.Kind.ELLIPSE, ellipse.kind);
        assertEquals(6f, ellipse.rx, 0.001f);
        assertEquals(7f, ellipse.ry, 0.001f);

        BirdSvgRenderer.Op rect = d.ops.get(2);
        assertEquals(BirdSvgRenderer.Kind.RECT, rect.kind);
        assertEquals(1f, rect.x, 0.001f);
        assertEquals(1f, rect.y, 0.001f);
        assertEquals(2f, rect.w, 0.001f);
        assertEquals(3f, rect.h, 0.001f);
        assertEquals(0.5f, rect.cornerRx, 0.001f);
        // translate(10 20) then scale(2): x' = 2x + 10, y' = 2y + 20.
        assertEquals(2f, rect.transform[0], 0.001f);
        assertEquals(2f, rect.transform[3], 0.001f);
        assertEquals(10f, rect.transform[4], 0.001f);
        assertEquals(20f, rect.transform[5], 0.001f);

        BirdSvgRenderer.Op path = d.ops.get(3);
        assertEquals(BirdSvgRenderer.Kind.PATH, path.kind);
        assertEquals("M0 0 L10 0 L10 10 Z", path.pathData);

        BirdSvgRenderer.Op text = d.ops.get(4);
        assertEquals(BirdSvgRenderer.Kind.TEXT, text.kind);
        assertEquals("!", text.text);
        assertEquals(7f, text.x, 0.001f);
        assertEquals(8f, text.y, 0.001f);
        assertEquals(26f, text.fontSize, 0.001f);
        assertTrue("font-weight 800 is bold", text.bold);
        assertEquals(0xFFEF4444, text.fill);
    }

    @Test
    public void rotateAndMatrixTransformsAreComposed() {
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse("<svg viewBox='0 0 10 10'>"
                + "<g transform='rotate(90)'><circle cx='0' cy='0' r='1'/></g>"
                + "<circle cx='0' cy='0' r='1' transform='matrix(1 2 3 4 5 6)'/>"
                + "<circle cx='0' cy='0' r='1' transform='rotate(90 10 10)'/>"
                + "</svg>");
        assertEquals(3, d.ops.size());
        BirdSvgRenderer.Op rotated = d.ops.get(0);
        assertEquals(0f, rotated.transform[0], 0.001f);
        assertEquals(1f, rotated.transform[1], 0.001f);
        assertEquals(-1f, rotated.transform[2], 0.001f);
        assertEquals(0f, rotated.transform[3], 0.001f);

        BirdSvgRenderer.Op matrix = d.ops.get(1);
        assertEquals(1f, matrix.transform[0], 0.001f);
        assertEquals(2f, matrix.transform[1], 0.001f);
        assertEquals(3f, matrix.transform[2], 0.001f);
        assertEquals(4f, matrix.transform[3], 0.001f);
        assertEquals(5f, matrix.transform[4], 0.001f);
        assertEquals(6f, matrix.transform[5], 0.001f);

        // rotate(90 10 10) keeps (10,10) where it is.
        BirdSvgRenderer.Op spinned = d.ops.get(2);
        assertEquals(10f - 0f * 10f + 1f * 10f, spinned.transform[4], 0.001f);
        assertEquals(10f - 1f * 10f - 0f * 10f, spinned.transform[5], 0.001f);
    }

    @Test
    public void unknownElementsAndAttributesAreSkippedNotThrown() {
        String svg = "<svg viewBox='0 0 10 10' xmlns='http://www.w3.org/2000/svg'>"
                + "<title>A bird</title>"
                + "<circle cx='1' cy='1' r='1' fill='#123' filter='url(#blur)'/>"
                + "<fancy-new-thing x='1' y='2'><circle cx='9' cy='9' r='9'/></fancy-new-thing>"
                + "<rect x='0' y='0' width='1' height='1' fill='#456'/>"
                + "</svg>";
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(svg);
        assertEquals("the two known shapes, and nothing from the unknown element", 2, d.ops.size());
        assertEquals(BirdSvgRenderer.Kind.CIRCLE, d.ops.get(0).kind);
        assertEquals(BirdSvgRenderer.Kind.RECT, d.ops.get(1).kind);

        // Junk in, an empty drawing out — never an exception.
        assertTrue(BirdSvgRenderer.parse(null).ops.isEmpty());
        assertTrue(BirdSvgRenderer.parse("").ops.isEmpty());
        assertTrue(BirdSvgRenderer.parse("not an svg at all").ops.isEmpty());
        assertTrue(BirdSvgRenderer.parse("<svg><circle cx='1'").ops.isEmpty());
    }

    @Test
    public void malformedNumbersSkipThatElementAndNothingElse() {
        String svg = "<svg viewBox='0 0 10 10'>"
                + "<circle cx='1' cy='1' r='abc' fill='#111'/>"
                + "<circle cx='2' cy='2' r='2' fill='#222'/>"
                + "<ellipse cx='3' cy='3' rx='1' fill='#333'/>"
                + "<rect x='0' y='0' width='1x' height='1' fill='#444'/>"
                + "<path d='M0 0 l3 x' fill='#555'/>"
                + "<path d='M0 0 l3 4 z' fill='#666'/>"
                + "<g transform='translate(nope)'><circle cx='5' cy='5' r='5' fill='#777'/></g>"
                + "<circle cx='6' cy='6' r='6' fill='#888'/>"
                + "</svg>";
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(svg);
        assertEquals("the good circle, the good path and the last circle", 3, d.ops.size());
        assertEquals(0xFF222222, d.ops.get(0).fill);
        assertEquals(BirdSvgRenderer.Kind.PATH, d.ops.get(1).kind);
        assertEquals(0xFF666666, d.ops.get(1).fill);
        assertEquals(0xFF888888, d.ops.get(2).fill);
    }

    @Test
    public void colours() {
        String svg = "<svg viewBox='0 0 10 10'>"
                + "<g fill='#010203'>"
                + "<circle cx='1' cy='1' r='1' fill='blurple'/>"
                + "<circle cx='2' cy='2' r='1' fill='none'/>"
                + "<circle cx='3' cy='3' r='1' fill='red'/>"
                + "<circle cx='4' cy='4' r='1' fill='#fff'/>"
                + "<circle cx='5' cy='5' r='1' fill='#1d1e32'/>"
                + "<circle cx='6' cy='6' r='1' fill='rgb(255, 128, 0)'/>"
                + "</g>"
                + "<circle cx='7' cy='7' r='1' style='fill:#0f0;opacity:.5'/>"
                + "</svg>";
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(svg);
        assertEquals(7, d.ops.size());
        assertEquals("an unknown colour inherits", 0xFF010203, d.ops.get(0).fill);
        assertEquals("none paints nothing", BirdSvgRenderer.NO_PAINT, d.ops.get(1).fill);
        assertEquals(0xFFFF0000, d.ops.get(2).fill);
        assertEquals(0xFFFFFFFF, d.ops.get(3).fill);
        assertEquals(0xFF1D1E32, d.ops.get(4).fill);
        assertEquals(0xFFFF8000, d.ops.get(5).fill);
        // style wins over attributes, and opacity reaches the alpha.
        assertEquals(0x8000FF00, d.ops.get(6).fill);
    }

    @Test
    public void viewBoxAndSvgDefaultFill() {
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse("<svg viewBox='-5 -6 24 12'><rect x='0' y='0' width='1' height='1'/></svg>");
        assertTrue(d.hasViewBox);
        assertEquals(-5f, d.viewBox[0], 0.001f);
        assertEquals(-6f, d.viewBox[1], 0.001f);
        assertEquals(24f, d.viewBox[2], 0.001f);
        assertEquals(12f, d.viewBox[3], 0.001f);
        assertEquals("SVG's default fill is black", 0xFF000000, d.ops.get(0).fill);

        // No viewBox but a width/height: still a box to lay the drawing out in.
        BirdSvgRenderer.Drawing sized = BirdSvgRenderer.parse("<svg width='32' height='32'><circle cx='1' cy='1' r='1'/></svg>");
        assertTrue(sized.hasViewBox);
        assertEquals(32f, sized.viewBox[2], 0.001f);

        // Nothing at all: the caller falls back to the 200-box.
        assertFalse(BirdSvgRenderer.parse("<svg><circle cx='1' cy='1' r='1'/></svg>").hasViewBox);
    }

    @Test
    public void commentsDoctypeAndCdataAreIgnored() {
        String svg = "<?xml version='1.0'?><!DOCTYPE svg><!-- a note -->"
                + "<svg viewBox='0 0 10 10'>"
                + "<circle cx='1' cy='1' r='1' fill='#abc'/>"
                + "</svg>";
        BirdSvgRenderer.Drawing d = BirdSvgRenderer.parse(svg);
        assertEquals(1, d.ops.size());
        assertEquals(0xFFAABBCC, d.ops.get(0).fill);
    }

    // ---- the bounds (review round 1): a broken or hostile drawing costs a redraw, never the widget --

    @Test
    public void deeplyNestedGroupsAreCappedAtMaxDepth() {
        // 100,000 `<g>` tags are 300 KB — past MAX_SVG_CHARS, where the size guard answers before the
        // walk starts. 80,000 (240 KB) fits under the cap and is far past the depth cap: the walk used to
        // push a state per level and search the stack on every closing tag.
        StringBuilder sb = new StringBuilder("<svg viewBox='0 0 200 200'><circle cx='1' cy='1' r='7'/>");
        for (int i = 0; i < 80_000; i++) sb.append("<g>");
        sb.append("<circle cx='2' cy='2' r='9'/></svg>");
        String svg = sb.toString();
        assertTrue("the document is under the size cap", svg.length() < BirdSvgRenderer.MAX_SVG_CHARS);

        BirdSvgRenderer.Drawing d = parseQuickly(svg);
        assertEquals("only the shape above the depth cap is drawn", 1, d.ops.size());
        assertEquals(7f, d.ops.get(0).rx, 0.001f);
    }

    @Test
    public void unmatchedClosingTagsCostOnlyTheStack() {
        // Thirty open groups and a flood of closing tags that match none of them: the search is the
        // stack's length (capped at MAX_DEPTH), never a rescan of the document.
        StringBuilder sb = new StringBuilder("<svg viewBox='0 0 200 200'><circle cx='1' cy='1' r='5'/>");
        for (int i = 0; i < 30; i++) sb.append("<g>");
        for (int i = 0; i < 60_000; i++) sb.append("</q>");
        sb.append("</svg>");
        String svg = sb.toString();
        assertTrue("the document is under the size cap", svg.length() < BirdSvgRenderer.MAX_SVG_CHARS);

        BirdSvgRenderer.Drawing d = parseQuickly(svg);
        assertEquals(1, d.ops.size());
        assertEquals(5f, d.ops.get(0).rx, 0.001f);
    }

    @Test
    public void elementFloodStopsAtTheOpCap() {
        // 100,000 circles written out are ~1.3 MB: past MAX_SVG_CHARS, so the size guard answers first.
        // The point is that neither guard builds 100,000 ops.
        StringBuilder huge = new StringBuilder("<svg viewBox='0 0 200 200'>");
        for (int i = 0; i < 100_000; i++) huge.append("<circle r='1'/>");
        huge.append("</svg>");
        BirdSvgRenderer.Drawing refused = parseQuickly(huge.toString());
        assertTrue("never more than the op cap", refused.ops.size() <= BirdSvgRenderer.MAX_OPS);

        // The cap itself, in a document small enough to reach the walk: it stops at MAX_OPS.
        StringBuilder many = new StringBuilder("<svg viewBox='0 0 200 200'>");
        for (int i = 0; i < 4_000; i++) many.append("<circle r='1'/>");
        many.append("</svg>");
        String svg = many.toString();
        assertTrue("the document is under the size cap", svg.length() < BirdSvgRenderer.MAX_SVG_CHARS);
        assertEquals(BirdSvgRenderer.MAX_OPS, parseQuickly(svg).ops.size());
    }

    @Test
    public void anOversizedDocumentIsAnEmptyDrawing() {
        StringBuilder sb = new StringBuilder("<svg viewBox='0 0 200 200'>");
        while (sb.length() < 300 * 1024) sb.append("<circle cx='1' cy='1' r='1'/>");
        sb.append("</svg>");
        String svg = sb.toString();
        assertTrue(svg.length() > BirdSvgRenderer.MAX_SVG_CHARS);

        BirdSvgRenderer.Drawing d = parseQuickly(svg);
        assertTrue("an oversized answer is refused whole, never half-drawn", d.ops.isEmpty());
        assertFalse(d.hasViewBox);
    }

    @Test
    public void anOverlongPathIsSkippedAndTheRestIsDrawn() {
        StringBuilder d = new StringBuilder("M0 0");
        while (d.length() < 40 * 1024) d.append(" l1 1");
        String svg = "<svg viewBox='0 0 200 200'>"
                + "<path d='" + d + "' fill='#111'/>"
                + "<circle cx='3' cy='3' r='3' fill='#222'/>"
                + "<path d='M0 0 l2 2 z' fill='#333'/>"
                + "</svg>";
        assertTrue(d.length() > BirdSvgRenderer.MAX_PATH_CHARS);
        assertTrue("the document is under the size cap", svg.length() < BirdSvgRenderer.MAX_SVG_CHARS);

        BirdSvgRenderer.Drawing parsed = parseQuickly(svg);
        assertEquals("the circle and the short path; the 40 KB path is skipped", 2, parsed.ops.size());
        assertEquals(BirdSvgRenderer.Kind.CIRCLE, parsed.ops.get(0).kind);
        assertEquals(BirdSvgRenderer.Kind.PATH, parsed.ops.get(1).kind);
        assertEquals("M0 0 l2 2 z", parsed.ops.get(1).pathData);
    }

    @Test
    public void aKeyguardDrawingLeavesOutTheWalkBadge() {
        BirdSvgRenderer.Drawing walked = BirdSvgRenderer.parse(REAL_BIRD);
        assertEquals(17, walked.ops.size());

        // The badge group and its five shapes (a roundel, two footprints, two dots) are gone; the bird
        // itself — head, body, belly, wing, tail, crest, beak, eye, feet — stays.
        BirdSvgRenderer.Drawing hidden = BirdSvgRenderer.parse(REAL_BIRD, false);
        assertEquals(12, hidden.ops.size());
        for (BirdSvgRenderer.Op op : hidden.ops) {
            assertFalse("no badge roundel",
                    op.kind == BirdSvgRenderer.Kind.CIRCLE && Math.abs(op.rx - 18f) < 0.01f);
        }
        BirdSvgRenderer.Op head = null;
        for (BirdSvgRenderer.Op op : hidden.ops) {
            if (op.kind == BirdSvgRenderer.Kind.CIRCLE && Math.abs(op.rx - 30f) < 0.01f) head = op;
        }
        assertNotNull("the bird is still drawn", head);
        assertEquals(0xFF1D1E32, head.fill);
    }
}