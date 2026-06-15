using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RPGMTransLauncher;

public sealed class Form1 : Form
{
    private readonly TextBox _exePath = new();
    private readonly TextBox _sourceRoot = new();
    private readonly TextBox _outputRoot = new();
    private readonly TextBox _dbPath = new();
    private readonly TextBox _targetLang = new();
    private readonly ComboBox _provider = new();
    private readonly TextBox _baseUrl = new();
    private readonly TextBox _model = new();
    private readonly TextBox _apiKey = new();
    private readonly CheckBox _showKey = new();
    private readonly CheckBox _autoRunOnDrop = new();
    private readonly CheckBox _skipTranslated = new();
    private readonly RichTextBox _log = new();
    private readonly Label _status = new();
    private readonly Label _stats = new();
    private readonly Panel _dropPanel = new();
    private readonly System.Windows.Forms.Timer _statsTimer = new();
    private readonly List<Control> _busyControls = new();

    private Process? _watcher;
    private string? _projectRoot;
    private string? _watcherConfigSignature;
    private LauncherConfig _config = new();
    private bool _loadingConfig;
    private bool _restartingWatcher;
    private readonly string? _initialExe;

    public Form1(string? initialExe = null)
    {
        _initialExe = initialExe;
        Text = "RPGMTransCompiler 本地运行时翻译启动器";
        MinimumSize = new Size(1060, 760);
        Size = new Size(1180, 820);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9F);
        AllowDrop = true;

