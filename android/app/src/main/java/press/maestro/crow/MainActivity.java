package press.maestro.crow;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONObject;

import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    static final String EXTRA_OPEN_SETTINGS = "open_settings";
    private static final String WORK_NAME = "crow_notification_poll";
    // Ramble walking (spec 2026-10-04 §10). Native is a dumb reader: it never
    // does step arithmetic — the gateway does (baselines, reboots, caps).
    private static final String KEY_STEPS_DEVICE_ID = "steps_device_id";
    private static final String KEY_STEPS_RATIONALE_SEEN = "steps_rationale_seen";
    private static final Pattern STEPS_REQ_ID = Pattern.compile("^[A-Za-z0-9]{1,32}$");
    private static final long STEPS_READ_TIMEOUT_MS = 4000L;
    private String pendingStepsPermId;
    private StepsReply pendingStepsReply;
    // Security fix 2026-10-04: the steps capabilities answer ONLY the paired
    // gateway origin (exact scheme + host + port of the saved gateway_url).
    // Preferred channel: a WebMessageListener injected as window.CrowStepsPort
    // into frames whose origin matches the rule, and nowhere else. (The panel's
    // own result receiver is window.CrowSteps — a different name on purpose.)
    static final String STEPS_PORT_NAME = "CrowStepsPort";
    private boolean stepsUsePort;
    /** The allowedOriginRule currently registered for STEPS_PORT_NAME, or null. */
    private String stepsPortRule;

    /** Where a steps result goes: the reply proxy (port) or evaluateJavascript (legacy). */
    private interface StepsReply {
        void send(String id, JSONObject payload);
    }

    private final ActivityResultLauncher<String> stepsPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                // A refusal after which Android would still prompt (rationale = true)
                // is remembered: only a LATER "not granted + no rationale" is a
                // permanent "denied". A dismissed dialog (tap outside / back) on the
                // very first ask also reads not-granted + no rationale, and must stay
                // "needs-permission".
                if (!granted && shouldShowRequestPermissionRationale(Manifest.permission.ACTIVITY_RECOGNITION)) {
                    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_STEPS_RATIONALE_SEEN, true).apply();
                }
                String id = pendingStepsPermId;
                StepsReply reply = pendingStepsReply;
                pendingStepsPermId = null;
                pendingStepsReply = null;
                if (id == null || reply == null) return;
                try {
                    JSONObject o = new JSONObject();
                    o.put("status", stepsStatusString());
                    reply.send(id, o);
                } catch (Exception ignored) { }
            });

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private volatile boolean isWebViewAtTop = false;
    // Debounce the pull-to-refresh scroll probe so a flurry of touch-downs
    // doesn't re-run the .content-body DOM walk on every tap (W3).
    private long lastScrollProbeMs = 0L;
    private FrameLayout statusOverlay;
    private TextView statusText;
    private ValueCallback<Uri[]> fileUploadCallback;
    private PermissionRequest pendingWebViewPermRequest;

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (fileUploadCallback == null) return;
                Uri[] results = null;
                if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
                    String dataString = result.getData().getDataString();
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    }
                }
                fileUploadCallback.onReceiveValue(results);
                fileUploadCallback = null;
            });

    private final ActivityResultLauncher<String> notifPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                // Nothing to do — notifications work if granted, silently skip if denied
            });

    private boolean pendingNeedCamera = false;

    private final ActivityResultLauncher<String> cameraPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (pendingWebViewPermRequest != null) {
                    // Grant even if camera denied (audio-only fallback)
                    pendingWebViewPermRequest.grant(pendingWebViewPermRequest.getResources());
                }
                pendingWebViewPermRequest = null;
            });

    private final ActivityResultLauncher<String> audioPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted && pendingWebViewPermRequest != null) {
                    // If camera is also needed, request it next
                    if (pendingNeedCamera && !hasCameraPermission()) {
                        pendingNeedCamera = false;
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
                        return;
                    }
                    pendingWebViewPermRequest.grant(pendingWebViewPermRequest.getResources());
                } else if (pendingWebViewPermRequest != null) {
                    pendingWebViewPermRequest.deny();
                }
                pendingWebViewPermRequest = null;
                pendingNeedCamera = false;
            });

    private Runnable pendingLocationCallback;

    private final ActivityResultLauncher<String[]> locationPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), grantResults -> {
                Runnable callback = pendingLocationCallback;
                pendingLocationCallback = null;
                if (callback != null) {
                    runOnUiThread(callback);
                }
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        statusOverlay = findViewById(R.id.statusOverlay);
        statusText = findViewById(R.id.statusText);

        // Create notification channels
        NotificationHelper.createChannels(this);

        // Request notification permission (Android 13+)
        requestNotificationPermission();

        configureWebView();

        swipeRefresh.setOnRefreshListener(() -> {
            webView.reload();
            swipeRefresh.setRefreshing(false);
        });

        // Only allow pull-to-refresh when WebView content is scrolled to the top.
        // The Crow's Nest uses CSS overflow-y:auto on .content-body, so
        // webView.getScrollY() is always 0. We must check via JavaScript.
        swipeRefresh.setOnChildScrollUpCallback((parent, child) -> {
            // Disable refresh by default; JS callback re-enables when at top
            return !isWebViewAtTop;
        });

        // Poll scroll position via JS on touch-down to detect nested scrollable containers.
        // Only evaluate on ACTION_DOWN to avoid running JS on every ACTION_MOVE during scrolling.
        // Walks all elements inside .content-body checking for any scrolled-down overflow container
        // (e.g. .msg-chat-viewport in Messages, <pre> blocks in Skills, etc.).
        webView.setOnTouchListener((v, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) {
                // Debounce: reuse the last result if probed <250ms ago. The DOM
                // walk is the cost; a burst of taps doesn't need to re-run it.
                long now = SystemClock.uptimeMillis();
                if (now - lastScrollProbeMs < 250) {
                    return false;
                }
                lastScrollProbeMs = now;
                webView.evaluateJavascript(
                    "(function() {" +
                    "  var all = document.querySelectorAll('.content-body, .content-body *');" +
                    "  for (var i = 0; i < all.length; i++) {" +
                    "    var el = all[i];" +
                    "    if (el.scrollHeight > el.clientHeight) {" +
                    "      var style = window.getComputedStyle(el);" +
                    "      var ov = style.overflowY;" +
                    "      if ((ov === 'auto' || ov === 'scroll') && el.scrollTop > 5) {" +
                    "        return el.scrollTop;" +
                    "      }" +
                    "    }" +
                    "  }" +
                    "  return window.scrollY || document.documentElement.scrollTop || 0;" +
                    "})()",
                    value -> {
                        try {
                            double scrollTop = Double.parseDouble(value);
                            isWebViewAtTop = scrollTop <= 5;
                        } catch (Exception e) {
                            isWebViewAtTop = false;
                        }
                    }
                );
            }
            return false; // Don't consume the touch event
        });

        // Schedule background notification polling (every 15 minutes)
        scheduleBackgroundPolling();

        // Start ntfy listener service for real-time push notifications
        startNtfyService();

        // (W3) Removed the 60s foreground notification poll: it was redundant
        // with the real-time ntfy stream (NtfyListenerService, replay-safe via
        // since=) plus the 15-min WorkManager fallback (scheduleBackgroundPolling).
        // Firing a WorkManager job every minute while foregrounded was pure
        // battery cost with no added coverage.

        // Load gateway or open settings
        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl == null || gatewayUrl.isEmpty() || wantsSettings(getIntent())) {
            openSettings();
        } else {
            handleIntent(getIntent(), gatewayUrl);
        }
    }

    /** The launcher's "Server settings" shortcut (res/xml/shortcuts.xml) opens
     *  Settings directly. The app theme has no action bar, so the options menu
     *  is unreachable and this shortcut is the way to change servers. */
    private static boolean wantsSettings(Intent intent) {
        return intent != null && intent.getBooleanExtra(EXTRA_OPEN_SETTINGS, false);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
            }
        }
    }

    private void scheduleBackgroundPolling() {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

        PeriodicWorkRequest pollWork = new PeriodicWorkRequest.Builder(
                NotificationWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                pollWork);
    }

    /**
     * Handle intent extras — notification tap opens a specific URL.
     */
    private void handleIntent(Intent intent, String gatewayUrl) {
        String actionUrl = intent.getStringExtra("action_url");
        if (actionUrl != null && !actionUrl.isEmpty()) {
            // Notification tap — load the action URL relative to gateway
            String fullUrl = gatewayUrl.replaceAll("/+$", "") + actionUrl;
            loadGateway(fullUrl);
        } else {
            loadGateway(gatewayUrl);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (wantsSettings(intent)) {
            openSettings();
            return;
        }
        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl != null) {
            handleIntent(intent, gatewayUrl);
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " CrowAndroid/" + BuildConfig.VERSION_NAME);

        webView.setWebViewClient(new CrowWebViewClient(this));
        webView.setWebChromeClient(new CrowWebChromeClient(this));

        // Expose native features to the Crow dashboard as `window.Crow.*`.
        // Panels check for these before attempting features that need
        // device-only APIs (e.g. Bluetooth for the Meta Glasses bundle).
        //
        // The Ramble steps capabilities are origin-scoped (security fix
        // 2026-10-04): with WEB_MESSAGE_LISTENER (any current WebView) they
        // live on window.CrowStepsPort, injected only into the paired gateway
        // origin; window.Crow then carries only a constant
        // stepsStatus() == "unavailable" so the panel on any other page can
        // tell "new app, not the paired server" from "old app".
        stepsUsePort = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        if (stepsUsePort) {
            webView.addJavascriptInterface(new CrowBridge(), "Crow");
            refreshStepsPort();
        } else {
            webView.addJavascriptInterface(new CrowBridgeLegacySteps(), "Crow");
        }
    }

    /**
     * (Re)register the steps listener for the CURRENT gateway_url. Called at
     * startup and on every resume, so a server changed via the "Server
     * settings" shortcut moves the rule to the new origin (the listener is
     * injected into documents loaded after registration). onStepsMessage also
     * re-checks the origin against the saved URL on every message, so a stale
     * registration can never answer an old origin.
     */
    private void refreshStepsPort() {
        if (!stepsUsePort || webView == null) return;
        String rule = OriginCheck.allowedOriginRule(getGatewayUrl());
        if (rule == null ? stepsPortRule == null : rule.equals(stepsPortRule)) return;
        if (stepsPortRule != null) {
            WebViewCompat.removeWebMessageListener(webView, STEPS_PORT_NAME);
            stepsPortRule = null;
        }
        if (rule == null) return; // no paired server: nothing is injected anywhere
        try {
            WebViewCompat.addWebMessageListener(webView, STEPS_PORT_NAME,
                    Collections.singleton(rule), this::onStepsMessage);
            stepsPortRule = rule;
        } catch (IllegalArgumentException e) {
            // A rule WebView rejects: the steps bridge stays off (fail closed).
        }
    }

    /**
     * Steps requests from window.CrowStepsPort.postMessage(JSON.stringify({op, id})).
     * Runs on the UI thread. Refuses silently unless the sender is the MAIN
     * frame AND its origin is exactly the paired gateway origin — an iframe
     * on the trusted page, another port on the same host and every other
     * tailnet host all get nothing (no reply, no prompt, no read, no intent).
     * Replies go back through the frame's own JavaScriptReplyProxy, never
     * evaluateJavascript, as {"id": id, "payload": {...}}.
     */
    private void onStepsMessage(WebView view, WebMessageCompat message, Uri sourceOrigin,
                                boolean isMainFrame, JavaScriptReplyProxy proxy) {
        if (!isMainFrame || sourceOrigin == null) return;
        if (!OriginCheck.sameOrigin(sourceOrigin.toString(), getGatewayUrl())) return;
        String data = message == null ? null : message.getData();
        if (data == null || data.length() > 512) return;
        JSONObject req;
        try {
            req = new JSONObject(data);
        } catch (Exception e) {
            return;
        }
        String op = req.optString("op", "");
        String id = req.optString("id", "");
        StepsReply reply = (rid, payload) -> runOnUiThread(() -> {
            try {
                JSONObject env = new JSONObject();
                env.put("id", rid);
                env.put("payload", payload);
                proxy.postMessage(env.toString());
            } catch (Exception ignored) { }
        });
        switch (op) {
            case "stepsStatus":
                if (!STEPS_REQ_ID.matcher(id).matches()) return;
                try {
                    JSONObject o = new JSONObject();
                    o.put("status", stepsStatusString());
                    reply.send(id, o);
                } catch (Exception ignored) { }
                break;
            case "requestStepsPermission":
                startStepsPermission(id, reply);
                break;
            case "readSteps":
                if (STEPS_REQ_ID.matcher(id).matches()) readStepsOnce(id, reply);
                break;
            case "openAppSettings":
                launchAppSettings();
                break;
            default:
                break;
        }
    }

    /**
     * UI thread only. Legacy-channel gate: the TOP-LEVEL page is on the paired
     * origin. NOTE this fallback cannot tell an iframe from the main frame —
     * a @JavascriptInterface call carries no frame or origin — so a
     * cross-origin iframe inside the trusted page would pass. It exists only
     * for WebViews without WEB_MESSAGE_LISTENER (none expected at minSdk 34).
     */
    private boolean isPairedTopLevel() {
        return webView != null && OriginCheck.sameOrigin(webView.getUrl(), getGatewayUrl());
    }

    /** UI thread only. Shared by both channels. */
    private void startStepsPermission(String id, StepsReply reply) {
        if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
        if (hasActivityPermission() || !hasStepCounter()) {
            try {
                JSONObject o = new JSONObject();
                o.put("status", stepsStatusString());
                reply.send(id, o);
            } catch (Exception ignored) { }
            return;
        }
        pendingStepsPermId = id;
        pendingStepsReply = reply;
        stepsPermissionLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION);
    }

    /** UI thread only. */
    private void launchAppSettings() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null));
        startActivity(i);
    }

    /**
     * JavaScript bridge exposed to the dashboard as `window.Crow`.
     * Methods annotated with @JavascriptInterface become callable from JS.
     */
    public class CrowBridge {
        /** Version advertised to panels for capability gating. */
        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.VERSION_NAME;
        }

        /** Launch the Meta Glasses pairing UI. Called by the meta-glasses panel. */
        @JavascriptInterface
        public void launchGlassesPairing() {
            runOnUiThread(() -> {
                Intent intent = new Intent(MainActivity.this, PairingActivity.class);
                startActivity(intent);
            });
        }

        /**
         * Let a panel suspend pull-to-refresh while it handles its own vertical
         * drag gestures (e.g. the Ramble map). Called from the panel's own
         * touchstart/touchend handlers, not from the scroll-probe above.
         */
        @JavascriptInterface
        public void setPullToRefresh(boolean enabled) {
            runOnUiThread(() -> swipeRefresh.setEnabled(enabled));
        }

        /**
         * Ramble walking on the origin-scoped channel: the real steps calls go
         * through window.CrowStepsPort (paired origin only). Here, on every
         * page and frame, this is a constant so the panel can tell "this app
         * is new but this is not its paired server" from an old app.
         */
        @JavascriptInterface
        public String stepsStatus() {
            return "unavailable";
        }
    }

    /**
     * Fallback for a WebView without WEB_MESSAGE_LISTENER: the steps calls stay
     * on window.Crow but every one checks the TOP-LEVEL page origin on the UI
     * thread before acting (see isPairedTopLevel — cannot distinguish iframes).
     * Refusal is silent: stepsStatus says "unavailable", nothing else happens.
     */
    public class CrowBridgeLegacySteps extends CrowBridge {
        /** "ok" | "needs-permission" | "denied" | "no-sensor" | "unavailable" (not the paired page). */
        @Override
        @JavascriptInterface
        public String stepsStatus() {
            FutureTask<Boolean> paired = new FutureTask<>(MainActivity.this::isPairedTopLevel);
            runOnUiThread(paired);
            try {
                if (!Boolean.TRUE.equals(paired.get(1500, TimeUnit.MILLISECONDS))) return "unavailable";
            } catch (Exception e) {
                return "unavailable";
            }
            return stepsStatusString();
        }

        /** Ask for ACTIVITY_RECOGNITION; delivers {status} to window.CrowSteps.deliver(id, ...). */
        @JavascriptInterface
        public void requestStepsPermission(String id) {
            if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
            runOnUiThread(() -> {
                if (!isPairedTopLevel()) return;
                startStepsPermission(id, legacyReply);
            });
        }

        /** Read the step counter once; delivers the reading to window.CrowSteps.deliver(id, ...). */
        @JavascriptInterface
        public void readSteps(String id) {
            if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
            runOnUiThread(() -> {
                if (!isPairedTopLevel()) return;
                readStepsOnce(id, legacyReply);
            });
        }

        /** For the "denied" case: this app's system settings page. */
        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                if (!isPairedTopLevel()) return;
                launchAppSettings();
            });
        }
    }

    /**
     * Legacy delivery: evaluateJavascript into the top-level page, re-checked
     * at delivery time so a result never lands on a page that navigated away
     * from the paired origin while the read or the prompt was pending.
     */
    private final StepsReply legacyReply = (id, payload) -> {
        if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
        final String js = "window.CrowSteps&&window.CrowSteps.deliver(" + JSONObject.quote(id) + "," + payload.toString() + ")";
        runOnUiThread(() -> {
            if (webView != null && isPairedTopLevel()) webView.evaluateJavascript(js, null);
        });
    };

    private void loadGateway(String url) {
        statusOverlay.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    public void showStatus(String message) {
        statusOverlay.setVisibility(View.VISIBLE);
        statusText.setText(message);
    }

    public void hideStatus() {
        statusOverlay.setVisibility(View.GONE);
    }

    private String getGatewayUrl() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getString(KEY_GATEWAY_URL, null);
    }

    private void startNtfyService() {
        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl != null && !gatewayUrl.isEmpty()) {
            Intent serviceIntent = new Intent(this, NtfyListenerService.class);
            ContextCompat.startForegroundService(this, serviceIntent);
        }
    }

    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
    }

    public void onFileUploadRequested(ValueCallback<Uri[]> callback, Intent chooserIntent) {
        fileUploadCallback = callback;
        fileChooserLauncher.launch(chooserIntent);
    }

    /** Check if app has RECORD_AUDIO permission (called by CrowWebChromeClient) */
    public boolean hasAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Check if app has CAMERA permission (called by CrowWebChromeClient) */
    public boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Check if app has FINE or COARSE location permission (called by CrowWebChromeClient) */
    public boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Request FINE + COARSE location permission, invoking {@code onResult} on the UI
     * thread once the user has answered (the result is not passed back directly —
     * the caller re-checks {@link #hasLocationPermission()} itself, e.g. from
     * {@code CrowWebChromeClient#onGeolocationPermissionsShowPrompt}).
     */
    public void requestLocationPermission(Runnable onResult) {
        pendingLocationCallback = onResult;
        locationPermissionLauncher.launch(new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
        });
    }

    private boolean hasStepCounter() {
        SensorManager sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        return sm != null && sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null;
    }

    private boolean hasActivityPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * "ok" | "needs-permission" | "denied" | "no-sensor". "denied" only once the
     * user has refused at least once with Android still willing to ask
     * (rationale seen) AND Android has now stopped offering the rationale — i.e.
     * "don't ask again". Before that, a dismissed dialog is still askable.
     */
    String stepsStatusString() {
        if (!hasStepCounter()) return "no-sensor";
        if (hasActivityPermission()) return "ok";
        boolean rationaleSeen = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(KEY_STEPS_RATIONALE_SEEN, false);
        if (rationaleSeen && !shouldShowRequestPermissionRationale(Manifest.permission.ACTIVITY_RECOGNITION)) return "denied";
        return "needs-permission";
    }

    /** A random id made once per install. Never ANDROID_ID. */
    private String stepsDeviceId() {
        SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String id = p.getString(KEY_STEPS_DEVICE_ID, null);
        if (id == null || id.isEmpty()) {
            id = UUID.randomUUID().toString();
            p.edit().putString(KEY_STEPS_DEVICE_ID, id).apply();
        }
        return id;
    }

    private static void deliverStepsError(String id, String reason, StepsReply reply) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("reason", reason);
            reply.send(id, o);
        } catch (Exception ignored) { }
    }

    /**
     * One-shot read. TYPE_STEP_COUNTER is an on-change sensor, which reports its
     * current value when a listener is registered, so the first event IS the
     * reading. Unregister on that event or after the timeout, whichever is first.
     */
    private void readStepsOnce(String id, StepsReply reply) {
        if (!hasStepCounter()) { deliverStepsError(id, "no-sensor", reply); return; }
        if (!hasActivityPermission()) { deliverStepsError(id, "no-permission", reply); return; }
        final SensorManager sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        final Sensor sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        final Handler main = new Handler(Looper.getMainLooper());
        final boolean[] done = { false };
        final SensorEventListener[] holder = new SensorEventListener[1];
        final Runnable timeout = () -> {
            if (done[0]) return;
            done[0] = true;
            sm.unregisterListener(holder[0]);
            deliverStepsError(id, "timeout", reply);
        };
        holder[0] = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (done[0]) return;
                done[0] = true;
                main.removeCallbacks(timeout);
                sm.unregisterListener(this);
                try {
                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    o.put("counter", (long) event.values[0]);
                    o.put("elapsed_ms", SystemClock.elapsedRealtime());
                    int boot = Settings.Global.getInt(getContentResolver(), Settings.Global.BOOT_COUNT, -1);
                    o.put("boot_count", boot >= 0 ? (Object) Integer.valueOf(boot) : JSONObject.NULL);
                    o.put("device_id", stepsDeviceId());
                    reply.send(id, o);
                } catch (Exception e) {
                    deliverStepsError(id, "error", reply);
                }
            }

            @Override
            public void onAccuracyChanged(Sensor s, int accuracy) { }
        };
        sm.registerListener(holder[0], sensor, SensorManager.SENSOR_DELAY_NORMAL, main);
        main.postDelayed(timeout, STEPS_READ_TIMEOUT_MS);
    }

    /** Request RECORD_AUDIO and grant WebView permission on callback */
    public void requestAudioPermissionForWebView(PermissionRequest request) {
        pendingWebViewPermRequest = request;
        pendingNeedCamera = false;
        audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
    }

    /** Request both RECORD_AUDIO and CAMERA, granting WebView permission when both complete */
    public void requestAudioAndCameraPermissionForWebView(PermissionRequest request) {
        pendingWebViewPermRequest = request;
        if (!hasAudioPermission()) {
            // Audio first, then camera in the audio callback
            pendingNeedCamera = true;
            audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
        } else if (!hasCameraPermission()) {
            // Audio already granted, just request camera
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
        } else {
            // Both already granted
            request.grant(request.getResources());
            pendingWebViewPermRequest = null;
        }
    }

    /** Request only CAMERA permission for WebView */
    public void requestCameraPermissionForWebView(PermissionRequest request) {
        pendingWebViewPermRequest = request;
        pendingNeedCamera = false;
        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Resume WebView JS timers/rendering (paused in onPause to save battery).
        if (webView != null) webView.onResume();
        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl != null && !gatewayUrl.isEmpty()) {
            if (webView.getUrl() == null) {
                loadGateway(gatewayUrl);
            }
        }
        // The gateway URL may have just changed in Settings: move the steps
        // listener's allowed origin with it (security fix 2026-10-04).
        refreshStepsPort();
        // Restart ntfy service (handles returning from settings with new gateway URL)
        startNtfyService();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Pause WebView JS timers/rendering while backgrounded (W3 battery win —
        // dashboard timers otherwise keep running off-screen).
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onDestroy() {
        // Leak-safe WebView teardown (W3): detach from its parent before
        // destroy() so the Activity isn't retained via the WebView's native
        // callbacks. The parent is a SwipeRefreshLayout, so cast to ViewGroup
        // (NOT FrameLayout — that would ClassCastException).
        if (webView != null) {
            webView.setOnTouchListener(null);
            ViewParent parent = webView.getParent();
            if (parent instanceof ViewGroup) {
                ((ViewGroup) parent).removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, R.string.settings_title);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            openSettings();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
