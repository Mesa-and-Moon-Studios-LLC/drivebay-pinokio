// "Connect my phone": maps the Android Drivebay phone-as-drive WebDAV share as a
// drive letter and keeps it there. The code/token lives ONLY in Windows
// Credential Manager; it is never written to files, logs, or command lines.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class PhoneCredentials
{
    const string GenericTarget = "Drivebay/PhoneShare"; // PhoneMountLogic.GenericCredentialTarget
    const int CRED_TYPE_GENERIC = 1;
    const int CRED_TYPE_DOMAIN_PASSWORD = 2;
    const int CRED_PERSIST_LOCAL_MACHINE = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref CREDENTIAL credential, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDelete(string target, int type, int flags);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    static bool Write(int type, string target, string user, string secret)
    {
        byte[] blob = Encoding.Unicode.GetBytes(secret);
        IntPtr mem = Marshal.AllocHGlobal(blob.Length);
        try
        {
            Marshal.Copy(blob, 0, mem, blob.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Type = type;
            c.TargetName = target;
            c.UserName = user;
            c.Comment = "Drivebay phone drive";
            c.CredentialBlob = mem;
            c.CredentialBlobSize = blob.Length;
            c.Persist = CRED_PERSIST_LOCAL_MACHINE;
            return CredWrite(ref c, 0);
        }
        finally
        {
            for (int i = 0; i < blob.Length; i++) { blob[i] = 0; Marshal.WriteByte(mem, i, 0); }
            Marshal.FreeHGlobal(mem);
        }
    }

    // Our own copy (readable by us) plus the Windows credential the WebDAV
    // redirector uses for the phone's host.
    public static bool Save(string host, string secret)
    {
        return Write(CRED_TYPE_GENERIC, GenericTarget, PhoneMountLogic.User, secret);
    }

    public static bool SaveOwnCopy(string secret)
    {
        return Write(CRED_TYPE_GENERIC, GenericTarget, PhoneMountLogic.User, secret);
    }

    // Early test builds also wrote a Domain credential for the host. Remove it only
    // when it is ours (user "drivebay"); never touch other credentials.
    static void DeleteOldDomainCredential(string host)
    {
        IntPtr p;
        if (!CredRead(host, CRED_TYPE_DOMAIN_PASSWORD, 0, out p)) return;
        string user;
        try
        {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            user = c.UserName;
        }
        finally
        {
            CredFree(p);
        }
        if (string.Equals(user, PhoneMountLogic.User, StringComparison.OrdinalIgnoreCase)) CredDelete(host, CRED_TYPE_DOMAIN_PASSWORD, 0);
    }

    public static string Read()
    {
        int ignored;
        return Read(out ignored);
    }

    // error is the Win32 code from CredRead. 1168 means the token is really gone.
    public static string Read(out int error)
    {
        return ReadTarget(GenericTarget, out error);
    }

    // This PC's token, then the single credential from before per-PC pairing.
    public static string Read(string peer, out int error)
    {
        string target = PhoneMountLogic.CredentialTarget(peer);
        if (target != GenericTarget)
        {
            string own = ReadTarget(target, out error);
            if (own != null) return own;
        }
        return ReadTarget(GenericTarget, out error);
    }

    // Copies the legacy credential onto this PC's target so reconnect keeps working after an upgrade.
    public static bool BindToPeer(string peer)
    {
        string target = PhoneMountLogic.CredentialTarget(peer);
        if (target == GenericTarget) return false;
        int error;
        string secret = Read(out error);
        if (secret == null) return false;
        return Write(CRED_TYPE_GENERIC, target, PhoneMountLogic.User, secret);
    }

    public static void DeletePeer(string peer)
    {
        string target = PhoneMountLogic.CredentialTarget(peer);
        if (target != GenericTarget) CredDelete(target, CRED_TYPE_GENERIC, 0);
    }

    static string ReadTarget(string target, out int error)
    {
        error = 0;
        IntPtr p;
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out p))
        {
            error = Marshal.GetLastWin32Error();
            return null;
        }
        try
        {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlobSize <= 0) return null;
            return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
        }
        finally
        {
            CredFree(p);
        }
    }

    public static void Delete(string host)
    {
        Delete(host, "");
    }

    public static void Delete(string host, string peer)
    {
        CredDelete(GenericTarget, CRED_TYPE_GENERIC, 0);
        DeletePeer(peer);
        if (!string.IsNullOrEmpty(host)) DeleteOldDomainCredential(host);
    }
}

