// Pure logic for "Connect my phone" (auto-mounting the Android phone-as-drive
// WebDAV share). No I/O here so it can be unit tested. C# 5 / .NET Framework 4.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal enum PhoneStatus
{
    Off,            // not set up / turned off
    Searching,      // set up, looking for the phone
    Connected,
    PhoneNotFound,
    CodeExpired     // 401: stopped retrying until the user enters a new code
}

internal enum PhoneStep
{
    Nothing,
    MarkNotFound,
    Verify,   // one authenticated request; never repeated after a 401
    Map
}

internal enum AuthResult
{
    Ok,
    BadCode,
    Unreachable
}

internal static class PhoneMountLogic
{
    public const int DefaultPort = 8780;
    public const string Label = "Drivebay Phone";
    public const string User = "drivebay";

    public static string StatusText(PhoneStatus s)
    {
        switch (s)
        {
            case PhoneStatus.Connected: return "Connected";
            case PhoneStatus.PhoneNotFound: return "Phone not found";
            case PhoneStatus.CodeExpired: return "Code expired, get a new code";
            case PhoneStatus.Searching: return "Looking for your phone...";
            default: return "Not connected";
        }
    }

    // Online Android peers from `tailscale status --json`, first IPv4 each.
    public static List<string> ParseAndroidPeers(string json)
    {
        List<string> result = new List<string>();
        if (string.IsNullOrEmpty(json)) return result;
        Dictionary<string, object> root;
        try
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 16 * 1024 * 1024;
            root = ser.Deserialize<Dictionary<string, object>>(json);
        }
        catch
        {
            return result;
        }
        if (root == null || !root.ContainsKey("Peer")) return result;
        IDictionary peers = root["Peer"] as IDictionary;
        if (peers == null) return result;
        foreach (object value in peers.Values)
        {
            IDictionary peer = value as IDictionary;
            if (peer == null) continue;
            string os = peer.Contains("OS") ? peer["OS"] as string : null;
            if (!string.Equals(os, "android", StringComparison.OrdinalIgnoreCase)) continue;
            object online = peer.Contains("Online") ? peer["Online"] : null;
            if (!(online is bool) || !(bool)online) continue;
            IEnumerable ips = peer.Contains("TailscaleIPs") ? peer["TailscaleIPs"] as IEnumerable : null;
            if (ips == null) continue;
            foreach (object ip in ips)
            {
                string s = ip as string;
                if (s != null && Regex.IsMatch(s, @"^\d{1,3}(\.\d{1,3}){3}$"))
                {
                    if (!result.Contains(s)) result.Add(s);
                    break;
                }
            }
        }
        return result;
    }

    // Accepts "100.1.2.3", "100.1.2.3:8780", "http://host:8780/". Hostnames too.
    public static bool TryParseAddress(string input, out string host, out int port)
    {
        host = null;
        port = DefaultPort;
        if (input == null) return false;
        string s = input.Trim();
        s = Regex.Replace(s, @"^https?://", "", RegexOptions.IgnoreCase);
        s = s.TrimEnd('/');
        Match m = Regex.Match(s, @"^([A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$");
        if (!m.Success) return false;
        if (m.Groups[2].Success)
        {
            int p;
            if (!int.TryParse(m.Groups[2].Value, out p) || p < 1 || p > 65535) return false;
            port = p;
        }
        host = m.Groups[1].Value;
        return true;
    }

    public static string UncPath(string host, int port)
    {
        return "\\\\" + host + "@" + port + "\\DavWWWRoot";
    }

    public static string BaseUrl(string host, int port)
    {
        return "http://" + host + ":" + port + "/";
    }

    // HKCU\...\Explorer\MountPoints2\<this>  value _LabelFromReg
    public static string MountPointsKey(string host, int port)
    {
        return "##" + host + "@" + port + "#DavWWWRoot";
    }

    // 6-digit code or a db_ token.
    public static bool LooksLikeSecret(string s)
    {
        if (s == null) return false;
        string t = s.Trim();
        if (Regex.IsMatch(t, @"^\d{6}$")) return true;
        return Regex.IsMatch(t, @"^db_[A-Za-z0-9_\-]{8,}$");
    }

    // Preferred letter if free (or already ours), else P..Z, then H..O.
    public static char PickLetter(ICollection<char> used, char preferred, char ours)
    {
        preferred = char.ToUpperInvariant(preferred);
        ours = char.ToUpperInvariant(ours);
        if (preferred >= 'A' && preferred <= 'Z' && (preferred == ours || !used.Contains(preferred))) return preferred;
        if (ours >= 'D' && ours <= 'Z') return ours;
        for (char c = 'P'; c <= 'Z'; c++) if (!used.Contains(c)) return c;
        for (char c = 'H'; c <= 'O'; c++) if (!used.Contains(c)) return c;
        return '\0';
    }

    // Seconds until the next background check. 30s while things are fine,
    // doubling up to 5 minutes while the phone is missing.
    public static int NextDelaySeconds(int misses)
    {
        if (misses <= 0) return 30;
        int d = 30;
        for (int i = 0; i < misses && d < 300; i++) d *= 2;
        return Math.Min(d, 300);
    }

    public static AuthResult Classify(int httpStatus)
    {
        if (httpStatus == 200 || httpStatus == 207) return AuthResult.Ok;
        if (httpStatus == 401 || httpStatus == 403) return AuthResult.BadCode;
        return AuthResult.Unreachable;
    }

    // What the background check should do next. `verified` is true once the
    // stored code was accepted since the phone last (re)appeared.
    public static PhoneStep Decide(PhoneStatus status, bool found, bool verified, bool mapped)
    {
        if (status == PhoneStatus.Off || status == PhoneStatus.CodeExpired) return PhoneStep.Nothing;
        if (!found) return PhoneStep.MarkNotFound;
        if (!verified) return PhoneStep.Verify;
        if (!mapped) return PhoneStep.Map;
        return PhoneStep.Nothing;
    }

    // Status after a verify attempt. A bad code stops everything.
    public static PhoneStatus AfterVerify(AuthResult r)
    {
        if (r == AuthResult.Ok) return PhoneStatus.Connected;
        if (r == AuthResult.BadCode) return PhoneStatus.CodeExpired;
        return PhoneStatus.PhoneNotFound;
    }
}
