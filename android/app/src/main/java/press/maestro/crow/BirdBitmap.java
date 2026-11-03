package press.maestro.crow;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.util.Log;

import androidx.core.graphics.PathParser;

/**
 * The bird drawing (BirdSvgRenderer's display list) on a Canvas — the Android half, kept out of the
 * parser so the parser stays JVM-testable.
 *
 * Paths go through androidx's own PathParser (already on the classpath through androidx.core: no new
 * dependency), and every op is drawn inside its own try/catch: one path the parser refuses costs that
 * path, never the bird. Any failure at all returns null, and the caller falls back to the app icon —
 * a widget update must never throw and must never show half a bird where an icon would do.
 */
final class BirdBitmap {

    private static final String TAG = "BirdBitmap";

    /** The bird is drawn in a 200x200 box; the size only decides how many pixels that box gets. */
    static final int VIEWBOX_FALLBACK = 200;

    /** A widget bitmap is small by nature; past this we are only spending memory. */
    private static final int MAX_SIZE = 512;

    private BirdBitmap() {
    }

    /**
     * Draw {@code svg} into a square bitmap of {@code sizePx} pixels.
     *
     * @return the bitmap, or null when the drawing cannot be read or drawn at all
     */
    static Bitmap render(String svg, int sizePx) {
        return render(svg, sizePx, true);
    }

