package press.maestro.crow;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/** WebView download rules (keychain Export fix 2026-10-20). */
public class DownloadPolicyTest {

    private static final String PAIRED = "https://crow.example.ts.net:8444/";
    private static final String FILE = "https://crow.example.ts.net:8444/dashboard/keychain/api/export/file/abc";

    @Test
    public void pairedOriginGetsTheSession() {
        assertEquals(DownloadPolicy.Action.SAVE_WITH_SESSION, DownloadPolicy.decide(FILE, PAIRED));
        assertEquals(DownloadPolicy.Action.SAVE_WITH_SESSION, DownloadPolicy.decide("HTTPS://CROW.example.ts.net:8444/x", PAIRED));
        assertEquals(DownloadPolicy.Action.SAVE_WITH_SESSION, DownloadPolicy.decide("http://10.0.0.201:3001/f", "http://10.0.0.201:3001"));
    }

    @Test
    public void everyOtherHttpOriginOpensOutsideWithoutTheCookie() {
        assertEquals(DownloadPolicy.Action.OPEN_EXTERNAL, DownloadPolicy.decide("https://crow.example.ts.net:8456/f", PAIRED)); // other port
        assertEquals(DownloadPolicy.Action.OPEN_EXTERNAL, DownloadPolicy.decide("https://crow.example.ts.net/f", PAIRED));
        assertEquals(DownloadPolicy.Action.OPEN_EXTERNAL, DownloadPolicy.decide("http://crow.example.ts.net:8444/f", PAIRED)); // other scheme
        assertEquals(DownloadPolicy.Action.OPEN_EXTERNAL, DownloadPolicy.decide("https://grackle.example.ts.net:8444/f", PAIRED));
        assertEquals(DownloadPolicy.Action.OPEN_EXTERNAL, DownloadPolicy.decide("https://crow.example.ts.net.evil.com:8444/f", PAIRED));
    }

    @Test
    public void userInfoNeverGetsTheCookie() {
        assertEquals(DownloadPolicy.Action.REFUSE, DownloadPolicy.decide("https://x:y@crow.example.ts.net:8444/f", PAIRED));
    }

    @Test
    public void blobIsNeverFetchedNatively() {
        assertEquals(DownloadPolicy.Action.REFUSE, DownloadPolicy.decide("blob:https://crow.example.ts.net:8444/0f6c-11", PAIRED));
        assertEquals(DownloadPolicy.Action.REFUSE, DownloadPolicy.decide("BLOB:https://evil.example/0f6c", PAIRED));
    }

    @Test
    public void onlyAnAttachmentResponseIsSaved() {
        assertEquals(true, DownloadPolicy.isAttachment(200, "attachment; filename=\"a.json\""));
        assertEquals(true, DownloadPolicy.isAttachment(200, "Attachment"));
        assertEquals(false, DownloadPolicy.isAttachment(200, null)); // a GET of a POST-form download: the page
        assertEquals(false, DownloadPolicy.isAttachment(200, "inline; filename=\"a.json\""));
        assertEquals(false, DownloadPolicy.isAttachment(200, "attachmentx"));
        assertEquals(false, DownloadPolicy.isAttachment(303, "attachment"));
        assertEquals(false, DownloadPolicy.isAttachment(410, "attachment"));
    }

    @Test
    public void otherSchemesAndNoGatewayAreRefused() {
        for (String u : new String[]{"data:application/json;base64,e30=", "file:///sdcard/x", "javascript:alert(1)", "content://x/y", "", "junk"}) {
            assertEquals(u, DownloadPolicy.Action.REFUSE, DownloadPolicy.decide(u, PAIRED));
        }
        assertEquals(DownloadPolicy.Action.REFUSE, DownloadPolicy.decide(FILE, null));
        assertEquals(DownloadPolicy.Action.REFUSE, DownloadPolicy.decide(FILE, ""));
        assertEquals(DownloadPolicy.Action.REFUSE, DownloadPolicy.decide(null, PAIRED));
    }

