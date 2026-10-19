// Drivebay system tray. Built with the .NET Framework csc.exe that ships on
// Windows (C# 5). No extra runtime is copied into the installer.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal enum RunState
{
    Stopped,
    Starting,
    Running,
    Failed
}

internal static class Program
{
    const string MutexName = "Local\\DrivebayTray";
    const string ActivateName = "Local\\DrivebayTrayActivate";
    const string StopName = "Local\\DrivebayTrayStop";
    const string QuitName = "Local\\DrivebayTrayQuit";

    static Mutex mutex;
    static bool ownsMutex;
    static NotifyIcon notifyIcon;
    static Form sink;
    static Icon appIcon;
    static Icon warnIcon;
    static Process serverProcess;
    static RunState state = RunState.Stopped;
    static bool userStopped;
    static bool quitting;
    static bool openWhenReady;
    static bool announceNextUp;
    static int probeRunning;
    static ToolStripMenuItem startItem;
    static ToolStripMenuItem stopItem;
    static ToolStripMenuItem restartItem;
    static ToolStripMenuItem startupItem;
    static ToolStripMenuItem phoneItem;
    static PhoneForm phoneForm;

    [STAThread]
    static void Main(string[] args)
    {
        bool background = HasArg(args, "--background");
        bool stop = HasArg(args, "--stop");
        bool quit = HasArg(args, "--quit");

        EventWaitHandle activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateName);
        EventWaitHandle stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, StopName);
        EventWaitHandle quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitName);

        mutex = new Mutex(false, MutexName);
        try
        {
            ownsMutex = mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            ownsMutex = true;
        }

        if (!ownsMutex)
        {
            try
            {
                if (quit) Signal(QuitName);
                else if (stop) Signal(StopName);
                else Signal(ActivateName);
            }
            catch (WaitHandleCannotBeOpenedException)
            {
            }
            if (quit) WaitForTrayExit();
            if (stop || quit) StopServerProcess();
            return;
        }

        // --stop and --quit must not become a new tray icon when none is running.
        if (stop || quit)
        {
            StopServerProcess();
            ReleaseMutex();
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        sink = new Form();
        sink.ShowInTaskbar = false;
        sink.FormBorderStyle = FormBorderStyle.FixedToolWindow;
        IntPtr handle = sink.Handle;
        if (handle == IntPtr.Zero) return;

        appIcon = LoadAppIcon();
        warnIcon = (Icon)SystemIcons.Warning.Clone();
        notifyIcon = new NotifyIcon();
        notifyIcon.Icon = appIcon;
        notifyIcon.Visible = true;
        notifyIcon.Text = Tip("Drivebay");
        notifyIcon.MouseDoubleClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) OpenDrivebay();
        };
        PhoneMount.TrayLog = Log;
        PhoneMount.UiThread = sink;
        PhoneMount.Notify = delegate(string title, string text)
        {
            try
            {
                sink.BeginInvoke((MethodInvoker)delegate
                {
                    notifyIcon.BalloonTipTitle = title;
                    notifyIcon.BalloonTipText = text;
                    notifyIcon.ShowBalloonTip(8000);
                });
            }
            catch
            {
            }
        };
        PhoneMount.Init();
        PhoneMount.StatusChanged += delegate { RefreshPhoneItem(); };
        notifyIcon.ContextMenuStrip = BuildMenu();

        Thread waiter = new Thread(delegate()
        {
            WaitHandle[] handles = new WaitHandle[] { activateEvent, stopEvent, quitEvent };
            while (!quitting)
            {
                int which;
                try
                {
                    which = WaitHandle.WaitAny(handles);
                }
                catch
                {
                    return;
                }
                try
                {
                    sink.BeginInvoke((MethodInvoker)delegate
                    {
                        if (which == 0) OpenDrivebay();
                        else if (which == 1) StopServer();
                        else Quit();
                    });
                }
                catch
                {
                    return;
                }
            }
        });
        waiter.IsBackground = true;
        waiter.Start();

        System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        timer.Interval = 2000;
        timer.Tick += delegate { Tick(); PhoneMount.Tick(); };
        timer.Start();

        openWhenReady = !background;
        StartServer(true);
        Application.Run();
    }

    static bool HasArg(string[] args, string name)
    {
        if (args == null) return false;
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static void Signal(string name)
    {
        EventWaitHandle handle = EventWaitHandle.OpenExisting(name);
        try
        {
            handle.Set();
        }
        finally
        {
            handle.Close();
        }
    }

    static void WaitForTrayExit()
    {
        using (Mutex wait = new Mutex(false, MutexName))
        {
            try
            {
                if (wait.WaitOne(8000)) wait.ReleaseMutex();
            }
            catch (AbandonedMutexException)
            {
                try { wait.ReleaseMutex(); } catch { }
            }
        }
    }

    static ContextMenuStrip BuildMenu()
    {
        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem openItem = new ToolStripMenuItem("Open settings");
        openItem.Click += delegate { OpenDrivebay(); };
        ToolStripMenuItem copyItem = new ToolStripMenuItem("Copy address");
        copyItem.Click += delegate { CopyAddress(); };
        startItem = new ToolStripMenuItem("Start server");
        startItem.Click += delegate
        {
            openWhenReady = true;
            StartServer(true);
        };
        stopItem = new ToolStripMenuItem("Stop server");
        stopItem.Click += delegate { StopServer(); };
        restartItem = new ToolStripMenuItem("Restart server");
        restartItem.Click += delegate { RestartServer(); };
        phoneItem = new ToolStripMenuItem("Connect my phone...");
        phoneItem.Click += delegate { OpenPhoneForm(); };
        ToolStripMenuItem logsItem = new ToolStripMenuItem("Open logs folder");
        logsItem.Click += delegate { OpenLogs(); };
        startupItem = new ToolStripMenuItem("Start with Windows");
        startupItem.Checked = ReadStartWithWindows();
        startupItem.Click += delegate
        {
            SetStartWithWindows(!ReadStartWithWindows());
            startupItem.Checked = ReadStartWithWindows();
        };
        ToolStripMenuItem resetItem = new ToolStripMenuItem("Reset password");
        resetItem.Click += delegate { ResetPassword(); };
        ToolStripMenuItem quitItem = new ToolStripMenuItem("Quit");
        quitItem.Click += delegate { Quit(); };

        menu.Items.Add(openItem);
        menu.Items.Add(copyItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startItem);
        menu.Items.Add(stopItem);
        menu.Items.Add(restartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(phoneItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(logsItem);
        menu.Items.Add(startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(resetItem);
        menu.Items.Add(quitItem);
        menu.Opening += delegate
        {
            startupItem.Checked = ReadStartWithWindows();
            RefreshMenu();
            RefreshPhoneItem();
        };
        RefreshMenu();
        RefreshPhoneItem();
        return menu;
    }

    static void RefreshPhoneItem()
    {
        if (phoneItem == null) return;
        if (PhoneMount.Status == PhoneStatus.Off) phoneItem.Text = "Connect my phone...";
        else phoneItem.Text = "My phone: " + PhoneMountLogic.StatusText(PhoneMount.Status);
    }

    static void OpenPhoneForm()
    {
        if (phoneForm != null && !phoneForm.IsDisposed)
        {
            phoneForm.Activate();
            return;
        }
        phoneForm = new PhoneForm(appIcon);
        phoneForm.Show();
        phoneForm.Activate();
    }

    static string ExePath()
    {
        return typeof(Program).Assembly.Location;
    }

    static string InstallDir()
    {
        return Path.GetDirectoryName(ExePath());
    }

    static string HomeDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Drivebay");
    }

    static string StartupCommand()
    {
        return "\"" + ExePath() + "\" --background";
    }

    static void ReleaseMutex()
    {
        if (ownsMutex && mutex != null)
        {
            try { mutex.ReleaseMutex(); } catch { }
            ownsMutex = false;
        }
    }

    static bool ReadStartWithWindows()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
            {
                if (key == null) return false;
                object value = key.GetValue("Drivebay");
                return value != null && value.ToString().Length > 0;
            }
        }
        catch
        {
            return false;
        }
    }

    static void SetStartWithWindows(bool enabled)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (key == null) return;
                if (enabled) key.SetValue("Drivebay", StartupCommand());
                else key.DeleteValue("Drivebay", false);
            }
        }
        catch (Exception ex)
        {
            Log("Could not update Start with Windows: " + ex.Message);
        }
    }

    static int ReadPort()
    {
        try
        {
            string text = File.ReadAllText(Path.Combine(HomeDir(), "drivebay.port")).Trim();
            int port = int.Parse(text);
            if (port >= 1024 && port <= 65535) return port;
        }
        catch
        {
        }
        try
        {
            string config = File.ReadAllText(Path.Combine(HomeDir(), "config.json"));
            Match match = Regex.Match(config, "\"port\"\\s*:\\s*(\\d+)");
            if (match.Success)
            {
                int port = int.Parse(match.Groups[1].Value);
                if (port >= 1024 && port <= 65535) return port;
            }
        }
        catch
        {
        }
        return 42013;
    }

    static string ReadMode()
    {
        try
        {
            string config = File.ReadAllText(Path.Combine(HomeDir(), "config.json"));
            Match match = Regex.Match(config, "\"mode\"\\s*:\\s*\"(tailscale|regular)\"");
            if (match.Success) return match.Groups[1].Value;
        }
        catch
        {
        }
        return "regular";
    }

    static string ShareAddress()
    {
        int port = ReadPort();
        string mode = ReadMode();
        if (mode == "tailscale")
        {
            string ts = TailscaleIPv4();
            if (ts == null) ts = FirstAddress(true);
            if (ts != null) return "http://" + ts + ":" + port + "/";
        }
        string lan = FirstAddress(false);
        if (lan != null) return "http://" + lan + ":" + port + "/";
        return "http://127.0.0.1:" + port + "/";
    }

    static string TailscaleIPv4()
    {
        string[] roots = new string[] {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
        };
        for (int i = 0; i < roots.Length; i++)
        {
            if (string.IsNullOrEmpty(roots[i])) continue;
            string exe = Path.Combine(roots[i], "Tailscale", "tailscale.exe");
            if (!File.Exists(exe)) continue;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = exe;
                info.Arguments = "ip -4";
                info.CreateNoWindow = true;
                info.UseShellExecute = false;
                info.RedirectStandardOutput = true;
                Process process = Process.Start(info);
                if (process == null) continue;
                if (!process.WaitForExit(2000))
                {
                    try { process.Kill(); } catch { }
                    continue;
                }
                string output = process.StandardOutput.ReadToEnd();
                string[] lines = output.Split(new char[] { '\r', '\n' });
                for (int n = 0; n < lines.Length; n++)
                {
                    string ip = lines[n].Trim();
                    if (IsIPv4(ip)) return ip;
                }
            }
            catch
            {
            }
        }
        return null;
    }

    static string FirstAddress(bool tailscaleRange)
    {
        try
        {
            NetworkInterface[] interfaces = NetworkInterface.GetAllNetworkInterfaces();
            for (int i = 0; i < interfaces.Length; i++)
            {
                NetworkInterface ni = interfaces[i];
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (UnicastIPAddressInformation addr in ni.GetIPProperties().UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    string ip = addr.Address.ToString();
                    if (tailscaleRange)
                    {
                        if (IsTailscale(ip)) return ip;
                    }
                    else if (IsPrivateLan(ip))
                    {
                        return ip;
                    }
                }
            }
        }
        catch
        {
        }
        return null;
    }

    static bool IsIPv4(string ip)
    {
        IPAddress parsed;
        return IPAddress.TryParse(ip, out parsed) && parsed.AddressFamily == AddressFamily.InterNetwork;
    }

    static bool IsTailscale(string ip)
    {
        string[] parts = ip.Split('.');
        if (parts.Length != 4) return false;
        int a;
        int b;
        if (!int.TryParse(parts[0], out a) || !int.TryParse(parts[1], out b)) return false;
        return a == 100 && b >= 64 && b <= 127;
    }

    static bool IsPrivateLan(string ip)
    {
        if (IsTailscale(ip)) return false;
        string[] parts = ip.Split('.');
        if (parts.Length != 4) return false;
        int a;
        int b;
        if (!int.TryParse(parts[0], out a) || !int.TryParse(parts[1], out b)) return false;
        if (a == 10) return true;
        if (a == 192 && b == 168) return true;
        if (a == 172 && b >= 16 && b <= 31) return true;
        return false;
    }

    static void CopyAddress()
    {
        string address = ShareAddress();
        try
        {
            Clipboard.SetText(address);
            notifyIcon.BalloonTipTitle = "Drivebay";
            notifyIcon.BalloonTipText = "Copied " + address;
            notifyIcon.ShowBalloonTip(3000);
        }
        catch (Exception ex)
        {
            Log("Could not copy the address: " + ex.Message);
        }
    }

    static void OpenDrivebay()
    {
        openWhenReady = true;
        if (Probe(ReadPort()))
        {
            openWhenReady = false;
            SetState(RunState.Running, ReadPort());
            OpenLocal();
            return;
        }
        StartServer(true);
    }

    static void OpenLocal()
    {
        string url = "http://127.0.0.1:" + ReadPort() + "/settings";
        try
        {
            Process.Start(url);
        }
        catch (Exception ex)
        {
            Log("Could not open the browser: " + ex.Message);
        }
    }

    static void ResetPassword()
    {
        string first = "";
        string second = "";
        try
        {
            using (Form form = new Form())
            {
                form.Text = "Reset Drivebay password";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                form.ShowInTaskbar = true;
                form.ClientSize = new Size(400, 210);
                Label help = new Label();
                help.Text = "This resets the password on this PC only. Type the new password twice. Other devices must sign in again. A phone cannot reset it.";
                help.Left = 12;
                help.Top = 12;
                help.Width = 376;
                help.Height = 48;
                TextBox firstBox = new TextBox();
                firstBox.PasswordChar = '*';
                firstBox.Left = 12;
                firstBox.Top = 68;
                firstBox.Width = 376;
                TextBox secondBox = new TextBox();
                secondBox.PasswordChar = '*';
                secondBox.Left = 12;
                secondBox.Top = 100;
                secondBox.Width = 376;
                Button ok = new Button();
                ok.Text = "Reset password";
                ok.DialogResult = DialogResult.OK;
                ok.Left = 196;
                ok.Top = 140;
                ok.Width = 110;
                Button cancel = new Button();
                cancel.Text = "Cancel";
                cancel.DialogResult = DialogResult.Cancel;
                cancel.Left = 312;
                cancel.Top = 140;
                form.Controls.Add(help);
                form.Controls.Add(firstBox);
                form.Controls.Add(secondBox);
                form.Controls.Add(ok);
                form.Controls.Add(cancel);
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                DialogResult result = form.ShowDialog();
                if (result != DialogResult.OK)
                {
                    firstBox.Text = "";
                    secondBox.Text = "";
                    return;
                }
                first = firstBox.Text;
                second = secondBox.Text;
                firstBox.Text = "";
                secondBox.Text = "";
            }
            if (first != second)
            {
                MessageBox.Show("Those passwords do not match.", "Drivebay");
                return;
            }
            if (first.Length < 8)
            {
                MessageBox.Show("Use at least 8 characters.", "Drivebay");
                return;
            }
            string node = Path.Combine(InstallDir(), "runtime", "node.exe");
            string launcher = Path.Combine(InstallDir(), "launcher.mjs");
            if (!File.Exists(node) || !File.Exists(launcher))
            {
                MessageBox.Show("Drivebay's reset program is missing. Update Drivebay on this PC.", "Drivebay");
                return;
            }
            bool wasRunning = state == RunState.Running || state == RunState.Starting || Probe(ReadPort());
            userStopped = true;
            StopServerProcess();
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = "\"" + launcher + "\" reset-password --stdin";
            info.WorkingDirectory = InstallDir();
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["DRIVEBAY_HOME"] = HomeDir();
            Process process = Process.Start(info);
            if (process == null)
            {
                MessageBox.Show("Password reset failed.", "Drivebay");
                return;
            }
            process.StandardInput.WriteLine(first);
            process.StandardInput.Close();
            string error = process.StandardError.ReadToEnd();
            process.StandardOutput.ReadToEnd();
            process.WaitForExit(120000);
            if (process.ExitCode == 0)
            {
                MessageBox.Show("Password updated. Sign in again on every device. Settings, drives, and API tokens were kept.", "Drivebay");
            }
            else if (error.Length > 0 && error.Length < 240)
            {
                MessageBox.Show(error.Trim(), "Drivebay");
            }
            else
            {
                MessageBox.Show("Password reset failed.", "Drivebay");
            }
            userStopped = false;
            if (wasRunning) StartServer(false);
        }
        catch (Exception ex)
        {
            Log("Password reset failed.");
            MessageBox.Show("Password reset failed.", "Drivebay");
        }
        finally
        {
            first = "";
            second = "";
        }
    }

    static void OpenLogs()
    {
        try
        {
            Directory.CreateDirectory(HomeDir());
            Process.Start(HomeDir());
        }
        catch (Exception ex)
        {
            Log("Could not open the logs folder: " + ex.Message);
        }
    }

    static bool ServerAlive()
    {
        try
        {
            return serverProcess != null && !serverProcess.HasExited;
        }
        catch
        {
            return false;
        }
    }

    static void StartServer(bool announce)
    {
        if (quitting) return;
        if (Probe(ReadPort()))
        {
            bool wasDown = state != RunState.Running;
            SetState(RunState.Running, ReadPort());
            if (announce && wasDown) ShowRunningBalloon(ReadPort());
            if (openWhenReady)
            {
                openWhenReady = false;
                OpenLocal();
            }
            return;
        }
        if (ServerAlive()) return;
        userStopped = false;
        announceNextUp = announce;
        string node = Path.Combine(InstallDir(), "runtime", "node.exe");
        string launcher = Path.Combine(InstallDir(), "launcher.mjs");
        if (!File.Exists(node) || !File.Exists(launcher))
        {
            SetState(RunState.Failed, ReadPort());
            notifyIcon.Text = Tip("Drivebay - runtime is missing");
            Log("Bundled runtime is missing.");
            return;
        }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = "\"" + launcher + "\"";
            info.WorkingDirectory = InstallDir();
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            info.EnvironmentVariables["DRIVEBAY_NO_BROWSER"] = "1";
            info.EnvironmentVariables["DRIVEBAY_HOME"] = HomeDir();
            serverProcess = Process.Start(info);
            if (serverProcess != null)
            {
                serverProcess.EnableRaisingEvents = true;
                serverProcess.Exited += delegate
                {
                    try
                    {
                        sink.BeginInvoke((MethodInvoker)delegate { OnServerExited(); });
                    }
                    catch
                    {
                    }
                };
            }
            SetState(RunState.Starting, ReadPort());
            Log("Tray started the Drivebay server.");
        }
        catch (Exception ex)
        {
            SetState(RunState.Failed, ReadPort());
            Log("Could not start Drivebay: " + ex.Message);
        }
    }

    static void OnServerExited()
    {
        serverProcess = null;
        if (quitting) return;
        int port = ReadPort();
        if (userStopped)
        {
            SetState(RunState.Stopped, port);
            return;
        }
        if (Probe(port))
        {
            SetState(RunState.Running, port);
            return;
        }
        SetState(RunState.Failed, port);
        Log("Drivebay server stopped unexpectedly.");
    }

    static void StopServer()
    {
        userStopped = true;
        announceNextUp = false;
        openWhenReady = false;
        StopServerProcess();
        int port = ReadPort();
        if (!Probe(port)) SetState(RunState.Stopped, port);
        Log("Tray stopped the Drivebay server.");
    }

    static void StopServerProcess()
    {
        string node = Path.Combine(InstallDir(), "runtime", "node.exe");
        string launcher = Path.Combine(InstallDir(), "launcher.mjs");
        if (File.Exists(node) && File.Exists(launcher))
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = node;
                info.Arguments = "\"" + launcher + "\" --stop";
                info.WorkingDirectory = InstallDir();
                info.CreateNoWindow = true;
                info.UseShellExecute = false;
                Process process = Process.Start(info);
                if (process != null) process.WaitForExit(8000);
            }
            catch
            {
            }
        }
        try
        {
            if (serverProcess != null && !serverProcess.HasExited) serverProcess.Kill();
        }
        catch
        {
        }
    }

    static void RestartServer()
    {
        StopServer();
        userStopped = false;
        openWhenReady = false;
        StartServer(true);
    }

    static void Quit()
    {
        if (quitting) return;
        quitting = true;
        userStopped = true;
        StopServerProcess();
        if (notifyIcon != null)
        {
            notifyIcon.Visible = false;
            notifyIcon.Dispose();
        }
        ReleaseMutex();
        Application.Exit();
    }

    static void Tick()
    {
        if (quitting) return;
        if (Interlocked.CompareExchange(ref probeRunning, 1, 0) != 0) return;
        int port = ReadPort();
        ThreadPool.QueueUserWorkItem(delegate
        {
            bool up = Probe(port);
            try
            {
                sink.BeginInvoke((MethodInvoker)delegate
                {
                    probeRunning = 0;
                    ApplyProbe(up, port);
                });
            }
            catch
            {
                probeRunning = 0;
            }
        });
    }

    static void ApplyProbe(bool up, int port)
    {
        if (quitting) return;
        if (up)
        {
            bool became = state != RunState.Running;
            SetState(RunState.Running, port);
            if (became && announceNextUp)
            {
                announceNextUp = false;
                ShowRunningBalloon(port);
            }
            if (openWhenReady)
            {
                openWhenReady = false;
                OpenLocal();
            }
            return;
        }
        if (state == RunState.Running && !userStopped && !ServerAlive())
        {
            SetState(RunState.Failed, port);
        }
    }

    static bool Probe(int port)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/login");
            request.Timeout = 1500;
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                int code = (int)response.StatusCode;
                return code >= 200 && code < 500;
            }
        }
        catch (WebException ex)
        {
            if (ex.Response != null)
            {
                int code = (int)((HttpWebResponse)ex.Response).StatusCode;
                ex.Response.Close();
                return code >= 200 && code < 500;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    static void ShowRunningBalloon(int port)
    {
        notifyIcon.BalloonTipTitle = "Drivebay";
        notifyIcon.BalloonTipText = "Drivebay is running on port " + port + ".";
        notifyIcon.ShowBalloonTip(4000);
    }

    static void SetState(RunState next, int port)
    {
        state = next;
        if (next == RunState.Running)
        {
            notifyIcon.Icon = appIcon;
            notifyIcon.Text = Tip("Drivebay - running on port " + port);
        }
        else if (next == RunState.Starting)
        {
            notifyIcon.Icon = appIcon;
            notifyIcon.Text = Tip("Drivebay - starting");
        }
        else if (next == RunState.Failed)
        {
            notifyIcon.Icon = warnIcon;
            notifyIcon.Text = Tip("Drivebay - server stopped unexpectedly");
        }
        else
        {
            notifyIcon.Icon = appIcon;
            notifyIcon.Text = Tip("Drivebay - stopped");
        }
        RefreshMenu();
    }

    static void RefreshMenu()
    {
        if (startItem == null) return;
        startItem.Enabled = state != RunState.Running && state != RunState.Starting;
        stopItem.Enabled = state == RunState.Running || state == RunState.Starting;
        restartItem.Enabled = true;
    }

    static string Tip(string text)
    {
        if (text.Length > 63) return text.Substring(0, 63);
        return text;
    }

    static Icon LoadAppIcon()
    {
        try
        {
            Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (icon != null) return icon;
        }
        catch
        {
        }
        string ico = Path.Combine(InstallDir(), "assets", "drivebay.ico");
        try
        {
            if (File.Exists(ico)) return new Icon(ico);
        }
        catch
        {
        }
        return (Icon)SystemIcons.Application.Clone();
    }

    static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(HomeDir());
            File.AppendAllText(
                Path.Combine(HomeDir(), "drivebay.log"),
                DateTime.Now.ToString("s") + " [tray] " + message + Environment.NewLine);
        }
        catch
        {
        }
    }
}
