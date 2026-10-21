// Unit tests for PhoneMountLogic. Build with csc together with PhoneMountLogic.cs
// (reference System.Web.Extensions.dll) and run; exit code 0 = pass.
using System;
using System.Collections.Generic;

internal static class PhoneMountTests
{
    static int failed, passed;
    static void Eq(object want, object got, string name)
    {
        if (object.Equals(want, got)) { passed++; return; }
        failed++;
        Console.WriteLine("FAIL " + name + ": want " + want + " got " + got);
    }

    static int Main()
    {
        string json = "{\"Self\":{\"OS\":\"windows\"},\"Peer\":{" +
            "\"a\":{\"OS\":\"android\",\"Online\":true,\"TailscaleIPs\":[\"100.70.170.22\",\"fd7a:115c:a1e0::1\"]}," +
            "\"b\":{\"OS\":\"android\",\"Online\":false,\"TailscaleIPs\":[\"100.1.1.1\"]}," +
            "\"c\":{\"OS\":\"macOS\",\"Online\":true,\"TailscaleIPs\":[\"100.2.2.2\"]}," +
            "\"d\":{\"OS\":\"Android\",\"Online\":true,\"TailscaleIPs\":[\"fd7a::5\",\"100.3.3.3\"]}}}";
        List<string> peers = PhoneMountLogic.ParseAndroidPeers(json);
        Eq(2, peers.Count, "peer count");
        Eq(true, peers.Contains("100.70.170.22"), "peer a");
        Eq(true, peers.Contains("100.3.3.3"), "peer d ipv4");
        Eq(0, PhoneMountLogic.ParseAndroidPeers("not json").Count, "bad json");
        Eq(0, PhoneMountLogic.ParseAndroidPeers(null).Count, "null json");
        Eq(0, PhoneMountLogic.ParseAndroidPeers("{\"Peer\":null}").Count, "null peers");

        string h; int p;
        Eq(true, PhoneMountLogic.TryParseAddress("100.70.170.22", out h, out p), "addr ip");
        Eq(8780, p, "default port");
        Eq(true, PhoneMountLogic.TryParseAddress("http://phone.tail1.ts.net:9000/", out h, out p), "addr url");
        Eq("phone.tail1.ts.net", h, "addr host"); Eq(9000, p, "addr port");
        Eq(false, PhoneMountLogic.TryParseAddress("bad host & net user", out h, out p), "addr injection");
        Eq(false, PhoneMountLogic.TryParseAddress("1.2.3.4:99999", out h, out p), "addr bad port");
        Eq(false, PhoneMountLogic.TryParseAddress("\"x\" /delete", out h, out p), "addr quote");

        Eq("\\\\100.70.170.22@8780\\DavWWWRoot", PhoneMountLogic.UncPath("100.70.170.22", 8780), "unc");
        Eq("##100.70.170.22@8780#DavWWWRoot", PhoneMountLogic.MountPointsKey("100.70.170.22", 8780), "mountpoints key");

        Eq(true, PhoneMountLogic.LooksLikeSecret(" 123456 "), "code");
        Eq(false, PhoneMountLogic.LooksLikeSecret("12345"), "short code");
        Eq(true, PhoneMountLogic.LooksLikeSecret("db_AbC123xyz_-9"), "token");
        Eq(false, PhoneMountLogic.LooksLikeSecret("db_ab"), "short token");

        HashSet<char> used = new HashSet<char>(new char[] { 'A', 'B', 'C', 'D' });
        Eq('P', PhoneMountLogic.PickLetter(used, 'P', '\0'), "letter P");
        used.Add('P');
        Eq('Q', PhoneMountLogic.PickLetter(used, 'P', '\0'), "next free");
        Eq('P', PhoneMountLogic.PickLetter(used, 'P', 'P'), "already ours");
        Eq('R', PhoneMountLogic.PickLetter(used, 'P', 'R'), "keep ours");
        HashSet<char> all = new HashSet<char>();
        for (char c = 'A'; c <= 'Z'; c++) all.Add(c);
        Eq('\0', PhoneMountLogic.PickLetter(all, 'P', '\0'), "no letters");

        Eq(30, PhoneMountLogic.NextDelaySeconds(0), "delay ok");
        Eq(60, PhoneMountLogic.NextDelaySeconds(1), "delay 1");
        Eq(120, PhoneMountLogic.NextDelaySeconds(2), "delay 2");
        Eq(300, PhoneMountLogic.NextDelaySeconds(50), "delay cap");

        Eq(AuthResult.Ok, PhoneMountLogic.Classify(207), "207");
        Eq(AuthResult.BadCode, PhoneMountLogic.Classify(401), "401");
        Eq(AuthResult.Unreachable, PhoneMountLogic.Classify(500), "500");

        Eq(PhoneStep.Nothing, PhoneMountLogic.Decide(PhoneStatus.Off, true, false, false), "off");
        Eq(PhoneStep.MarkNotFound, PhoneMountLogic.Decide(PhoneStatus.Connected, false, true, true), "gone keeps mapping");
        Eq(PhoneStep.Verify, PhoneMountLogic.Decide(PhoneStatus.PhoneNotFound, true, false, true), "back -> verify once");
        Eq(PhoneStep.Map, PhoneMountLogic.Decide(PhoneStatus.Searching, true, true, false), "map");
        Eq(PhoneStep.Nothing, PhoneMountLogic.Decide(PhoneStatus.Connected, true, true, true), "steady");

        // Bad-code safety: simulate a background loop; count authenticated tries.
        PhoneStatus st = PhoneStatus.Searching; bool verified = false; int tries = 0;
        for (int i = 0; i < 100; i++)
        {
            PhoneStep step = PhoneMountLogic.Decide(st, true, verified, false);
            if (step == PhoneStep.Verify) { tries++; st = PhoneMountLogic.AfterVerify(AuthResult.BadCode); }
        }
        Eq(1, tries, "401 burns at most one try");
        Eq(PhoneStatus.CodeExpired, st, "401 -> CodeExpired");
        // Phone flapping with a bad code still never retries after 401.
        for (int i = 0; i < 50; i++)
        {
            if (PhoneMountLogic.Decide(st, i % 2 == 0, false, false) == PhoneStep.Verify) tries++;
        }
        Eq(1, tries, "flapping after 401");

        Eq(AuthResult.Ok, PhoneMountLogic.ClassifyMapError(0), "map ok");
        Eq(AuthResult.BadCode, PhoneMountLogic.ClassifyMapError(1326), "map logon failure");
        Eq(AuthResult.BadCode, PhoneMountLogic.ClassifyMapError(86), "map bad password");
        Eq(AuthResult.Unreachable, PhoneMountLogic.ClassifyMapError(67), "map bad net name");
        Eq(AuthResult.Unreachable, PhoneMountLogic.ClassifyMapError(53), "map path not found");
        Eq(true, PhoneMountLogic.IsLetterBusy(85), "letter busy 85");
        Eq(true, PhoneMountLogic.IsLetterBusy(1202), "letter busy 1202");
        Eq(false, PhoneMountLogic.IsLetterBusy(0), "letter not busy");

        Eq("verify 100.70.170.22:8780 -> Ok", PhoneMountLogic.Scrub("verify 100.70.170.22:8780 -> Ok"), "scrub keeps ip/port");
        Eq("code ****** token db_***", PhoneMountLogic.Scrub("code 123456 token db_AbC123xyz"), "scrub secrets");
        Eq("a b", PhoneMountLogic.Scrub("a\nb"), "scrub newline");

        Eq("Connected", PhoneMountLogic.StatusText(PhoneStatus.Connected), "text connected");
        Eq("Reconnecting...", PhoneMountLogic.StatusText(PhoneStatus.Reconnecting), "text reconnecting");
        Eq("Phone not found", PhoneMountLogic.StatusText(PhoneStatus.PhoneNotFound), "text missing");
        Eq("Code expired, get a new code", PhoneMountLogic.StatusText(PhoneStatus.CodeExpired), "text expired");

        Eq(PhoneStatus.Off, PhoneMountLogic.InitialStatus(false, false, true), "init off");
        Eq(PhoneStatus.CodeExpired, PhoneMountLogic.InitialStatus(true, true, true), "init expired");
        Eq(PhoneStatus.Reconnecting, PhoneMountLogic.InitialStatus(true, false, true), "init paired");
        Eq(PhoneStatus.Searching, PhoneMountLogic.InitialStatus(true, false, false), "init new");
        Eq(PhoneStatus.Reconnecting, PhoneMountLogic.MissingStatus("100.1.1.1", "", PhoneStatus.Connected), "missing known host");
        Eq(PhoneStatus.PhoneNotFound, PhoneMountLogic.MissingStatus("", "", PhoneStatus.Searching), "missing never paired");

        Eq(PhoneStep.Verify, PhoneMountLogic.Decide(PhoneStatus.Reconnecting, true, false, false), "reconnect verifies");
        Eq(PhoneStep.MarkNotFound, PhoneMountLogic.Decide(PhoneStatus.Reconnecting, false, false, true), "reconnect still waiting");
        Eq(PhoneStep.Nothing, PhoneMountLogic.Decide(PhoneStatus.CodeExpired, true, false, false), "expired stays stopped");

        Eq(AuthResult.Unreachable, PhoneMountLogic.ClassifyMapError(1219), "1219 is not a bad token");
        Eq(true, PhoneMountLogic.ShouldResetSession(1219), "1219 drops the session");
        Eq(true, PhoneMountLogic.ShouldResetSession(85), "85 drops the session");
        Eq(false, PhoneMountLogic.ShouldResetSession(1326), "logon failure is not a stale session");

        List<string[]> lan = new List<string[]>();
        lan.Add(new string[] { "192.168.1.50", "8780" });
        List<string> tail = new List<string>();
        tail.Add("100.9.9.9");
        tail.Add("100.2.2.2");
        List<string[]> ordered = PhoneMountLogic.OrderCandidates(true, "100.1.1.1", 8780, "100.2.2.2", 8780, lan, tail);
        Eq(4, ordered.Count, "stale manual is not the only candidate");
        Eq("100.1.1.1", ordered[0][0], "manual first");
        Eq("100.2.2.2", ordered[1][0], "saved second");
        Eq("100.9.9.9", ordered[2][0], "tailscale before lan");
        Eq("192.168.1.50", ordered[3][0], "lan last");

        string peer; int dport;
        Eq(true, PhoneMountLogic.TryParseDiscovery("DRIVEBAY1 abcdef0123456789 8780", out peer, out dport), "beacon");
        Eq("abcdef0123456789", peer, "beacon peer");
        Eq(8780, dport, "beacon port");
        Eq(false, PhoneMountLogic.TryParseDiscovery("DRIVEBAY1 nope", out peer, out dport), "beacon short");
        Eq(false, PhoneMountLogic.TryParseDiscovery("HELLO abcdef0123456789 8780", out peer, out dport), "beacon magic");

        List<string> candHosts = new List<string>(new string[] { "100.1.1.1", "100.2.2.2", "192.168.1.50" });
        List<bool> candOk = new List<bool>(new bool[] { true, false, true });
        List<string> candIds = new List<string>(new string[] { "aaaaaaaaaaaaaaaa", "", "bbbbbbbbbbbbbbbb" });
        Eq(2, PhoneMountLogic.PickCandidate(candHosts, candOk, candIds, "bbbbbbbbbbbbbbbb", "100.2.2.2"), "pick matching peer");
        Eq(0, PhoneMountLogic.PickCandidate(candHosts, candOk, candIds, "", "100.2.2.2"), "first answer before a peer is saved");
        candOk[2] = false;
        candIds[0] = "";
        Eq(0, PhoneMountLogic.PickCandidate(candHosts, candOk, candIds, "bbbbbbbbbbbbbbbb", "100.1.1.1"), "saved host without a header still counts");
        candOk[0] = false;
        Eq(-1, PhoneMountLogic.PickCandidate(candHosts, candOk, candIds, "bbbbbbbbbbbbbbbb", "100.1.1.1"), "different phone is ignored");

        Console.WriteLine(passed + " passed, " + failed + " failed");
        return failed == 0 ? 0 : 1;
    }
}
