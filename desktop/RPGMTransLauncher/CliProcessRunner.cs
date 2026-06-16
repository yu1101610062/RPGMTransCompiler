using System.Diagnostics;
using System.Text;

namespace RPGMTransLauncher;

internal sealed class CliProcessRunner : IDisposable
{
    private readonly Func<IReadOnlyDictionary<string, string>> _environmentProvider;
    private readonly Action<string> _appendLog;
    private readonly Func<string, string> _redact;
    private readonly Action<int?> _watcherExited;
    private Process? _watcher;
    private string? _projectRoot;

    public CliProcessRunner(
        Func<IReadOnlyDictionary<string, string>> environmentProvider,
        Action<string> appendLog,
        Func<string, string> redact,
        Action<int?> watcherExited)
    {
        _environmentProvider = environmentProvider;
        _appendLog = appendLog;
        _redact = redact;
        _watcherExited = watcherExited;
    }

    public string? ProjectRoot => _projectRoot ??= LauncherPaths.FindProjectRoot();

    public bool IsWatcherRunning => _watcher is { HasExited: false };

    public async Task EnsureCliBuiltAsync()
    {
        var root = RequireProjectRoot();
        if (File.Exists(Path.Combine(root, "dist", "cli.js"))) return;
        _appendLog("未找到 dist/cli.js，开始构建 TypeScript。");
        await RunProcessAsync("npm.cmd", "run build");
    }

    public async Task RunCliAsync(string command, string args)
    {
        _ = RequireProjectRoot();
        await RunProcessAsync(ResolveNodeExecutable(), $"dist/cli.js {command} {args}");
    }

    public async Task<string> RunCliCaptureAsync(string command, string args)
    {
        _ = RequireProjectRoot();
        return await RunProcessCaptureAsync(ResolveNodeExecutable(), $"dist/cli.js {command} {args}");
    }

    public void StartWatcher(string dbPath, string provider, bool skipTranslated)
    {
        var skipArg = skipTranslated ? "" : " --no-skip-translated";
        _watcher = StartProcess(
            ResolveNodeExecutable(),
            $"dist/cli.js watch {LauncherPaths.Quote(dbPath)} --provider {provider} --batch-size 20 --concurrency 100{skipArg}",
            keepAlive: true);
    }

    public void StopWatcher()
    {
        StopWatcherCoreAsync(throwOnError: false).ConfigureAwait(false).GetAwaiter().GetResult();
    }

    public Task StopWatcherAsync()
    {
        return StopWatcherCoreAsync(throwOnError: true);
    }

    private async Task StopWatcherCoreAsync(bool throwOnError)
    {
        var process = _watcher;
        if (process == null) return;
        _watcher = null;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
                await Task.Delay(150).ConfigureAwait(false);
            }
            _appendLog("监听已停止。");
        }
        catch (Exception ex) when (!throwOnError)
        {
            _appendLog($"停止监听失败: {ex.Message}");
        }
        finally
        {
            process.Dispose();
        }
    }

    public void Dispose()
    {
        StopWatcher();
    }

    private string RequireProjectRoot()
    {
        var root = ProjectRoot;
        if (root == null)
        {
            throw new InvalidOperationException(
                "无法定位 RPGMTransCompiler 工具目录。请使用发布目录中的完整启动器文件夹运行，或设置环境变量 RPGMTRANS_COMPILER_ROOT 指向工具目录。");
        }
        return root;
    }

    private string ResolveNodeExecutable()
    {
        var root = RequireProjectRoot();
        var bundled = Path.Combine(root, "node", "node.exe");
        return File.Exists(bundled) ? bundled : "node";
    }

    private async Task RunProcessAsync(string fileName, string arguments)
    {
        using var process = StartProcess(fileName, arguments, keepAlive: false);
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"{fileName} {_redact(arguments)} 退出码 {process.ExitCode}");
        }
    }

    private async Task<string> RunProcessCaptureAsync(string fileName, string arguments)
    {
        var root = RequireProjectRoot();
        _appendLog($"> {fileName} {_redact(arguments)}");
        using var process = new Process
        {
            StartInfo = CreateStartInfo(fileName, arguments, root)
        };
        if (!process.Start()) throw new InvalidOperationException($"无法启动进程: {fileName}");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (!string.IsNullOrWhiteSpace(stderr)) _appendLog(_redact(stderr.Trim()));
        if (!string.IsNullOrWhiteSpace(stdout)) _appendLog(_redact(stdout.Trim()));
        if (process.ExitCode != 0) throw new InvalidOperationException($"{fileName} {_redact(arguments)} exit code {process.ExitCode}");
        return stdout;
    }

    private Process StartProcess(string fileName, string arguments, bool keepAlive)
    {
        var root = RequireProjectRoot();
        _appendLog($"> {fileName} {_redact(arguments)}");
        var process = new Process
        {
            StartInfo = CreateStartInfo(fileName, arguments, root),
            EnableRaisingEvents = true
        };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) _appendLog(_redact(e.Data)); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) _appendLog(_redact(e.Data)); };
        process.Exited += (_, _) =>
        {
            if (!keepAlive) return;
            if (!ReferenceEquals(_watcher, process)) return;
            var exitCode = TryGetExitCode(process);
            _watcher = null;
            _watcherExited(exitCode);
        };
        if (!process.Start()) throw new InvalidOperationException($"无法启动进程: {fileName}");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private ProcessStartInfo CreateStartInfo(string fileName, string arguments, string root)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true
        };
        ApplyProviderEnvironment(startInfo);
        return startInfo;
    }

    private void ApplyProviderEnvironment(ProcessStartInfo startInfo)
    {
        foreach (var (key, value) in _environmentProvider())
        {
            if (!string.IsNullOrWhiteSpace(value)) startInfo.Environment[key] = value.Trim();
        }
    }

    private static int? TryGetExitCode(Process process)
    {
        try
        {
            return process.ExitCode;
        }
        catch
        {
            return null;
        }
    }
}
