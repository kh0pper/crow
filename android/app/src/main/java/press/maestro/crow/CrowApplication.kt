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
        // Restart GlassesService for any previously-paired device. Without
        // this, the service only starts during an explicit pairing flow,
        // so a user who launches the app on a paired device gets no
        // notification PTT and no reconnect.
        try {
            val gateway = getSharedPreferences("CrowPrefs", MODE_PRIVATE)
                .getString("gateway_url", null)
            if (!gateway.isNullOrEmpty()) {
                for (id in GlassesTokenStore.listDeviceIds(this)) {
                    val svc = Intent(this, GlassesService::class.java)
                    svc.putExtra(GlassesService.EXTRA_DEVICE_ID, id)
                    ContextCompat.startForegroundService(this, svc)
                }
            }
        } catch (t: Throwable) {
            Log.w("CrowApplication", "GlassesService auto-start failed", t)
        }
    }
}
