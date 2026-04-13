package press.maestro.crow

import android.app.Application
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.meta.wearable.dat.core.Wearables

class CrowApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            Wearables.initialize(this)
        } catch (t: Throwable) {
            Log.w("CrowApplication", "Wearables.initialize failed", t)
        }
        // Restart GlassesService for any previously-paired device IF we're
        // being created from a user-visible context (launcher tap, boot
        // receiver path). In background-only Application creation — e.g.
        // Android re-creating our process because a QS tile was clicked —
        // the system blocks FGS starts with
        // ForegroundServiceStartNotAllowedException, which we just swallow
        // here. The tile and shortcut entry points call
        // startForegroundService themselves, so a denial here is harmless.
        try {
            val gateway = getSharedPreferences("CrowPrefs", MODE_PRIVATE)
                .getString("gateway_url", null)
            if (!gateway.isNullOrEmpty()) {
                for (id in GlassesTokenStore.listDeviceIds(this)) {
                    val svc = Intent(this, GlassesService::class.java)
                    svc.putExtra(GlassesService.EXTRA_DEVICE_ID, id)
                    try {
                        ContextCompat.startForegroundService(this, svc)
                    } catch (t: Throwable) {
                        // Background FGS block is expected when we're being
                        // created to service a QS tile click — the tile's
                        // own startForegroundService has the temp-allow grant.
                        Log.d("CrowApplication", "deferred GlassesService start: ${t.message}")
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w("CrowApplication", "GlassesService auto-start outer failed", t)
        }
    }
}
