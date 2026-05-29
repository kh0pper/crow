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

        // Cross-origin but still on the user's Tailscale tailnet — i.e. another
        // of their own Crow instances. Keep it in the WebView so cross-instance
        // single sign-on (a grackle→MPA redirect, for example) lands its session
        // cookie in THIS app's cookie jar instead of an external browser, where
        // the login would be useless to the app.
        if (isTailnetHost(requestHost)) {
            return false;
        }

        // Truly external: open in system browser
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        activity.startActivity(intent);
        return true;
    }

    /**
     * True for hosts on the user's Tailscale tailnet: MagicDNS names
     * (*.ts.net) and CGNAT addresses (100.64.0.0/10). These are the user's own
     * instances, safe to keep inside the app.
     */
    private static boolean isTailnetHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        if (h.endsWith(".ts.net")) return true;
        if (h.startsWith("100.")) {
            String[] p = h.split("\\.");
            if (p.length == 4) {
                try {
                    int second = Integer.parseInt(p[1]);
                    return second >= 64 && second <= 127;
                } catch (NumberFormatException ignored) {
                    return false;
                }
            }
        }
        return false;
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
