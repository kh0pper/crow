package press.maestro.crow;

import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

public class SettingsActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    /** Queue item 21c: the audio-mode guard's kill switch (default on). Off = log only. */
    static final String KEY_AUDIO_GUARD = "audio_guard_enabled";

    private EditText urlInput;
    private TextView connectionStatus;
    private TextView tailscaleStatus;
    private Button testButton;
    private Button tailscaleButton;
    private Button saveButton;
    private Button pinBirdButton;
    private androidx.appcompat.widget.SwitchCompat audioGuardSwitch;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        urlInput = findViewById(R.id.urlInput);
        connectionStatus = findViewById(R.id.connectionStatus);
        tailscaleStatus = findViewById(R.id.tailscaleStatus);
        testButton = findViewById(R.id.testButton);
        tailscaleButton = findViewById(R.id.tailscaleButton);
        saveButton = findViewById(R.id.saveButton);
        pinBirdButton = findViewById(R.id.pinBirdButton);
        audioGuardSwitch = findViewById(R.id.audioGuardSwitch);

        // Load saved URL
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_GATEWAY_URL, "");
        urlInput.setText(savedUrl);
        audioGuardSwitch.setChecked(prefs.getBoolean(KEY_AUDIO_GUARD, true));
        // Saved at once (not by "Save"): it is read at every check.
        audioGuardSwitch.setOnCheckedChangeListener((b, on) ->
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_AUDIO_GUARD, on).apply());

        updateTailscaleStatus();

        testButton.setOnClickListener(v -> testConnection());
        tailscaleButton.setOnClickListener(v -> handleTailscaleAction());
        saveButton.setOnClickListener(v -> saveSettings());
        pinBirdButton.setOnClickListener(v -> pinBird());
    }

    /**
     * "Add your bird to the home screen" (widgets phase 3): pin the bird the widget last cached — the
     * same drawing, from the same SVG — as a launcher shortcut. With nothing cached yet (a fresh
     * install, or no bird) the shortcut still pins, with the app icon, and the next refresh repaints it
     * (BirdRefreshWorker calls BirdShortcut.update when the bird changes). The pin also starts the
     * half-hourly bird refresh — BirdShortcut.requestPin does — so a pinned bird keeps updating with
     * no widget on any home screen.
     */
    private void pinBird() {
        Bitmap bird = BirdShortcut.iconBitmap(this);
        if (BirdShortcut.requestPin(this, bird)) {
            // The launcher pins the icon it was given; a refresh right away replaces the app-icon
            // fallback with the real bird as soon as the gateway answers (BirdShortcut.update).
            BirdWidgetProvider.refreshAll(this);
            return;
        }
        Toast.makeText(this, R.string.widget_bird_pin_unsupported, Toast.LENGTH_SHORT).show();
    }

    private void updateTailscaleStatus() {
        boolean installed = TailscaleHelper.isInstalled(this);
        boolean vpnActive = TailscaleHelper.isVpnActive(this);

        if (!installed) {
            tailscaleStatus.setText(R.string.tailscale_not_installed);
            tailscaleButton.setText(R.string.install_tailscale);
        } else if (!vpnActive) {
            tailscaleStatus.setText(R.string.tailscale_disconnected);
            tailscaleButton.setText(R.string.open_tailscale);
        } else {
            tailscaleStatus.setText(R.string.tailscale_connected);
            tailscaleButton.setText(R.string.open_tailscale);
        }
    }

    private void handleTailscaleAction() {
        if (TailscaleHelper.isInstalled(this)) {
            TailscaleHelper.openTailscale(this);
        } else {
            TailscaleHelper.openPlayStore(this);
        }
    }

    private void testConnection() {
        String url = urlInput.getText().toString().trim();
        if (url.isEmpty()) {
            connectionStatus.setText(R.string.url_empty);
            return;
        }

        // Normalize URL
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }

        connectionStatus.setText(R.string.testing_connection);
        testButton.setEnabled(false);

        final String healthUrl = url.endsWith("/") ? url + "health" : url + "/health";

        new Thread(() -> {
            String result;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(healthUrl).openConnection();
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setRequestMethod("GET");

                int responseCode = connection.getResponseCode();
                if (responseCode == 200) {
                    result = getString(R.string.connection_success);
                } else {
                    result = getString(R.string.connection_error_code, responseCode);
                }
                connection.disconnect();
            } catch (IOException e) {
                result = getString(R.string.connection_failed, e.getMessage());
            }

            final String finalResult = result;
            runOnUiThread(() -> {
                connectionStatus.setText(finalResult);
                testButton.setEnabled(true);
            });
        }).start();
    }

    private void saveSettings() {
        String url = urlInput.getText().toString().trim();

        // Normalize URL
        if (!url.isEmpty() && !url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().putString(KEY_GATEWAY_URL, url).apply();

        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show();
        finish();
    }
}
