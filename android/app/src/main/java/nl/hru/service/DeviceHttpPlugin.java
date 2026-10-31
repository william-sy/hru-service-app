package nl.hru.service;

import android.content.Context;
import android.net.ConnectivityManager;
import android.content.Intent;
import android.net.Network;
import android.net.Uri;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.net.NetworkCapabilities;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native HTTP for the service app.
 *
 * - network "wifi": goes out over the Wi-Fi network even when Android considers it
 *   offline (the unit's access point has no internet), so mobile data is not used.
 * - network "default": normal routing, for downloading firmware from GitHub.
 * - No CORS: requests are made natively, not by the WebView.
 */
@CapacitorPlugin(name = "DeviceHttp")
public class DeviceHttpPlugin extends Plugin {
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private Network joined;                       // network from joinWifi(), preferred over any other Wi-Fi
    private ConnectivityManager.NetworkCallback joinCb;

    private Network wifiNetwork() {
        if (joined != null) return joined;
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return n;
        }
        return null;
    }

    /** A network that really has internet (mobile data, or other Wi-Fi), never the unit's offline AP. */
    private Network internetNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return n;
        }
        return null;
    }

    private File fwDir() {
        File d = new File(getContext().getFilesDir(), "firmware");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private File fwFile(String name) {
        // flat names only, no path traversal
        return new File(fwDir(), new File(name).getName());
    }

    /** joinWifi({ssid, password}) - Android 10+. Connects to the unit for this app only (no Settings trip). */
    @PluginMethod
    public void joinWifi(PluginCall call) {
        if (Build.VERSION.SDK_INT < 29) { call.reject("Needs Android 10 or newer. Join the Wi-Fi in Android settings instead."); return; }
        String ssid = call.getString("ssid");
        String pw = call.getString("password", "");
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (joinCb != null) { try { cm.unregisterNetworkCallback(joinCb); } catch (Exception ignored) {} joinCb = null; joined = null; }

        WifiNetworkSpecifier.Builder sb = new WifiNetworkSpecifier.Builder().setSsid(ssid);
        if (!pw.isEmpty()) sb.setWpa2Passphrase(pw);
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(sb.build()).build();

        final boolean[] done = {false};
        joinCb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) {
                joined = n;
                if (!done[0]) { done[0] = true; call.resolve(); }
            }
            @Override public void onUnavailable() {
                if (!done[0]) { done[0] = true; call.reject("Could not join " + ssid + " (declined, out of range, or wrong password)"); }
            }
            @Override public void onLost(Network n) { if (joined == n) joined = null; }
        };
        cm.requestNetwork(req, joinCb, 45000);
    }

    /** True when the phone is joined to some Wi-Fi network. */
    @PluginMethod
    public void wifiConnected(PluginCall call) {
        JSObject r = new JSObject();
        r.put("connected", wifiNetwork() != null);
        call.resolve(r);
    }

    /**
     * request({url, method, headers?, body?, file?:{name,offset,size}, timeoutMs?, network?})
     * -> {status, body}. Non-2xx statuses resolve normally; only transport failures reject.
     */
    @PluginMethod
    public void request(PluginCall call) {
        pool.execute(() -> {
            try {
                String url = call.getString("url");
                String method = call.getString("method", "GET");
                int timeout = call.getInt("timeoutMs", 10000);
                String which = call.getString("network", "default");

                Network net = null;
                if ("wifi".equals(which)) {
                    net = wifiNetwork();
                    if (net == null) { call.reject("NO_WIFI", "Not connected to any Wi-Fi network"); return; }
                } else if ("internet".equals(which)) {
                    net = internetNetwork();
                    if (net == null) { call.reject("NO_INTERNET", "No network with internet (turn on mobile data)"); return; }
                }
                URL u = new URL(url);
                HttpURLConnection c = (HttpURLConnection) (net != null ? net.openConnection(u) : u.openConnection());
                c.setRequestMethod(method);
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setUseCaches(false);

                JSObject headers = call.getObject("headers");
                if (headers != null) {
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, headers.getString(k)); }
                }

                byte[] body = null;
                JSObject file = call.getObject("file");
                if (file != null) {
                    int size = file.getInteger("size");
                    body = new byte[size];
                    try (RandomAccessFile raf = new RandomAccessFile(fwFile(file.getString("name")), "r")) {
                        raf.seek(file.getLong("offset"));
                        raf.readFully(body);
                    }
                } else if (call.getString("body") != null) {
                    body = call.getString("body").getBytes("UTF-8");
                } else if ("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) {
                    body = new byte[0];
                }
                if (body != null) {
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(body.length);
                    try (OutputStream os = c.getOutputStream()) { os.write(body); }
                }

                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = in == null ? "" : new String(readAll(in), "UTF-8");
                c.disconnect();

                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", text);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "NO_RESPONSE");
            }
        });
    }

    /** download({url, name, sha256?}) over the normal network; verifies the hash if given. */
    @PluginMethod
    public void download(PluginCall call) {
        pool.execute(() -> {
            File tmp = null;
            try {
                String name = call.getString("name");
                String want = call.getString("sha256");
                URL du = new URL(call.getString("url"));
                Network inet = internetNetwork();
                if (inet == null) { call.reject("No network with internet (turn on mobile data)"); return; }
                HttpURLConnection c = (HttpURLConnection) inet.openConnection(du);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                if (c.getResponseCode() != 200) { call.reject("HTTP " + c.getResponseCode()); return; }

                tmp = new File(fwDir(), name + ".part");
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long total = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); md.update(buf, 0, n); total += n; }
                }
                String got = hex(md.digest());
                if (want != null && !want.isEmpty() && !want.equalsIgnoreCase(got)) {
                    tmp.delete();
                    call.reject("Checksum mismatch: expected " + want + ", got " + got);
                    return;
                }
                File dest = fwFile(name);
                if (dest.exists()) dest.delete();
                if (!tmp.renameTo(dest)) { call.reject("Could not store " + name); return; }
                JSObject r = new JSObject();
                r.put("size", total);
                r.put("sha256", got);
                call.resolve(r);
            } catch (Exception e) {
                if (tmp != null) tmp.delete();
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        });
    }

    /** shareFile({name, text}) - opens the Android share sheet so the user can save/send a backup file. */
    @PluginMethod
    public void shareFile(PluginCall call) {
        try {
            String name = new File(call.getString("name", "backup.json")).getName();
            File dir = new File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(call.getString("text", "").getBytes("UTF-8")); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/json");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Save settings backup");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    /** listFiles() -> {files:[{name,size}]} of the cached firmware. */
    @PluginMethod
    public void listFiles(PluginCall call) {
        JSArray arr = new JSArray();
        File[] fs = fwDir().listFiles();
        if (fs != null) for (File f : fs) {
            if (f.getName().endsWith(".part")) continue;
            JSObject o = new JSObject();
            o.put("name", f.getName());
            o.put("size", f.length());
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("files", arr);
        call.resolve(r);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
