package press.maestro.crow;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import press.maestro.crow.dat.DatBridge;

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

    /**
     * Request BLUETOOTH_CONNECT + BLUETOOTH_SCAN at runtime. Android 14+ requires
     * these grants before an app can start a foreground service of type
     * `connectedDevice` — which GlassesService is. Without them the FGS start
     * throws SecurityException and the process dies.
     */
    private static final String[] BT_PERMS = new String[]{
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.RECORD_AUDIO,
    };

    private final ActivityResultLauncher<String[]> btPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), results -> {
                boolean allGranted = true;
                for (String p : BT_PERMS) {
                    Boolean granted = results.get(p);
                    if (granted == null || !granted) { allGranted = false; break; }
                }
                if (allGranted) {
                    appendLog("Permissions granted (Bluetooth + microphone).");
                } else {
                    appendLog("One or more permissions denied. Grant them in Settings → Apps → Crow → Permissions, then retry.");
                }
            });

    private boolean hasBtPermissions() {
        for (String p : BT_PERMS) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

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
        startBtn.setOnClickListener(v -> {
            if (!hasBtPermissions()) {
                appendLog("Requesting Bluetooth permissions…");
                btPermissionLauncher.launch(BT_PERMS);
                return;
            }
            startDatPairing();
        });
        root.addView(startBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        // Temporary push-to-talk test button. Press and hold to record,
        // release to hand the audio to the gateway for STT → LLM → TTS.
        Button pttBtn = new Button(this);
        pttBtn.setText("Hold to talk");
        pttBtn.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    appendLog("Turn start.");
                    Intent begin = new Intent(this, GlassesService.class).setAction(GlassesService.ACTION_BEGIN_TURN);
                    ContextCompat.startForegroundService(this, begin);
                    v.setPressed(true);
                    return true;
                case android.view.MotionEvent.ACTION_UP:
                case android.view.MotionEvent.ACTION_CANCEL:
                    appendLog("Turn end.");
                    Intent end = new Intent(this, GlassesService.class).setAction(GlassesService.ACTION_END_TURN);
                    ContextCompat.startForegroundService(this, end);
                    v.setPressed(false);
                    return true;
            }
            return false;
        });
        root.addView(pttBtn, new LinearLayout.LayoutParams(
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
     * Kick off the Meta DAT registration + device discovery flow via {@link DatBridge}.
     *
     * The Meta Wearables DAT SDK doesn't expose a per-device "pairing intent" — the
     * Meta AI companion app owns glasses pairing. Instead this app registers with
     * Meta AI and then reads the available {@code Wearables.devices} set. The
     * bridge handles the Flow collection and surfaces a simple callback.
     */
    private void startDatPairing() {
        appendLog("Launching DAT registration via Meta AI...");
        DatBridge.startRegistration(this, this, new DatBridge.Listener() {
            @Override public void onStatus(String message) {
                appendLog(message);
            }
            @Override public void onDevicePaired(String deviceId, String displayName) {
                // DAT only supports Ray-Ban Meta (Gen 2) and Ray-Ban Meta Display —
                // Gen 1 Stories won't surface in Wearables.devices at all.
                completePairing(deviceId, displayName, "gen2");
            }
            @Override public void onError(String message) {
                appendLog("DAT error: " + message);
            }
        });
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
