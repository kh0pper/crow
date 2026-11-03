package press.maestro.crow;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The summary JSON → NeedsMeRenderer.Summary, on the device only: Android's org.json.
 *
 * No JVM unit test lives here on purpose — org.json's methods are stubs under the JVM — so this file
 * stays tiny and defensive: a missing, mistyped or empty field becomes null or an empty list, never an
 * exception that costs the whole widget. Every decision worth testing is in NeedsMeRenderer.
 *
 * The widget's cache under the "needs_me_cache" key is one of two things: a summary exactly as the
 * gateway sent it, or {@link #SIGN_IN_JSON} when the last refresh found no session.
 */
final class NeedsMeJson {

    /** The synthetic state stored when the app is signed out (never served by the gateway). */
    static final String SIGN_IN_STATE = "sign_in";
    static final String SIGN_IN_JSON = "{\"state\":\"" + SIGN_IN_STATE + "\"}";

    private NeedsMeJson() {
    }

    /** The summary in a cached string, or null when it is absent or not the JSON we expected. */
    static NeedsMeRenderer.Summary fromText(String text) {
        if (text == null || text.trim().isEmpty()) return null;
        try {
            return fromJson(new JSONObject(text));
        } catch (Exception e) {
            return null;
        }
    }

    static NeedsMeRenderer.Summary fromJson(JSONObject o) {
        if (o == null) return null;
        NeedsMeRenderer.Summary s = new NeedsMeRenderer.Summary();
        s.state = string(o, "state");
        s.title = string(o, "title");
        s.headline = string(o, "headline");
        s.moreHref = string(o, "more_href");

        JSONObject lock = o.optJSONObject("lock");
        if (lock != null) {
            s.lockCount = lock.optInt("count", 0);
            s.lockLabel = string(lock, "label");
        }

        JSONArray doing = o.optJSONArray("doing");
        if (doing != null) {
            List<String> lines = new ArrayList<>();
            for (int i = 0; i < doing.length(); i++) {
                String line = doing.optString(i, null);
                if (line != null && !line.trim().isEmpty()) lines.add(line.trim());
            }
            s.doing = lines;
        }

        JSONArray items = o.optJSONArray("items");
        if (items != null) {
            List<NeedsMeRenderer.Item> parsed = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                JSONObject io = items.optJSONObject(i);
                if (io != null) parsed.add(item(io));
            }
            s.items = parsed;
        }
        return s;
    }

    private static NeedsMeRenderer.Item item(JSONObject o) {
        NeedsMeRenderer.Item item = new NeedsMeRenderer.Item();
        item.key = string(o, "key");
        item.kind = string(o, "kind");
        item.title = string(o, "title");
        item.project = string(o, "project");
        item.href = string(o, "href");
        item.nonce = string(o, "nonce");

        JSONArray actions = o.optJSONArray("actions");
        if (actions != null) {
            List<NeedsMeRenderer.Action> parsed = new ArrayList<>();
            for (int i = 0; i < actions.length(); i++) {
                JSONObject ao = actions.optJSONObject(i);
                if (ao == null) continue;
                String id = string(ao, "id");
                if (id == null) continue;
                parsed.add(new NeedsMeRenderer.Action(id, string(ao, "label"), string(ao, "style")));
            }
            item.actions = parsed;
        }
        return item;
    }

    /** The field as a string, or null when it is absent, JSON null or not a string at all. */
    private static String string(JSONObject o, String key) {
        Object value = o.opt(key);
        return value instanceof String ? (String) value : null;
    }
}