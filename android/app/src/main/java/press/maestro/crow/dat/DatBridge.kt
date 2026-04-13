package press.maestro.crow.dat

import android.app.Activity
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.RegistrationState
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Java-friendly bridge around the Kotlin/coroutine-based DAT SDK surface used for pairing.
 *
 * Flow:
 *   1. [startRegistration] launches the Meta AI app via Wearables.startRegistration.
 *   2. We observe Wearables.registrationState until Registered.
 *   3. We observe Wearables.devices until a device identifier appears.
 *   4. We read that device's metadata once to pull its display name.
 *   5. [Listener.onDevicePaired] fires with (deviceId, displayName).
 *
 * Errors — SDK exceptions, the user declining registration, no devices discovered — route to
 * [Listener.onError]. Progress messages are forwarded via [Listener.onStatus] for the UI log.
 */
object DatBridge {

    private const val TAG = "DatBridge"

    interface Listener {
        fun onStatus(message: String)
        fun onDevicePaired(deviceId: String, displayName: String)
        fun onError(message: String)
    }

    @JvmStatic
    fun startRegistration(activity: Activity, owner: LifecycleOwner, listener: Listener): Job {
        val scope = owner.lifecycleScope
        return scope.launch {
            try {
                owner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                    listener.onStatus("Requesting registration in Meta AI app...")
                    try {
                        Wearables.startRegistration(activity)
                    } catch (t: Throwable) {
                        listener.onError("startRegistration threw: ${t.message}")
                        return@repeatOnLifecycle
                    }

                    val registered = Wearables.registrationState.first { state ->
                        when (state) {
                            is RegistrationState.Registered -> true
                            else -> {
                                listener.onStatus("Registration state: ${state.javaClass.simpleName}")
                                false
                            }
                        }
                    }
                    listener.onStatus("Registered. Waiting for a Ray-Ban device...")

                    val devices = Wearables.devices.first { it.isNotEmpty() }
                    val deviceId = devices.first()
                    val idStr = deviceId.toString()

                    val displayName = try {
                        val metaFlow = Wearables.devicesMetadata[deviceId]
                        val meta = metaFlow?.first()
                        val name = meta?.name
                        if (name.isNullOrEmpty()) idStr else name
                    } catch (t: Throwable) {
                        Log.w(TAG, "devicesMetadata read failed", t)
                        idStr
                    }

                    listener.onStatus("Device ready: $displayName ($idStr)")
                    listener.onDevicePaired(idStr, displayName)
                    // One-shot: stop collecting once we've handed off to the gateway register step.
                    return@repeatOnLifecycle
                }
            } catch (t: Throwable) {
                listener.onError("DAT bridge error: ${t.message}")
            }
        }
    }
}
