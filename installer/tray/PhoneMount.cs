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
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class PhoneCredentials
{
    const string GenericTarget = "Drivebay/PhoneShare";
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

    // 3.36.0-test also wrote a Domain credential for the host. Remove it only
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
        IntPtr p;
        if (!CredRead(GenericTarget, CRED_TYPE_GENERIC, 0, out p)) return null;
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
        CredDelete(GenericTarget, CRED_TYPE_GENERIC, 0);
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
                "preferred=" + PreferredLetter
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
    static DateTime nextCheck = DateTime.MinValue;
    static int busy;

    public static void Init()
    {
        Settings = PhoneSettings.Load();
        if (!Settings.Enabled) Status = PhoneStatus.Off;
        else if (Settings.Expired) Status = PhoneStatus.CodeExpired;
        else Status = PhoneStatus.Searching;
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
        bool found = FindPhone(out host, out port);
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
            SetStatus(PhoneStatus.PhoneNotFound);
            return;
        }
        misses = 0;
        if (step == PhoneStep.Verify)
        {
            string secret = PhoneCredentials.Read();
            if (secret == null) { MarkExpired(); return; }
            AuthResult r = VerifyOnce(Settings.Host, Settings.Port, secret);
            secret = null;
            Log("check: verify -> " + r);
            PhoneStatus after = PhoneMountLogic.AfterVerify(r);
            if (after == PhoneStatus.CodeExpired) { MarkExpired(); return; }
            if (after != PhoneStatus.Connected) { misses++; SetStatus(after); return; }
            verified = true;
            step = PhoneStep.Map; // (re)connect the session with the verified code
        }
        if (step == PhoneStep.Map)
        {
            AuthResult m = MapNow();
            if (m == AuthResult.BadCode) { MarkExpired(); return; }
            if (m != AuthResult.Ok) { misses++; verified = false; SetStatus(PhoneStatus.PhoneNotFound); return; }
        }
        SetStatus(PhoneStatus.Connected);
    }

    static void MarkExpired()
    {
        Log("phone code was refused; stopped retrying");
        // Remove the mapping and saved password so Windows cannot keep
        // retrying a bad code and lock it on the phone.
        if (Settings.Letter != '\0') Unmap(Settings.Letter, Settings.Host, Settings.Port);
        PhoneCredentials.Delete(Settings.Host);
        Settings.Expired = true;
        Settings.Letter = '\0';
        Settings.Save();
        verified = false;
        SetStatus(PhoneStatus.CodeExpired);
        Notify("Drivebay Phone", "Code expired, get a new code. Open Drivebay on your phone, tap New token, then use Connect my phone.");
    }

    // Maps with WNetAddConnection2W: user + code passed in memory only.
    static AuthResult MapNow()
    {
        string secret = PhoneCredentials.Read();
        if (secret == null) { Log("map: no saved code in Credential Manager"); return AuthResult.BadCode; }
        string unc = PhoneMountLogic.UncPath(Settings.Host, Settings.Port);
        char current = Settings.Letter;
        if (current != '\0' && IsMapped(current, Settings.Host, Settings.Port))
        {
            int c = WNetCancelConnection2W(current + ":", 0, true);
            Log("map: dropped old session on " + current + ": result " + c);
        }
        char letter = PhoneMountLogic.PickLetter(UsedLetters(current), Settings.PreferredLetter, current);
        if (letter == '\0') { Log("map: no free drive letter"); return AuthResult.Unreachable; }
        SetLabel(Settings.Host, Settings.Port);
        NETRESOURCE nr = new NETRESOURCE();
        nr.dwType = RESOURCETYPE_DISK;
        nr.lpLocalName = letter + ":";
        nr.lpRemoteName = unc;
        int rc = WNetAddConnection2W(ref nr, secret, PhoneMountLogic.User, CONNECT_UPDATE_PROFILE);
        if (PhoneMountLogic.IsLetterBusy(rc) && current == letter)
        {
            WNetCancelConnection2W(letter + ":", CONNECT_UPDATE_PROFILE, true);
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
        if (!FindPhone(out host, out port))
        {
            Log("connect: phone not found; code saved for later");
            // Save the code so it connects as soon as the phone shows up.
            Settings.Host = host ?? Settings.Host;
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
        PhoneCredentials.Save(host, secret);
        Settings.Enabled = true; Settings.Expired = false;
        verified = true; misses = 0;
        if (Settings.Letter != '\0' && !IsMapped(Settings.Letter, host, port)) Settings.Letter = '\0';
        Settings.Save();
        AuthResult m = MapNow();
        if (m == AuthResult.BadCode) { MarkExpired(); return PhoneStatus.CodeExpired; }
        if (m != AuthResult.Ok) { verified = false; misses = 1; SetStatus(PhoneStatus.PhoneNotFound); return PhoneStatus.PhoneNotFound; }
        SetStatus(PhoneStatus.Connected);
        return PhoneStatus.Connected;
    }

    // Unmount + turn off + forget the code.
    public static void Disconnect()
    {
        if (Settings.Letter != '\0') Unmap(Settings.Letter, Settings.Host, Settings.Port);
        PhoneCredentials.Delete(Settings.Host);
        Settings.Enabled = false; Settings.Expired = false; Settings.Letter = '\0';
        Settings.Save();
        verified = false;
        SetStatus(PhoneStatus.Off);
    }

    // ----- discovery -----

    static bool FindPhone(out string host, out int port)
    {
        host = null; port = PhoneMountLogic.DefaultPort;
        List<string[]> candidates = new List<string[]>();
        string mh; int mp;
        if (!string.IsNullOrEmpty(Settings.ManualAddress) && PhoneMountLogic.TryParseAddress(Settings.ManualAddress, out mh, out mp))
        {
            candidates.Add(new string[] { mh, mp.ToString() });
        }
        else
        {
            if (!string.IsNullOrEmpty(Settings.Host)) candidates.Add(new string[] { Settings.Host, Settings.Port.ToString() });
            string ts = TailscaleStatusJson();
            List<string> peers = PhoneMountLogic.ParseAndroidPeers(ts);
            Log("discover: tailscale " + (ts == null ? "not available" : "ok") + ", online Android peers " + peers.Count);
            foreach (string ip in peers)
            {
                if (ip != Settings.Host) candidates.Add(new string[] { ip, PhoneMountLogic.DefaultPort.ToString() });
            }
        }
        foreach (string[] c in candidates)
        {
            int p = int.Parse(c[1]);
            int st = OptionsStatus(c[0], p);
            Log("discover: OPTIONS " + c[0] + ":" + p + " -> " + (st < 0 ? "no answer" : st.ToString()));
            if (st == 200) { host = c[0]; port = p; return true; }
        }
        Log("discover: " + candidates.Count + " candidate(s), none answered");
        if (candidates.Count > 0) { host = candidates[0][0]; port = int.Parse(candidates[0][1]); }
        return false;
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
    static int OptionsStatus(string host, int port)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PhoneMountLogic.BaseUrl(host, port));
            req.Method = "OPTIONS"; req.Timeout = 3000; req.Proxy = null; req.AllowAutoRedirect = false;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                int code = (int)res.StatusCode;
                if (code == 200 && res.Headers["DAV"] == null) return 299; // answered, but not WebDAV
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
        help.Text = "On your phone, open Drivebay > Settings > Phone as a drive, turn sharing on, and tap New token. Type the 6-digit code here. You only need to do this once.";
        help.SetBounds(16, 12, 408, 60);

        code = new TextBox();
        code.SetBounds(16, 78, 200, 28);
        code.UseSystemPasswordChar = true;
        code.MaxLength = 200;

        connect = new Button();
        connect.Text = "Connect my phone";
        connect.SetBounds(226, 76, 198, 32);
        connect.Click += delegate { DoConnect(); };
        AcceptButton = connect;

        status = new Label();
        status.SetBounds(16, 118, 408, 24);
        status.Font = new Font("Segoe UI", 10f, FontStyle.Bold);

        disconnect = new Button();
        disconnect.Text = "Unmount and forget phone";
        disconnect.SetBounds(16, 150, 220, 30);
        disconnect.Click += delegate { DoDisconnect(); };

        advancedLink = new LinkLabel();
        advancedLink.Text = "Advanced";
        advancedLink.SetBounds(340, 156, 84, 24);
        advancedLink.TextAlign = ContentAlignment.MiddleRight;
        advancedLink.LinkClicked += delegate
        {
            advanced.Visible = !advanced.Visible;
            ClientSize = new Size(440, advanced.Visible ? 300 : 200);
        };

        advanced = new Panel();
        advanced.SetBounds(16, 190, 408, 100);
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
        ClientSize = new Size(440, 200);

        Action refresh = delegate { ShowStatus(PhoneMount.Status); };
        PhoneMount.StatusChanged += refresh;
        FormClosed += delegate { PhoneMount.StatusChanged -= refresh; };
        ShowStatus(PhoneMount.Status);
    }

    void ShowStatus(PhoneStatus s)
    {
        string text = PhoneMountLogic.StatusText(s);
        if (s == PhoneStatus.Connected && PhoneMount.Settings.Letter != '\0')
            text = "Connected (" + PhoneMount.Settings.Letter + ": Drivebay Phone)";
        status.Text = text;
        status.ForeColor = s == PhoneStatus.Connected ? Color.ForestGreen : (s == PhoneStatus.CodeExpired ? Color.Firebrick : SystemColors.ControlText);
        disconnect.Enabled = PhoneMount.Settings.Enabled || PhoneMount.Settings.Letter != '\0';
    }

    void DoConnect()
    {
        string secret = code.Text;
        if (!PhoneMountLogic.LooksLikeSecret(secret))
        {
            status.Text = "Type the 6-digit code from your phone.";
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