// Non-secret settings: %LOCALAPPDATA%\Drivebay\phone-mount.txt
internal sealed class PhoneSettings
{
    public bool Enabled;
    public bool Expired;
    public string Host = "";
    public int Port = PhoneMountLogic.DefaultPort;
    public string ManualAddress = ""; // Advanced; blank = find automatically
    public char Letter = '\0';        // the letter we mapped
    public char PreferredLetter = 'P';
    public string PeerId = "";        // X-Drivebay-Phone, not the token

    static string FilePath()
    {
        return Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Drivebay"), "phone-mount.txt");
    }

    public static PhoneSettings Load()
    {
        PhoneSettings s = new PhoneSettings();
        try
        {
            if (!File.Exists(FilePath())) return s;
            foreach (string line in File.ReadAllLines(FilePath()))
            {
                int eq = line.IndexOf('=');
                if (eq < 1) continue;
                string k = line.Substring(0, eq).Trim();
                string v = line.Substring(eq + 1).Trim();
                if (k == "enabled") s.Enabled = v == "1";
                else if (k == "expired") s.Expired = v == "1";
                else if (k == "host") s.Host = v;
                else if (k == "port") int.TryParse(v, out s.Port);
                else if (k == "manual") s.ManualAddress = v;
                else if (k == "letter" && v.Length == 1) s.Letter = char.ToUpperInvariant(v[0]);
                else if (k == "preferred" && v.Length == 1) s.PreferredLetter = char.ToUpperInvariant(v[0]);
                else if (k == "peer" && v.Length >= 8 && v.Length <= 32) s.PeerId = v.ToLowerInvariant();
            }
        }
        catch
        {
        }
        if (s.Port <= 0) s.Port = PhoneMountLogic.DefaultPort;
        return s;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath()));
            File.WriteAllLines(FilePath(), new string[] {
                "enabled=" + (Enabled ? "1" : "0"),
                "expired=" + (Expired ? "1" : "0"),
                "host=" + Host,
                "port=" + Port,
                "manual=" + ManualAddress,
                "letter=" + (Letter == '\0' ? "" : Letter.ToString()),
                "preferred=" + PreferredLetter,
                "peer=" + (PeerId ?? "")
            });
        }
        catch
        {
        }
    }
}

internal static class PhoneMount
{
    public static PhoneSettings Settings;
    public static PhoneStatus Status = PhoneStatus.Off;
    public static event Action StatusChanged;
    public static Action<string> TrayLog = delegate { };

    // Own log file (shared open so the server holding drivebay.log can't block
    // it) plus the tray log. Lines are scrubbed; secrets are never passed in.
    public static void Log(string message)
    {
        string line = DateTime.Now.ToString("s") + " [phone] " + PhoneMountLogic.Scrub(message) + Environment.NewLine;
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Drivebay");
            Directory.CreateDirectory(dir);
            using (FileStream fs = new FileStream(Path.Combine(dir, "phone-mount.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
            {
                byte[] b = Encoding.UTF8.GetBytes(line);
                fs.Write(b, 0, b.Length);
            }
        }
        catch
        {
        }
        try { TrayLog("[phone] " + PhoneMountLogic.Scrub(message)); } catch { }
    }
    public static Action<string, string> Notify = delegate { };
    public static Control UiThread;

    static bool verified;
    static int misses;
    static string seenPeer = "";
    static DateTime nextCheck = DateTime.MinValue;
    static int busy;

    public static void Init()
    {
        Settings = PhoneSettings.Load();
        bool paired = !string.IsNullOrEmpty(Settings.Host) || !string.IsNullOrEmpty(Settings.PeerId);
        Status = PhoneMountLogic.InitialStatus(Settings.Enabled, Settings.Expired, paired);
        if (Settings.Enabled && !Settings.Expired)
            Log("saved phone " + Settings.Host + ":" + Settings.Port + " peer=" + (string.IsNullOrEmpty(Settings.PeerId) ? "none" : Settings.PeerId));
    }

    static void RememberPeer()
    {
        string peer = PhoneMountLogic.MatchingPeer(seenPeer, Settings.PeerId);
        if (string.IsNullOrEmpty(peer)) peer = PhoneMountLogic.MatchingPeer(seenPeer, "");
        if (string.IsNullOrEmpty(peer)) return;
        if (!string.IsNullOrEmpty(Settings.PeerId) && !string.Equals(Settings.PeerId, peer, StringComparison.OrdinalIgnoreCase))
            PhoneCredentials.DeletePeer(Settings.PeerId);
        bool changed = !string.Equals(Settings.PeerId, peer, StringComparison.OrdinalIgnoreCase);
        Settings.PeerId = peer;
        PhoneCredentials.BindToPeer(peer);
        if (!changed) return;
        Settings.Save();
        Log("saved peer " + peer);
    }

    static void SetStatus(PhoneStatus s)
    {
        Status = s;
        Action h = StatusChanged;
        if (h == null) return;
        try
        {
            if (UiThread != null && UiThread.InvokeRequired) UiThread.BeginInvoke((MethodInvoker)delegate { h(); });
            else h();
        }
        catch
        {
        }
    }

    // Called by the tray's 2s timer.
    public static void Tick()
    {
        if (Settings == null || !Settings.Enabled || Settings.Expired) return;
        if (DateTime.UtcNow < nextCheck) return;
        if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try { Check(); }
            catch (Exception ex) { Log("phone check error: " + ex.GetType().Name); }
            finally
            {
                nextCheck = DateTime.UtcNow.AddSeconds(PhoneMountLogic.NextDelaySeconds(misses));
                busy = 0;
            }
        });
    }

