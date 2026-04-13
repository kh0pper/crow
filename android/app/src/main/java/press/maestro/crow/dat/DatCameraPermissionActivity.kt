package press.maestro.crow.dat

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus

/**
 * Headless activity that drives the DAT camera permission request. The
 * RequestPermissionContract requires an ActivityResultLauncher registered
 * before the host Activity is STARTED, which is why this isn't just a
 * helper method on the pure-Java PairingActivity.
 *
 * Caller (PairingActivity) fires this via startActivity(...); result is
 * surfaced as a Toast. Subsequent DatBridge.capturePhoto calls will see
 * the granted state via Wearables.checkPermissionStatus.
 */
class DatCameraPermissionActivity : ComponentActivity() {

    private var launched = false

    private val launcher = registerForActivityResult(
        Wearables.RequestPermissionContract()
    ) { result ->
        Log.i("DatCamPerm", "raw result=$result")
        val status = try { result.getOrDefault(PermissionStatus.Denied) } catch (t: Throwable) {
            Log.w("DatCamPerm", "result parse err: ${t.message}")
            PermissionStatus.Denied
        }
        val msg = "Glasses camera permission: $status"
        Log.i("DatCamPerm", msg)
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i("DatCamPerm", "onCreate saved=${savedInstanceState != null}")
        launched = savedInstanceState?.getBoolean("launched", false) ?: false
    }

    override fun onStart() {
        super.onStart()
        Log.i("DatCamPerm", "onStart launched=$launched")
        if (!launched) {
            launched = true
            try { launcher.launch(Permission.CAMERA) } catch (t: Throwable) {
                Log.e("DatCamPerm", "launcher.launch failed", t)
                Toast.makeText(this, "Permission launcher failed: ${t.message}", Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("launched", launched)
    }
}
