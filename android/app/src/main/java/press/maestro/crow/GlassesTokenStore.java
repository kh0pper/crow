package press.maestro.crow;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * Stores per-device bearer tokens for the Meta Glasses /session WebSocket.
 *
 * Backed by {@link EncryptedSharedPreferences} so tokens at rest are
 * encrypted with a key held in the Android Keystore.
 */
public final class GlassesTokenStore {
    private static final String FILE = "crow_glasses_tokens";

    private GlassesTokenStore() {}

    public static SharedPreferences open(Context ctx) {
        try {
            MasterKey masterKey = new MasterKey.Builder(ctx)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            return EncryptedSharedPreferences.create(
                    ctx,
                    FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (GeneralSecurityException | IOException e) {
            throw new RuntimeException("Failed to open encrypted token store", e);
        }
    }

    public static void save(Context ctx, String deviceId, String token) {
        open(ctx).edit().putString(deviceId, token).apply();
    }

    public static String load(Context ctx, String deviceId) {
        return open(ctx).getString(deviceId, null);
    }

    public static void clear(Context ctx, String deviceId) {
        open(ctx).edit().remove(deviceId).apply();
    }

    /** List all stored device IDs (for auto-start on boot / app launch). */
    public static java.util.Set<String> listDeviceIds(Context ctx) {
        return open(ctx).getAll().keySet();
    }
}