    static void Check()
    {
        string host; int port;
        bool found = FindPhone(out host, out port, true);
        if (found && (host != Settings.Host || port != Settings.Port))
        {
            // Phone moved to a new address: remap there, re-verify once.
            if (Settings.Letter != '\0') Unmap(Settings.Letter, Settings.Host, Settings.Port);
            Settings.Host = host; Settings.Port = port; Settings.Letter = '\0';
            Settings.Save();
            verified = false;
        }
        bool mapped = Settings.Letter != '\0' && IsMapped(Settings.Letter, Settings.Host, Settings.Port);
        PhoneStep step = PhoneMountLogic.Decide(Status, found, verified, mapped);
        if (step != PhoneStep.Nothing || Status != PhoneStatus.Connected)
            Log("check: found=" + found + " host=" + Settings.Host + ":" + Settings.Port + " mapped=" + mapped + " verified=" + verified + " step=" + step);
        if (step == PhoneStep.MarkNotFound)
        {
            misses++;
            verified = false; // re-check the code once when it comes back
            SetStatus(PhoneMountLogic.MissingStatus(Settings.Host, Settings.PeerId, Status));
            return;
        }
        misses = 0;
        if (step == PhoneStep.Verify)
        {
            int credErr;
            string secret = PhoneCredentials.Read(Settings.PeerId, out credErr);
            if (secret == null)
            {
                if (credErr == 1168) { MarkExpired(); return; }
                Log("check: credential unreadable (" + credErr + "), retrying");
                misses++;
                SetStatus(PhoneStatus.Reconnecting);
                return;
            }
            AuthResult r = VerifyOnce(Settings.Host, Settings.Port, secret);
            secret = null;
            Log("check: verify -> " + r);
            PhoneStatus after = PhoneMountLogic.AfterVerify(r);
            if (after == PhoneStatus.CodeExpired) { MarkExpired(); return; }
            if (after != PhoneStatus.Connected) { misses++; SetStatus(PhoneStatus.Reconnecting); return; }
            verified = true;
            RememberPeer();
            step = PhoneStep.Map; // (re)connect the session with the verified code
        }
        if (step == PhoneStep.Map)
        {
            AuthResult m = MapNow();
            if (m == AuthResult.BadCode) { MarkExpired(); return; }
            if (m != AuthResult.Ok) { misses++; verified = false; SetStatus(PhoneStatus.Reconnecting); return; }
        }
        SetStatus(PhoneStatus.Connected);
    }