    /**
     * Draw {@code svg} into a square bitmap of {@code sizePx} pixels.
     *
     * @param keepWalkBadge false leaves out the engine's "walked today" badge
     *     (class="rb-walk-badge"): a host that draws on the keyguard shows the bird with walked=false
     * @return the bitmap, or null when the drawing cannot be read or drawn at all
     */
    static Bitmap render(String svg, int sizePx, boolean keepWalkBadge) {
        Bitmap bitmap = null;
        try {
            BirdSvgRenderer.Drawing drawing = BirdSvgRenderer.parse(svg, keepWalkBadge);
            if (drawing == null || drawing.ops.isEmpty()) return null;

            int size = sizePx > 0 ? Math.min(sizePx, MAX_SIZE) : VIEWBOX_FALLBACK;
            bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);

            float[] box = drawing.hasViewBox && drawing.viewBox[2] > 0f && drawing.viewBox[3] > 0f
                    ? drawing.viewBox
                    : new float[]{0f, 0f, VIEWBOX_FALLBACK, VIEWBOX_FALLBACK};
            float scale = Math.min(size / box[2], size / box[3]);

            // The viewBox -> pixels transform, centred (a non-square viewBox keeps its aspect).
            canvas.translate(-box[0] * scale + (size - box[2] * scale) / 2f,
                    -box[1] * scale + (size - box[3] * scale) / 2f);
            canvas.scale(scale, scale);

            Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            fillPaint.setStyle(Paint.Style.FILL);
            Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            strokePaint.setStyle(Paint.Style.STROKE);
            Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            textPaint.setStyle(Paint.Style.FILL);
            textPaint.setTextAlign(Paint.Align.LEFT);

            for (BirdSvgRenderer.Op op : drawing.ops) {
                // One unreadable op costs only itself.
                try {
                    drawOp(canvas, op, fillPaint, strokePaint, textPaint);
                } catch (Exception e) {
                    Log.w(TAG, "op skipped: " + e.getMessage());
                }
            }
            return bitmap;
        } catch (Throwable t) {
            // Includes OutOfMemoryError and a Canvas that refuses: no bird is better than a crash.
            Log.w(TAG, "render failed: " + t.getMessage());
            if (bitmap != null) {
                try {
                    bitmap.recycle();
                } catch (Exception ignored) {
                    // nothing to do
                }
            }
            return null;
        }
    }

    private static void drawOp(Canvas canvas, BirdSvgRenderer.Op op, Paint fillPaint, Paint strokePaint,
                               Paint textPaint) {
        if (op == null || op.kind == null) return;

        Matrix matrix = matrixOf(op.transform);
        int restore = canvas.save();
        try {
            if (matrix != null) canvas.concat(matrix);

            switch (op.kind) {
                case CIRCLE:
                    paint(fillPaint, op.fill, op);
                    paint(strokePaint, op.stroke, op);
                    if (op.fill != BirdSvgRenderer.NO_PAINT) canvas.drawCircle(op.cx, op.cy, op.rx, fillPaint);
                    if (op.stroke != BirdSvgRenderer.NO_PAINT) canvas.drawCircle(op.cx, op.cy, op.rx, strokePaint);
                    break;
                case ELLIPSE: {
                    RectF oval = new RectF(op.cx - op.rx, op.cy - op.ry, op.cx + op.rx, op.cy + op.ry);
                    if (op.fill != BirdSvgRenderer.NO_PAINT) {
                        paint(fillPaint, op.fill, op);
                        canvas.drawOval(oval, fillPaint);
                    }
                    if (op.stroke != BirdSvgRenderer.NO_PAINT) {
                        paint(strokePaint, op.stroke, op);
                        canvas.drawOval(oval, strokePaint);
                    }
                    break;
                }
                case RECT: {
                    RectF rect = new RectF(op.x, op.y, op.x + op.w, op.y + op.h);
                    if (op.fill != BirdSvgRenderer.NO_PAINT) {
                        paint(fillPaint, op.fill, op);
                        if (op.cornerRx > 0f) canvas.drawRoundRect(rect, op.cornerRx, op.cornerRx, fillPaint);
                        else canvas.drawRect(rect, fillPaint);
                    }
                    if (op.stroke != BirdSvgRenderer.NO_PAINT) {
                        paint(strokePaint, op.stroke, op);
                        if (op.cornerRx > 0f) canvas.drawRoundRect(rect, op.cornerRx, op.cornerRx, strokePaint);
                        else canvas.drawRect(rect, strokePaint);
                    }
                    break;
                }
                case PATH: {
                    if (op.pathData == null) return;
                    Path path = PathParser.createPathFromPathData(op.pathData);
                    if (path == null) return;
                    if (op.fill != BirdSvgRenderer.NO_PAINT) {
                        paint(fillPaint, op.fill, op);
                        canvas.drawPath(path, fillPaint);
                    }
                    if (op.stroke != BirdSvgRenderer.NO_PAINT) {
                        paint(strokePaint, op.stroke, op);
                        canvas.drawPath(path, strokePaint);
                    }
                    break;
                }
                case TEXT: {
                    if (op.text == null || op.text.isEmpty()) return;
                    if (op.fill == BirdSvgRenderer.NO_PAINT) return;
                    paint(textPaint, op.fill, op);
                    textPaint.setTextSize(op.fontSize > 0f ? op.fontSize : 16f);
                    textPaint.setTypeface(op.bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
                    canvas.drawText(op.text, op.x, op.y, textPaint);
                    break;
                }
                default:
                    break;
            }
        } finally {
            canvas.restoreToCount(restore);
        }
    }

    /** The op's transform as an android Matrix, or null when it is the identity. */
    private static Matrix matrixOf(float[] t) {
        if (t == null || t.length < 6) return null;
        if (t[0] == 1f && t[1] == 0f && t[2] == 0f && t[3] == 1f && t[4] == 0f && t[5] == 0f) return null;
        Matrix matrix = new Matrix();
        // android.graphics.Matrix is row-major: [scaleX skewX transX; skewY scaleY transY; 0 0 1].
        matrix.setValues(new float[]{t[0], t[2], t[4], t[1], t[3], t[5], 0f, 0f, 1f});
        return matrix;
    }

    private static void paint(Paint paint, int colour, BirdSvgRenderer.Op op) {
        paint.setColor(colour);
        if (paint.getStyle() == Paint.Style.STROKE) {
            paint.setStrokeWidth(Math.max(0.01f, op.strokeWidth));
            paint.setStrokeCap(op.roundCap ? Paint.Cap.ROUND : Paint.Cap.BUTT);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }
    }
}