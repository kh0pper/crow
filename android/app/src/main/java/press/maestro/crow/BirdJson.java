package press.maestro.crow;

import org.json.JSONObject;

/**
 * The bird API's JSON (GET /dashboard/widgets-api/bird) on the device: Android's org.json, on the
 * device only.
 *
 * No JVM test lives here on purpose — org.json's methods are stubs under the JVM — so this stays tiny
 * and defensive: a missing or mistyped field becomes null or 0, never an exception that costs the
 * whole widget. Every decision worth testing is in BirdSvgRenderer (and NeedsMeRenderer's siblings).
 *
 * The cache holds one of three things: the bird exactly as the gateway sent it, {@link #SIGN_IN_JSON}
 * when the last refresh found no session, or {@link #NO_BIRD_JSON} when this instance has no Ramble or
 * no hatched bird (the gateway's 404 codes) — the widget says so instead of pretending.
 */
final class BirdJson {

    /** The cached "this app has no session for the owner" state (never served by the gateway). */
    static final String SIGN_IN_STATE = "sign_in";
    static final String SIGN_IN_JSON = "{\"state\":\"" + SIGN_IN_STATE + "\"}";

    /** The cached "Ramble is here but there is no bird yet" state (the gateway's no_bird/no_ramble). */
    static final String NO_BIRD_STATE = "no_bird";
    static final String NO_BIRD_JSON = "{\"state\":\"" + NO_BIRD_STATE + "\"}";

    private BirdJson() {
    }

    /** The bird API's answer, as plain fields. */
    static final class Bird {
        /** null for a real bird; {@link #SIGN_IN_STATE} or {@link #NO_BIRD_STATE} otherwise. */
        String state;
        String mood;
        int steps;
        int stepsGoal;
        boolean walked;
        /** The full drawing, the same SVG string the profile picture is made of. */
        String svg;

        boolean hasDrawing() {
            return state == null && svg != null && !svg.trim().isEmpty();
        }
    }

    /** The answer in a cached string, or null when it is absent or not the JSON we expected. */
    static Bird fromText(String text) {
        if (text == null || text.trim().isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(text);
            Bird bird = new Bird();
            bird.state = string(o, "state");
            bird.mood = string(o, "mood");
            bird.steps = Math.max(0, o.optInt("steps", 0));
            bird.stepsGoal = Math.max(0, o.optInt("steps_goal", 0));
            bird.walked = o.optBoolean("walked", false);
            bird.svg = string(o, "svg");
            return bird;
        } catch (Exception e) {
            return null;
        }
    }

    /** The field as a string, or null when it is absent, JSON null or not a string at all. */
    private static String string(JSONObject o, String key) {
        Object value = o.opt(key);
        return value instanceof String ? (String) value : null;
    }
}