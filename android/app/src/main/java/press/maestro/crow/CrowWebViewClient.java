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

        // Cross-origin but on the SAME Tailscale tailnet as the page we're
        // currently on — i.e. another of the user's own Crow instances. Keep it
        // in the WebView so cross-instance single sign-on (a grackle→MPA
        // redirect, for example) lands its session cookie in THIS app's cookie
        // jar instead of an external browser, where the login would be useless
        // to the app. Scoped to the current tailnet (not any *.ts.net) so a
        // hostile page can't keep an arbitrary Tailscale host in-app.
        if (isSameTailnet(requestHost, currentHost)) {
            return false;
        }

        // Truly external: open in system browser
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        activity.startActivity(intent);
        return true;
    }

    /**
     * True when {@code requestHost} is on the same Tailscale tailnet as
     * {@code currentHost} (the page already loaded — the user's own gateway):
     *  - MagicDNS: both share the tailnet domain, e.g. a request to
     *    {@code crow.<tailnet>.ts.net} while on {@code grackle.<tailnet>.ts.net}.
     *  - CGNAT: both are 100.64.0.0/10 addresses (only meaningful when the
     *    current page is itself reached over the tailnet).
     * Anchored to the current tailnet rather than any {@code *.ts.net} host.
     */
    private static boolean isSameTailnet(String requestHost, String currentHost) {
        if (requestHost == null || currentHost == null) return false;
        String r = requestHost.toLowerCase();
        String c = currentHost.toLowerCase();

        if (c.endsWith(".ts.net")) {
            int dot = c.indexOf('.');
            if (dot < 0) return false;
            String tailnet = c.substring(dot + 1); // e.g. "dachshund-chromatic.ts.net"
            return r.equals(tailnet) || r.endsWith("." + tailnet);
        }

        return isCgnat(c) && isCgnat(r);
    }

    /** True for a Tailscale CGNAT address (100.64.0.0/10). */
    private static boolean isCgnat(String host) {
        if (host == null || !host.startsWith("100.")) return false;
        String[] p = host.split("\\.");
        if (p.length != 4) return false;
        try {
            for (String part : p) {
                int n = Integer.parseInt(part);
                if (n < 0 || n > 255) return false;
            }
            int second = Integer.parseInt(p[1]);
            return second >= 64 && second <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
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
