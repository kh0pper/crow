package press.maestro.crow;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class CrowWebViewClient extends WebViewClient {

    private final MainActivity activity;

    public CrowWebViewClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String requestHost = uri.getHost();
        String currentHost = Uri.parse(view.getUrl()).getHost();

        // Same-origin: stay in WebView
        if (requestHost != null && requestHost.equals(currentHost)) {
            return false;
        }

        // Different domain: open in system browser
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        activity.startActivity(intent);
        return true;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        new AlertDialog.Builder(activity)
                .setTitle(R.string.ssl_error_title)
                .setMessage(R.string.ssl_error_message)
                .setPositiveButton(R.string.ssl_proceed, (dialog, which) -> handler.proceed())
                .setNegativeButton(R.string.ssl_cancel, (dialog, which) -> handler.cancel())
                .setCancelable(false)
                .show();
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        activity.hideStatus();
    }
}
