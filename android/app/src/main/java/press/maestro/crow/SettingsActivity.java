package press.maestro.crow;

import android.content.SharedPreferences;
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

    private static final String PREFS_NAME = "crow_prefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";

    private EditText urlInput;
    private TextView connectionStatus;
    private TextView tailscaleStatus;
    private Button testButton;
    private Button tailscaleButton;
    private Button saveButton;

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

        // Load saved URL
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_GATEWAY_URL, "");
        urlInput.setText(savedUrl);

        updateTailscaleStatus();

        testButton.setOnClickListener(v -> testConnection());
        tailscaleButton.setOnClickListener(v -> handleTailscaleAction());
        saveButton.setOnClickListener(v -> saveSettings());
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
