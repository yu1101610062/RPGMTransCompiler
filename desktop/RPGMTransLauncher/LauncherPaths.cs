using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RPGMTransLauncher;

internal static class LauncherPaths
{
    public static DerivedPaths DeriveFromExe(string exePath, string? projectRoot)
    {
        var exe = Path.GetFullPath(exePath);
        var source = Path.GetDirectoryName(exe);
        if (string.IsNullOrWhiteSpace(source)) throw new InvalidOperationException("无法从游戏 exe 推导游戏目录。");

        var manifest = TryReadRuntimeManifest(source);
        var id = ShortHash(source);
        var dbPath = projectRoot != null
            ? Path.Combine(projectRoot, "work", "launcher", $"{Path.GetFileName(source)}-{id}", "project.sqlite")
            : Path.Combine(source, "RPGMTransRuntime", "work", id, "project.sqlite");

        return new DerivedPaths(source, source, dbPath, manifest?.TargetLang, manifest != null);
    }

    public static RuntimeManifestInfo? TryReadRuntimeManifest(string gameRoot)
    {
        var file = Path.Combine(gameRoot, "RPGMTransRuntime", "manifest.json");
        if (!File.Exists(file)) return null;
        try
        {
            using var doc = JsonDocument.Parse(ReadAllTextShared(file));
            var root = doc.RootElement;
            return new RuntimeManifestInfo
            {
                SourceRoot = root.TryGetProperty("sourceRoot", out var sourceRoot) ? sourceRoot.GetString() : null,
                TargetLang = root.TryGetProperty("targetLang", out var targetLang) ? targetLang.GetString() : null
            };
        }
        catch
        {
            return null;
        }
    }

    public static string? FindProjectRoot()
    {
        var candidates = new List<string?>
        {
            Environment.GetEnvironmentVariable("RPGMTRANS_COMPILER_ROOT"),
            AppContext.BaseDirectory,
            Environment.CurrentDirectory,
            Path.GetDirectoryName(Process.GetCurrentProcess().MainModule?.FileName ?? "")
        };

        foreach (var candidate in candidates.Where(item => !string.IsNullOrWhiteSpace(item)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var found = SearchUp(candidate!, 20);
            if (found != null) return found;

            foreach (var childName in new[] { "RPGMTransCompiler", "app", "tool" })
            {
                var child = Path.Combine(candidate!, childName);
                if (IsToolRoot(child)) return child;
            }
        }

        return null;
    }

    public static string? SearchUp(string start, int maxDepth)
    {
        var dir = Directory.Exists(start) ? start : Path.GetDirectoryName(start);
        for (var i = 0; i < maxDepth && !string.IsNullOrWhiteSpace(dir); i++)
        {
            if (IsToolRoot(dir)) return dir;
            dir = Directory.GetParent(dir)?.FullName;
        }
        return null;
    }

    public static bool IsToolRoot(string dir)
    {
        return Directory.Exists(dir)
            && File.Exists(Path.Combine(dir, "package.json"))
            && File.Exists(Path.Combine(dir, "dist", "cli.js"))
            && File.Exists(Path.Combine(dir, "scripts", "rgss_bridge.rb"));
    }

    public static string? FindLaunchExe(string root)
    {
        foreach (var name in new[] { "Game.exe", "RPG_RT.exe", "nw.exe" })
        {
            var file = Path.Combine(root, name);
            if (File.Exists(file)) return file;
        }
        return Directory.Exists(root) ? Directory.GetFiles(root, "*.exe").FirstOrDefault() : null;
    }

    public static string ReadAllTextShared(string file)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    public static string Quote(string value) => $"\"{value.Replace("\"", "\\\"")}\"";

    public static string ShortHash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant()[..12];
    }
}
