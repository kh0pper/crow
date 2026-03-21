package press.maestro.crow;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "crow_prefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private FrameLayout statusOverlay;
    private TextView statusText;
    private ValueCallback<Uri[]> fileUploadCallback;

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        statusOverlay = findViewById(R.id.statusOverlay);
        statusText = findViewById(R.id.statusText);

        configureWebView();

        swipeRefresh.setOnRefreshListener(() -> {
            webView.reload();
            swipeRefresh.setRefreshing(false);
        });

        String gatewayUrl = getGatewayUrl();
        if (gatewayUrl == null || gatewayUrl.isEmpty()) {
            openSettings();
        } else {
            loadGateway(gatewayUrl);
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
