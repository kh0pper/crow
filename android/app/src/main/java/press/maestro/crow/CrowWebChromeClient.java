package press.maestro.crow;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

public class CrowWebChromeClient extends WebChromeClient {

    private final MainActivity activity;

    public CrowWebChromeClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        // Grant audio/video permissions for companion voice chat and camera
        activity.runOnUiThread(() -> {
            String[] resources = request.getResources();
            boolean needsAudio = false;
            boolean needsVideo = false;

            for (String resource : resources) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    needsAudio = true;
                }
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                    needsVideo = true;
                }
            }

            if (!needsAudio && !needsVideo) {
                request.deny();
                return;
            }

            boolean hasAudio = activity.hasAudioPermission();
            boolean hasCamera = activity.hasCameraPermission();

            if (needsVideo && needsAudio) {
                // Both requested: compound permission flow
                if (hasAudio && hasCamera) {
                    request.grant(resources);
                } else {
                    activity.requestAudioAndCameraPermissionForWebView(request);
                }
            } else if (needsVideo) {
                // Video only
                if (hasCamera) {
                    request.grant(resources);
                } else {
                    activity.requestCameraPermissionForWebView(request);
                }
            } else {
                // Audio only
                if (hasAudio) {
                    request.grant(resources);
                } else {
                    activity.requestAudioPermissionForWebView(request);
                }
            }
        });
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
