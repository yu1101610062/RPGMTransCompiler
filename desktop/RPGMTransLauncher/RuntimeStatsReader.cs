using System.Text;
using System.Text.Json;

namespace RPGMTransLauncher;

internal static class RuntimeStatsReader
{
    public static string ReadSummary(string outputRoot, bool skipTranslated, bool watcherRunning)
    {
        try
        {
            var runtime = Path.Combine(outputRoot, "RPGMTransRuntime");
            var requests = Path.Combine(runtime, "requests");
            var cache = Path.Combine(runtime, "cache", "translations.rtc");
            var pretranslate = Path.Combine(runtime, "cache", "pretranslate.json");
            var requestLines = Directory.Exists(requests)
                ? Directory.GetFiles(requests, "*.rtlog").Sum(file => CountLinesStartingWith(file, "1\t"))
                : 0;
            var cacheLines = File.Exists(cache)
                ? CountLinesStartingWith(cache, "1\t")
                : 0;
            var pretranslateStats = ReadPretranslateStats(pretranslate);
            var pretranslateText = pretranslateStats.BatchesTotal > 0 && pretranslateStats.Phase != "done"
                ? $"{pretranslateStats.Translated}({pretranslateStats.BatchesCompleted}/{pretranslateStats.BatchesTotal}, 运行 {pretranslateStats.InFlight})"
                : pretranslateStats.Translated.ToString();
            var skipText = skipTranslated ? "开" : "关";
            return $"请求 {requestLines} / 缓存 {cacheLines} / 预翻译 {pretranslateText} / 跳过已译 {skipText} / 监听 {(watcherRunning ? "运行中" : "未运行")}";
        }
        catch
        {
            return "";
        }
    }

    private static PretranslateStats ReadPretranslateStats(string file)
    {
        if (!File.Exists(file)) return new PretranslateStats();
        try
        {
            using var doc = JsonDocument.Parse(LauncherPaths.ReadAllTextShared(file));
            return new PretranslateStats
            {
                Phase = ReadString(doc.RootElement, "phase"),
                Translated = ReadInt(doc.RootElement, "translated"),
                BatchesCompleted = ReadInt(doc.RootElement, "batchesCompleted"),
                BatchesTotal = ReadInt(doc.RootElement, "batchesTotal"),
                InFlight = ReadInt(doc.RootElement, "inFlight")
            };
        }
        catch
        {
            return new PretranslateStats();
        }
    }

    private static int CountLinesStartingWith(string file, string prefix)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            var count = 0;
            while (reader.ReadLine() is { } line)
            {
                if (line.StartsWith(prefix, StringComparison.Ordinal)) count++;
            }
            return count;
        }
        catch
        {
            return 0;
        }
    }

    private static int ReadInt(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.TryGetInt32(out var count) ? count : 0;
    }

    private static string ReadString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) ? value.GetString() ?? "" : "";
    }
}
