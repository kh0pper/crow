package press.maestro.crow;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

public class CrowWebChromeClient extends WebChromeClient {

    private final MainActivity activity;

    public CrowWebChromeClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                     FileChooserParams fileChooserParams) {
        Intent intent = fileChooserParams.createIntent();
        activity.onFileUploadRequested(filePathCallback, intent);
        return true;
    }

    @Override
    public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
        new AlertDialog.Builder(activity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                .setCancelable(false)
                .show();
        return true;
    }

    @Override
    public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
        new AlertDialog.Builder(activity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                .setCancelable(false)
                .show();
        return true;
    }
}
