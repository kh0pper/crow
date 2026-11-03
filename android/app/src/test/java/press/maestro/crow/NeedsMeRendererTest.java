package press.maestro.crow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The home-screen widget's draw decisions, without Android: what a locked phone may see, which rows
 * keep buttons, the all-clear state and the sign-in state. (The summary JSON is parsed on the device
 * only — org.json's methods are stubs under the JVM — so this test feeds the renderer plain objects.)
 */
public class NeedsMeRendererTest {

    private static NeedsMeRenderer.Action action(String id, String label) {
        return new NeedsMeRenderer.Action(id, label, "plain");
    }

    private static NeedsMeRenderer.Item item(String key, String kind, String title, String href,
                                             NeedsMeRenderer.Action... actions) {
        return new NeedsMeRenderer.Item(key, kind, title, "Garden", href, "nonce-" + key,
                new ArrayList<>(Arrays.asList(actions)));
    }

    private static NeedsMeRenderer.Summary summary(String state, String headline, String lockLabel,
                                                   List<NeedsMeRenderer.Item> items, List<String> doing) {
        NeedsMeRenderer.Summary s = new NeedsMeRenderer.Summary();
        s.state = state;
        s.title = "What needs me";
        s.headline = headline;
        s.moreHref = "/dashboard/bot-board";
        s.items = items == null ? new ArrayList<>() : items;
        s.doing = doing == null ? new ArrayList<>() : doing;
        s.lockCount = s.items.size();
        s.lockLabel = lockLabel;
        return s;
    }

    @Test
    public void lockViewHasNoItemText() {
        NeedsMeRenderer.Summary s = summary("ok", "2 waiting", null,
                Arrays.asList(
                        item("card:1:decision", "decision", "Choose a mulch", "/dashboard/bot-board/1",
                                action("option:0", "Mulch")),
                        item("handoff:vh-1", "handoff", "Water the beds", "/dashboard/voice/handoffs/vh-1",
                                action("yes", "Yes"))),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, true, false);

        assertEquals(NeedsMeRenderer.Headline.LOCKED, model.kind);
        assertEquals("2 waiting", model.headline);
        assertFalse(model.signIn);
        assertTrue(model.rows.isEmpty());
        assertTrue(model.doing.isEmpty());
    }

    @Test
    public void lockedWithoutALabelFallsBackToTheCount() {
        NeedsMeRenderer.Summary s = summary("ok", "3 waiting", null,
                Arrays.asList(
                        item("card:1:decision", "decision", "A", "/dashboard/x"),
                        item("card:2:plan:1", "plan", "B", "/dashboard/x"),
                        item("message:7", "message", "C", "/dashboard/x")),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, true, false);
        assertEquals("3 waiting", model.headline);
        assertTrue(model.rows.isEmpty());
    }

    @Test
    public void planRowHasNoButtons() {
        NeedsMeRenderer.Summary s = summary("ok", "1 waiting", "1 waiting",
                Arrays.asList(item("card:4:plan:2", "plan", "Approve the rebuild plan", "/dashboard/bot-board/4")),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);

        assertEquals(1, model.rows.size());
        NeedsMeRenderer.Row row = model.rows.get(0);
        assertEquals("card:4:plan:2", row.key);
        assertTrue(row.buttons.isEmpty());
        assertEquals("/dashboard/bot-board/4", row.href);
    }

    @Test
    public void messageRowHasNoButtonsEither() {
        NeedsMeRenderer.Summary s = summary("ok", "1 waiting", "1 waiting",
                Arrays.asList(item("message:7", "message", "A reply from alex", "/dashboard/messages#peer-7")),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);
        assertEquals(1, model.rows.size());
        assertTrue(model.rows.get(0).buttons.isEmpty());
    }

    @Test
    public void decisionRowShowsItsOptionButtons() {
        NeedsMeRenderer.Summary s = summary("ok", "1 waiting", "1 waiting",
                Arrays.asList(item("card:1:decision", "decision", "Choose a mulch", "/dashboard/bot-board/1",
                        action("option:0", "Mulch"), action("option:1", "Compost"))),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);

        assertEquals(1, model.rows.size());
        NeedsMeRenderer.Row row = model.rows.get(0);
        assertEquals(2, row.buttons.size());
        assertEquals("option:0", row.buttons.get(0).id);
        assertEquals("Mulch", row.buttons.get(0).label);
        assertEquals("option:1", row.buttons.get(1).id);
        assertEquals("Compost", row.buttons.get(1).label);
        assertEquals("nonce-card:1:decision", row.nonce);
    }

    @Test
    public void emptySummaryShowsTheHeadlineAndTheDoingLines() {
        NeedsMeRenderer.Summary s = summary("empty", "All clear", "0 waiting", null,
                Arrays.asList("Ivy is on the beds", "Ash is reading the mail"));

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);

        assertEquals(NeedsMeRenderer.Headline.SUMMARY, model.kind);
        assertEquals("All clear", model.headline);
        assertTrue(model.rows.isEmpty());
        assertEquals(2, model.doing.size());
        assertEquals("Ivy is on the beds", model.doing.get(0));
        assertEquals("Ash is reading the mail", model.doing.get(1));
    }

    @Test
    public void signInState() {
        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(null, false, true);

        assertTrue(model.signIn);
        assertEquals(NeedsMeRenderer.Headline.SIGN_IN, model.kind);
        assertTrue(model.rows.isEmpty());
        assertTrue(model.doing.isEmpty());
    }

    @Test
    public void noSummaryIsAnErrorState() {
        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(null, false, false);

        assertEquals(NeedsMeRenderer.Headline.ERROR, model.kind);
        assertFalse(model.signIn);
        assertTrue(model.rows.isEmpty());
        assertTrue(model.doing.isEmpty());
    }

    @Test
    public void serverErrorStateCarriesNoRows() {
        NeedsMeRenderer.Summary s = summary("error", "", "0 waiting",
                Arrays.asList(item("card:1:decision", "decision", "Choose a mulch", "/dashboard/bot-board/1",
                        action("option:0", "Mulch"))),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);
        assertEquals(NeedsMeRenderer.Headline.ERROR, model.kind);
        assertTrue(model.rows.isEmpty());
    }

    @Test
    public void hrefGuard() {
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, NeedsMeRenderer.safeHref("javascript:alert(1)"));
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, NeedsMeRenderer.safeHref("//evil.example/x"));
        assertEquals("/dashboard/x", NeedsMeRenderer.safeHref("/dashboard/x"));
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, NeedsMeRenderer.safeHref(null));
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, NeedsMeRenderer.safeHref(""));
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, NeedsMeRenderer.safeHref("https://crow.example.ts.net/x"));
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, NeedsMeRenderer.safeHref("/"));
        assertEquals("/dashboard/messages#peer-7", NeedsMeRenderer.safeHref("/dashboard/messages#peer-7"));
    }

    @Test
    public void anUnsafeHrefBecomesTheBoard() {
        NeedsMeRenderer.Summary s = summary("ok", "1 waiting", "1 waiting",
                Arrays.asList(item("card:1:decision", "decision", "Choose a mulch", "javascript:alert(1)")),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);
        assertEquals(NeedsMeRenderer.FALLBACK_HREF, model.rows.get(0).href);
    }

    @Test
    public void atMostFiveRows() {
        List<NeedsMeRenderer.Item> items = new ArrayList<>();
        for (int i = 1; i <= 7; i++) {
            items.add(item("card:" + i + ":decision", "decision", "Item " + i, "/dashboard/bot-board/" + i,
                    action("option:0", "Mulch")));
        }
        NeedsMeRenderer.Summary s = summary("ok", "7 waiting", "7 waiting", items, null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);

        assertEquals(NeedsMeRenderer.MAX_ROWS, model.rows.size());
        assertEquals(5, model.rows.size());
        assertEquals("card:5:decision", model.rows.get(4).key);
    }

    @Test
    public void aRowKeepsAtMostThreeButtons() {
        NeedsMeRenderer.Summary s = summary("ok", "1 waiting", "1 waiting",
                Arrays.asList(item("card:1:decision", "decision", "Choose a mulch", "/dashboard/bot-board/1",
                        action("option:0", "A"), action("option:1", "B"), action("option:2", "C"),
                        action("option:3", "D"))),
                null);

        NeedsMeRenderer.RenderModel model = NeedsMeRenderer.render(s, false, false);
        assertEquals(NeedsMeRenderer.MAX_BUTTONS, model.rows.get(0).buttons.size());

        assertNotNull(model.moreHref);
    }
}