        BuildUi();
        WireEvents();
        SetDefaults();
        Shown += async (_, _) => await HandleInitialExeAsync();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        StopWatcher();
        base.OnFormClosing(e);
    }

    private void BuildUi()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 5,
            Padding = new Padding(14),
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 96));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 228));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 126));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        Controls.Add(root);

        _dropPanel.Dock = DockStyle.Fill;
        _dropPanel.BorderStyle = BorderStyle.FixedSingle;
        _dropPanel.BackColor = Color.FromArgb(245, 248, 252);
        _dropPanel.AllowDrop = true;
        _dropPanel.Cursor = Cursors.Hand;
        var dropText = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Text = "拖入游戏启动程序 exe\n或点击选择要注入运行时翻译插件的游戏 exe",
            Font = new Font(Font.FontFamily, 13F, FontStyle.Bold),
            ForeColor = Color.FromArgb(38, 58, 86)
        };
        _dropPanel.Controls.Add(dropText);
        root.Controls.Add(_dropPanel, 0, 0);

        var settings = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 7,
            Padding = new Padding(0, 12, 0, 0),
        };
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 116));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 112));
        for (var i = 0; i < 7; i++) settings.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        root.Controls.Add(settings, 0, 1);

        AddPathRow(settings, 0, "游戏 exe", _exePath, "选择 exe", ChooseExe);
        AddPathRow(settings, 1, "游戏目录", _sourceRoot, "打开目录", () => ChooseFolder(_sourceRoot));
        AddPathRow(settings, 2, "注入目录", _outputRoot, "打开目录", () => ChooseFolder(_outputRoot));
        AddPathRow(settings, 3, "项目库", _dbPath, "自动生成", FillDerivedPaths);

        AddLabel(settings, "目标语言", 0, 4);
        _targetLang.Dock = DockStyle.Fill;
        settings.Controls.Add(_targetLang, 1, 4);
        AddLabel(settings, "Provider", 2, 4);
        _provider.Dock = DockStyle.Fill;
        _provider.DropDownStyle = ComboBoxStyle.DropDownList;
        _provider.Items.AddRange(["mock", "deepseek", "openai"]);
        settings.Controls.Add(_provider, 3, 4);

        AddLabel(settings, "API Base", 0, 5);
        _baseUrl.Dock = DockStyle.Fill;
        settings.Controls.Add(_baseUrl, 1, 5);
        AddLabel(settings, "模型", 2, 5);
        _model.Dock = DockStyle.Fill;
        settings.Controls.Add(_model, 3, 5);

        AddLabel(settings, "API Key", 0, 6);
        _apiKey.Dock = DockStyle.Fill;
        _apiKey.UseSystemPasswordChar = true;
        _apiKey.PlaceholderText = "留空时读取 DEEPSEEK_API_KEY / .env.local";
        settings.Controls.Add(_apiKey, 1, 6);
        _showKey.Text = "显示密钥";
        _showKey.Dock = DockStyle.Fill;
        settings.Controls.Add(_showKey, 2, 6);
        var openOut = new Button { Text = "打开目录", Dock = DockStyle.Fill };
        openOut.Click += (_, _) => OpenFolder(_outputRoot.Text);
        settings.Controls.Add(openOut, 3, 6);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            Padding = new Padding(0, 10, 0, 0)
        };
        root.Controls.Add(actions, 0, 2);

        _autoRunOnDrop.Text = "拖入后自动注入并启动";
        _autoRunOnDrop.Checked = true;
        _autoRunOnDrop.Width = 172;
        _autoRunOnDrop.Height = 38;
        _autoRunOnDrop.TextAlign = ContentAlignment.MiddleLeft;
        _autoRunOnDrop.Margin = new Padding(0, 7, 12, 10);
        actions.Controls.Add(_autoRunOnDrop);

        _skipTranslated.Text = "跳过已翻译条目";
        _skipTranslated.Checked = true;
        _skipTranslated.Width = 150;
        _skipTranslated.Height = 38;
        _skipTranslated.TextAlign = ContentAlignment.MiddleLeft;
        _skipTranslated.Margin = new Padding(0, 7, 12, 10);
        actions.Controls.Add(_skipTranslated);

        AddButton(actions, "扫描", async () => await RunScanAsync());
        AddButton(actions, "注入插件", async () => await RunInstallAsync());
        AddButton(actions, "还原", async () => await RunRestoreAsync());
        AddButton(actions, "启动监听", async () => await StartWatcherAsync());
        AddButton(actions, "停止监听", () => StopWatcher());
        AddButton(actions, "启动游戏", () => LaunchGame());
        AddButton(actions, "扫描并预翻译缓存", async () => await RunPretranslateAsync(), 170);
        AddButton(actions, "一键注入并启动", async () => await OneClickAsync(), 150);
        AddButton(actions, "生成报告", async () => await RunCliAsync("report", Quote(_dbPath.Text)));

        _log.Dock = DockStyle.Fill;
        _log.ReadOnly = true;
        _log.BackColor = Color.FromArgb(18, 24, 33);
        _log.ForeColor = Color.FromArgb(228, 236, 245);
        _log.Font = new Font("Consolas", 10F);
        root.Controls.Add(_log, 0, 3);

        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
        _status.Dock = DockStyle.Fill;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _stats.Dock = DockStyle.Fill;
        _stats.TextAlign = ContentAlignment.MiddleRight;
        footer.Controls.Add(_status, 0, 0);
        footer.Controls.Add(_stats, 1, 0);
        root.Controls.Add(footer, 0, 4);
    }

    private void WireEvents()
    {
        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;
        _dropPanel.DragEnter += OnDragEnter;
        _dropPanel.DragDrop += OnDragDrop;
        _dropPanel.Click += (_, _) => ChooseExe();
        foreach (Control child in _dropPanel.Controls) child.Click += (_, _) => ChooseExe();
        _exePath.TextChanged += (_, _) => FillDerivedPaths();
        _provider.SelectedIndexChanged += (_, _) =>
        {
            FillProviderDefaults(loadSaved: true);
            SaveLauncherConfig();
        };
        _baseUrl.TextChanged += (_, _) => SaveLauncherConfig();
        _model.TextChanged += (_, _) => SaveLauncherConfig();
        _apiKey.TextChanged += (_, _) => SaveLauncherConfig();
        _showKey.CheckedChanged += (_, _) => _apiKey.UseSystemPasswordChar = !_showKey.Checked;
        _skipTranslated.CheckedChanged += async (_, _) =>
        {
            SaveLauncherConfig();
            if (!_loadingConfig) await RestartWatcherForConfigChangeAsync();
        };
        _statsTimer.Interval = 1000;
        _statsTimer.Tick += (_, _) => UpdateStats();
        _statsTimer.Start();
    }

    private void SetDefaults()
    {
        _loadingConfig = true;
        try
        {
            _config = LoadLauncherConfig();
            _targetLang.Text = "zh-Hans";
            _skipTranslated.Checked = _config.SkipTranslated ?? true;
            _provider.SelectedItem = string.IsNullOrWhiteSpace(_config.Provider) ? "deepseek" : _config.Provider;
            if (_provider.SelectedItem == null) _provider.SelectedItem = "deepseek";
            FillProviderDefaults(loadSaved: true);
            _status.Text = "等待拖入游戏 exe";
            _projectRoot = FindProjectRoot();
        }
        finally
        {
            _loadingConfig = false;
        }
        AppendLog($"项目目录: {_projectRoot ?? "未找到"}");
        AppendLog("默认使用 DeepSeek；API Key 已按当前 Windows 用户加密保存到本地配置。");
    }

    private void AddPathRow(TableLayoutPanel layout, int row, string label, TextBox box, string buttonText, Action action)
    {
        AddLabel(layout, label, 0, row);
        box.Dock = DockStyle.Fill;
        layout.Controls.Add(box, 1, row);
        layout.SetColumnSpan(box, 2);
        var button = new Button { Text = buttonText, Dock = DockStyle.Fill };
        button.Click += (_, _) => action();
        layout.Controls.Add(button, 3, row);
    }

    private static void AddLabel(TableLayoutPanel layout, string text, int column, int row)
    {
        layout.Controls.Add(new Label
        {
            Text = text,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft
        }, column, row);
    }

    private void AddButton(FlowLayoutPanel panel, string text, Func<Task> action, int width = 112)
    {
        var button = NewActionButton(text, width);
        button.Click += async (_, _) => await GuardAsync(action);
        panel.Controls.Add(button);
    }

    private void AddButton(FlowLayoutPanel panel, string text, Action action, int width = 112)
    {
        var button = NewActionButton(text, width);
        button.Click += (_, _) => action();
        panel.Controls.Add(button);
    }

    private Button NewActionButton(string text, int width)
    {
        var button = new Button
        {
            Text = text,
            Width = width,
            Height = 38,
            TextAlign = ContentAlignment.MiddleCenter,
            Padding = new Padding(0, 2, 0, 3),
            Margin = new Padding(0, 0, 8, 10)
        };
        _busyControls.Add(button);
        return button;
    }

    private async Task GuardAsync(Func<Task> action)
    {
        try
        {
            SetBusy(true);
            await action();
        }
        catch (Exception ex)
        {
            AppendLog($"错误: {ex.Message}");
            MessageBox.Show(this, ex.Message, "执行失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        foreach (var control in _busyControls) control.Enabled = !busy;
        Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
    }

    private void ChooseExe()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "选择游戏启动程序",
            Filter = "游戏启动程序 (*.exe)|*.exe|所有文件 (*.*)|*.*"
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) SetExePath(dialog.FileName);
    }

    private void ChooseFolder(TextBox box)
    {
        using var dialog = new FolderBrowserDialog
        {
            SelectedPath = Directory.Exists(box.Text) ? box.Text : ""
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
    }

    private void OnDragEnter(object? sender, DragEventArgs e)
    {
        e.Effect = e.Data?.GetDataPresent(DataFormats.FileDrop) == true ? DragDropEffects.Copy : DragDropEffects.None;
    }

    private void OnDragDrop(object? sender, DragEventArgs e)
    {
        if (e.Data?.GetData(DataFormats.FileDrop) is not string[] files || files.Length == 0) return;
        var file = files[0];
        var accepted = false;
        if (Directory.Exists(file))
        {
            var exe = Directory.GetFiles(file, "*.exe").FirstOrDefault();
            if (exe != null)
            {
                SetExePath(exe);
                accepted = true;
            }
        }
        else if (Path.GetExtension(file).Equals(".exe", StringComparison.OrdinalIgnoreCase))
        {
            SetExePath(file);
            accepted = true;
        }
        if (accepted && _autoRunOnDrop.Checked && File.Exists(_exePath.Text))
        {
            _ = GuardAsync(OneClickAsync);
        }
    }

    private void SetExePath(string exe)
    {
        _exePath.Text = exe;
        FillDerivedPaths();
        AppendLog($"已选择游戏: {exe}");
        var dir = Path.GetDirectoryName(Path.GetFullPath(exe));
        if (!string.IsNullOrWhiteSpace(dir) && TryReadRuntimeManifest(dir) != null)
        {
            AppendLog("检测到已注入运行时插件的游戏目录，将原地更新插件并复用现有翻译缓存。");
        }
    }

    private async Task HandleInitialExeAsync()
    {
        if (string.IsNullOrWhiteSpace(_initialExe)) return;
        if (!File.Exists(_initialExe)) return;
        SetExePath(_initialExe);
        if (_autoRunOnDrop.Checked) await GuardAsync(OneClickAsync);
    }

    private void FillDerivedPaths()
    {
        if (string.IsNullOrWhiteSpace(_exePath.Text)) return;
        var exe = Path.GetFullPath(_exePath.Text);
        var source = Path.GetDirectoryName(exe);
        if (string.IsNullOrWhiteSpace(source)) return;
        var manifest = TryReadRuntimeManifest(source);
        if (manifest != null)
        {
            if (!string.IsNullOrWhiteSpace(manifest.TargetLang)) _targetLang.Text = manifest.TargetLang;
        }
        _sourceRoot.Text = source;
        _outputRoot.Text = source;
        var root = RequireProjectRoot(false);
        if (root != null)
        {
            var id = ShortHash(source);
            _dbPath.Text = Path.Combine(root, "work", "launcher", $"{Path.GetFileName(source)}-{id}", "project.sqlite");
        }
        else
        {
            var id = ShortHash(source);
            _dbPath.Text = Path.Combine(source, "RPGMTransRuntime", "work", $"{id}", "project.sqlite");
        }
    }

    private static RuntimeManifestInfo? TryReadRuntimeManifest(string gameRoot)
    {
        var file = Path.Combine(gameRoot, "RPGMTransRuntime", "manifest.json");
        if (!File.Exists(file)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
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

    private void FillProviderDefaults(bool loadSaved = false)
    {
        var selected = _provider.SelectedItem?.ToString() ?? "mock";
        if (selected == "deepseek")
        {
            if (loadSaved || string.IsNullOrWhiteSpace(_baseUrl.Text))
                _baseUrl.Text = _config.DeepSeekBaseUrl ?? FirstEnvironment("DEEPSEEK_BASE_URL", "OPENAI_BASE_URL") ?? "https://api.deepseek.com";
            if (loadSaved || string.IsNullOrWhiteSpace(_model.Text))
                _model.Text = _config.DeepSeekModel ?? FirstEnvironment("DEEPSEEK_MODEL", "OPENAI_MODEL") ?? "deepseek-v4-flash";
            if (loadSaved)
                _apiKey.Text = UnprotectSecret(_config.DeepSeekApiKeyProtected) ?? FirstEnvironment("DEEPSEEK_API_KEY", "OPENAI_API_KEY") ?? "";
        }
        else if (selected == "openai")
        {
            if (loadSaved || string.IsNullOrWhiteSpace(_baseUrl.Text))
                _baseUrl.Text = _config.OpenAiBaseUrl ?? FirstEnvironment("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
            if (loadSaved || string.IsNullOrWhiteSpace(_model.Text))
                _model.Text = _config.OpenAiModel ?? FirstEnvironment("OPENAI_MODEL") ?? "";
            if (loadSaved)
                _apiKey.Text = UnprotectSecret(_config.OpenAiApiKeyProtected) ?? FirstEnvironment("OPENAI_API_KEY") ?? "";
        }
        else if (selected == "mock" && loadSaved)
        {
            _apiKey.Text = "";
        }
    }

    private async Task OneClickAsync()
    {
        await RunScanAsync();
        await RunInstallAsync();
        await StartWatcherAsync();
        LaunchGame();
    }

    private async Task RunScanAsync()
    {
        ValidatePaths(forInstall: false);
        await EnsureCliBuiltAsync();
        await RunCliAsync("scan", $"{Quote(_sourceRoot.Text)} --db {Quote(_dbPath.Text)} --out {Quote(_outputRoot.Text)} --target {Quote(_targetLang.Text)}");
        _status.Text = "扫描完成";
    }

    private async Task RunInstallAsync()
    {
        ValidatePaths(forInstall: true);
        await EnsureCliBuiltAsync();
        await RunCliAsync("install-runtime", Quote(_dbPath.Text));
        await RunCliAsync("validate-runtime", Quote(_dbPath.Text));
        _status.Text = "插件已注入，原文件已备份";
        UpdateStats();
    }

    private async Task RunRestoreAsync()
    {
        ValidatePaths(forInstall: false);
        StopWatcher();
        await RunScanAsync();
        await RunCliAsync("restore-runtime", Quote(_dbPath.Text));
        _status.Text = "已还原原始文件";
        UpdateStats();
    }

    private async Task RunPretranslateAsync()
    {
        await RunScanAsync();
        await RunInstallAsync();
        var provider = _provider.SelectedItem?.ToString() ?? "mock";
        var overwrite = _skipTranslated.Checked ? "" : " --overwrite";
        await RunCliAsync("pretranslate", $"{Quote(_dbPath.Text)} --provider {provider} --mode safe --batch-size 20 --concurrency 100 --progress{overwrite}");
        _status.Text = "预翻译缓存完成";
        UpdateStats();
    }

    private async Task StartWatcherAsync()
    {
        ValidatePaths(forInstall: true);
        var provider = _provider.SelectedItem?.ToString() ?? "mock";
        var configSignature = WatcherConfigSignature(provider);
        if (_watcher is { HasExited: false })
        {
            if (_watcherConfigSignature == configSignature)
            {
                AppendLog("监听已经在运行。");
                return;
            }
            AppendLog("监听配置已变更，重启监听进程。");
            StopWatcher();
        }
        await EnsureCliBuiltAsync();
        var skipArg = _skipTranslated.Checked ? "" : " --no-skip-translated";
        _watcher = StartProcess("node", $"dist/cli.js watch {Quote(_dbPath.Text)} --provider {provider} --batch-size 20 --concurrency 100{skipArg}", keepAlive: true);
        _watcherConfigSignature = configSignature;
        _status.Text = $"监听中: {provider}";
        AppendLog("监听已启动。首次缺译显示原文，翻译完成后写入缓存，游戏会自动重载。");
    }

    private async Task RestartWatcherForConfigChangeAsync()
    {
        if (_restartingWatcher) return;
        if (_watcher is not { HasExited: false }) return;
        _restartingWatcher = true;
        try
        {
            AppendLog("跳过已翻译条目设置已变更，正在重启监听使其立即生效。");
            await GuardAsync(StartWatcherAsync);
        }
        finally
        {
            _restartingWatcher = false;
        }
    }

    private void StopWatcher()
    {
        if (_watcher == null) return;
        try
        {
            if (!_watcher.HasExited) _watcher.Kill(entireProcessTree: true);
            AppendLog("监听已停止。");
        }
        catch (Exception ex)
        {
            AppendLog($"停止监听失败: {ex.Message}");
        }
        finally
        {
            _watcher.Dispose();
            _watcher = null;
            _watcherConfigSignature = null;
            _status.Text = "监听已停止";
        }
    }

    private void LaunchGame()
    {
        ValidatePaths(forInstall: true);
        var exe = FindLaunchExe(_outputRoot.Text);
        if (exe == null) throw new InvalidOperationException($"游戏目录没有找到可启动 exe: {_outputRoot.Text}");
        Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
            UseShellExecute = true
        });
        _status.Text = "游戏已启动";
        AppendLog($"启动游戏: {exe}");
    }

    private async Task EnsureCliBuiltAsync()
    {
        var root = RequireProjectRoot(true)!;
        if (File.Exists(Path.Combine(root, "dist", "cli.js"))) return;
        AppendLog("未找到 dist/cli.js，开始构建 TypeScript。");
        await RunProcessAsync("npm.cmd", "run build");
    }

    private async Task RunCliAsync(string command, string args)
    {
        await EnsureProjectReadyAsync();
        await RunProcessAsync("node", $"dist/cli.js {command} {args}");
    }

    private async Task EnsureProjectReadyAsync()
    {
        _ = RequireProjectRoot(true);
        await Task.CompletedTask;
    }

    private async Task RunProcessAsync(string fileName, string arguments)
    {
        using var process = StartProcess(fileName, arguments, keepAlive: false);
        await process.WaitForExitAsync();
        if (process.ExitCode != 0) throw new InvalidOperationException($"{fileName} {arguments} 退出码 {process.ExitCode}");
    }

    private Process StartProcess(string fileName, string arguments, bool keepAlive)
    {
        var root = RequireProjectRoot(true)!;
        AppendLog($"> {fileName} {Redact(arguments)}");
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
        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        process.Exited += (_, _) =>
        {
            if (!keepAlive) return;
            var exitCode = TryGetExitCode(process);
            try
            {
                if (IsDisposed || !IsHandleCreated) return;
                BeginInvoke(() =>
                {
                    try
                    {
                        AppendLog($"监听进程已退出，退出码 {exitCode?.ToString() ?? "未知"}");
                        if (ReferenceEquals(_watcher, process)) _watcher = null;
                        _status.Text = "监听未运行";
                    }
                    catch
                    {
                    }
                });
            }
            catch
            {
            }
        };
        if (!process.Start()) throw new InvalidOperationException($"无法启动进程: {fileName}");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
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

    private void ApplyProviderEnvironment(ProcessStartInfo startInfo)
    {
        var provider = _provider.SelectedItem?.ToString() ?? "mock";
        if (provider == "deepseek")
        {
            if (!string.IsNullOrWhiteSpace(_baseUrl.Text)) startInfo.Environment["DEEPSEEK_BASE_URL"] = _baseUrl.Text.Trim();
            if (!string.IsNullOrWhiteSpace(_model.Text)) startInfo.Environment["DEEPSEEK_MODEL"] = _model.Text.Trim();
            if (!string.IsNullOrWhiteSpace(_apiKey.Text)) startInfo.Environment["DEEPSEEK_API_KEY"] = _apiKey.Text.Trim();
        }
        if (provider == "openai")
        {
            if (!string.IsNullOrWhiteSpace(_baseUrl.Text)) startInfo.Environment["OPENAI_BASE_URL"] = _baseUrl.Text.Trim();
            if (!string.IsNullOrWhiteSpace(_model.Text)) startInfo.Environment["OPENAI_MODEL"] = _model.Text.Trim();
            if (!string.IsNullOrWhiteSpace(_apiKey.Text)) startInfo.Environment["OPENAI_API_KEY"] = _apiKey.Text.Trim();
        }
    }

    private void ValidatePaths(bool forInstall)
    {
        if (!File.Exists(_exePath.Text)) throw new InvalidOperationException("请先拖入或选择游戏 exe。");
        if (!Directory.Exists(_sourceRoot.Text)) throw new InvalidOperationException("游戏目录不存在。");
        if (string.IsNullOrWhiteSpace(_outputRoot.Text)) throw new InvalidOperationException("注入目录不能为空。");
        if (!Path.GetFullPath(_sourceRoot.Text).Equals(Path.GetFullPath(_outputRoot.Text), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("当前版本只在原游戏目录注入插件，不再生成汉化副本。请让游戏目录和注入目录保持一致。");
        if (string.IsNullOrWhiteSpace(_dbPath.Text)) throw new InvalidOperationException("项目库路径不能为空。");
        if (forInstall && !File.Exists(_dbPath.Text)) throw new InvalidOperationException("项目库不存在，请先扫描。");
    }

    private string? RequireProjectRoot(bool throwIfMissing)
    {
        _projectRoot ??= FindProjectRoot();
        if (_projectRoot == null && throwIfMissing)
        {
            throw new InvalidOperationException(
                "无法定位 RPGMTransCompiler 工具目录。请使用发布目录中的完整启动器文件夹运行，或设置环境变量 RPGMTRANS_COMPILER_ROOT 指向工具目录。");
        }
        return _projectRoot;
    }

    private static string? FindProjectRoot()
    {
        var candidates = new List<string?>();
        candidates.Add(Environment.GetEnvironmentVariable("RPGMTRANS_COMPILER_ROOT"));
        candidates.Add(AppContext.BaseDirectory);
        candidates.Add(Environment.CurrentDirectory);
        candidates.Add(Path.GetDirectoryName(Process.GetCurrentProcess().MainModule?.FileName ?? ""));
        candidates.Add(Path.GetDirectoryName(Application.ExecutablePath));

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

    private static string? SearchUp(string start, int maxDepth)
    {
        var dir = Directory.Exists(start) ? start : Path.GetDirectoryName(start);
        for (var i = 0; i < maxDepth && !string.IsNullOrWhiteSpace(dir); i++)
        {
            if (IsToolRoot(dir)) return dir;
            dir = Directory.GetParent(dir)?.FullName;
        }
        return null;
    }

    private static bool IsToolRoot(string dir)
    {
        return Directory.Exists(dir)
            && File.Exists(Path.Combine(dir, "package.json"))
            && File.Exists(Path.Combine(dir, "dist", "cli.js"))
            && File.Exists(Path.Combine(dir, "scripts", "rgss_bridge.rb"));
    }

    private void UpdateStats()
    {
        try
        {
            var runtime = Path.Combine(_outputRoot.Text, "RPGMTransRuntime");
            var requests = Path.Combine(runtime, "requests");
            var cache = Path.Combine(runtime, "cache", "translations.rtc");
            var pretranslate = Path.Combine(runtime, "cache", "pretranslate.json");
            var requestLines = Directory.Exists(requests)
                ? Directory.GetFiles(requests, "*.rtlog").Sum(file => File.ReadLines(file, Encoding.UTF8).Count(line => line.StartsWith("1\t")))
                : 0;
            var cacheLines = File.Exists(cache)
                ? File.ReadLines(cache, Encoding.UTF8).Count(line => line.StartsWith("1\t"))
                : 0;
            var pretranslateStats = ReadPretranslateStats(pretranslate);
            var pretranslateText = pretranslateStats.BatchesTotal > 0 && pretranslateStats.Phase != "done"
                ? $"{pretranslateStats.Translated}({pretranslateStats.BatchesCompleted}/{pretranslateStats.BatchesTotal}, 运行 {pretranslateStats.InFlight})"
                : pretranslateStats.Translated.ToString();
            var skipText = _skipTranslated.Checked ? "开" : "关";
            _stats.Text = $"请求 {requestLines} / 缓存 {cacheLines} / 预翻译 {pretranslateText} / 跳过已译 {skipText} / 监听 {(_watcher is { HasExited: false } ? "运行中" : "未运行")}";
        }
        catch
        {
            _stats.Text = "";
        }
    }

    private static PretranslateStats ReadPretranslateStats(string file)
    {
        if (!File.Exists(file)) return new PretranslateStats();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
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

    private static int ReadInt(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.TryGetInt32(out var count) ? count : 0;
    }

    private static string ReadString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) ? value.GetString() ?? "" : "";
    }

    private void AppendLog(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendLog(text));
            return;
        }
        var typedKey = _apiKey.Text.Trim();
        if (!string.IsNullOrWhiteSpace(typedKey)) text = text.Replace(typedKey, "***");
        if (text.Contains("API_KEY", StringComparison.OrdinalIgnoreCase)) text = Redact(text);
        if (text.StartsWith("[预翻译] ", StringComparison.Ordinal))
        {
            _status.Text = text.Length > 70 ? $"{text[..70]}..." : text;
        }
        _log.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}");
        _log.ScrollToCaret();
        UpdateStats();
    }

    private static string Quote(string value) => $"\"{value.Replace("\"", "\\\"")}\"";

    private static string Redact(string value)
    {
        return value
            .Replace(Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY") ?? "\0", "***")
            .Replace(Environment.GetEnvironmentVariable("OPENAI_API_KEY") ?? "\0", "***");
    }

    private static string ShortHash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant()[..12];
    }

    private static string? FindLaunchExe(string root)
    {
        foreach (var name in new[] { "Game.exe", "RPG_RT.exe", "nw.exe" })
        {
            var file = Path.Combine(root, name);
            if (File.Exists(file)) return file;
        }
        return Directory.Exists(root) ? Directory.GetFiles(root, "*.exe").FirstOrDefault() : null;
    }

    private static string? FirstEnvironment(params string[] names)
    {
        foreach (var name in names)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return null;
    }

    private string WatcherConfigSignature(string provider)
    {
        return ShortHash(string.Join("\n", [
            provider,
            _baseUrl.Text.Trim(),
            _model.Text.Trim(),
            _apiKey.Text.Trim(),
            _skipTranslated.Checked ? "skip-translated" : "overwrite-translated"
        ]));
    }

    private static string ConfigFilePath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RPGMTransCompiler",
            "launcher.config.json");
    }

    private static LauncherConfig LoadLauncherConfig()
    {
        var file = ConfigFilePath();
        if (!File.Exists(file)) return new LauncherConfig();
        try
        {
            return JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(file, Encoding.UTF8)) ?? new LauncherConfig();
        }
        catch
        {
            return new LauncherConfig();
        }
    }

    private void SaveLauncherConfig()
    {
        if (_loadingConfig) return;
        try
        {
            var provider = _provider.SelectedItem?.ToString() ?? "deepseek";
            _config.Provider = provider;
            _config.SkipTranslated = _skipTranslated.Checked;
            if (provider == "deepseek")
            {
                _config.DeepSeekBaseUrl = EmptyToNull(_baseUrl.Text);
                _config.DeepSeekModel = EmptyToNull(_model.Text);
                _config.DeepSeekApiKeyProtected = ProtectSecret(_apiKey.Text);
            }
            else if (provider == "openai")
            {
                _config.OpenAiBaseUrl = EmptyToNull(_baseUrl.Text);
                _config.OpenAiModel = EmptyToNull(_model.Text);
                _config.OpenAiApiKeyProtected = ProtectSecret(_apiKey.Text);
            }

            var file = ConfigFilePath();
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var json = JsonSerializer.Serialize(_config, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(file, json, Encoding.UTF8);
        }
        catch (Exception ex)
        {
            _status.Text = $"保存配置失败: {ex.Message}";
        }
    }

    private static string? EmptyToNull(string value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string? ProtectSecret(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value.Trim()), null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(bytes);
    }

    private static string? UnprotectSecret(string? value)
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

    private static void OpenFolder(string folder)
    {
        if (!Directory.Exists(folder)) return;
        Process.Start(new ProcessStartInfo { FileName = folder, UseShellExecute = true });
    }

    private sealed class LauncherConfig
    {
        public string? Provider { get; set; }
        public string? DeepSeekBaseUrl { get; set; }
        public string? DeepSeekModel { get; set; }
        public string? DeepSeekApiKeyProtected { get; set; }
        public string? OpenAiBaseUrl { get; set; }
        public string? OpenAiModel { get; set; }
        public string? OpenAiApiKeyProtected { get; set; }
        public bool? SkipTranslated { get; set; }
    }

    private sealed class PretranslateStats
    {
        public string Phase { get; set; } = "";
        public int Translated { get; set; }
        public int BatchesCompleted { get; set; }
        public int BatchesTotal { get; set; }
        public int InFlight { get; set; }
    }

    private sealed class RuntimeManifestInfo
    {
        public string? SourceRoot { get; set; }
        public string? TargetLang { get; set; }
    }
}