    static void MarkExpired()
    {
        Log("phone code was refused; stopped retrying");
        // Remove the mapping and saved password so Windows cannot keep
        // retrying a bad code and lock it on the phone.
        if (Settings.Letter != '\0') Unmap(Settings.Letter, Settings.Host, Settings.Port);
        PhoneCredentials.Delete(Settings.Host, Settings.PeerId);
        Settings.Expired = true;
        Settings.Letter = '\0';
        Settings.PeerId = "";
        Settings.Save();
        verified = false;
        SetStatus(PhoneStatus.CodeExpired);
        Notify("Drivebay Phone", "Code expired, get a new code. Open Drivebay on your phone, tap Pair a PC, then use Connect my phone.");
    }

    // Maps with WNetAddConnection2W: user + code passed in memory only.
    static AuthResult MapNow()
    {
        int credErr;
        string secret = PhoneCredentials.Read(Settings.PeerId, out credErr);
        if (secret == null)
        {
            Log("map: no saved code in Credential Manager (" + credErr + ")");
            return credErr == 1168 ? AuthResult.BadCode : AuthResult.Unreachable;
        }
        string unc = PhoneMountLogic.UncPath(Settings.Host, Settings.Port);
        char current = Settings.Letter;
        // A phone or PC restart leaves a dead WebClient session. Drop the letter
        // and the UNC before mapping again, or Windows returns 1219 / 85 and
        // the drive never comes back.
        DropSession(current, Settings.Host, Settings.Port);
        char letter = PhoneMountLogic.PickLetter(UsedLetters(current), Settings.PreferredLetter, current);
        if (letter == '\0') { Log("map: no free drive letter"); return AuthResult.Unreachable; }
        SetLabel(Settings.Host, Settings.Port);
        NETRESOURCE nr = new NETRESOURCE();
        nr.dwType = RESOURCETYPE_DISK;
        nr.lpLocalName = letter + ":";
        nr.lpRemoteName = unc;
        int rc = WNetAddConnection2W(ref nr, secret, PhoneMountLogic.User, CONNECT_UPDATE_PROFILE);
        if (PhoneMountLogic.ShouldResetSession(rc))
        {
            DropSession(letter, Settings.Host, Settings.Port);
            rc = WNetAddConnection2W(ref nr, secret, PhoneMountLogic.User, CONNECT_UPDATE_PROFILE);
        }
        secret = null;
        Log("map: WNetAddConnection2 " + letter + ": -> " + unc + " result " + rc + (rc == 0 ? "" : " (" + new Win32Exception(rc).Message + ")"));
        AuthResult r = PhoneMountLogic.ClassifyMapError(rc);
        if (r != AuthResult.Ok) return r;
        Settings.Letter = letter;
        Settings.Save();
        RefreshExplorer(letter);
        return AuthResult.Ok;
    }

    const int RESOURCETYPE_DISK = 1;
    const int CONNECT_UPDATE_PROFILE = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct NETRESOURCE
    {
        public int dwScope;
        public int dwType;
        public int dwDisplayType;
        public int dwUsage;
        public string lpLocalName;
        public string lpRemoteName;
        public string lpComment;
        public string lpProvider;
    }

