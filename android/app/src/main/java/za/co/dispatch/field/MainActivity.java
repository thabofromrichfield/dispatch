package za.co.dispatch.field;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String PREFS = "dispatch-field";
    private static final String KEY_SERVER = "serverBase";
    private static final String DEFAULT_SERVER = "https://dispatch-brown-five.vercel.app";
    private static final String PREF_LOCATION_DENIED = "locationPermissionDenied";
    private static final String ASSET_ORIGIN = "https://appassets.androidplatform.net";
    private static final int REQUEST_LOCATION = 4101;
    private static final int REQUEST_MICROPHONE = 4102;

    private SharedPreferences preferences;
    private volatile String serverBase = "";
    private LinearLayout root;
    private volatile WebView webView;
    private final ExecutorService apiExecutor = Executors.newFixedThreadPool(3);
    private PermissionRequest pendingMediaRequest;
    private String pendingOfficerId;
    private int pendingInterval = 15;
    private boolean locationPermissionRequestActive;
    private boolean locationPermissionDenied;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(8, 17, 30));
        getWindow().setNavigationBarColor(Color.rgb(8, 17, 30));
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        locationPermissionDenied = preferences.getBoolean(PREF_LOCATION_DENIED, false) && !hasFineLocation();
        serverBase = preferences.getString(KEY_SERVER, DEFAULT_SERVER);
        if (serverBase == null || serverBase.trim().isEmpty()) {
            serverBase = DEFAULT_SERVER;
            preferences.edit().putString(KEY_SERVER, serverBase).apply();
        }
        if (validServer(serverBase)) showApp(); else showConnectScreen();
    }

    private void showConnectScreen() {
        if (webView != null) {
            webView.removeJavascriptInterface("DispatchNative");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(24), dp(24), dp(24), dp(24));
        root.setBackgroundColor(Color.rgb(8, 17, 30));

        TextView title = new TextView(this);
        title.setText("Dispatch Field");
        title.setTextColor(Color.WHITE);
        title.setTextSize(28);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title, matchWrap());

        TextView intro = new TextView(this);
        intro.setText("Connect to the HTTPS Dispatch server. HTTP is for localhost-only development when explicitly enabled by the server operator. The server URL is stored on this device only.");
        intro.setTextColor(Color.rgb(190, 204, 220));
        intro.setTextSize(15);
        intro.setPadding(0, dp(10), 0, dp(18));
        root.addView(intro, matchWrap());

        EditText urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setTextColor(Color.WHITE);
        urlInput.setHintTextColor(Color.rgb(133, 151, 172));
        urlInput.setHint(DEFAULT_SERVER);
        urlInput.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setText(serverBase);
        urlInput.setSelectAllOnFocus(true);
        urlInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        urlInput.setBackgroundColor(Color.rgb(24, 39, 58));
        root.addView(urlInput, matchWidthWrap());

        Button connect = button("Connect", true);
        LinearLayout.LayoutParams buttonParams = matchWidthWrap();
        buttonParams.topMargin = dp(14);
        root.addView(connect, buttonParams);
        connect.setOnClickListener(v -> {
            String value = normalizeServer(urlInput.getText().toString());
            if (!validServer(value)) {
                Toast.makeText(this, "Enter the HTTPS URL of your Dispatch server", Toast.LENGTH_LONG).show();
                return;
            }
            if (!serverBase.equals(value)) {
                Intent stop = new Intent(this, LocationTrackingService.class);
                stop.setAction(LocationTrackingService.ACTION_STOP);
                preferences.edit().remove("trackingOfficer").apply();
                try { startService(stop); } catch (RuntimeException ignored) { }
            }
            serverBase = value;
            preferences.edit().putString(KEY_SERVER, serverBase).apply();
            showApp();
        });

        TextView safety = new TextView(this);
        safety.setText("Sign in with a provisioned account. Use HTTPS and a trusted network; do not bypass the server TLS configuration.");
        safety.setTextColor(Color.rgb(247, 184, 108));
        safety.setTextSize(13);
        safety.setPadding(0, dp(22), 0, 0);
        root.addView(safety, matchWrap());
        setContentView(root);
    }

    private void showApp() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(8, 17, 30));

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled(false);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView.addJavascriptInterface(new DispatchBridge(this), "DispatchNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !"appassets.androidplatform.net".equals(uri.getHost());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }

        });


        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        webView.loadUrl(ASSET_ORIGIN + "/index.html");
    }

    private void handleWebPermission(PermissionRequest request) {
        boolean needsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needsAudio = true;
        }
        if (!needsAudio) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMediaRequest = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
        }
    }

    private void requestLocationPermission() {
        if (hasFineLocation()) {
            completeLocationPermission(true);
            return;
        }
        if (locationPermissionRequestActive) return;
        locationPermissionRequestActive = true;
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.POST_NOTIFICATIONS}, REQUEST_LOCATION);
        } else {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQUEST_LOCATION);
        }
    }

    private boolean hasFineLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void completeLocationPermission(boolean granted) {
        if (pendingOfficerId != null) {
            if (granted) startLocationService(pendingOfficerId, pendingInterval);
            else Toast.makeText(this, "Precise location permission is required for background tracking", Toast.LENGTH_LONG).show();
            pendingOfficerId = null;
        }
    }

    private void startLocationService(String officerId, int interval) {
        preferences.edit().putString("trackingOfficer", officerId).apply();
        Intent intent = new Intent(this, LocationTrackingService.class);
        intent.setAction(LocationTrackingService.ACTION_START);
        intent.putExtra(LocationTrackingService.EXTRA_SERVER, serverBase);
        intent.putExtra(LocationTrackingService.EXTRA_OFFICER, officerId);
        intent.putExtra(LocationTrackingService.EXTRA_INTERVAL, interval);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
            else startService(intent);
        } catch (RuntimeException error) {
            Toast.makeText(this, "Could not start location service: " + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_MICROPHONE) {
            if (pendingMediaRequest != null) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    pendingMediaRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else pendingMediaRequest.deny();
                pendingMediaRequest = null;
            }
        } else if (requestCode == REQUEST_LOCATION) {
            locationPermissionRequestActive = false;
            locationPermissionDenied = !hasFineLocation();
            preferences.edit().putBoolean(PREF_LOCATION_DENIED, locationPermissionDenied).apply();
            completeLocationPermission(!locationPermissionDenied);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("DispatchNative");
            webView.destroy();
            webView = null;
        }
        apiExecutor.shutdownNow();
        super.onDestroy();
    }

    private Button button(String text, boolean primary) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(primary ? Color.rgb(37, 126, 213) : Color.rgb(28, 47, 68));
        return button;
    }

    private int dp(float value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }
    private LinearLayout.LayoutParams matchWrap() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); }
    private LinearLayout.LayoutParams matchWidthWrap() { return matchWrap(); }

    private static String normalizeServer(String raw) {
        String value = raw == null ? "" : raw.trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private static boolean validServer(String value) {
        try {
            Uri uri = Uri.parse(value);
            String scheme = uri.getScheme();
            return "https".equalsIgnoreCase(scheme)
                    && uri.getHost() != null && !uri.getHost().trim().isEmpty()
                    && (uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))
                    && uri.getUserInfo() == null && uri.getQuery() == null && uri.getFragment() == null;
        } catch (RuntimeException ignored) { return false; }
    }

    private final class DispatchBridge {
        private final Context context;
        DispatchBridge(Context context) { this.context = context; }

        @JavascriptInterface
        public void openServerSettings() {
            MainActivity.this.runOnUiThread(MainActivity.this::showConnectScreen);
        }

        @JavascriptInterface
        public void requestAsync(String path, String method, String headersJson, String body, String callbackId) {
            if (callbackId == null || !callbackId.matches("[A-Za-z0-9_-]{1,100}")) return;
            apiExecutor.execute(() -> {
                String response = request(path, method, headersJson, body);
                WebView target = webView;
                if (target == null) return;
                String script = "window.DispatchNativeResolve && window.DispatchNativeResolve("
                        + JSONObject.quote(callbackId) + "," + JSONObject.quote(response) + ");";
                target.post(() -> target.evaluateJavascript(script, null));
            });
        }

        @JavascriptInterface
        public String request(String path, String method, String headersJson, String body) {
            JSONObject result = new JSONObject();
            HttpURLConnection connection = null;
            try {
                if (path == null || !path.startsWith("/api/") || path.contains("\\") || !validServer(serverBase))
                    throw new IllegalArgumentException("Only Dispatch API routes are allowed");
                String verb = method == null ? "GET" : method.toUpperCase(java.util.Locale.ROOT);
                if (!verb.equals("GET") && !verb.equals("POST") && !verb.equals("DELETE"))
                    throw new IllegalArgumentException("Unsupported API method");
                connection = (HttpURLConnection) new URL(serverBase + path).openConnection();
                connection.setRequestMethod(verb);
                String cookieHeader = CookieManager.getInstance().getCookie(serverBase);
                if (cookieHeader != null && !cookieHeader.isEmpty()) connection.setRequestProperty("Cookie", cookieHeader);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(45000);
                connection.setRequestProperty("X-Dispatch-Client", "android-field");
                JSONObject requestHeaders = new JSONObject(headersJson == null ? "{}" : headersJson);
                Iterator<String> names = requestHeaders.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    if (name.equalsIgnoreCase("content-type") || name.equalsIgnoreCase("accept"))
                        connection.setRequestProperty(name, requestHeaders.optString(name));
                }
                if ((verb.equals("POST") || verb.equals("DELETE")) && body != null && !body.isEmpty()) {
                    connection.setDoOutput(true);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
                }
                int status = connection.getResponseCode();
                for (java.util.Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                    if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey()) && entry.getValue() != null) {
                        for (String cookie : entry.getValue()) CookieManager.getInstance().setCookie(serverBase, cookie);
                    }
                }
                CookieManager.getInstance().flush();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String contentType = connection.getContentType();
                result.put("status", status);
                result.put("body", stream == null ? "" : readUtf8(stream));
                JSONObject responseHeaders = new JSONObject();
                if (contentType != null) responseHeaders.put("Content-Type", contentType);
                responseHeaders.put("Cache-Control", connection.getHeaderField("Cache-Control") == null ? "no-store" : connection.getHeaderField("Cache-Control"));
                result.put("headers", responseHeaders);
            } catch (Exception error) {
                try {
                    result.put("status", 503);
                    result.put("body", new JSONObject().put("error", "Dispatch server unavailable: " + error.getMessage()).toString());
                    result.put("headers", new JSONObject().put("Content-Type", "application/json"));
                } catch (JSONException ignored) { }
            } finally {
                if (connection != null) connection.disconnect();
            }
            return result.toString();
        }

        @JavascriptInterface
        public boolean startTracking(String officerId, int intervalSeconds) {
            if (officerId == null || officerId.trim().isEmpty()) return false;
            int interval = Math.max(2, Math.min(300, intervalSeconds));
            if (officerId.equals(preferences.getString("trackingOfficer", null))) return true;
            if (!hasFineLocation()) {
                if (locationPermissionDenied) return true;
                pendingOfficerId = officerId;
                pendingInterval = interval;
                runOnUiThread(() -> requestLocationPermission());
                return true;
            }
            runOnUiThread(() -> startLocationService(officerId, interval));
            return true;
        }

        @JavascriptInterface
        public void stopTracking() {
            if (preferences.getString("trackingOfficer", null) == null) return;
            preferences.edit().remove("trackingOfficer").apply();
            runOnUiThread(() -> {
                Intent intent = new Intent(context, LocationTrackingService.class);
                intent.setAction(LocationTrackingService.ACTION_STOP);
                try { startService(intent); } catch (RuntimeException ignored) { }
            });
        }
    }

    private static String readUtf8(InputStream stream) throws Exception {
        try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
