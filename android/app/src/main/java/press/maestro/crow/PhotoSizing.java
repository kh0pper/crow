package press.maestro.crow;

import java.util.Locale;

/**
 * Pure size/format rules for glasses photos before upload (no Android types, so
 * plain JUnit covers them). The gateway's vision model reads JPEG/PNG only and
 * caps each image anyway, so a 12 MP HEIC from the glasses is converted to a
 * JPEG whose long side is at most {@link #MAX_LONG_SIDE}: smaller upload, a
 * format every vision server decodes, and the same picture for the library.
 */
public final class PhotoSizing {
    /** ~1.9 MP at 4:3; plenty for "what am I looking at" and for reading a sign. */
    public static final int MAX_LONG_SIDE = 1600;
    public static final int JPEG_QUALITY = 85;

    private PhotoSizing() {}

    /** {width, height} scaled so the long side is at most maxLongSide; never upscales. */
    public static int[] targetSize(int width, int height, int maxLongSide) {
        if (width <= 0 || height <= 0 || maxLongSide <= 0) return new int[] {width, height};
        int longSide = Math.max(width, height);
        if (longSide <= maxLongSide) return new int[] {width, height};
        double scale = (double) maxLongSide / longSide;
        int w = Math.max(1, (int) Math.round(width * scale));
        int h = Math.max(1, (int) Math.round(height * scale));
        return new int[] {w, h};
    }

    /** True unless the photo is already a JPEG within the size cap. */
    public static boolean needsReencode(String mime, int width, int height, int maxLongSide) {
        String m = mime == null ? "" : mime.toLowerCase(Locale.ROOT);
        if (!m.equals("image/jpeg")) return true;
        return Math.max(width, height) > maxLongSide;
    }
}
