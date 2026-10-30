param(
    [string]$WindowHandle,
    [switch]$Probe
)
$ErrorActionPreference = 'Stop'

# The helper receives only a native window handle. No keyboard input, mouse
# movement, or clicks outside that window are recorded or sent to Folia.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class FoliaWidgetRightClick
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const uint WM_QUIT = 0x0012;
    private const uint GW_HWNDNEXT = 2;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x20;
    private static IntPtr target;
    private static IntPtr hook;
    private static bool captured;
    private static uint messageThread;
    private static readonly HookProc callback = OnMouse;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public Point Point;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Point;
        public uint Private;
    }
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr value);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr value, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")]
    private static extern IntPtr GetTopWindow(IntPtr parent);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);

    private static bool Contains(Rect rect, Point point)
    {
        return point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom;
    }

    private static bool CanCapture(Point point)
    {
        if (target == IntPtr.Zero || !IsWindowVisible(target) || IsIconic(target) ||
            (GetWindowLong(target, GWL_EXSTYLE) & WS_EX_TRANSPARENT) == 0) return false;
        Rect bounds;
        if (!GetWindowRect(target, out bounds) || !Contains(bounds, point)) return false;
        // Respect real z-order, including other topmost windows. Never steal a
        // right-click from an application or menu that covers the widget.
        for (IntPtr window = GetTopWindow(IntPtr.Zero); window != IntPtr.Zero; window = GetWindow(window, GW_HWNDNEXT))
        {
            if (window == target) return true;
            if (!IsWindowVisible(window) || IsIconic(window) ||
                (GetWindowLong(window, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0) continue;
            int cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) continue;
            if (GetWindowRect(window, out bounds) && Contains(bounds, point)) return false;
        }
        return false;
    }

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        int message = wParam.ToInt32();
        if (code < 0 || (message != WM_RBUTTONDOWN && message != WM_RBUTTONUP))
            return CallNextHookEx(hook, code, wParam, lParam);
        MouseInput input = (MouseInput)Marshal.PtrToStructure(lParam, typeof(MouseInput));
        if (message == WM_RBUTTONDOWN)
        {
            captured = CanCapture(input.Point);
            if (captured) return new IntPtr(1);
        }
        else if (captured)
        {
            captured = false;
            // Consume the paired release even after leaving the rectangle;
            // opening a menu still requires both ends to be over the widget.
            if (CanCapture(input.Point))
            {
                Console.Out.WriteLine("RIGHT_UP " + input.Point.X + " " + input.Point.Y);
                Console.Out.Flush();
            }
            return new IntPtr(1);
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    public static void Run(string windowHandle, bool probe)
    {
        target = probe ? IntPtr.Zero : new IntPtr(Convert.ToInt64(windowHandle, 16));
        if (!probe && !IsWindow(target)) throw new InvalidOperationException("The widget window no longer exists.");
        // Hook points and GetWindowRect must use physical pixels on mixed-DPI
        // desktops. Electron converts the captured point back to DIP once.
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        messageThread = GetCurrentThreadId();
        Message message;
        PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
        hook = SetWindowsHookEx(WH_MOUSE_LL, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (probe) { Console.Out.WriteLine("PROBE_OK"); return; }
            var input = new Thread(() => {
                while (Console.In.ReadLine() != null) { }
                PostThreadMessage(messageThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            });
            input.IsBackground = true;
            input.Start();
            Console.Out.WriteLine("READY");
            Console.Out.Flush();
            int status;
            while ((status = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            if (status < 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }
    }
}
'@

try {
    [FoliaWidgetRightClick]::Run($WindowHandle, [bool]$Probe)
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
