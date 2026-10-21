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
    CodeExpired,    // 401: stopped retrying until the user enters a new code
    Reconnecting    // saved pairing, phone or PC came back, trying again
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
    public const int DiscoveryPort = 8781;
    public const string DiscoveryQuery = "DRIVEBAY?";
    public const string PeerHeader = "X-Drivebay-Phone";
    public const string ClientHeader = "X-Drivebay-Client";
    public const string GenericCredentialTarget = "Drivebay/PhoneShare";
    public const string Label = "Drivebay Phone";
    public const string User = "drivebay";

    public static string StatusText(PhoneStatus s)
    {
        switch (s)
        {
            case PhoneStatus.Connected: return "Connected";
            case PhoneStatus.Reconnecting: return "Reconnecting...";
            case PhoneStatus.PhoneNotFound: return "Phone not found";
            case PhoneStatus.CodeExpired: return "Code expired, get a new code";
            case PhoneStatus.Searching: return "Looking for your phone...";
            default: return "Not connected";
        }
    }

    // Saved pairing comes back as Reconnecting. A brand-new setup is Searching.
    public static PhoneStatus InitialStatus(bool enabled, bool expired, bool paired)
    {
        if (!enabled) return PhoneStatus.Off;
        if (expired) return PhoneStatus.CodeExpired;
        if (paired) return PhoneStatus.Reconnecting;
        return PhoneStatus.Searching;
    }

    public static PhoneStatus MissingStatus(string host, string peer, PhoneStatus current)
    {
        if (!string.IsNullOrEmpty(host) || !string.IsNullOrEmpty(peer) || current == PhoneStatus.Connected || current == PhoneStatus.Reconnecting)
            return PhoneStatus.Reconnecting;
        return PhoneStatus.PhoneNotFound;
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

    // WNetAddConnection2 result codes.
    public static AuthResult ClassifyMapError(int win32)
    {
        if (win32 == 0) return AuthResult.Ok;
        if (win32 == 1326 || win32 == 86 || win32 == 5 || win32 == 1244) return AuthResult.BadCode; // logon failure, bad password, denied, not authenticated
        return AuthResult.Unreachable;
    }

    // A dead WebClient session (1219 and friends). Drop it and try the map once more.
    // These are not a wrong token.
    public static bool ShouldResetSession(int win32)
    {
        return win32 == 1219 || win32 == 85 || win32 == 1202 || win32 == 64 || win32 == 59 || win32 == 2250 || win32 == 1203;
    }

    // manual, then last known host, then Tailscale peers, then LAN replies.
    // A stale manual address is first but is not the only candidate.
    public static List<string[]> OrderCandidates(bool hasManual, string manualHost, int manualPort, string savedHost, int savedPort, IList<string[]> lan, IList<string> tailscaleIps)
    {
        List<string[]> list = new List<string[]>();
        if (hasManual) AddCandidate(list, manualHost, manualPort);
        if (!string.IsNullOrEmpty(savedHost)) AddCandidate(list, savedHost, savedPort > 0 ? savedPort : DefaultPort);
        if (tailscaleIps != null)
        {
            foreach (string ip in tailscaleIps) AddCandidate(list, ip, DefaultPort);
        }
        if (lan != null)
        {
            foreach (string[] row in lan)
            {
                if (row == null || row.Length < 2) continue;
                int p;
                if (!int.TryParse(row[1], out p)) p = DefaultPort;
                AddCandidate(list, row[0], p);
            }
        }
        return list;
    }

    static void AddCandidate(List<string[]> list, string host, int port)
    {
        if (string.IsNullOrEmpty(host) || port < 1 || port > 65535) return;
        for (int i = 0; i < list.Count; i++)
        {
            if (string.Equals(list[i][0], host, StringComparison.OrdinalIgnoreCase) && list[i][1] == port.ToString()) return;
        }
        list.Add(new string[] { host, port.ToString() });
    }

    // Reply to DRIVEBAY? : "DRIVEBAY1 <peerId> <port>".
    public static bool TryParseDiscovery(string message, out string peer, out int port)
    {
        peer = null;
        port = 0;
        if (string.IsNullOrEmpty(message)) return false;
        string[] parts = message.Trim().Split(new char[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 3 || parts[0] != "DRIVEBAY1") return false;
        if (!Regex.IsMatch(parts[1], "^[0-9a-f]{8,32}$")) return false;
        int p;
        if (!int.TryParse(parts[2], out p) || p < 1 || p > 65535) return false;
        peer = parts[1];
        port = p;
        return true;
    }

    // One credential per paired PC. An older install keeps Drivebay/PhoneShare.
    public static string CredentialTarget(string peer)
    {
        if (string.IsNullOrEmpty(peer)) return GenericCredentialTarget;
        string p = peer.Trim().ToLowerInvariant();
        if (!Regex.IsMatch(p, "^[0-9a-f]{8,32}$")) return GenericCredentialTarget;
        return GenericCredentialTarget + "/" + p;
    }

    // OPTIONS may list every paired PC. Empty expected matches any answer.
    public static bool PeerHeaderMatches(string header, string expected)
    {
        if (string.IsNullOrEmpty(expected)) return true;
        if (string.IsNullOrEmpty(header)) return false;
        string[] parts = header.Split(new char[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string part in parts)
        {
            if (string.Equals(part.Trim(), expected, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    // The peer id this PC should store. Prefer [expected] when the header lists it.
    // Otherwise the first id, so a comma-separated list is not saved as the peer.
    public static string MatchingPeer(string header, string expected)
    {
        if (string.IsNullOrEmpty(header)) return "";
        string[] parts = header.Split(new char[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries);
        string first = "";
        foreach (string raw in parts)
        {
            string part = raw.Trim().ToLowerInvariant();
            if (!Regex.IsMatch(part, "^[0-9a-f]{8,32}$")) continue;
            if (first.Length == 0) first = part;
            if (!string.IsNullOrEmpty(expected) && string.Equals(part, expected, StringComparison.OrdinalIgnoreCase)) return part;
        }
        if (!string.IsNullOrEmpty(expected)) return "";
        return first;
    }

    // Index of the phone that answered, or -1. With a saved peer id, ignore a
    // different phone. A saved host that answers without the header (older app)
    // is still accepted. A header that lists several peers matches this PC's id.
    public static int PickCandidate(IList<string> hosts, IList<bool> answered, IList<string> peerIds, string expectedPeer, string savedHost)
    {
        if (hosts == null || answered == null || peerIds == null) return -1;
        int n = hosts.Count;
        if (answered.Count < n) n = answered.Count;
        if (peerIds.Count < n) n = peerIds.Count;
        int fallback = -1;
        for (int i = 0; i < n; i++)
        {
            if (!answered[i]) continue;
            string id = peerIds[i] ?? "";
            if (string.IsNullOrEmpty(expectedPeer)) return i;
            if (PeerHeaderMatches(id, expectedPeer)) return i;
            if (id.Length == 0 && !string.IsNullOrEmpty(savedHost) && string.Equals(hosts[i], savedHost, StringComparison.OrdinalIgnoreCase) && fallback < 0)
                fallback = i;
        }
        return fallback;
    }

    // 85 = ERROR_ALREADY_ASSIGNED, 1202 = ERROR_DEVICE_ALREADY_REMEMBERED
    public static bool IsLetterBusy(int win32)
    {
        return win32 == 85 || win32 == 1202;
    }

    // Log-safe one-liner: never includes a secret, strips anything code-like.
    public static string Scrub(string line)
    {
        if (line == null) return "";
        string s = Regex.Replace(line, @"db_[A-Za-z0-9_\-]+", "db_***");
        s = Regex.Replace(s, @"(?<![\d.])\d{6}(?![\d.])", "******");
        return s.Replace("\r", " ").Replace("\n", " ");
    }

    // Status after a verify attempt. A bad code stops everything.
    public static PhoneStatus AfterVerify(AuthResult r)
    {
        if (r == AuthResult.Ok) return PhoneStatus.Connected;
        if (r == AuthResult.BadCode) return PhoneStatus.CodeExpired;
        return PhoneStatus.PhoneNotFound;
    }
}
