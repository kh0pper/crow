package press.maestro.crow;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Pairing UI for Meta Ray-Ban (Gen 2) glasses via the Meta Wearables DAT SDK.
 *
 * High-level flow:
 *   1. Launch the DAT pairing sheet (Meta Wearables SDK handles the UX).
 *   2. On success the SDK returns a device handle. We do a capability probe
 *      to distinguish Gen 2 (supported) from Gen 1 Stories (unsupported).
 *   3. POST to /api/meta-glasses/pair on the Crow gateway to register the
 *      device and receive a bearer token.
 *   4. Store the token in encrypted SharedPreferences keyed by device id.
 *   5. Start {@link GlassesService} which maintains the /session WebSocket.
 *
 * DAT SDK bridging is intentionally narrowed to a single package-private
 * helper (see inner TODOs) so the rest of the Crow Android app doesn't
 * directly depend on Meta's SDK surface.
 */
public class PairingActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";

    private TextView log;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 48, 48, 48);
        root.setGravity(Gravity.TOP);

        TextView title = new TextView(this);
        title.setText("Pair Meta Ray-Ban Glasses");
        title.setTextSize(22);
        title.setPadding(0, 0, 0, 24);
        root.addView(title);

        TextView instructions = new TextView(this);
        instructions.setText(
                "1. Make sure your Ray-Ban Meta (Gen 2) glasses are powered on.\n" +
                        "2. Your phone must be on Android 14+ and have the Meta Wearables " +
                        "Device Access Toolkit installed.\n" +
                        "3. Gen 1 Ray-Ban Stories are not supported."
        );
        instructions.setPadding(0, 0, 0, 32);
        root.addView(instructions);

        Button startBtn = new Button(this);
        startBtn.setText("Open pairing sheet");
        startBtn.setOnClickListener(v -> startDatPairing());
        root.addView(startBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        log = new TextView(this);
        log.setTextSize(12);
        log.setPadding(0, 24, 0, 0);
        log.setMovementMethod(new ScrollingMovementMethod());
        log.setText("Ready.");
        root.addView(log);

        setContentView(root);
    }

    private void appendLog(String line) {
        runOnUiThread(() -> {
            CharSequence existing = log.getText();
            log.setText((existing == null ? "" : existing) + "\n" + line);
        });
    }

    /**
     * Kick off the Meta DAT pairing sheet.
     *
     * TODO(meta-glasses): wire the real SDK call here. At the time of this
     * writing the DAT SDK's preview API exposes a helper along the lines of:
     *
     *   com.meta.wearables.DeviceSession.createPairingIntent(context)
     *
     * and returns a device handle via an ActivityResultCallback. We stub
     * out the success case so the rest of the pipeline is exercisable
     * against {@code mwdat-mockdevice}. Once the real SDK is linked,
     * replace {@link #stubCompletePairing()} with the DAT callback.
     */
    private void startDatPairing() {
        appendLog("Launching DAT pairing sheet...");
        // TODO: Intent datIntent = DeviceSession.createPairingIntent(this);
        //       startActivityForResult(datIntent, 0x1234);
        //       onActivityResult → call completePairing(deviceId, generation)
        //
        // Placeholder: simulate a successful pairing using a mock device id.
        stubCompletePairing();
    }

    /** Placeholder: simulate a DAT pairing success. Remove once SDK is wired. */
    private void stubCompletePairing() {
        String deviceId = "mock-" + System.currentTimeMillis();
        String generation = "unknown"; // Real SDK would report gen2/gen1
        completePairing(deviceId, "Mock Glasses", generation);
    }

    /**
     * Called after DAT pairing succeeds. Talks to the Crow gateway to
     * register the device and obtain a bearer token.
     */
    private void completePairing(String deviceId, String displayName, String generation) {
        if ("gen1".equals(generation)) {
            appendLog("This looks like Ray-Ban Stories (Gen 1). Not supported.");
            return;
        }
        appendLog("Paired via DAT (" + deviceId + "). Registering with Crow...");
        new Thread(() -> {
            try {
                String gateway = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_GATEWAY_URL, null);
                if (gateway == null || gateway.isEmpty()) {
                    appendLog("Gateway URL not set. Open Crow settings and configure the gateway first.");
                    return;
                }
                String base = gateway.replaceAll("/+$", "");
                URL url = new URL(base + "/api/meta-glasses/pair");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                // The gateway's /api/meta-glasses/pair route is gated by
                // dashboardAuth. The Crow WebView in MainActivity holds the
                // session cookie after login; share it with this HttpURLConnection
                // so we don't get redirected to the HTML login page.
                String cookies = CookieManager.getInstance().getCookie(base);
                if (cookies != null && !cookies.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookies);
                }
                conn.setDoOutput(true);
                JSONObject body = new JSONObject()
                        .put("id", deviceId)
                        .put("name", displayName)
                        .put("generation", generation);
                try (DataOutputStream out = new DataOutputStream(conn.getOutputStream())) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getErrorStream(), StandardCharsets.UTF_8))) {
                        StringBuilder err = new StringBuilder();
                        String ln;
                        while ((ln = br.readLine()) != null) err.append(ln);
                        appendLog("Pairing failed (" + code + "): " + err);
                    }
                    return;
                }
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String ln;
                    while ((ln = br.readLine()) != null) sb.append(ln);
                }
                JSONObject resp = new JSONObject(sb.toString());
                String token = resp.optString("token", null);
                if (token == null) {
                    appendLog("No token in pair response: " + resp);
                    return;
                }
                GlassesTokenStore.save(this, deviceId, token);
                appendLog("Registered and token stored. Starting glasses service...");
                Intent svc = new Intent(this, GlassesService.class);
                svc.putExtra(GlassesService.EXTRA_DEVICE_ID, deviceId);
                ContextCompat.startForegroundService(this, svc);
                appendLog("Done. You can close this screen.");
            } catch (Exception e) {
                appendLog("Error: " + e.getMessage());
            }
        }).start();
    }
}
