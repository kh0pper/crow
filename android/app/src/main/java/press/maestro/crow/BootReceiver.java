package press.maestro.crow;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * Starts the ntfy listener service on device boot if a gateway URL is configured.
 * The service will use cached ntfy config (no cookie needed at boot time).
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        SharedPreferences prefs = context.getSharedPreferences("CrowPrefs", Context.MODE_PRIVATE);
        String gatewayUrl = prefs.getString("gateway_url", null);

        if (gatewayUrl != null && !gatewayUrl.isEmpty()) {
            Intent serviceIntent = new Intent(context, NtfyListenerService.class);
            ContextCompat.startForegroundService(context, serviceIntent);
        }
    }
}