    [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
    static extern int WNetAddConnection2W(ref NETRESOURCE netResource, string password, string username, int flags);
    [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
    static extern int WNetCancelConnection2W(string name, int flags, bool force);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern void SHChangeNotify(int eventId, int flags, string item1, IntPtr item2);

    static void RefreshExplorer(char letter)
    {
        try
        {
            const int SHCNE_DRIVEADD = 0x100, SHCNE_UPDATEITEM = 0x2000, SHCNF_PATHW = 0x5, SHCNF_FLUSH = 0x1000;
            SHChangeNotify(SHCNE_DRIVEADD, SHCNF_PATHW | SHCNF_FLUSH, letter + ":\\", IntPtr.Zero);
            SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH, letter + ":\\", IntPtr.Zero);
        }
        catch
        {
        }
    }

    // ----- user actions (call off the UI thread) -----

    // One attempt with the typed code. Returns the status to show.
    public static PhoneStatus Connect(string secret, string manualAddress, char preferred)
    {
        secret = secret.Trim();
        Log("connect: started (manual address " + ((manualAddress ?? "").Trim().Length > 0 ? "set" : "auto") + ", preferred " + preferred + ")");
        Settings.ManualAddress = (manualAddress ?? "").Trim();
        Settings.PreferredLetter = preferred == '\0' ? 'P' : preferred;
        string host; int port;
        if (!FindPhone(out host, out port, false))
        {
            Log("connect: phone not found; code saved for later");
            // Save the code so it connects as soon as the phone shows up.
            // A new token replaces the old phone identity, or the next reply
            // from this phone would be ignored.
            Settings.Host = host ?? Settings.Host;
            Settings.PeerId = "";
            PhoneCredentials.SaveOwnCopy(secret);
            Settings.Enabled = true; Settings.Expired = false; verified = false; misses = 1;
            Settings.Save();
            SetStatus(PhoneStatus.PhoneNotFound);
            return PhoneStatus.PhoneNotFound;
        }
        AuthResult r = VerifyOnce(host, port, secret);
        Log("connect: verify " + host + ":" + port + " -> " + r);
        if (r == AuthResult.BadCode)
        {
            SetStatus(PhoneStatus.CodeExpired);
            return PhoneStatus.CodeExpired;
        }
        if (r != AuthResult.Ok) { SetStatus(PhoneStatus.PhoneNotFound); return PhoneStatus.PhoneNotFound; }
        if (Settings.Letter != '\0' && (host != Settings.Host || port != Settings.Port)) Unmap(Settings.Letter, Settings.Host, Settings.Port);
        Settings.Host = host; Settings.Port = port;
        if (!PhoneCredentials.Save(host, secret)) Log("connect: could not save the token in Credential Manager");
        Settings.Enabled = true; Settings.Expired = false;
        verified = true; misses = 0;
        RememberPeer();
        if (Settings.Letter != '\0' && !IsMapped(Settings.Letter, host, port)) Settings.Letter = '\0';
        Settings.Save();
        AuthResult m = MapNow();
        if (m == AuthResult.BadCode) { MarkExpired(); return PhoneStatus.CodeExpired; }
        if (m != AuthResult.Ok) { verified = false; misses = 1; SetStatus(PhoneStatus.Reconnecting); return PhoneStatus.Reconnecting; }
        SetStatus(PhoneStatus.Connected);
        return PhoneStatus.Connected;
    }

    // Unmount + turn off + forget the code.
    public static void Disconnect()
    {
        if (Settings.Letter != '\0') Unmap(Settings.Letter, Settings.Host, Settings.Port);
        PhoneCredentials.Delete(Settings.Host, Settings.PeerId);
        Settings.Enabled = false; Settings.Expired = false; Settings.Letter = '\0';
        Settings.PeerId = "";
        Settings.Host = "";
        Settings.Save();
        verified = false;
        SetStatus(PhoneStatus.Off);
    }

    // ----- discovery -----

    static bool FindPhone(out string host, out int port, bool matchPeer)
    {
        host = null;
        port = PhoneMountLogic.DefaultPort;
        seenPeer = "";
        string mh = null;
        int mp = PhoneMountLogic.DefaultPort;
        bool hasManual = false;
        if (!string.IsNullOrEmpty(Settings.ManualAddress))
            hasManual = PhoneMountLogic.TryParseAddress(Settings.ManualAddress, out mh, out mp);
        List<string[]> lan = ProbeLan();
        if (matchPeer && !string.IsNullOrEmpty(Settings.PeerId))
        {
            List<string[]> mine = new List<string[]>();
            foreach (string[] row in lan)
            {
                if (row.Length >= 3 && string.Equals(row[2], Settings.PeerId, StringComparison.OrdinalIgnoreCase)) mine.Add(row);
            }
            lan = mine;
        }
        string ts = TailscaleStatusJson();
        List<string> peers = PhoneMountLogic.ParseAndroidPeers(ts);
        Log("discover: tailscale " + (ts == null ? "not available" : "ok") + ", online Android peers " + peers.Count + ", lan replies " + lan.Count);
        List<string[]> candidates = PhoneMountLogic.OrderCandidates(hasManual, mh, mp, Settings.Host, Settings.Port, lan, peers);
        List<string> hosts = new List<string>();
        List<bool> answered = new List<bool>();
        List<string> ids = new List<string>();
        foreach (string[] c in candidates)
        {
            int p = int.Parse(c[1]);
            string id;
            int st = OptionsStatus(c[0], p, out id);
            Log("discover: OPTIONS " + c[0] + ":" + p + " -> " + (st < 0 ? "no answer" : st.ToString()));
            hosts.Add(c[0]);
            answered.Add(st == 200);
            ids.Add(id ?? "");
        }
        string expected = matchPeer ? Settings.PeerId : "";
        int pick = PhoneMountLogic.PickCandidate(hosts, answered, ids, expected, Settings.Host);
        if (pick < 0)
        {
            Log("discover: " + candidates.Count + " candidate(s), none matched");
            if (candidates.Count > 0) { host = candidates[0][0]; port = int.Parse(candidates[0][1]); }
            return false;
        }
        host = hosts[pick];
        port = int.Parse(candidates[pick][1]);
        seenPeer = ids[pick] ?? "";
        Log("discover: using " + host + ":" + port + (seenPeer.Length == 0 ? "" : " peer " + seenPeer));
        return true;
    }

    static List<string[]> ProbeLan()
    {
        List<string[]> found = new List<string[]>();
        Socket socket = null;
        try
        {
            socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.EnableBroadcast = true;
            socket.ReceiveTimeout = 400;
            socket.SendTimeout = 400;
            byte[] query = Encoding.ASCII.GetBytes(PhoneMountLogic.DiscoveryQuery);
            socket.SendTo(query, new IPEndPoint(IPAddress.Broadcast, PhoneMountLogic.DiscoveryPort));
            DateTime until = DateTime.UtcNow.AddMilliseconds(450);
            while (DateTime.UtcNow < until)
            {
                byte[] buf = new byte[256];
                EndPoint remote = new IPEndPoint(IPAddress.Any, 0);
                int n;
                try { n = socket.ReceiveFrom(buf, ref remote); }
                catch { break; }
                if (n <= 0) break;
                string peer;
                int dport;
                if (!PhoneMountLogic.TryParseDiscovery(Encoding.ASCII.GetString(buf, 0, n), out peer, out dport)) continue;
                IPEndPoint ep = remote as IPEndPoint;
                if (ep == null) continue;
                found.Add(new string[] { ep.Address.ToString(), dport.ToString(), peer });
            }
        }
        catch (Exception ex)
        {
            Log("discover: lan probe " + ex.GetType().Name);
        }
        finally
        {
            if (socket != null) socket.Close();
        }
        return found;
    }

    static void DropSession(char letter, string host, int port)
    {
        if (letter != '\0')
        {
            int c = WNetCancelConnection2W(letter + ":", 0, true);
            if (c != 0 && c != 2250) Log("map: drop " + letter + ": result " + c);
        }
        if (string.IsNullOrEmpty(host)) return;
        int unc = WNetCancelConnection2W(PhoneMountLogic.UncPath(host, port), 0, true);
        WNetCancelConnection2W(PhoneMountLogic.BaseUrl(host, port), 0, true);
        if (unc != 0 && unc != 2250 && unc != 67) Log("map: drop unc result " + unc);
    }

    static string TailscaleStatusJson()
    {
        string[] paths = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale\\tailscale.exe"),
            "tailscale.exe"
        };
        foreach (string exe in paths)
        {
            try
            {
                if (exe.Contains("\\") && !File.Exists(exe)) continue;
                ProcessStartInfo psi = new ProcessStartInfo(exe, "status --json");
                psi.UseShellExecute = false; psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    return output;
                }
            }
            catch
            {
            }
        }
        return null;
    }

    // Unauthenticated OPTIONS: no code is sent, so it can't count as a try.
    static int OptionsStatus(string host, int port, out string peer)
    {
        peer = "";
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PhoneMountLogic.BaseUrl(host, port));
            req.Method = "OPTIONS"; req.Timeout = 3000; req.Proxy = null; req.AllowAutoRedirect = false;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                int code = (int)res.StatusCode;
                if (code == 200 && res.Headers["DAV"] == null) return 299; // answered, but not WebDAV
                string id = res.Headers[PhoneMountLogic.PeerHeader];
                if (!string.IsNullOrEmpty(id)) peer = id.Trim().ToLowerInvariant();
                return code;
            }
        }
        catch (WebException ex)
        {
            HttpWebResponse r = ex.Response as HttpWebResponse;
            if (r == null) return -1;
            int code = (int)r.StatusCode;
            r.Close();
            return code;
        }
        catch
        {
            return -1;
        }
    }

    // Exactly ONE authenticated request (pre-set header, no challenge retry).
    static AuthResult VerifyOnce(string host, int port, string secret)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PhoneMountLogic.BaseUrl(host, port));
            req.Method = "PROPFIND"; req.Timeout = 8000; req.Proxy = null; req.AllowAutoRedirect = false;
            req.Headers["Depth"] = "0";
            req.Headers["Authorization"] = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(PhoneMountLogic.User + ":" + secret));
            req.ContentLength = 0;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                string client = res.Headers[PhoneMountLogic.ClientHeader];
                string matched = PhoneMountLogic.MatchingPeer(client, "");
                if (matched.Length > 0) seenPeer = matched;
                return PhoneMountLogic.Classify((int)res.StatusCode);
            }
        }
        catch (WebException ex)
        {
            HttpWebResponse r = ex.Response as HttpWebResponse;
            if (r == null) return AuthResult.Unreachable;
            int code = (int)r.StatusCode;
            r.Close();
            return PhoneMountLogic.Classify(code);
        }
        catch
        {
            return AuthResult.Unreachable;
        }
    }

    // ----- drive mapping -----

    static ICollection<char> UsedLetters(char ours)
    {
        HashSet<char> used = new HashSet<char>();
        foreach (string d in Environment.GetLogicalDrives()) if (d.Length > 0) used.Add(char.ToUpperInvariant(d[0]));
        try
        {
            using (RegistryKey net = Registry.CurrentUser.OpenSubKey("Network"))
            {
                if (net != null) foreach (string n in net.GetSubKeyNames()) if (n.Length == 1) used.Add(char.ToUpperInvariant(n[0]));
            }
        }
        catch
        {
        }
        used.Add('A'); used.Add('B'); used.Add('C');
        if (ours != '\0') used.Remove(char.ToUpperInvariant(ours));
        return used;
    }

    static bool IsMapped(char letter, string host, int port)
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey("Network\\" + letter))
            {
                if (k == null) return false;
                string remote = k.GetValue("RemotePath") as string;
                return string.Equals(remote, PhoneMountLogic.UncPath(host, port), StringComparison.OrdinalIgnoreCase);
            }
        }
        catch
        {
            return false;
        }
    }

    static void Unmap(char letter, string host, int port)
    {
        if (IsMapped(letter, host, port))
        {
            int rc = WNetCancelConnection2W(letter + ":", CONNECT_UPDATE_PROFILE, true);
            Log("unmap " + letter + ": result " + rc);
        }
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\" + PhoneMountLogic.MountPointsKey(host, port), false);
        }
        catch
        {
        }
    }

    static void SetLabel(string host, int port)
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\" + PhoneMountLogic.MountPointsKey(host, port)))
            {
                k.SetValue("_LabelFromReg", PhoneMountLogic.Label, RegistryValueKind.String);
            }
        }
        catch
        {
        }
    }
}

