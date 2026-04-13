package press.maestro.crow

import android.app.Application
import android.util.Log
import com.meta.wearable.dat.core.Wearables

class CrowApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            Wearables.initialize(this)
        } catch (t: Throwable) {
            Log.w("CrowApplication", "Wearables.initialize failed", t)
        }
    }
}
