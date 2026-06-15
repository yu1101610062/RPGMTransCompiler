param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$ScreenshotPath,
  [int]$WaitSeconds = 5
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  public static string Text(IntPtr hWnd) {
    var sb = new StringBuilder(2048);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static string ClassName(IntPtr hWnd) {
    var sb = new StringBuilder(256);
    GetClassName(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static List<Dictionary<string, object>> WindowsForPid(uint pid) {
    var list = new List<Dictionary<string, object>>();
    EnumWindows((hWnd, lParam) => {
      uint currentPid;
      GetWindowThreadProcessId(hWnd, out currentPid);
      if (currentPid == pid && IsWindowVisible(hWnd)) {
        var children = new List<Dictionary<string, string>>();
        EnumChildWindows(hWnd, (child, cp) => {
          var childText = Text(child);
          var childClass = ClassName(child);
          if (!String.IsNullOrWhiteSpace(childText) || !String.IsNullOrWhiteSpace(childClass)) {
            children.Add(new Dictionary<string, string> {
              {"className", childClass},
              {"text", childText}
            });
          }
          return true;
        }, IntPtr.Zero);
        list.Add(new Dictionary<string, object> {
          {"handle", hWnd.ToInt64()},
          {"title", Text(hWnd)},
          {"className", ClassName(hWnd)},
          {"children", children}
        });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$proc = Start-Process -FilePath $ExePath -WorkingDirectory $WorkingDirectory -PassThru
Start-Sleep -Seconds $WaitSeconds

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ScreenshotPath) | Out-Null
$bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

$windows = [WindowProbe]::WindowsForPid([uint32]$proc.Id)
$exited = $proc.HasExited
$exitCode = $null
if ($exited) { $exitCode = $proc.ExitCode }

if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[ordered]@{
  pid = $proc.Id
  exited = $exited
  exitCode = $exitCode
  screenshotPath = $ScreenshotPath
  windows = $windows
} | ConvertTo-Json -Depth 8
