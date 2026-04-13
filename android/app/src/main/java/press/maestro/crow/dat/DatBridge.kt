package press.maestro.crow.dat

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.meta.wearable.dat.camera.startStreamSession
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamSessionState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

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

    interface PhotoListener {
        /** Called on the main thread with a ready-to-upload byte array + MIME type. */
        fun onPhoto(bytes: ByteArray, mime: String)
        fun onError(code: String, message: String)
    }

    /**
     * Capture a single photo from the glasses via DAT StreamSession.
     *
     * Fast-fails with code="permission_needed" when Wearables camera
     * permission isn't granted — caller should route the user to the
     * PairingActivity which has an Activity context for the permission
     * request contract. Other failures surface as code="no_device" /
     * "stream_start_failed" / "capture_failed".
     */
    @JvmStatic
    fun capturePhoto(context: Context, listener: PhotoListener): Job {
        val scope = CoroutineScope(Dispatchers.Main)
        return scope.launch {
            try {
                val permResult = Wearables.checkPermissionStatus(Permission.CAMERA)
                val status = permResult.getOrNull()
                Log.i(TAG, "camera permission status=$status permResult=$permResult")
                // Don't pre-block on Denied — the check can lag real state after
                // a fresh grant. Let startStreamSession tell us the truth.

                val session = try {
                    Wearables.startStreamSession(
                        context,
                        AutoDeviceSelector(),
                        StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 24),
                    )
                } catch (t: Throwable) {
                    listener.onError("stream_start_failed", t.message ?: "startStreamSession failed")
                    return@launch
                }

                val seen = mutableListOf<StreamSessionState>()
                val streaming = withTimeoutOrNull(15_000) {
                    session.state.first { s ->
                        seen.add(s)
                        Log.i(TAG, "stream state=$s")
                        s == StreamSessionState.STREAMING || s == StreamSessionState.STOPPED || s == StreamSessionState.CLOSED
                    }
                }
                if (streaming != StreamSessionState.STREAMING) {
                    listener.onError("stream_start_failed", "Session never reached STREAMING (got $streaming, saw $seen)")
                    try { session.close() } catch (_: Throwable) {}
                    return@launch
                }

                val result = session.capturePhoto()
                try { session.close() } catch (_: Throwable) {}

                result
                    .onSuccess { photo ->
                        when (photo) {
                            is PhotoData.HEIC -> {
                                val buf = photo.data
                                val bytes = ByteArray(buf.remaining())
                                buf.get(bytes)
                                listener.onPhoto(bytes, "image/heic")
                            }
                            is PhotoData.Bitmap -> {
                                val out = ByteArrayOutputStream()
                                photo.bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
                                listener.onPhoto(out.toByteArray(), "image/jpeg")
                            }
                            else -> listener.onError("capture_failed", "Unknown PhotoData subclass")
                        }
                    }
                    .onFailure { err, _ ->
                        listener.onError("capture_failed", err.description ?: "capture error")
                    }
            } catch (t: Throwable) {
                Log.w(TAG, "capturePhoto exception", t)
                listener.onError("capture_failed", t.message ?: "unknown")
            }
        }
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