    @Test
    public void fileNameComesFromTheHeaderThenTheUrlAndIsSanitized() {
        assertEquals("crow-keychain-2026-10-20.json", DownloadPolicy.fileName("attachment; filename=\"crow-keychain-2026-10-20.json\"", FILE));
        assertEquals("plain.txt", DownloadPolicy.fileName("attachment; filename=plain.txt", FILE));
        assertEquals("résumé.pdf", DownloadPolicy.fileName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf; filename=\"x.pdf\"", FILE));
        assertEquals("abc", DownloadPolicy.fileName(null, FILE));
        assertEquals("_.._etc_passwd", DownloadPolicy.fileName("attachment; filename=\"../../etc/passwd\"", FILE)); // no separator survives
        assertEquals("a_b_c", DownloadPolicy.fileName("attachment; filename=\"a\\b:c\"", FILE));
        assertEquals("bashrc", DownloadPolicy.fileName("attachment; filename=\".bashrc\"", FILE));
        assertEquals("a_b", DownloadPolicy.fileName("attachment; filename=\"a\u0000b\"", FILE));
        assertEquals("download", DownloadPolicy.fileName(null, "https://crow.example.ts.net:8444/"));
        assertEquals("download", DownloadPolicy.fileName("", null));
        assertEquals(100, DownloadPolicy.sanitize(new String(new char[300]).replace('\0', 'a')).length());
    }

    @Test
    public void mimeIsCheckedOrDefaulted() {
        assertEquals("application/json", DownloadPolicy.mime("application/json; charset=utf-8"));
        assertEquals("application/octet-stream", DownloadPolicy.mime("text/html\r\nX: y"));
        assertEquals("application/octet-stream", DownloadPolicy.mime(null));
        assertEquals("application/octet-stream", DownloadPolicy.mime("nonsense"));
    }

    private static Map<String, Object> msg(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    @Test
    public void saveMessageText() {
        DownloadPolicy.SaveRequest r = DownloadPolicy.validateSave(msg("op", "save", "id", "kc11760000000000", "name", "crow-keychain.json", "mime", "application/json", "text", "{}"));
        assertNotNull(r);
        assertEquals("kc11760000000000", r.id);
        assertEquals("crow-keychain.json", r.name);
        assertEquals("application/json", r.mime);
        assertArrayEquals("{}".getBytes(StandardCharsets.UTF_8), r.bytes);
    }

    @Test
    public void saveMessageBase64AndDataUrl() {
        String b = Base64.getEncoder().encodeToString("hi".getBytes(StandardCharsets.UTF_8));
        assertArrayEquals("hi".getBytes(StandardCharsets.UTF_8), DownloadPolicy.validateSave(msg("op", "save", "id", "b1", "name", "a.txt", "b64", b)).bytes);
        DownloadPolicy.SaveRequest d = DownloadPolicy.validateSave(msg("op", "save", "id", "b2", "name", "a.txt", "b64", "data:text/plain;base64," + b));
        assertEquals("text/plain", d.mime);
        assertArrayEquals("hi".getBytes(StandardCharsets.UTF_8), d.bytes);
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "b3", "b64", "data:text/plain,hi")), "not base64 data: URL");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "b4", "b64", "***")), "junk base64");
    }

    @Test
    public void saveMessageRefusesBadShapes() {
        assertNull(DownloadPolicy.validateSave(null), "null");
        assertNull(DownloadPolicy.validateSave(msg("op", "open", "id", "a", "text", "x")), "op");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a-b", "text", "x")), "id chars");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", new String(new char[33]).replace('\0', 'a'), "text", "x")), "id length");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", 7, "text", "x")), "id type");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a")), "neither");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a", "text", "x", "b64", "eA==")), "both");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a", "text", 5)), "text type");
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a", "text", "x", "b64", null)), "b64 present but not a string");
    }

    @Test
    public void saveMessageSizeCaps() {
        String big = new String(new char[DownloadPolicy.MAX_BYTES + 1]).replace('\0', 'a');
        assertNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a", "text", big)), "over the cap");
        String ok = new String(new char[1024]).replace('\0', 'a');
        assertNotNull(DownloadPolicy.validateSave(msg("op", "save", "id", "a", "text", ok)));
    }

    @Test
    public void saveMessageNameIsSanitizedAndMimeDefaulted() {
        DownloadPolicy.SaveRequest r = DownloadPolicy.validateSave(msg("op", "save", "id", "a", "name", "../x.json", "mime", "bad", "text", "x"));
        assertEquals("_x.json", r.name);
        assertEquals("application/octet-stream", r.mime);
        assertEquals("download", DownloadPolicy.validateSave(msg("op", "save", "id", "a", "text", "x")).name);
    }

    private static void assertNull(Object o, String why) {
        org.junit.Assert.assertNull(why, o);
    }
}