internal sealed class PhoneForm : Form
{
    Label status;
    TextBox code;
    Button connect;
    Button disconnect;
    LinkLabel advancedLink;
    Panel advanced;
    TextBox address;
    ComboBox letter;

    public PhoneForm(Icon icon)
    {
        Text = "Connect my phone";
        Icon = icon;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10f);
        ClientSize = new Size(440, 250);

        Label help = new Label();
        help.Text = "On your phone, set the owner password, turn on sharing, and tap Pair a PC. Paste this PC's token here once. Drivebay saves it and reconnects if the phone or this PC restarts.";
        help.SetBounds(16, 12, 408, 72);

        code = new TextBox();
        code.SetBounds(16, 92, 200, 28);
        code.UseSystemPasswordChar = true;
        code.MaxLength = 200;

        connect = new Button();
        connect.Text = "Connect my phone";
        connect.SetBounds(226, 90, 198, 32);
        connect.Click += delegate { DoConnect(); };
        AcceptButton = connect;

        status = new Label();
        status.SetBounds(16, 132, 408, 24);
        status.Font = new Font("Segoe UI", 10f, FontStyle.Bold);

        disconnect = new Button();
        disconnect.Text = "Unmount and forget phone";
        disconnect.SetBounds(16, 164, 220, 30);
        disconnect.Click += delegate { DoDisconnect(); };

