package press.maestro.crow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The steps bridge's origin gate (security fix 2026-10-04, spec §10 "Exposure"). */
public class OriginCheckTest {

    private static final String PAIRED = "https://crow.example.ts.net:8444/";

    @Test
    public void canonicalFillsDefaultPortsAndLowercases() {
        assertEquals("https://crow.example.ts.net:443", OriginCheck.canonical("HTTPS://Crow.Example.ts.net/dashboard"));
        assertEquals("http://10.0.0.237:80", OriginCheck.canonical("http://10.0.0.237"));
        assertEquals("https://crow.example.ts.net:8444", OriginCheck.canonical("https://crow.example.ts.net:8444/x?y=1#z"));
        assertEquals("http://[::1]:3001", OriginCheck.canonical("http://[::1]:3001/"));
    }

    @Test
    public void canonicalRejectsNonHttpAndJunk() {
        assertNull(OriginCheck.canonical(null));
        assertNull(OriginCheck.canonical(""));
        assertNull(OriginCheck.canonical("null"));
        assertNull(OriginCheck.canonical("file:///android_asset/x.html"));
        assertNull(OriginCheck.canonical("javascript:alert(1)"));
        assertNull(OriginCheck.canonical("data:text/html,hi"));
        assertNull(OriginCheck.canonical("https://"));
        assertNull(OriginCheck.canonical("https://bad host/"));
    }

    @Test
    public void pairedPageIsTrusted() {
        assertTrue(OriginCheck.sameOrigin("https://crow.example.ts.net:8444", PAIRED));
        assertTrue(OriginCheck.sameOrigin("https://crow.example.ts.net:8444/dashboard/ramble", PAIRED));
        assertTrue(OriginCheck.sameOrigin("https://CROW.example.ts.net:8444", PAIRED));
        assertTrue(OriginCheck.sameOrigin("https://crow.example.ts.net:443", "https://crow.example.ts.net/"));
    }

    @Test
    public void sameHostOtherPortIsRefused() {
        assertFalse(OriginCheck.sameOrigin("https://crow.example.ts.net:8456", PAIRED)); // Nextcloud
        assertFalse(OriginCheck.sameOrigin("https://crow.example.ts.net:8457", PAIRED)); // ONLYOFFICE
        assertFalse(OriginCheck.sameOrigin("https://crow.example.ts.net", PAIRED));
    }

    @Test
    public void otherHostsAndSchemesAreRefused() {
        assertFalse(OriginCheck.sameOrigin("https://grackle.example.ts.net:8444", PAIRED));
        assertFalse(OriginCheck.sameOrigin("http://crow.example.ts.net:8444", PAIRED));
        assertFalse(OriginCheck.sameOrigin("https://crow.example.ts.net.evil.com:8444", PAIRED));
        assertFalse(OriginCheck.sameOrigin("null", PAIRED));
        assertFalse(OriginCheck.sameOrigin(PAIRED, null));
        assertFalse(OriginCheck.sameOrigin(PAIRED, ""));
        assertFalse(OriginCheck.sameOrigin(null, null));
    }

    @Test
    public void changedGatewayMovesTheTrust() {
        String next = "http://10.0.0.237:3001";
        assertTrue(OriginCheck.sameOrigin("http://10.0.0.237:3001", next));
        assertFalse(OriginCheck.sameOrigin("https://crow.example.ts.net:8444", next));
    }

    @Test
    public void allowedOriginRuleOmitsOnlyDefaultPorts() {
        assertEquals("https://crow.example.ts.net:8444", OriginCheck.allowedOriginRule(PAIRED));
        assertEquals("https://crow.example.ts.net", OriginCheck.allowedOriginRule("https://Crow.Example.ts.net:443/x"));
        assertEquals("http://10.0.0.237", OriginCheck.allowedOriginRule("http://10.0.0.237/"));
        assertEquals("http://10.0.0.237:3001", OriginCheck.allowedOriginRule("http://10.0.0.237:3001"));
        assertNull(OriginCheck.allowedOriginRule(""));
        assertNull(OriginCheck.allowedOriginRule("ftp://x"));
    }
}
