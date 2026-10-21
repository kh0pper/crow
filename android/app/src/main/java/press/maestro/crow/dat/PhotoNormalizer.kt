package press.maestro.crow.dat

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import press.maestro.crow.PhotoSizing

/**
 * Turns whatever the glasses hand back (HEIC bytes or a full-size Bitmap) into a JPEG whose long
 * side is at most [PhotoSizing.MAX_LONG_SIDE]. Runs off the main thread (callers use
 * Dispatchers.Default). On any decode failure the original bytes go up unchanged, so a photo is
 * never lost: the library still keeps it, only the description may fail.
 */
object PhotoNormalizer {
    private const val TAG = "PhotoNormalizer"

    data class Result(val bytes: ByteArray, val mime: String)

    fun fromEncoded(bytes: ByteArray, mime: String): Result {
        return try {
            var srcW = 0
            var srcH = 0
            val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                srcW = info.size.width
                srcH = info.size.height
                val t = PhotoSizing.targetSize(srcW, srcH, PhotoSizing.MAX_LONG_SIDE)
                decoder.setTargetSize(t[0], t[1])
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            if (!PhotoSizing.needsReencode(mime, srcW, srcH, PhotoSizing.MAX_LONG_SIDE)) {
                bitmap.recycle()
                return Result(bytes, mime)
            }
            val out = toJpeg(bitmap)
            Log.i(TAG, "normalized $mime ${srcW}x$srcH (${bytes.size} B) -> image/jpeg ${bitmap.width}x${bitmap.height} (${out.size} B)")
            bitmap.recycle()
            Result(out, "image/jpeg")
        } catch (t: Throwable) {
            Log.w(TAG, "normalize failed for $mime (${bytes.size} B), uploading the original: ${t.message}")
            Result(bytes, mime)
        }
    }

    fun fromBitmap(bitmap: Bitmap): Result {
        return try {
            val t = PhotoSizing.targetSize(bitmap.width, bitmap.height, PhotoSizing.MAX_LONG_SIDE)
            val scaled = if (t[0] != bitmap.width || t[1] != bitmap.height) Bitmap.createScaledBitmap(bitmap, t[0], t[1], true) else bitmap
            val out = toJpeg(scaled)
            if (scaled !== bitmap) scaled.recycle()
            Result(out, "image/jpeg")
        } catch (t: Throwable) {
            // Never lose the photo: fall back to the full-size JPEG the app used to send.
            Log.w(TAG, "scaling failed for a ${bitmap.width}x${bitmap.height} bitmap, uploading it unscaled: ${t.message}")
            Result(toJpeg(bitmap), "image/jpeg")
        }
    }

    private fun toJpeg(bitmap: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, PhotoSizing.JPEG_QUALITY, out)
        return out.toByteArray()
    }
}