        advancedLink = new LinkLabel();
        advancedLink.Text = "Advanced";
        advancedLink.SetBounds(340, 168, 84, 24);
        advancedLink.TextAlign = ContentAlignment.MiddleRight;
        advancedLink.LinkClicked += delegate
        {
            advanced.Visible = !advanced.Visible;
            ClientSize = new Size(440, advanced.Visible ? 320 : 214);
        };

        advanced = new Panel();
        advanced.SetBounds(16, 204, 408, 100);
        advanced.Visible = false;
        Label al = new Label(); al.Text = "Phone address (blank = find it automatically)"; al.SetBounds(0, 0, 408, 22);
        address = new TextBox(); address.SetBounds(0, 24, 260, 28);
        address.Text = PhoneMount.Settings.ManualAddress;
        Label ll = new Label(); ll.Text = "Drive"; ll.SetBounds(276, 0, 120, 22);
        letter = new ComboBox(); letter.DropDownStyle = ComboBoxStyle.DropDownList; letter.SetBounds(276, 24, 120, 28);
        letter.Items.Add("Automatic");
        for (char c = 'D'; c <= 'Z'; c++) letter.Items.Add(c + ":");
        letter.SelectedIndex = 0;
        if (PhoneMount.Settings.PreferredLetter != 'P' && PhoneMount.Settings.PreferredLetter >= 'D')
            letter.SelectedItem = PhoneMount.Settings.PreferredLetter + ":";
        advanced.Controls.Add(al); advanced.Controls.Add(address); advanced.Controls.Add(ll); advanced.Controls.Add(letter);

