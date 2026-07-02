# iPhone (PWA)

Access Crow from your iPhone by installing the Crow's Nest as a web app — no App Store account, no APK, nothing to approve. This is called a Progressive Web App (PWA), and it looks and behaves like any other app icon on your Home Screen.

::: tip Requires iOS 16.4 or later
Apple added push notification support for installed web apps in iOS 16.4. If notifications don't show up as an option, check **Settings** > **General** > **About** > **Software Version** and update if needed.
:::

## Step 1: Join your Crow's Tailscale network

If your Crow gateway runs on a home server (not something already reachable from the open internet), install Tailscale first so your iPhone can reach it securely from anywhere:

1. Install the [Tailscale app from the App Store](https://apps.apple.com/app/tailscale/id1470499037)
2. Open Tailscale and sign in with the same account used on your Crow server
3. Toggle Tailscale **on**

See the full [Tailscale Setup guide](../getting-started/tailscale-setup) if this is your first time setting it up, or if you need the server's Tailscale address.

::: tip Already on the same Wi-Fi?
If your iPhone and your Crow server are on the same home network, you can skip Tailscale and use the server's local address directly.
:::

## Step 2: Open your Crow's Nest URL in Safari

1. Open **Safari** (this must be Safari — other browsers on iOS can't install web apps to the Home Screen)
2. Type in the address whoever set up your Crow gave you — it looks like a website address, for example `http://100.121.254.89:3001` or `https://your-server.ts.net`
3. Log in with your Crow's Nest password

## Step 3: Add Crow to your Home Screen

1. Tap the **Share** button (the square with an arrow pointing up, in the bottom toolbar)
2. Scroll down the list of options and tap **Add to Home Screen**
3. Confirm the name (or leave it as "Crow") and tap **Add**

A Crow icon now appears on your Home Screen, just like any other app.

## Step 4: Open Crow from the Home Screen and turn on notifications

::: warning Open the icon, not the Safari tab
Notification permission can only be granted from **inside the installed app** — tapping the Home Screen icon. Safari itself will not offer to turn on notifications for the site, even though it's the same page.
:::

1. Close Safari and tap the **Crow icon** on your Home Screen
2. Go to **Settings** > **Notifications** inside Crow's Nest
3. Tap **Enable Push**
4. When iOS asks to allow notifications, tap **Allow**

That's it — Crow now runs full-screen, without Safari's address bar, and can send you push notifications for calls, messages, and reminders.

## Troubleshooting

### I don't see an option to enable notifications

Make sure you opened Crow from the **Home Screen icon**, not from a Safari tab or bookmark. If you're not sure, close Safari completely, then tap the Crow icon again.

### I already added it to the Home Screen, but notifications still don't work

- Remove the icon from your Home Screen (long-press it > **Remove App** > **Remove from Home Screen**) and repeat Steps 2-4. This forces iOS to re-register the app.
- Confirm you're on iOS 16.4 or later (**Settings** > **General** > **About**).
- Check that notifications aren't being silenced by a Focus mode: **Settings** > **Focus**, and make sure the active Focus (Do Not Disturb, Sleep, Work, etc.) allows notifications from Crow, or turn the Focus off.
- Check **Settings** > **Notifications** > **Crow** on the iPhone itself and confirm "Allow Notifications" is on.

### The page looks like a normal website, not an app

If it still shows Safari's address bar and tabs, you're looking at the Safari tab, not the installed app. Go back to Step 3 and add it to the Home Screen, then always open it from that icon going forward.

### I can't reach the page at all

- If you're away from home, confirm Tailscale is connected (open the Tailscale app and check it says "Connected")
- Double-check the address — it's case-sensitive and needs the `http://` or `https://` part
- Ask whoever manages your Crow server to confirm the gateway is running
