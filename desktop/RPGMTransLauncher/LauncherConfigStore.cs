using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RPGMTransLauncher;

internal static class LauncherConfigStore
{
    public static string ConfigFilePath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RPGMTransCompiler",
            "launcher.config.json");
    }

    public static LauncherConfig Load()
    {
        var file = ConfigFilePath();
        if (!File.Exists(file)) return new LauncherConfig();
        try
        {
            return JsonSerializer.Deserialize<LauncherConfig>(LauncherPaths.ReadAllTextShared(file)) ?? new LauncherConfig();
        }
        catch
        {
            return new LauncherConfig();
        }
    }

    public static void Save(LauncherConfig config)
    {
        var file = ConfigFilePath();
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(file, json, Encoding.UTF8);
    }

    public static string? ProtectSecret(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value.Trim()), null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(bytes);
    }

    public static string? UnprotectSecret(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        try
        {
            var bytes = ProtectedData.Unprotect(Convert.FromBase64String(value), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return null;
        }
    }

    public static string? EmptyToNull(string value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
