package press.maestro.crow;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
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
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    private static final String WORK_NAME = "crow_notification_poll";
    private static final long FOREGROUND_POLL_INTERVAL_MS = 60_000; // 60 seconds

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private volatile boolean isWebViewAtTop = false;
    private FrameLayout statusOverlay;
    private TextView statusText;
    private ValueCallback<Uri[]> fileUploadCallback;
    private Handler foregroundPollHandler;
    private Runnable foregroundPollRunnable;

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

        // Set up foreground polling handler
        foregroundPollHandler = new Handler(Looper.getMainLooper());
        foregroundPollRunnable = new Runnable() {
            @Override
            public void run() {
                // Run the notification check on a background thread
                new Thread(() -> {
                    NotificationWorker worker = null;
                    try {
                        // Use WorkManager's one-time work for immediate check
                        androidx.work.OneTimeWorkRequest immediateWork =
                                new androidx.work.OneTimeWorkRequest.Builder(NotificationWorker.class)
                                        .build();
                        WorkManager.getInstance(getApplicationContext()).enqueue(immediateWork);
                    } catch (Exception e) {
                        // Ignore — best effort
                    }
                }).start();
                foregroundPollHandler.postDelayed(this, FOREGROUND_POLL_INTERVAL_MS);
            }
        };

        // Load gateway or open settings
        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl == null || gatewayUrl.isEmpty()) {
            openSettings();
        } else {
            handleIntent(getIntent(), gatewayUrl);
        }
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
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " CrowAndroid/1.0");

        webView.setWebViewClient(new CrowWebViewClient(this));
        webView.setWebChromeClient(new CrowWebChromeClient(this));
    }

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

    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
    }

    public void onFileUploadRequested(ValueCallback<Uri[]> callback, Intent chooserIntent) {
        fileUploadCallback = callback;
        fileChooserLauncher.launch(chooserIntent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl != null && !gatewayUrl.isEmpty()) {
            if (webView.getUrl() == null) {
                loadGateway(gatewayUrl);
            }
        }
        // Start foreground polling
        foregroundPollHandler.postDelayed(foregroundPollRunnable, FOREGROUND_POLL_INTERVAL_MS);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Stop foreground polling
        foregroundPollHandler.removeCallbacks(foregroundPollRunnable);
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
