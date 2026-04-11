package press.maestro.crow;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Creates notification channels and builds Android notifications from Crow events.
 */
public class NotificationHelper {

    public static final String CHANNEL_MESSAGES = "crow_messages";
    public static final String CHANNEL_SYSTEM = "crow_system";
    public static final String CHANNEL_REMINDERS = "crow_reminders";
    public static final String CHANNEL_MEDIA = "crow_media";
    public static final String CHANNEL_SERVICE = "crow_service";

    /**
     * Create notification channels (Android 8+). Safe to call multiple times.
     */
    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager mgr = context.getSystemService(NotificationManager.class);
        if (mgr == null) return;

        mgr.createNotificationChannel(new NotificationChannel(
                CHANNEL_MESSAGES, "Messages",
                NotificationManager.IMPORTANCE_HIGH));

        mgr.createNotificationChannel(new NotificationChannel(
                CHANNEL_REMINDERS, "Reminders",
                NotificationManager.IMPORTANCE_HIGH));

        mgr.createNotificationChannel(new NotificationChannel(
                CHANNEL_SYSTEM, "System",
                NotificationManager.IMPORTANCE_DEFAULT));

        mgr.createNotificationChannel(new NotificationChannel(
                CHANNEL_MEDIA, "Media",
                NotificationManager.IMPORTANCE_LOW));

        NotificationChannel serviceChannel = new NotificationChannel(
                CHANNEL_SERVICE, "Connection Status",
                NotificationManager.IMPORTANCE_MIN);
        serviceChannel.setShowBadge(false);
        mgr.createNotificationChannel(serviceChannel);
    }

    /**
     * Map Crow notification type to Android channel ID.
     */
    public static String channelForType(String type) {
        if (type == null) return CHANNEL_SYSTEM;
        switch (type) {
            case "peer": return CHANNEL_MESSAGES;
            case "reminder": return CHANNEL_REMINDERS;
            case "media": return CHANNEL_MEDIA;
            default: return CHANNEL_SYSTEM;
        }
    }

    /**
     * Show an Android notification.
     *
     * @param notificationId Unique ID (use Crow notification DB id)
     * @param title          Notification title
     * @param body           Notification body (may be null)
     * @param actionUrl      URL to open on tap (relative, e.g. /dashboard/messages)
     * @param type           Crow notification type (peer, reminder, media, system)
     */
    public static void show(Context context, int notificationId, String title, String body,
                            String actionUrl, String type) {
        String channelId = channelForType(type);

        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (actionUrl != null) {
            intent.putExtra("action_url", actionUrl);
        }

        PendingIntent pending = PendingIntent.getActivity(
                context, notificationId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentIntent(pending)
                .setAutoCancel(true);

        if (body != null && !body.isEmpty()) {
            builder.setContentText(body);
        }

        try {
            NotificationManagerCompat.from(context).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS permission not granted — silently ignore
        }
    }

    /**
     * Map ntfy tag strings to Crow notification type.
     * Tags come as comma-separated in the ntfy JSON "tags" array.
     */
    public static String typeFromNtfyTags(String tags) {
        if (tags == null) return "system";
        if (tags.contains("incoming_envelope")) return "peer";
        if (tags.contains("alarm_clock")) return "reminder";
        if (tags.contains("musical_note")) return "media";
        return "system";
    }
}