        Controls.Add(help); Controls.Add(code); Controls.Add(connect); Controls.Add(status);
        Controls.Add(disconnect); Controls.Add(advancedLink); Controls.Add(advanced);
        ClientSize = new Size(440, 214);

        Action refresh = delegate { ShowStatus(PhoneMount.Status); };
        PhoneMount.StatusChanged += refresh;
        FormClosed += delegate { PhoneMount.StatusChanged -= refresh; };
        ShowStatus(PhoneMount.Status);
    }

    void ShowStatus(PhoneStatus s)
    {
        string text = PhoneMountLogic.StatusText(s);
        if ((s == PhoneStatus.Connected || s == PhoneStatus.Reconnecting) && PhoneMount.Settings.Letter != '\0')
            text = PhoneMountLogic.StatusText(s) + " (" + PhoneMount.Settings.Letter + ": Drivebay Phone)";
        status.Text = text;
        status.ForeColor = s == PhoneStatus.Connected ? Color.ForestGreen : (s == PhoneStatus.CodeExpired ? Color.Firebrick : (s == PhoneStatus.Reconnecting ? Color.DarkGoldenrod : SystemColors.ControlText));
        disconnect.Enabled = PhoneMount.Settings.Enabled || PhoneMount.Settings.Letter != '\0';
    }

    void DoConnect()
    {
        string secret = code.Text;
        if (!PhoneMountLogic.LooksLikeSecret(secret))
        {
            status.Text = "Paste the token from your phone.";
            status.ForeColor = Color.Firebrick;
            return;
        }
        string manual = address.Text;
        string h; int p;
        if (manual.Trim().Length > 0 && !PhoneMountLogic.TryParseAddress(manual, out h, out p))
        {
            status.Text = "That phone address doesn't look right (Advanced).";
            status.ForeColor = Color.Firebrick;
            return;
        }
        char pref = letter.SelectedIndex <= 0 ? 'P' : ((string)letter.SelectedItem)[0];
        connect.Enabled = false;
        status.Text = "Connecting...";
        status.ForeColor = SystemColors.ControlText;
        ThreadPool.QueueUserWorkItem(delegate
        {
            PhoneStatus result;
            try { result = PhoneMount.Connect(secret, manual, pref); }
            catch { result = PhoneStatus.PhoneNotFound; }
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    connect.Enabled = true;
                    if (result == PhoneStatus.Connected) code.Text = "";
                    ShowStatus(result);
                    if (result == PhoneStatus.PhoneNotFound)
                        status.Text = "Phone not found. Code saved; it will connect when your phone is on.";
                });
            }
            catch
            {
            }
        });
    }

    void DoDisconnect()
    {
        disconnect.Enabled = false;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try { PhoneMount.Disconnect(); } catch { }
            try { BeginInvoke((MethodInvoker)delegate { ShowStatus(PhoneMount.Status); }); } catch { }
        });
    }
}
