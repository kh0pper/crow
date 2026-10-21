package press.maestro.crow;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Glasses photo normalisation: size + format rules (2026-10-21). */
public class PhotoSizingTest {

    @Test
    public void aTwelveMegapixelLandscapeShrinksToTheLongSideCap() {
        assertArrayEquals(new int[] {1600, 1200}, PhotoSizing.targetSize(4032, 3024, 1600));
    }

    @Test
    public void portraitKeepsItsAspectRatio() {
        assertArrayEquals(new int[] {1200, 1600}, PhotoSizing.targetSize(3024, 4032, 1600));
        assertArrayEquals(new int[] {900, 1600}, PhotoSizing.targetSize(1080, 1920, 1600));
    }

    @Test
    public void aPhotoAlreadyWithinTheCapIsNeverUpscaled() {
        assertArrayEquals(new int[] {1280, 720}, PhotoSizing.targetSize(1280, 720, 1600));
        assertArrayEquals(new int[] {1600, 900}, PhotoSizing.targetSize(1600, 900, 1600));
    }

    @Test
    public void neitherSideRoundsToZero() {
        int[] t = PhotoSizing.targetSize(20000, 3, 1600);
        assertEquals(1600, t[0]);
        assertEquals(1, t[1]);
    }

    @Test
    public void nonsenseDimensionsComeBackUnchanged() {
        assertArrayEquals(new int[] {0, 0}, PhotoSizing.targetSize(0, 0, 1600));
        assertArrayEquals(new int[] {-5, 10}, PhotoSizing.targetSize(-5, 10, 1600));
    }

    @Test
    public void heicAndOversizedPhotosAreReencodedSmallJpegsPassThrough() {
        assertTrue(PhotoSizing.needsReencode("image/heic", 1600, 1200, 1600));
        assertTrue(PhotoSizing.needsReencode("image/heif", 800, 600, 1600));
        assertTrue(PhotoSizing.needsReencode("image/jpeg", 4032, 3024, 1600));
        assertTrue(PhotoSizing.needsReencode("image/png", 800, 600, 1600));
        assertFalse(PhotoSizing.needsReencode("image/jpeg", 1600, 1200, 1600));
        assertFalse(PhotoSizing.needsReencode("IMAGE/JPEG", 640, 480, 1600));
    }
}
