// VisualGrab - screen / window / region capture for the dsh-visual-check plugin.
//
// Design notes (all learned from the probes in ../probe/, which are the
// evidence behind these choices):
//
//  * Pure Win32 + a hand-written PNG encoder. System.Drawing is deliberately
//    NOT used: it loads inconsistently depending on the host process, and the
//    capture path does not need it.
//  * Comments here are intentionally ASCII-only. Windows PowerShell 5.1 reads
//    BOM-less UTF-8 as ANSI, which mangles non-ASCII characters and has already
//    broken this toolchain twice. Keep this file ASCII.
//  * PrintWindow reports success (returns 1) yet yields an all-black bitmap for
//    DWM-composited windows, so its return value is never trusted; callers
//    validate the content instead.
//  * Capturing a window that is covered by another window silently returns the
//    OCCLUDING window's pixels - not black, not an error. SampleCoverage exists
//    to detect that before the capture is used, and Activate exists to fix it.

using System;
using System.IO;
using System.Runtime.InteropServices;

public static class VisualGrab
{
    // ---------------------------------------------------------------- Win32

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(int attach, int attachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();

    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int index);

    const uint SRCCOPY = 0x00CC0020;
    const uint CAPTUREBLT = 0x40000000;
    const int DESKTOPHORZRES = 118;
    const int DESKTOPVERTRES = 117;
    const int SM_XVIRTUALSCREEN = 76;
    const int SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78;
    const int SM_CYVIRTUALSCREEN = 79;
    const uint GA_ROOT = 2;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x00000020;
    const int WS_EX_LAYERED = 0x00080000;
    const int SW_RESTORE = 9;
    const int SW_MINIMIZE = 6;
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;

    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    /// <summary>
    /// Needed because GetWindowRect on a minimized window returns the minimized
    /// (off-screen, tiny) rect. rcNormalPosition is where the window would sit
    /// when restored, which is what callers actually want to know.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth; public int biHeight;
        public ushort biPlanes; public ushort biBitCount; public uint biCompression;
        public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
        public uint biClrUsed; public uint biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public uint[] bmiColors;
    }

    // ------------------------------------------------------------ DPI aware

    /// <summary>
    /// Become per-monitor DPI aware. Without this the virtual screen reports
    /// 1707x960 on a 2560x1440 display and every capture comes out wrong.
    /// </summary>
    public static string MakeDpiAware()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch { }
        try { if (SetProcessDPIAware()) return "system-aware"; } catch { }
        return "none";
    }

    public static int ScreenX() { return GetSystemMetrics(SM_XVIRTUALSCREEN); }
    public static int ScreenY() { return GetSystemMetrics(SM_YVIRTUALSCREEN); }
    public static int ScreenW() { return GetSystemMetrics(SM_CXVIRTUALSCREEN); }
    public static int ScreenH() { return GetSystemMetrics(SM_CYVIRTUALSCREEN); }

    // -------------------------------------------------------------- windows

    /// <summary>One visible top-level window, with the flags callers need to choose a target.</summary>
    public class WinInfo
    {
        public long Handle;
        public int Pid;
        public string Process = "";
        public string Title = "";
        public int X, Y, W, H;
        public bool Foreground;
        public bool Minimized;
        public bool Overlay;   // layered / click-through: occlusion sampling is meaningless
    }

    public static System.Collections.Generic.List<WinInfo> ListWindows()
    {
        var list = new System.Collections.Generic.List<WinInfo>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len == 0) return true;
            var sb = new System.Text.StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.Trim().Length == 0) return true;

            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            bool minimized = IsIconic(h);
            if (minimized)
            {
                // GetWindowRect reports the minimized (off-screen, tiny) rect, so a
                // size filter applied to it silently drops EVERY minimized window.
                // Measure the restore rect instead.
                WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                if (GetWindowPlacement(h, ref wp)) r = wp.rcNormalPosition;
            }
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            if (w < 40 || ht < 40) return true;

            int pid;
            GetWindowThreadProcessId(h, out pid);
            string pname = "";
            try { pname = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }

            int ex = GetWindowLong(h, GWL_EXSTYLE);
            list.Add(new WinInfo
            {
                Handle = h.ToInt64(),
                Pid = pid,
                Process = pname,
                Title = title,
                X = r.Left, Y = r.Top, W = w, H = ht,
                Foreground = (h == fg),
                Minimized = minimized,
                Overlay = ((ex & WS_EX_TRANSPARENT) != 0) || ((ex & WS_EX_LAYERED) != 0)
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>
    /// How many of nine sample points across the window's rect actually belong
    /// to that window. "0/9" means fully covered, "9/9" means fully visible.
    /// Overlay windows always score low because WindowFromPoint skips them.
    /// </summary>
    public static string SampleCoverage(long handle)
    {
        IntPtr target = new IntPtr(handle);
        RECT r;
        if (!GetWindowRect(target, out r)) return "0/0";
        int hit = 0, total = 0;
        double[] frac = { 0.25, 0.5, 0.75 };
        foreach (double fx in frac)
        {
            foreach (double fy in frac)
            {
                POINT p;
                p.X = r.Left + (int)((r.Right - r.Left) * fx);
                p.Y = r.Top + (int)((r.Bottom - r.Top) * fy);
                IntPtr hitWnd = WindowFromPoint(p);
                if (hitWnd != IntPtr.Zero)
                {
                    IntPtr root = GetAncestor(hitWnd, GA_ROOT);
                    if (root == IntPtr.Zero) root = hitWnd;
                    if (root == target) hit++;
                }
                total++;
            }
        }
        return hit + "/" + total;
    }

    /// <summary>
    /// Bring a window to the foreground. The same routine serves both raising a
    /// capture target and restoring the original foreground afterwards; using it
    /// for only one of the two leaves the other silently denied.
    /// Attaching to the thread that currently owns the foreground is what makes
    /// SetForegroundWindow permitted; the ALT keystroke is the fallback.
    /// </summary>
    public static string Activate(long handle)
    {
        IntPtr hwnd = new IntPtr(handle);
        var log = new System.Text.StringBuilder();
        if (IsIconic(hwnd)) { ShowWindow(hwnd, SW_RESTORE); log.Append("unminimized;"); }

        IntPtr current = GetForegroundWindow();
        if (current == hwnd) return log.Append("already-foreground").ToString();

        int myTid = GetCurrentThreadId();
        int dummy;
        int curTid = (current == IntPtr.Zero) ? 0 : GetWindowThreadProcessId(current, out dummy);
        int tgtTid = GetWindowThreadProcessId(hwnd, out dummy);

        bool a1 = false, a2 = false;
        if (curTid != 0 && curTid != myTid) a1 = AttachThreadInput(myTid, curTid, true);
        if (tgtTid != 0 && tgtTid != myTid && tgtTid != curTid) a2 = AttachThreadInput(myTid, tgtTid, true);
        log.Append("attach(cur=").Append(a1).Append(",tgt=").Append(a2).Append(");");

        BringWindowToTop(hwnd);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        bool ok = SetForegroundWindow(hwnd);
        if (GetForegroundWindow() != hwnd)
        {
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            SetForegroundWindow(hwnd);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            log.Append("altTrick;");
        }
        if (a2) AttachThreadInput(myTid, tgtTid, false);
        if (a1) AttachThreadInput(myTid, curTid, false);
        log.Append("setfg=").Append(ok).Append(";final=").Append(GetForegroundWindow() == hwnd);
        return log.ToString();
    }

    public static long ForegroundHandle() { return GetForegroundWindow().ToInt64(); }

    // ------------------------------------------------------- minimize state

    /// <summary>Report whether a window still exists and whether it is minimized.</summary>
    public static string WindowState(long handle)
    {
        IntPtr hwnd = new IntPtr(handle);
        if (!IsWindow(hwnd)) return "exists=0";
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return "exists=1;minimized=0";
        return "exists=1"
             + ";minimized=" + (IsIconic(hwnd) ? 1 : 0)
             + ";foreground=" + (GetForegroundWindow() == hwnd ? 1 : 0)
             + ";w=" + (r.Right - r.Left) + ";h=" + (r.Bottom - r.Top);
    }

    /// <summary>
    /// Restore a minimized window so it can be captured.
    ///
    /// Return code doubles as a diagnostic and as the caller's signal about
    /// whether it must minimize the window again:
    ///   0 = nothing to do (not minimized)
    ///   1 = restored (async, or async+sync)
    ///   2 = restored via SetForegroundWindow (last resort)
    ///  -1 = window does not exist
    ///  -2 = still minimized after every strategy (caller must not capture)
    ///
    /// Three strategies, because a single one is not reliable across processes:
    /// ShowWindowAsync posts the request to the owning thread, the synchronous
    /// ShowWindow is often ignored when the caller is a background process, and
    /// SetForegroundWindow forces the window visible as a last resort.
    /// </summary>
    public static int RestoreWindow(long handle)
    {
        IntPtr hwnd = new IntPtr(handle);
        if (!IsWindow(hwnd)) return -1;
        if (!IsIconic(hwnd)) return 0;

        ShowWindowAsync(hwnd, SW_RESTORE);
        if (WaitUnminimized(hwnd, 700)) return 1;

        ShowWindow(hwnd, SW_RESTORE);
        if (WaitUnminimized(hwnd, 700)) return 1;

        SetForegroundWindow(hwnd);
        if (WaitUnminimized(hwnd, 700)) return 2;

        return -2;
    }

    /// <summary>Poll until the window is no longer minimized, or the budget runs out.</summary>
    static bool WaitUnminimized(IntPtr hwnd, int budgetMs)
    {
        for (int waited = 0; waited < budgetMs; waited += 50)
        {
            if (!IsIconic(hwnd)) return true;
            System.Threading.Thread.Sleep(50);
        }
        return !IsIconic(hwnd);
    }

    /// <summary>
    /// Put a window back to minimized (undo a RestoreWindow).
    ///
    /// Symmetric with RestoreWindow: ShowWindowAsync only *posts* the request, so
    /// returning right after it reports success while the window is still visible.
    /// Wait for IsIconic to actually flip, with a synchronous fallback.
    /// Returns 1 minimized, 0 already minimized, -1 gone, -2 failed.
    /// </summary>
    public static int MinimizeWindow(long handle)
    {
        IntPtr hwnd = new IntPtr(handle);
        if (!IsWindow(hwnd)) return -1;
        if (IsIconic(hwnd)) return 0;

        ShowWindowAsync(hwnd, SW_MINIMIZE);
        if (WaitMinimized(hwnd, 700)) return 1;

        ShowWindow(hwnd, SW_MINIMIZE);
        if (WaitMinimized(hwnd, 700)) return 1;

        return -2;
    }

    /// <summary>Poll until the window is minimized, or the budget runs out.</summary>
    static bool WaitMinimized(IntPtr hwnd, int budgetMs)
    {
        for (int waited = 0; waited < budgetMs; waited += 50)
        {
            if (IsIconic(hwnd)) return true;
            System.Threading.Thread.Sleep(50);
        }
        return IsIconic(hwnd);
    }

    // ------------------------------------------------------------- capture

    static byte[] GrabRects(int x, int y, int w, int h)
    {
        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        BITMAPINFO bmi = new BITMAPINFO();
        bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;   // negative = top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = 0;
        bmi.bmiColors = new uint[256];

        IntPtr bits;
        IntPtr dib = CreateDIBSection(screenDc, ref bmi, 0, out bits, IntPtr.Zero, 0);
        if (dib == IntPtr.Zero) { DeleteDC(memDc); ReleaseDC(IntPtr.Zero, screenDc); throw new Exception("CreateDIBSection failed"); }
        IntPtr old = SelectObject(memDc, dib);
        bool ok = BitBlt(memDc, 0, 0, w, h, screenDc, x, y, SRCCOPY | CAPTUREBLT);
        byte[] buf = new byte[w * h * 4];
        if (ok) Marshal.Copy(bits, buf, 0, buf.Length);
        SelectObject(memDc, old);
        DeleteObject(dib);
        DeleteDC(memDc);
        ReleaseDC(IntPtr.Zero, screenDc);
        if (!ok) throw new Exception("BitBlt failed");
        return buf;
    }

    /// <summary>Largest aspect-preserving size within a pixel budget.</summary>
    public static int[] FitSize(int w, int h, int maxPixels)
    {
        if (maxPixels <= 0 || (long)w * h <= maxPixels) return new int[] { w, h };
        double s = Math.Sqrt((double)maxPixels / ((double)w * h));
        return new int[] { Math.Max(1, (int)Math.Floor(w * s)), Math.Max(1, (int)Math.Floor(h * s)) };
    }

    /// <summary>Area-average downscale (supports non-integer ratios), fixed point.</summary>
    public static byte[] ResizeArea(byte[] src, int sw, int sh, int dw, int dh)
    {
        if (dw == sw && dh == sh) return src;
        byte[] dst = new byte[dw * dh * 4];
        long scaleX = ((long)sw << 20) / dw;
        long scaleY = ((long)sh << 20) / dh;
        for (int dy = 0; dy < dh; dy++)
        {
            long sy0 = dy * scaleY, sy1 = sy0 + scaleY;
            int y0 = (int)(sy0 >> 20);
            int y1 = (int)((sy1 + (1 << 20) - 1) >> 20);
            if (y1 > sh) y1 = sh;
            if (y0 >= y1) y1 = Math.Min(sh, y0 + 1);
            for (int dx = 0; dx < dw; dx++)
            {
                long sx0 = dx * scaleX, sx1 = sx0 + scaleX;
                int x0 = (int)(sx0 >> 20);
                int x1 = (int)((sx1 + (1 << 20) - 1) >> 20);
                if (x1 > sw) x1 = sw;
                if (x0 >= x1) x1 = Math.Min(sw, x0 + 1);
                long sb = 0, sg = 0, sr = 0, n = 0;
                for (int sy = y0; sy < y1; sy++)
                {
                    int row = sy * sw * 4;
                    for (int sx = x0; sx < x1; sx++)
                    {
                        int i = row + sx * 4;
                        sb += src[i]; sg += src[i + 1]; sr += src[i + 2]; n++;
                    }
                }
                int o = (dy * dw + dx) * 4;
                if (n == 0) n = 1;
                dst[o] = (byte)(sb / n); dst[o + 1] = (byte)(sg / n); dst[o + 2] = (byte)(sr / n); dst[o + 3] = 255;
            }
        }
        return dst;
    }

    /// <summary>Fraction of sampled pixels that are (near) uniform - used to flag blank captures.</summary>
    public static string Blankness(byte[] bgra, int w, int h)
    {
        int stepX = Math.Max(1, w / 32), stepY = Math.Max(1, h / 32);
        var seen = new System.Collections.Generic.HashSet<int>();
        long luma = 0; int n = 0;
        for (int y = 0; y < h; y += stepY)
        {
            for (int x = 0; x < w; x += stepX)
            {
                int i = (y * w + x) * 4;
                int b = bgra[i], g = bgra[i + 1], r = bgra[i + 2];
                seen.Add((r << 16) | (g << 8) | b);
                luma += (r + g + b) / 3; n++;
            }
        }
        int avg = n == 0 ? 0 : (int)(luma / n);
        return "distinct=" + seen.Count + ";avgLuma=" + avg + ";blank=" + (seen.Count <= 2 ? 1 : 0);
    }

    // ------------------------------------------------------------ PNG out

    static uint[] crcTable;
    static uint Crc32(byte[] d, int off, int len)
    {
        if (crcTable == null)
        {
            crcTable = new uint[256];
            for (uint i = 0; i < 256; i++)
            {
                uint c = i;
                for (int k = 0; k < 8; k++) c = ((c & 1) != 0) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
                crcTable[i] = c;
            }
        }
        uint crc = 0xFFFFFFFFu;
        for (int i = off; i < off + len; i++) crc = crcTable[(crc ^ d[i]) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFFu;
    }

    static uint Adler32(byte[] d, int off, int len)
    {
        const uint MOD = 65521;
        uint a = 1, b = 0;
        for (int i = off; i < off + len; i++) { a = (a + d[i]) % MOD; b = (b + a) % MOD; }
        return (b << 16) | a;
    }

    static void WriteBE(Stream s, uint v, int bytes)
    {
        for (int i = bytes - 1; i >= 0; i--) s.WriteByte((byte)((v >> (8 * i)) & 0xFF));
    }

    static void WriteChunk(Stream s, string type, byte[] data, int off, int len)
    {
        WriteBE(s, (uint)len, 4);
        byte[] t = System.Text.Encoding.ASCII.GetBytes(type);
        s.Write(t, 0, 4);
        if (len > 0) s.Write(data, off, len);
        byte[] crcIn = new byte[4 + len];
        Buffer.BlockCopy(t, 0, crcIn, 0, 4);
        if (len > 0) Buffer.BlockCopy(data, off, crcIn, 4, len);
        WriteBE(s, Crc32(crcIn, 0, crcIn.Length), 4);
    }

    /// <summary>Encode BGRA to a truecolour PNG. IDAT is real deflate, so a 2560x1440 frame lands near 2 MB instead of 11 MB.</summary>
    public static void EncodePng(byte[] bgra, int w, int h, string path)
    {
        int stride = w * 3;
        byte[] raw = new byte[(stride + 1) * h];
        int p = 0;
        for (int y = 0; y < h; y++)
        {
            raw[p++] = 0;
            int row = y * w * 4;
            for (int x = 0; x < w; x++)
            {
                int i = row + x * 4;
                raw[p++] = bgra[i + 2]; raw[p++] = bgra[i + 1]; raw[p++] = bgra[i];
            }
        }
        byte[] deflated;
        using (MemoryStream ms = new MemoryStream())
        {
            using (var ds = new System.IO.Compression.DeflateStream(ms, System.IO.Compression.CompressionMode.Compress, true))
                ds.Write(raw, 0, raw.Length);
            deflated = ms.ToArray();
        }
        byte[] zlib = new byte[deflated.Length + 6];
        zlib[0] = 0x78; zlib[1] = 0x9C;
        Buffer.BlockCopy(deflated, 0, zlib, 2, deflated.Length);
        uint adler = Adler32(raw, 0, raw.Length);
        zlib[zlib.Length - 4] = (byte)((adler >> 24) & 0xFF);
        zlib[zlib.Length - 3] = (byte)((adler >> 16) & 0xFF);
        zlib[zlib.Length - 2] = (byte)((adler >> 8) & 0xFF);
        zlib[zlib.Length - 1] = (byte)(adler & 0xFF);

        string dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        using (FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write))
        {
            fs.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, 0, 8);
            byte[] ihdr = new byte[13];
            ihdr[0] = (byte)((w >> 24) & 0xFF); ihdr[1] = (byte)((w >> 16) & 0xFF); ihdr[2] = (byte)((w >> 8) & 0xFF); ihdr[3] = (byte)(w & 0xFF);
            ihdr[4] = (byte)((h >> 24) & 0xFF); ihdr[5] = (byte)((h >> 16) & 0xFF); ihdr[6] = (byte)((h >> 8) & 0xFF); ihdr[7] = (byte)(h & 0xFF);
            ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
            WriteChunk(fs, "IHDR", ihdr, 0, 13);
            WriteChunk(fs, "IDAT", zlib, 0, zlib.Length);
            WriteChunk(fs, "IEND", new byte[0], 0, 0);
        }
    }

    // ------------------------------------------------------- capture entry

    /// <summary>Capture a region (or the whole virtual screen when w/h are 0). Returns "k=v;k=v".</summary>
    public static string CaptureRegion(string path, int x, int y, int w, int h, int maxPixels)
    {
        if (w <= 0 || h <= 0) { x = ScreenX(); y = ScreenY(); w = ScreenW(); h = ScreenH(); }
        if (x + w > ScreenX() + ScreenW()) w = ScreenX() + ScreenW() - x;
        if (y + h > ScreenY() + ScreenH()) h = ScreenY() + ScreenH() - y;
        if (w <= 0 || h <= 0) throw new Exception("capture region is empty after clamping to the virtual screen");

        byte[] src = GrabRects(x, y, w, h);
        int[] size = FitSize(w, h, maxPixels);
        byte[] outPx = ResizeArea(src, w, h, size[0], size[1]);
        EncodePng(outPx, size[0], size[1], path);
        long bytes = new FileInfo(path).Length;
        return "srcW=" + w + ";srcH=" + h + ";srcX=" + x + ";srcY=" + y
             + ";width=" + size[0] + ";height=" + size[1]
             + ";bytes=" + bytes + ";" + Blankness(src, w, h);
    }

    /// <summary>Capture one window by handle. Returns "k=v;k=v".</summary>
    public static string CaptureWindow(string path, long handle, int maxPixels)
    {
        IntPtr hwnd = new IntPtr(handle);
        RECT r;
        if (!GetWindowRect(hwnd, out r)) throw new Exception("GetWindowRect failed");
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) throw new Exception("window has no area (minimized?)");
        if (IsIconic(hwnd)) throw new Exception("window is minimized; the driver restores it before calling (set VG_RESTOREMINIMIZED=1), or capture the screen instead");

        byte[] src = GrabRects(r.Left, r.Top, w, h);
        int[] size = FitSize(w, h, maxPixels);
        byte[] outPx = ResizeArea(src, w, h, size[0], size[1]);
        EncodePng(outPx, size[0], size[1], path);
        long bytes = new FileInfo(path).Length;
        return "srcW=" + w + ";srcH=" + h + ";srcX=" + r.Left + ";srcY=" + r.Top
             + ";width=" + size[0] + ";height=" + size[1]
             + ";bytes=" + bytes + ";coverage=" + SampleCoverage(handle) + ";" + Blankness(src, w, h);
    }

    /// <summary>Centre pixel of a window's rect as R,G,B - used by tests as ground truth.</summary>
    public static string CentrePixel(long handle)
    {
        IntPtr hwnd = new IntPtr(handle);
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return "R=-1;G=-1;B=-1";
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return "R=-1;G=-1;B=-1";
        byte[] px = GrabRects(r.Left, r.Top, w, h);
        int i = ((h / 2) * w + (w / 2)) * 4;
        return "R=" + px[i + 2] + ";G=" + px[i + 1] + ";B=" + px[i];
    }
}
