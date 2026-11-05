package za.co.dispatch.field;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LocationTrackingService extends Service implements LocationListener {
    public static final String ACTION_START = "za.co.dispatch.field.START_TRACKING";
    public static final String ACTION_STOP = "za.co.dispatch.field.STOP_TRACKING";
    public static final String EXTRA_SERVER = "serverBase";
    public static final String EXTRA_OFFICER = "officerId";
    public static final String EXTRA_INTERVAL = "intervalSeconds";

    private static final String PREFS = "dispatch-field";
    private static final String KEY_SERVER = "serverBase";
    private static final String KEY_TRACKING = "trackingOfficer";
    private static final String KEY_QUEUE = "pendingNativeLocations";
    private static final String CHANNEL_ID = "dispatch-location";
    private static final int NOTIFICATION_ID = 4801;

    private final Object queueLock = new Object();
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private SharedPreferences preferences;
    private LocationManager locationManager;
    private String officerId;
    private String serverBase;
    private long intervalMs;

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopTracking();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            serverBase = intent.getStringExtra(EXTRA_SERVER);
            officerId = intent.getStringExtra(EXTRA_OFFICER);
            int seconds = intent.getIntExtra(EXTRA_INTERVAL, 15);
            intervalMs = Math.max(2000L, Math.min(300L, seconds) * 1000L);
        } else {
            serverBase = preferences.getString(KEY_SERVER, "");
            officerId = preferences.getString(KEY_TRACKING, null);
            intervalMs = 15000L;
        }
        if (serverBase == null || serverBase.trim().isEmpty() || officerId == null || officerId.trim().isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        preferences.edit().putString(KEY_SERVER, serverBase).putString(KEY_TRACKING, officerId).apply();
        startForeground(NOTIFICATION_ID, buildNotification());
        beginTracking();
        return START_STICKY;
    }

    private void beginTracking() {
        stopLocationUpdates();
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopTracking();
            return;
        }
        try {
            // GPS_PROVIDER is used directly for the most accurate handset position; no coarse/network
            // estimate is silently substituted. A zero distance threshold keeps close fixes flowing.
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, intervalMs, 0f, this, Looper.getMainLooper());
            if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                updateNotification("Waiting for GPS to become available");
                return;
            }
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last != null) onLocationChanged(last);
            updateNotification("High-accuracy GPS sharing is active");
        } catch (SecurityException | IllegalArgumentException error) {
            updateNotification("GPS permission or provider unavailable");
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null || officerId == null || !location.hasAccuracy()) return;
        try {
            JSONObject point = new JSONObject();
            point.put("type", "location");
            point.put("officerId", officerId);
            point.put("lat", location.getLatitude());
            point.put("lng", location.getLongitude());
            point.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            point.put("timestamp", Instant.ofEpochMilli(location.getTime()).toString());
            point.put("eventId", officerId + "-android-" + location.getTime());
            point.put("speed", location.hasSpeed() ? location.getSpeed() : 0);
            enqueue(point);
        } catch (JSONException ignored) { }
    }

    @Override
    public void onProviderEnabled(String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) beginTracking();
    }

    @Override
    public void onProviderDisabled(String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) updateNotification("GPS is disabled; location sharing is paused");
    }

    @Override
    public void onStatusChanged(String provider, int status, android.os.Bundle extras) { }

    private void enqueue(JSONObject point) {
        synchronized (queueLock) {
            JSONArray queue = readQueue();
            queue.put(point);
            while (queue.length() > 200) {
                JSONArray reduced = new JSONArray();
                for (int i = 1; i < queue.length(); i++) reduced.put(queue.opt(i));
                queue = reduced;
            }
            preferences.edit().putString(KEY_QUEUE, queue.toString()).apply();
        }
        network.execute(this::flushQueue);
    }

    private void flushQueue() {
        while (true) {
            String first;
            synchronized (queueLock) {
                JSONArray queue = readQueue();
                if (queue.length() == 0) return;
                first = queue.optString(0, "");
            }
            if (first.isEmpty() || !sendPoint(first)) return;
            synchronized (queueLock) {
                JSONArray queue = readQueue();
                if (queue.length() > 0 && first.equals(queue.optString(0))) {
                    JSONArray reduced = new JSONArray();
                    for (int i = 1; i < queue.length(); i++) reduced.put(queue.opt(i));
                    preferences.edit().putString(KEY_QUEUE, reduced.toString()).apply();
                }
            }
        }
    }

    private boolean sendPoint(String json) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(serverBase + "/api/action").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(10000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("X-Dispatch-Client", "android-field");
            String cookieHeader = CookieManager.getInstance().getCookie(serverBase);
            if (cookieHeader != null && !cookieHeader.isEmpty()) connection.setRequestProperty("Cookie", cookieHeader);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            for (java.util.Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey()) && entry.getValue() != null) {
                    for (String cookie : entry.getValue()) CookieManager.getInstance().setCookie(serverBase, cookie);
                }
            }
            CookieManager.getInstance().flush();
            return code >= 200 && code < 300;
        } catch (Exception error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private JSONArray readQueue() {
        try { return new JSONArray(preferences.getString(KEY_QUEUE, "[]")); }
        catch (JSONException ignored) { return new JSONArray(); }
    }

    private void stopLocationUpdates() {
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); }
            catch (SecurityException ignored) { }
        }
    }

    private void stopTracking() {
        stopLocationUpdates();
        preferences.edit().remove(KEY_TRACKING).apply();
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Dispatch location sharing")
                .setContentText("High-accuracy GPS is active while you are clocked in")
                .setContentIntent(pending)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    private void updateNotification(String message) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        Notification notification = builder.setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Dispatch location sharing")
                .setContentText(message)
                .setContentIntent(pending)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, notification);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Dispatch location", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Visible while field GPS tracking is active");
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        }
    }

    @Override
    public void onDestroy() {
        stopLocationUpdates();
        network.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
