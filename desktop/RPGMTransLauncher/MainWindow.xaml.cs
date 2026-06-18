using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace RPGMTransLauncher;

public sealed partial class MainWindow : Window
{
    private static readonly HttpClient ModelListHttp = new()
    {
        Timeout = TimeSpan.FromSeconds(30)
    };

    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const int GwlWndProc = -4;
    private const int WhMouseLl = 14;
    private const uint WmInput = 0x00FF;
    private const uint WmMouseWheel = 0x020A;
    private const uint RidInput = 0x10000003;
    private const uint RidevInputSink = 0x00000100;
    private const uint RimTypeMouse = 0;
    private const ushort HidUsagePageGeneric = 0x01;
    private const ushort HidUsageGenericMouse = 0x02;
    private const ushort RawMouseWheel = 0x0400;

    private readonly string? _initialExe;
    private readonly DispatcherQueueTimer _statsTimer;
    private readonly CliProcessRunner _runner;
    private readonly List<Control> _busyControls;
    private readonly List<string> _logLines = new();
    private readonly WndProcDelegate _wndProcDelegate;
    private readonly LowLevelMouseProcDelegate _mouseHookDelegate;
    private readonly List<TargetLanguageOption> _targetLanguages =
    [
        new("中文简体", "zh-Hans"),
        new("英文", "en"),
        new("日语", "ja")
    ];
    private readonly List<ModelFormatOption> _modelFormats =
    [
        new("OpenAI 新格式 / Responses API", "openai-responses"),
        new("OpenAI 旧格式 / Chat Completions", "openai-chat"),
        new("Anthropic Messages", "anthropic"),
        new("Google Gemini", "google")
    ];

    private LauncherConfig _config = new();
    private List<ModelSourceConfig> _modelSources = new();
    private List<ModelSourceItem> _modelSourceItems = new();
    private List<string> _modelSuggestions = new();
    private ModelSourceConfig? _editingSource;
    private string? _watcherConfigSignature;
    private string _exePath = "";
    private string _sourceRoot = "";
    private string _outputRoot = "";
    private string _dbPath = "";
    private string _engineName = "";
    private bool _loadingConfig;
    private bool _loadingModelSourceUi;
    private bool _restartingWatcher;
    private bool _syncingConfigApiKey;
    private bool _dragOverlayVisible;
    private string _redactionApiKey = "";
    private TaskCompletionSource<bool>? _bannerDecision;
    private IntPtr _hwnd;
    private IntPtr _oldWndProc;
    private IntPtr _mouseHook;

    public MainWindow(string? initialExe = null)
    {
        _initialExe = initialExe;
        InitializeComponent();
        _wndProcDelegate = WindowProc;
        _mouseHookDelegate = LowLevelMouseProc;

        _busyControls =
        [
            PretranslateButton,
            ToggleRuntimeButton,
            ToggleWatchButton,
            LaunchGameButton
        ];
        _runner = new CliProcessRunner(BuildProviderEnvironment, AppendLog, Redact, OnWatcherExited);
        _statsTimer = DispatcherQueue.CreateTimer();

        ConfigureWindow();
        SetDefaults();
        WireRuntimeEvents();
    }

    private ModelSourceConfig? SelectedModelSource => (ModelSourceBox.SelectedItem as ModelSourceItem)?.Source;
    private string SelectedProvider => SelectedModelSource == null ? "mock" : "configured";
    private string SelectedTargetLang => (TargetLangBox.SelectedItem as TargetLanguageOption)?.Code ?? "zh-Hans";

    private string ConfigApiKeyText
    {
        get => ConfigShowKeyBox.IsChecked == true ? ConfigApiKeyTextBox.Text : ConfigApiKeyPasswordBox.Password;
        set => SetConfigApiKeyText(value);
    }

    private void ConfigureWindow()
    {
        _hwnd = WindowNative.GetWindowHandle(this);
        _oldWndProc = SetWindowLongPtr(_hwnd, GwlWndProc, Marshal.GetFunctionPointerForDelegate(_wndProcDelegate));
        RegisterMouseRawInput();
        _ = SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, 1180, 820, SwpNoZOrder | SwpNoActivate);
    }

    private void WireRuntimeEvents()
    {
        RootGrid.Loaded += async (_, _) =>
        {
            InstallMouseHook();
            await HandleInitialExeAsync();
        };
        Closed += (_, _) =>
        {
            if (_hwnd != IntPtr.Zero && _oldWndProc != IntPtr.Zero)
            {
                _ = SetWindowLongPtr(_hwnd, GwlWndProc, _oldWndProc);
                _oldWndProc = IntPtr.Zero;
            }
            if (_mouseHook != IntPtr.Zero)
            {
                _ = UnhookWindowsHookEx(_mouseHook);
                _mouseHook = IntPtr.Zero;
            }
            _statsTimer.Stop();
            _runner.Dispose();
        };
        _statsTimer.Interval = TimeSpan.FromSeconds(1);
        _statsTimer.Tick += (_, _) => UpdateStats();
        _statsTimer.Start();
    }

    private void SetDefaults()
    {
        _loadingConfig = true;
        try
        {
            _config = LauncherConfigStore.Load();
            _modelSources = LoadModelSources(_config);
            TargetLangBox.ItemsSource = _targetLanguages;
            ConfigFormatBox.ItemsSource = _modelFormats;
            SelectTargetLanguage(_config.TargetLang ?? "zh-Hans");
            SkipTranslatedBox.IsChecked = _config.SkipTranslated ?? true;
            RefreshModelSourceLists(_config.SelectedModelSourceId);
            StatusText.Text = "等待拖入游戏 exe";
            UpdateActionButtons();
        }
        finally
        {
            _loadingConfig = false;
        }

        AppendLog($"项目目录: {_runner.ProjectRoot ?? "未找到"}");
        AppendLog("模型源配置按当前 Windows 用户加密保存到本地配置。");
    }

    private static List<ModelSourceConfig> LoadModelSources(LauncherConfig config)
    {
        var sources = config.ModelSources
            .Where(item => !string.IsNullOrWhiteSpace(item.Name) || !string.IsNullOrWhiteSpace(item.Model) || !string.IsNullOrWhiteSpace(item.BaseUrl))
            .ToList();
        if (sources.Count > 0) return sources;

        if (!string.IsNullOrWhiteSpace(config.DeepSeekModel) || !string.IsNullOrWhiteSpace(config.DeepSeekBaseUrl) || !string.IsNullOrWhiteSpace(config.DeepSeekApiKeyProtected))
        {
            sources.Add(new ModelSourceConfig
            {
                Id = "deepseek-openai-chat",
                Name = "DeepSeek（OpenAI 旧格式）",
                Format = "openai-chat",
                BaseUrl = config.DeepSeekBaseUrl ?? "https://api.deepseek.com",
                Model = config.DeepSeekModel ?? "deepseek-v4-flash",
                ApiKeyProtected = config.DeepSeekApiKeyProtected,
                InputTokenPricePerMillion = config.DeepSeekInputTokenPricePerMillion,
                OutputTokenPricePerMillion = config.DeepSeekOutputTokenPricePerMillion
            });
        }

        if (!string.IsNullOrWhiteSpace(config.OpenAiModel) || !string.IsNullOrWhiteSpace(config.OpenAiBaseUrl) || !string.IsNullOrWhiteSpace(config.OpenAiApiKeyProtected))
        {
            sources.Add(new ModelSourceConfig
            {
                Id = "openai-responses",
                Name = "OpenAI（新格式）",
                Format = "openai-responses",
                BaseUrl = config.OpenAiBaseUrl ?? "https://api.openai.com/v1",
                Model = config.OpenAiModel,
                ApiKeyProtected = config.OpenAiApiKeyProtected,
                InputTokenPricePerMillion = config.OpenAiInputTokenPricePerMillion,
                OutputTokenPricePerMillion = config.OpenAiOutputTokenPricePerMillion
            });
        }

        if (sources.Count == 0)
        {
            sources.Add(new ModelSourceConfig
            {
                Id = "deepseek-openai-chat",
                Name = "DeepSeek（OpenAI 旧格式）",
                Format = "openai-chat",
                BaseUrl = "https://api.deepseek.com",
                Model = "deepseek-v4-flash"
            });
        }

        return sources;
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
            await ShowMessageAsync("执行失败", ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        foreach (var control in _busyControls) control.IsEnabled = !busy;
        TargetLangBox.IsEnabled = !busy;
        ModelSourceBox.IsEnabled = !busy;
        RootGrid.AllowDrop = !busy;
        DropTarget.Opacity = busy ? 0.72 : 1;
        if (busy) HideDragOverlay();
    }

    private async Task ShowMessageAsync(string title, string message)
    {
        ShowBanner(title, message);
        await Task.CompletedTask;
    }

    private Task<bool> ConfirmPretranslateAsync(PretranslateEstimate estimate)
    {
        _bannerDecision?.TrySetResult(false);
        _bannerDecision = new TaskCompletionSource<bool>();
        ShowBanner("确认预翻译消耗", BuildPretranslateEstimateMessage(estimate), primaryText: "继续", secondaryText: "取消");
        return _bannerDecision.Task;
    }

    private void ShowBanner(string title, string message, string? primaryText = null, string? secondaryText = null)
    {
        if (_bannerDecision != null && string.IsNullOrWhiteSpace(primaryText) && string.IsNullOrWhiteSpace(secondaryText))
        {
            _bannerDecision.TrySetResult(false);
            _bannerDecision = null;
        }
        BannerTitleText.Text = title;
        BannerMessageText.Text = message;
        BannerPrimaryButton.Content = primaryText ?? "";
        BannerPrimaryButton.Visibility = string.IsNullOrWhiteSpace(primaryText) ? Visibility.Collapsed : Visibility.Visible;
        BannerSecondaryButton.Content = secondaryText ?? "";
        BannerSecondaryButton.Visibility = string.IsNullOrWhiteSpace(secondaryText) ? Visibility.Collapsed : Visibility.Visible;
        BannerCloseButton.Content = _bannerDecision == null ? "关闭" : "取消";
        BannerHost.Visibility = Visibility.Visible;
    }

    private void CloseBanner(bool decision)
    {
        var pending = _bannerDecision;
        _bannerDecision = null;
        BannerHost.Visibility = Visibility.Collapsed;
        pending?.TrySetResult(decision);
    }

    private void BannerPrimaryButton_Click(object sender, RoutedEventArgs e)
    {
        CloseBanner(true);
    }

    private void BannerSecondaryButton_Click(object sender, RoutedEventArgs e)
    {
        CloseBanner(false);
    }

    private void BannerCloseButton_Click(object sender, RoutedEventArgs e)
    {
        CloseBanner(false);
    }

    private async Task ChooseExeAsync()
    {
        var picker = new FileOpenPicker
        {
            SuggestedStartLocation = PickerLocationId.Desktop,
            ViewMode = PickerViewMode.List
        };
        InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this));
        picker.FileTypeFilter.Add(".exe");
        picker.FileTypeFilter.Add("*");
        var file = await picker.PickSingleFileAsync();
        if (file != null) await TrySetExePathAsync(file.Path);
    }

    private void RootGrid_DragOver(object sender, DragEventArgs e)
    {
        e.AcceptedOperation = DataPackageOperation.Copy;
        var point = e.GetPosition(RootGrid);
        ShowDragOverlay(IsAutoRunDropPoint(point));
        e.Handled = true;
    }

    private void RootGrid_DragLeave(object sender, DragEventArgs e)
    {
        var point = e.GetPosition(RootGrid);
        if (point.X < 0 || point.Y < 0 || point.X > RootGrid.ActualWidth || point.Y > RootGrid.ActualHeight)
        {
            HideDragOverlay();
        }
        e.Handled = true;
    }

    private async void RootGrid_Drop(object sender, DragEventArgs e)
    {
        e.AcceptedOperation = DataPackageOperation.Copy;
        var autoRun = IsAutoRunDropPoint(e.GetPosition(RootGrid));
        HideDragOverlay();
        e.Handled = true;

        var selectedExe = await GetDroppedExeAsync(e.DataView);
        if (selectedExe == null) return;

        var accepted = await TrySetExePathAsync(selectedExe);
        if (accepted && autoRun && File.Exists(_exePath))
        {
            await GuardAsync(OneClickAsync);
        }
    }

    private async Task<string?> GetDroppedExeAsync(DataPackageView dataView)
    {
        if (!dataView.Contains(StandardDataFormats.StorageItems))
        {
            ShowBanner("无法选择游戏", "拖入的数据不是文件或目录。请拖入游戏启动程序 exe，或者拖入包含 exe 的游戏目录。");
            return null;
        }

        var items = await dataView.GetStorageItemsAsync();
        var path = items.FirstOrDefault()?.Path;
        if (string.IsNullOrWhiteSpace(path)) return null;

        if (Directory.Exists(path))
        {
            var exe = Directory.GetFiles(path, "*.exe").FirstOrDefault();
            if (exe != null) return exe;
        }
        else if (Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase))
        {
            return path;
        }

        ResetSelectedGame();
        ShowBanner("无法选择游戏", "拖入的项目不是 exe，或者目录下没有找到可启动的 exe。");
        return null;
    }

    private void ShowDragOverlay(bool autoRun)
    {
        if (!_dragOverlayVisible)
        {
            DragOverlayHost.Visibility = Visibility.Visible;
            _dragOverlayVisible = true;
            DragOverlayHost.UpdateLayout();
        }
        HighlightDragOverlay(autoRun);
    }

    private void HighlightDragOverlay(bool autoRun)
    {
        DragScanZone.Opacity = autoRun ? 0.62 : 1;
        DragAutoZone.Opacity = autoRun ? 1 : 0.62;
    }

    private bool IsAutoRunDropPoint(Windows.Foundation.Point rootPoint)
    {
        if (IsPointInsideElement(DragAutoZone, rootPoint)) return true;
        if (IsPointInsideElement(DragScanZone, rootPoint)) return false;

        var scanCenter = GetElementCenterX(DragScanZone);
        var autoCenter = GetElementCenterX(DragAutoZone);
        if (!double.IsNaN(scanCenter) && !double.IsNaN(autoCenter) && autoCenter > scanCenter)
        {
            return rootPoint.X >= (scanCenter + autoCenter) / 2;
        }

        return rootPoint.X >= RootGrid.ActualWidth / 2;
    }

    private void HideDragOverlay()
    {
        DragOverlayHost.Visibility = Visibility.Collapsed;
        _dragOverlayVisible = false;
    }

    private async void DropTarget_Tapped(object sender, TappedRoutedEventArgs e)
    {
        await ChooseExeAsync();
    }

    private void TargetLangBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        SaveLauncherConfig();
    }

    private void ModelSourceBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        UpdateModelSourceSummary();
        SaveLauncherConfig();
    }

    private void OpenConfigPage_Click(object sender, RoutedEventArgs e)
    {
        MainPage.Visibility = Visibility.Collapsed;
        ConfigPage.Visibility = Visibility.Visible;
        RefreshModelSourceLists(SelectedModelSource?.Id);
        LoadModelSourceEditor(SelectedModelSource ?? _modelSources.FirstOrDefault());
    }

    private void BackToMainPage_Click(object sender, RoutedEventArgs e)
    {
        SaveCurrentModelSourceFromEditor();
        SaveLauncherConfig();
        MainPage.Visibility = Visibility.Visible;
        ConfigPage.Visibility = Visibility.Collapsed;
    }

    private void ModelSourceList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingModelSourceUi) return;
        LoadModelSourceEditor((ModelSourceList.SelectedItem as ModelSourceItem)?.Source);
    }

    private void ConfigApiKeyPasswordBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (_syncingConfigApiKey) return;
        _syncingConfigApiKey = true;
        ConfigApiKeyTextBox.Text = ConfigApiKeyPasswordBox.Password;
        _syncingConfigApiKey = false;
    }

    private void ConfigApiKeyTextBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (_syncingConfigApiKey) return;
        _syncingConfigApiKey = true;
        ConfigApiKeyPasswordBox.Password = ConfigApiKeyTextBox.Text;
        _syncingConfigApiKey = false;
    }

    private void ConfigShowKeyBox_Changed(object sender, RoutedEventArgs e)
    {
        var show = ConfigShowKeyBox.IsChecked == true;
        ConfigApiKeyTextBox.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        ConfigApiKeyPasswordBox.Visibility = show ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void FetchModelsButton_Click(object sender, RoutedEventArgs e)
    {
        await GuardAsync(FetchModelsForEditorAsync);
    }

    private void ConfigModelBox_TextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        if (_loadingModelSourceUi) return;
        if (args.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;
        RefreshModelSuggestionList();
    }

    private void ConfigModelBox_SuggestionChosen(AutoSuggestBox sender, AutoSuggestBoxSuggestionChosenEventArgs args)
    {
        if (args.SelectedItem is string model) sender.Text = model;
    }

    private void ConfigModelBox_QuerySubmitted(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
    {
        if (args.ChosenSuggestion is string model) sender.Text = model;
    }

    private async Task FetchModelsForEditorAsync()
    {
        var source = BuildEditorModelSource();
        var apiKey = ConfigApiKeyText.Trim();
        if (string.IsNullOrWhiteSpace(apiKey)) apiKey = ProviderSpecificApiKeyFallback(source) ?? "";
        if (string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("请先填写 API Key，或设置当前格式对应的环境变量。");

        FetchModelsButton.IsEnabled = false;
        try
        {
            StatusText.Text = "正在获取模型列表...";
            var models = await FetchModelListAsync(source.Format, source.BaseUrl, apiKey.Trim());
            if (models.Count == 0) throw new InvalidOperationException("接口没有返回可用模型。");
            SaveCurrentModelSourceFromEditor();
            var target = _editingSource ?? SelectedModelSource ?? throw new InvalidOperationException("当前没有可保存的模型源。");
            target.AvailableModels = CleanModelList(models);
            SaveLauncherConfig();
            _modelSuggestions = target.AvailableModels;
            RefreshModelSuggestionList();
            ConfigModelBox.Focus(FocusState.Programmatic);
            ConfigModelBox.IsSuggestionListOpen = true;
            StatusText.Text = $"已获取并保存 {_modelSuggestions.Count} 个模型";
            AppendLog($"已获取并保存模型列表: {source.Format} / {_modelSuggestions.Count} 个模型");
        }
        finally
        {
            FetchModelsButton.IsEnabled = true;
        }
    }

    private ModelSourceConfig BuildEditorModelSource()
    {
        return new ModelSourceConfig
        {
            Id = _editingSource?.Id ?? "",
            Name = ConfigNameBox.Text,
            Format = (ConfigFormatBox.SelectedItem as ModelFormatOption)?.Format ?? "openai-chat",
            BaseUrl = LauncherConfigStore.EmptyToNull(ConfigBaseUrlBox.Text),
            Model = LauncherConfigStore.EmptyToNull(ConfigModelBox.Text)
        };
    }

    private void RefreshModelSuggestionList()
    {
        if (_modelSuggestions.Count == 0)
        {
            ConfigModelBox.ItemsSource = null;
            return;
        }

        ConfigModelBox.ItemsSource = _modelSuggestions;
    }

    private static List<string> CleanModelList(IEnumerable<string> models)
    {
        return models
            .Select(model => model.Trim())
            .Where(model => !string.IsNullOrWhiteSpace(model))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(model => model, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private void AddModelSource_Click(object sender, RoutedEventArgs e)
    {
        SaveCurrentModelSourceFromEditor();
        var source = new ModelSourceConfig
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = "新模型源",
            Format = "openai-chat",
            BaseUrl = "https://api.openai.com/v1"
        };
        _modelSources.Add(source);
        RefreshModelSourceLists(source.Id);
        LoadModelSourceEditor(source);
    }

    private void DeleteModelSource_Click(object sender, RoutedEventArgs e)
    {
        var source = (ModelSourceList.SelectedItem as ModelSourceItem)?.Source;
        if (source == null) return;
        _modelSources.Remove(source);
        if (_modelSources.Count == 0)
        {
            _modelSources.Add(new ModelSourceConfig
            {
                Id = "openai-chat-default",
                Name = "OpenAI 兼容源",
                Format = "openai-chat",
                BaseUrl = "https://api.openai.com/v1"
            });
        }
        RefreshModelSourceLists(_modelSources.First().Id);
        LoadModelSourceEditor(_modelSources.First());
        SaveLauncherConfig();
    }

    private void SaveModelSource_Click(object sender, RoutedEventArgs e)
    {
        SaveCurrentModelSourceFromEditor();
        SaveLauncherConfig();
        RefreshModelSourceLists(_editingSource?.Id ?? SelectedModelSource?.Id);
        LoadModelSourceEditor(_editingSource ?? SelectedModelSource);
    }

    private async void SkipTranslatedBox_Changed(object sender, RoutedEventArgs e)
    {
        SaveLauncherConfig();
        if (!_loadingConfig) await RestartWatcherForConfigChangeAsync();
    }

    private async void ToggleRuntimeButton_Click(object sender, RoutedEventArgs e)
    {
        await GuardAsync(IsRuntimeInjected() ? RunRestoreAsync : RunInstallAsync);
    }

    private async void ToggleWatchButton_Click(object sender, RoutedEventArgs e)
    {
        await GuardAsync(async () =>
        {
            if (_runner.IsWatcherRunning)
            {
                await StopWatcherAsync();
            }
            else
            {
                await StartWatcherAsync();
            }
        });
    }

    private void LaunchGameButton_Click(object sender, RoutedEventArgs e)
    {
        _ = GuardAsync(() =>
        {
            LaunchGame();
            return Task.CompletedTask;
        });
    }

    private async void PretranslateButton_Click(object sender, RoutedEventArgs e)
    {
        await GuardAsync(RunPretranslateAsync);
    }

    private async Task<bool> TrySetExePathAsync(string exe)
    {
        ResetSelectedGame();
        var normalizedExe = Path.GetFullPath(exe);
        if (!File.Exists(normalizedExe))
        {
            ShowBanner("无法选择游戏", $"文件不存在：{normalizedExe}");
            return false;
        }

        try
        {
            SetBusy(true);
            StatusText.Text = "正在识别游戏...";
            await _runner.EnsureCliBuiltAsync();

            var derived = LauncherPaths.DeriveFromExe(normalizedExe, _runner.ProjectRoot);
            var scanJson = await _runner.RunCliCaptureAsync(
                "scan",
                $"{LauncherPaths.Quote(derived.SourceRoot)} --db {LauncherPaths.Quote(derived.DbPath)} --out {LauncherPaths.Quote(derived.OutputRoot)} --target {LauncherPaths.Quote(SelectedTargetLang)}");
            using var document = JsonDocument.Parse(scanJson);
            var root = document.RootElement;
            var profile = root.GetProperty("profile");
            var engine = profile.GetProperty("engine").GetProperty("name").GetString() ?? "UNKNOWN";
            var detectedBy = ReadDetectedBy(profile);

            if (TryGetUnsupportedEngineReason(engine, detectedBy, out var reason))
            {
                ResetSelectedGame();
                AppendLog($"不支持的游戏: {normalizedExe} / {engine}");
                ShowBanner("不支持该游戏", reason);
                return false;
            }

            CloseBanner(false);
            _exePath = normalizedExe;
            _sourceRoot = GetString(profile, "sourceRoot") ?? derived.SourceRoot;
            _outputRoot = GetString(profile, "outputRoot") ?? derived.OutputRoot;
            _dbPath = GetString(root, "dbPath") ?? derived.DbPath;
            _engineName = engine;
            var targetLang = GetString(profile, "targetLang");
            if (!string.IsNullOrWhiteSpace(targetLang)) SelectTargetLanguage(targetLang);

            GamePathText.Text = _sourceRoot;
            UpdateModifiedFilesSummary();
            DbPathText.Text = _dbPath;
            ProjectSummaryGrid.Visibility = Visibility.Visible;
            StatusText.Text = $"已识别: {engine}";
            AppendLog($"已选择游戏: {normalizedExe}");

            var dir = Path.GetDirectoryName(normalizedExe);
            if (!string.IsNullOrWhiteSpace(dir) && LauncherPaths.TryReadRuntimeManifest(dir) != null)
            {
                AppendLog("检测到已注入运行时插件的游戏目录，将原地更新插件并复用现有翻译缓存。");
            }
            UpdateStats();
            return true;
        }
        catch (Exception ex)
        {
            ResetSelectedGame();
            AppendLog($"识别失败: {ex.Message}");
            ShowBanner("无法识别游戏", $"没有完成受支持游戏引擎识别，窗口已恢复初始状态。\n\n{ex.Message}");
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task HandleInitialExeAsync()
    {
        if (string.IsNullOrWhiteSpace(_initialExe)) return;
        if (!File.Exists(_initialExe)) return;
        await TrySetExePathAsync(_initialExe);
    }

    private void ResetSelectedGame()
    {
        _exePath = "";
        _sourceRoot = "";
        _outputRoot = "";
        _dbPath = "";
        _engineName = "";
        GamePathText.Text = "";
        InjectPathText.Text = "";
        DbPathText.Text = "";
        ProjectSummaryGrid.Visibility = Visibility.Collapsed;
        StatusText.Text = "等待拖入游戏 exe";
        UpdateStats();
    }

    private bool IsRuntimeInjected()
    {
        return !string.IsNullOrWhiteSpace(_outputRoot)
            && Directory.Exists(_outputRoot)
            && LauncherPaths.TryReadRuntimeManifest(_outputRoot) != null;
    }

    private void UpdateActionButtons()
    {
        ToggleRuntimeButton.Content = IsRuntimeInjected()
            ? "已注入，点击还原"
            : "未注入，点击注入";
        ToggleWatchButton.Content = _runner.IsWatcherRunning
            ? "已监听，点击停止"
            : "未监听，点击监听";
    }

    private void UpdateModifiedFilesSummary()
    {
        InjectPathText.Text = BuildModifiedFilesSummary();
    }

    private string BuildModifiedFilesSummary()
    {
        if (IsRuntimeInjected())
        {
            var actual = ReadActualModifiedFiles();
            if (actual.Count > 0) return FormatModifiedFiles(actual);
        }

        var planned = PlannedModifiedFiles();
        return planned.Count > 0 ? FormatModifiedFiles(planned) : "等待识别游戏引擎";
    }

    private List<string> ReadActualModifiedFiles()
    {
        if (string.IsNullOrWhiteSpace(_outputRoot)) return [];
        var manifest = Path.Combine(_outputRoot, "RPGMTransRuntime", "backups", "backup-manifest.json");
        if (!File.Exists(manifest)) return [];
        try
        {
            using var doc = JsonDocument.Parse(LauncherPaths.ReadAllTextShared(manifest));
            if (!doc.RootElement.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array) return [];
            return entries.EnumerateArray()
                .Select(item => item.TryGetProperty("path", out var path) ? path.GetString() : null)
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Select(item => item!.Replace('\\', '/'))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch
        {
            return [];
        }
    }

    private List<string> PlannedModifiedFiles()
    {
        if (string.IsNullOrWhiteSpace(_outputRoot) || string.IsNullOrWhiteSpace(_engineName)) return [];
        return _engineName switch
        {
            "MV" or "MZ" => PlannedMvMzFiles(),
            "XP" or "VX" or "VXA" => PlannedRgssFiles(),
            "RENPY" => ["game/rpgmtrans_runtime.rpy"],
            "TYRANO" => PlannedTyranoFiles(),
            _ => []
        };
    }

    private List<string> PlannedMvMzFiles()
    {
        var jsRoot = Directory.Exists(Path.Combine(_outputRoot, "www", "js")) ? "www/js" : "js";
        return [$"{jsRoot}/plugins/RPGMTransRuntime.js", $"{jsRoot}/plugins.js"];
    }

    private List<string> PlannedRgssFiles()
    {
        var files = new List<string>();
        foreach (var name in new[] { "Scripts.rvdata2", "Scripts.rvdata", "Scripts.rxdata" })
        {
            var rel = $"Data/{name}";
            if (File.Exists(Path.Combine(_outputRoot, "Data", name))) files.Add(rel);
        }
        foreach (var name in new[] { "Game.rgss3a", "Game.rgss2a", "Game.rgssad" })
        {
            if (File.Exists(Path.Combine(_outputRoot, name))) files.Add($"{name} -> {name}.rpgmtrans-disabled");
        }
        return files.Count > 0 ? files : ["Data/Scripts.*"];
    }

    private List<string> PlannedTyranoFiles()
    {
        var files = new List<string> { "data/others/rpgmtrans_runtime.js" };
        foreach (var rel in new[] { "data/scenario/first.ks", "data/scenario/title.ks", "data/scenario/scene1.ks", "index.html" })
        {
            if (File.Exists(Path.Combine(_outputRoot, rel.Replace('/', Path.DirectorySeparatorChar))))
            {
                files.Add(rel);
                return files;
            }
        }
        return files;
    }

    private static string FormatModifiedFiles(IReadOnlyList<string> files)
    {
        const int max = 8;
        var shown = files.Take(max).ToList();
        var text = string.Join("  |  ", shown);
        return files.Count > max ? $"{text}  |  等 {files.Count} 个文件" : text;
    }

    private static bool TryGetUnsupportedEngineReason(string engine, IReadOnlyList<string> detectedBy, out string reason)
    {
        var detectedText = detectedBy.Count == 0 ? "无明确识别特征" : string.Join("、", detectedBy);
        switch (engine)
        {
            case "RM2K":
            case "RM2K3":
                reason = $"检测到 RPG Maker 2000/2003 工程特征（{detectedText}）。当前版本尚不支持该引擎的运行时注入、渲染拦截和预翻译缓存，已清空本次选择。";
                return true;
            case "UNKNOWN":
                reason = $"未识别到受支持的 Windows 游戏引擎特征（{detectedText}）。当前仅支持 RPG Maker MV/MZ/XP/VX/VX Ace、Ren'Py、TyranoScript/TyranoBuilder，已清空本次选择。";
                return true;
            default:
                reason = "";
                return false;
        }
    }

    private static IReadOnlyList<string> ReadDetectedBy(JsonElement profile)
    {
        if (!profile.TryGetProperty("engine", out var engine)) return Array.Empty<string>();
        if (!engine.TryGetProperty("detectedBy", out var detectedBy) || detectedBy.ValueKind != JsonValueKind.Array) return Array.Empty<string>();
        return detectedBy.EnumerateArray()
            .Select(item => item.GetString())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!)
            .ToList();
    }

    private static string? GetString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private void FillDerivedPaths()
    {
        if (string.IsNullOrWhiteSpace(_exePath)) return;
        if (!File.Exists(_exePath)) return;
        var derived = LauncherPaths.DeriveFromExe(_exePath, _runner.ProjectRoot);
        _sourceRoot = derived.SourceRoot;
        _outputRoot = derived.OutputRoot;
        _dbPath = derived.DbPath;
        if (!string.IsNullOrWhiteSpace(derived.TargetLang)) SelectTargetLanguage(derived.TargetLang);
        GamePathText.Text = _sourceRoot;
        UpdateModifiedFilesSummary();
        DbPathText.Text = _dbPath;
        ProjectSummaryGrid.Visibility = Visibility.Visible;
        UpdateStats();
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
        await _runner.EnsureCliBuiltAsync();
        await _runner.RunCliAsync("scan", $"{LauncherPaths.Quote(_sourceRoot)} --db {LauncherPaths.Quote(_dbPath)} --out {LauncherPaths.Quote(_outputRoot)} --target {LauncherPaths.Quote(SelectedTargetLang)}");
        StatusText.Text = "扫描完成";
    }

    private async Task RunInstallAsync()
    {
        ValidatePaths(forInstall: true);
        await _runner.EnsureCliBuiltAsync();
        await _runner.RunCliAsync("install-runtime", LauncherPaths.Quote(_dbPath));
        await _runner.RunCliAsync("validate-runtime", LauncherPaths.Quote(_dbPath));
        StatusText.Text = "插件已注入，原文件已备份";
        UpdateModifiedFilesSummary();
        UpdateStats();
    }

    private async Task RunRestoreAsync()
    {
        ValidatePaths(forInstall: false);
        await StopWatcherAsync();
        await RunScanAsync();
        await _runner.RunCliAsync("restore-runtime", LauncherPaths.Quote(_dbPath));
        StatusText.Text = "已还原原始文件";
        UpdateModifiedFilesSummary();
        UpdateStats();
    }

    private async Task RunPretranslateAsync()
    {
        await RunScanAsync();
        await RunInstallAsync();
        var provider = SelectedProvider;
        var overwrite = SkipTranslatedBox.IsChecked == true ? "" : " --overwrite";
        var selectedSource = SelectedModelSource;
        var inputPrice = PriceArg(selectedSource?.InputTokenPricePerMillion);
        var outputPrice = PriceArg(selectedSource?.OutputTokenPricePerMillion);
        var estimateJson = await _runner.RunCliCaptureAsync("pretranslate-estimate", $"{LauncherPaths.Quote(_dbPath)} --mode safe --batch-size 20 --input-token-price {inputPrice} --output-token-price {outputPrice}{overwrite}");
        var estimate = JsonSerializer.Deserialize<PretranslateEstimate>(estimateJson, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("无法解析预翻译 token 估算结果。");
        if (!await ConfirmPretranslateAsync(estimate))
        {
            StatusText.Text = "已取消预翻译";
            AppendLog("已取消预翻译。");
            return;
        }
        await _runner.RunCliAsync("pretranslate", $"{LauncherPaths.Quote(_dbPath)} --provider {provider} --mode safe --batch-size 20 --concurrency 100 --progress{overwrite}");
        StatusText.Text = "预翻译缓存完成";
        UpdateStats();
    }

    private async Task StartWatcherAsync()
    {
        ValidatePaths(forInstall: true);
        var provider = SelectedProvider;
        var configSignature = WatcherConfigSignature(provider);
        if (_runner.IsWatcherRunning)
        {
            if (_watcherConfigSignature == configSignature)
            {
                AppendLog("监听已经在运行。");
                return;
            }
            AppendLog("监听配置已变更，重启监听进程。");
            await StopWatcherAsync();
        }
        await _runner.EnsureCliBuiltAsync();
        _runner.StartWatcher(_dbPath, provider, SkipTranslatedBox.IsChecked == true);
        _watcherConfigSignature = configSignature;
        StatusText.Text = $"监听中: {SelectedModelSource?.Name ?? provider}";
        AppendLog("监听已启动。首次缺译显示原文，翻译完成后写入缓存，游戏会自动重载。");
    }

    private async Task RestartWatcherForConfigChangeAsync()
    {
        if (_restartingWatcher) return;
        if (!_runner.IsWatcherRunning) return;
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

    private async Task StopWatcherAsync()
    {
        await _runner.StopWatcherAsync();
        _watcherConfigSignature = null;
        StatusText.Text = "监听已停止";
        UpdateStats();
    }

    private void LaunchGame()
    {
        ValidatePaths(forInstall: true);
        var exe = LauncherPaths.FindLaunchExe(_outputRoot);
        if (exe == null) throw new InvalidOperationException($"游戏目录没有找到可启动 exe: {_outputRoot}");
        Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
            UseShellExecute = true
        });
        StatusText.Text = "游戏已启动";
        AppendLog($"启动游戏: {exe}");
    }

    private void ValidatePaths(bool forInstall)
    {
        if (!File.Exists(_exePath)) throw new InvalidOperationException("请先拖入或点击选择游戏 exe。");
        if (!Directory.Exists(_sourceRoot)) throw new InvalidOperationException("游戏目录不存在。");
        if (string.IsNullOrWhiteSpace(_outputRoot)) throw new InvalidOperationException("注入位置不能为空。");
        if (!Path.GetFullPath(_sourceRoot).Equals(Path.GetFullPath(_outputRoot), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("当前版本只在原游戏目录注入插件，不再生成汉化副本。");
        if (string.IsNullOrWhiteSpace(_dbPath)) throw new InvalidOperationException("项目库路径不能为空。");
        if (forInstall && !File.Exists(_dbPath)) throw new InvalidOperationException("项目库不存在，请先扫描。");
        if (SelectedModelSource == null) throw new InvalidOperationException("请先在模型源配置页添加并选择一个模型源。");
    }

    private IReadOnlyDictionary<string, string> BuildProviderEnvironment()
    {
        var source = SelectedModelSource;
        if (source == null) return new Dictionary<string, string>();
        var apiKey = LauncherConfigStore.UnprotectSecret(source.ApiKeyProtected) ?? ProviderSpecificApiKeyFallback(source) ?? "";
        _redactionApiKey = apiKey.Trim();
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["RPGMTRANS_PROVIDER_FORMAT"] = source.Format,
            ["RPGMTRANS_PROVIDER_BASE_URL"] = source.BaseUrl ?? "",
            ["RPGMTRANS_PROVIDER_MODEL"] = source.Model ?? "",
            ["RPGMTRANS_PROVIDER_API_KEY"] = apiKey
        };
    }

    private static string? ProviderSpecificApiKeyFallback(ModelSourceConfig source)
    {
        return source.Format switch
        {
            "anthropic" => FirstEnvironment("ANTHROPIC_API_KEY"),
            "google" => FirstEnvironment("GOOGLE_API_KEY", "GEMINI_API_KEY"),
            "openai-responses" => FirstEnvironment("OPENAI_API_KEY"),
            "openai-chat" when (source.BaseUrl ?? "").Contains("deepseek", StringComparison.OrdinalIgnoreCase) => FirstEnvironment("DEEPSEEK_API_KEY", "OPENAI_API_KEY"),
            "openai-chat" => FirstEnvironment("OPENAI_API_KEY"),
            _ => null
        };
    }

    private static async Task<List<string>> FetchModelListAsync(string format, string? baseUrl, string apiKey)
    {
        var endpoint = BuildModelListEndpoint(format, baseUrl, apiKey);
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        if (format is "openai-responses" or "openai-chat")
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        }
        else if (format == "anthropic")
        {
            request.Headers.TryAddWithoutValidation("x-api-key", apiKey);
            request.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
        }

        using var response = await ModelListHttp.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"获取模型列表失败 {((int)response.StatusCode)}: {TrimErrorBody(body)}");
        }

        using var document = JsonDocument.Parse(body);
        return ParseModelList(format, document.RootElement);
    }

    private static string BuildModelListEndpoint(string format, string? baseUrl, string apiKey)
    {
        var root = (string.IsNullOrWhiteSpace(baseUrl), format) switch
        {
            (true, "anthropic") => "https://api.anthropic.com/v1",
            (true, "google") => "https://generativelanguage.googleapis.com/v1beta",
            (true, _) => "https://api.openai.com/v1",
            _ => baseUrl!.Trim()
        };
        var endpoint = AppendPathIfNeeded(root, "models");
        return format == "google" ? AppendQuery(endpoint, "key", apiKey) : endpoint;
    }

    private static string AppendPathIfNeeded(string root, string path)
    {
        var trimmed = root.TrimEnd('/');
        return trimmed.EndsWith($"/{path}", StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : $"{trimmed}/{path}";
    }

    private static string AppendQuery(string url, string key, string value)
    {
        var separator = url.Contains("?", StringComparison.Ordinal) ? "&" : "?";
        return $"{url}{separator}{Uri.EscapeDataString(key)}={Uri.EscapeDataString(value)}";
    }

    private static List<string> ParseModelList(string format, JsonElement root)
    {
        var models = new List<string>();
        if (root.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in root.EnumerateArray()) AddModelListItem(format, item, models);
        }
        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray()) AddModelListItem(format, item, models);
        }
        if (root.TryGetProperty("models", out var modelArray) && modelArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in modelArray.EnumerateArray()) AddModelListItem(format, item, models);
        }

        return models
            .Select(model => NormalizeModelId(format, model))
            .Where(model => !string.IsNullOrWhiteSpace(model))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(model => model, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static void AddModelListItem(string format, JsonElement item, List<string> models)
    {
        if (item.ValueKind == JsonValueKind.String)
        {
            var value = item.GetString();
            if (!string.IsNullOrWhiteSpace(value)) models.Add(value);
            return;
        }
        if (item.ValueKind != JsonValueKind.Object) return;
        if (format == "google" && !SupportsGenerateContent(item)) return;

        foreach (var property in new[] { "id", "name", "model" })
        {
            if (!item.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String) continue;
            var text = value.GetString();
            if (!string.IsNullOrWhiteSpace(text))
            {
                models.Add(text);
                return;
            }
        }
    }

    private static bool SupportsGenerateContent(JsonElement item)
    {
        if (!item.TryGetProperty("supportedGenerationMethods", out var methods) || methods.ValueKind != JsonValueKind.Array)
        {
            return true;
        }

        return methods.EnumerateArray()
            .Select(method => method.GetString())
            .Any(method => method != null && method.Contains("generateContent", StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizeModelId(string format, string model)
    {
        var text = model.Trim();
        if (format == "google" && text.StartsWith("models/", StringComparison.OrdinalIgnoreCase))
        {
            text = text["models/".Length..];
        }
        return text;
    }

    private static string TrimErrorBody(string body)
    {
        var text = string.IsNullOrWhiteSpace(body) ? "empty response body" : body.Trim();
        return text.Length > 1000 ? $"{text[..1000]}..." : text;
    }

    private void SaveLauncherConfig()
    {
        if (_loadingConfig) return;
        try
        {
            _config.Provider = SelectedProvider;
            _config.TargetLang = SelectedTargetLang;
            _config.SelectedModelSourceId = SelectedModelSource?.Id;
            _config.ModelSources = _modelSources;
            _config.SkipTranslated = SkipTranslatedBox.IsChecked == true;
            LauncherConfigStore.Save(_config);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"保存配置失败: {ex.Message}";
        }
    }

    private void RefreshModelSourceLists(string? selectedId)
    {
        _loadingModelSourceUi = true;
        try
        {
            _modelSourceItems = _modelSources.Select(item => new ModelSourceItem(item)).ToList();
            ModelSourceBox.ItemsSource = null;
            ModelSourceList.ItemsSource = null;
            ModelSourceBox.ItemsSource = _modelSourceItems;
            ModelSourceList.ItemsSource = _modelSourceItems;
            var selectedItem = _modelSourceItems.FirstOrDefault(item => item.Source.Id == selectedId) ?? _modelSourceItems.FirstOrDefault();
            ModelSourceBox.SelectedItem = selectedItem;
            ModelSourceList.SelectedItem = selectedItem;
        }
        finally
        {
            _loadingModelSourceUi = false;
        }
        UpdateModelSourceSummary();
    }

    private void LoadModelSourceEditor(ModelSourceConfig? source)
    {
        _editingSource = source;
        _loadingModelSourceUi = true;
        try
        {
            ConfigNameBox.Text = source?.Name ?? "";
            ConfigBaseUrlBox.Text = source?.BaseUrl ?? "";
            ConfigModelBox.Text = source?.Model ?? "";
            _modelSuggestions = CleanModelList(source?.AvailableModels ?? []);
            RefreshModelSuggestionList();
            ConfigInputPriceBox.Text = FormatPrice(source?.InputTokenPricePerMillion, null);
            ConfigOutputPriceBox.Text = FormatPrice(source?.OutputTokenPricePerMillion, null);
            SetConfigApiKeyText(source == null ? "" : LauncherConfigStore.UnprotectSecret(source.ApiKeyProtected) ?? "");
            ConfigFormatBox.SelectedItem = _modelFormats.FirstOrDefault(item => item.Format == source?.Format) ?? _modelFormats.First();
        }
        finally
        {
            _loadingModelSourceUi = false;
        }
    }

    private void SaveCurrentModelSourceFromEditor()
    {
        if (_editingSource == null) return;
        _editingSource.Name = string.IsNullOrWhiteSpace(ConfigNameBox.Text) ? "未命名模型源" : ConfigNameBox.Text.Trim();
        _editingSource.Format = (ConfigFormatBox.SelectedItem as ModelFormatOption)?.Format ?? "openai-chat";
        _editingSource.BaseUrl = LauncherConfigStore.EmptyToNull(ConfigBaseUrlBox.Text);
        _editingSource.Model = LauncherConfigStore.EmptyToNull(ConfigModelBox.Text);
        _editingSource.ApiKeyProtected = LauncherConfigStore.ProtectSecret(ConfigApiKeyText);
        _editingSource.InputTokenPricePerMillion = ParseNullableDecimal(ConfigInputPriceBox.Text);
        _editingSource.OutputTokenPricePerMillion = ParseNullableDecimal(ConfigOutputPriceBox.Text);
        if (ModelSourceBox.SelectedItem is not ModelSourceItem selected || selected.Source.Id == _editingSource.Id)
        {
            RefreshModelSourceLists(_editingSource.Id);
        }
    }

    private void UpdateModelSourceSummary()
    {
        var source = SelectedModelSource;
        if (source == null)
        {
            ModelSourceSummaryText.Text = "未配置模型源";
            return;
        }
        var format = _modelFormats.FirstOrDefault(item => item.Format == source.Format)?.Label ?? source.Format;
        var model = string.IsNullOrWhiteSpace(source.Model) ? "未填写模型" : source.Model;
        var baseUrl = string.IsNullOrWhiteSpace(source.BaseUrl) ? "默认地址" : source.BaseUrl;
        ModelSourceSummaryText.Text = $"{format} / {model} / {baseUrl}";
    }

    private void SelectTargetLanguage(string code)
    {
        TargetLangBox.SelectedItem = _targetLanguages.FirstOrDefault(item => item.Code.Equals(code, StringComparison.OrdinalIgnoreCase))
            ?? _targetLanguages.First();
    }

    private void UpdateStats()
    {
        StatsText.Text = RuntimeStatsReader.ReadSummary(
            _outputRoot,
            SkipTranslatedBox.IsChecked == true,
            _runner.IsWatcherRunning);
        UpdateActionButtons();
    }

    private void AppendLog(string text)
    {
        if (!DispatcherQueue.HasThreadAccess)
        {
            _ = DispatcherQueue.TryEnqueue(() => AppendLog(text));
            return;
        }

        text = Redact(text);
        if (text.Contains("API_KEY", StringComparison.OrdinalIgnoreCase)) text = Redact(text);
        if (text.StartsWith("[预翻译] ", StringComparison.Ordinal))
        {
            StatusText.Text = text.Length > 70 ? $"{text[..70]}..." : text;
        }
        AddLogLines(text);
        if (_logLines.Count > 3000) _logLines.RemoveRange(0, _logLines.Count - 3000);
        LogTextBlock.Text = string.Join(Environment.NewLine, _logLines);
        ScrollLogToEnd();
        UpdateStats();
    }

    private void AddLogLines(string text)
    {
        var prefix = $"[{DateTime.Now:HH:mm:ss}] ";
        var continuationPrefix = new string(' ', prefix.Length);
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            _logLines.Add((i == 0 ? prefix : continuationPrefix) + lines[i]);
        }
    }

    private void ScrollLogToEnd()
    {
        LogScrollViewer.UpdateLayout();
        LogScrollViewer.ChangeView(null, LogScrollViewer.ScrollableHeight, null, disableAnimation: true);
    }

    private void InstallMouseHook()
    {
        if (_mouseHook != IntPtr.Zero) return;

        _mouseHook = SetWindowsHookEx(WhMouseLl, _mouseHookDelegate, IntPtr.Zero, 0);
        if (_mouseHook != IntPtr.Zero) return;

        _mouseHook = SetWindowsHookEx(WhMouseLl, _mouseHookDelegate, GetModuleHandle(null), 0);
    }

    private void RegisterMouseRawInput()
    {
        var devices = new[]
        {
            new RawInputDevice
            {
                UsagePage = HidUsagePageGeneric,
                Usage = HidUsageGenericMouse,
                Flags = RidevInputSink,
                Target = _hwnd
            }
        };

        _ = RegisterRawInputDevices(devices, (uint)devices.Length, (uint)Marshal.SizeOf<RawInputDevice>());
    }

    private bool ScrollLogByWheelDelta(int delta)
    {
        if (delta == 0) return false;

        LogScrollViewer.UpdateLayout();
        if (LogScrollViewer.ScrollableHeight <= 0) return false;

        var direction = delta > 0 ? -1 : 1;
        var notches = Math.Max(1, Math.Abs(delta) / 120.0);
        var pixelStep = 24 * notches;
        var next = Math.Clamp(LogScrollViewer.VerticalOffset + direction * pixelStep, 0, LogScrollViewer.ScrollableHeight);
        LogScrollViewer.ChangeView(null, next, null, disableAnimation: false);
        return true;
    }

    private IntPtr WindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WmInput && TryHandleRawInputLogWheel(lParam))
        {
            return IntPtr.Zero;
        }

        if (msg == WmMouseWheel && TryHandleNativeLogWheel(wParam))
        {
            return IntPtr.Zero;
        }

        return _oldWndProc != IntPtr.Zero
            ? CallWindowProc(_oldWndProc, hWnd, msg, wParam, lParam)
            : DefWindowProc(hWnd, msg, wParam, lParam);
    }

    private bool TryHandleRawInputLogWheel(IntPtr rawInputHandle)
    {
        uint size = 0;
        var headerSize = (uint)Marshal.SizeOf<RawInputHeader>();
        _ = GetRawInputData(rawInputHandle, RidInput, IntPtr.Zero, ref size, headerSize);
        if (size == 0) return false;

        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(rawInputHandle, RidInput, buffer, ref size, headerSize) != size) return false;
            var raw = Marshal.PtrToStructure<RawInput>(buffer);
            if (raw.Header.Type != RimTypeMouse) return false;
            if ((raw.Mouse.ButtonFlags & RawMouseWheel) == 0) return false;
            if (!GetCursorPos(out var point) || !IsScreenPointInsideLogPanel(point)) return false;

            return ScrollLogByWheelDelta(unchecked((short)raw.Mouse.ButtonData));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private bool TryHandleNativeLogWheel(IntPtr wParam)
    {
        if (_hwnd == IntPtr.Zero) return false;
        if (!GetCursorPos(out var point)) return false;
        if (!IsScreenPointInsideLogPanel(point)) return false;

        return ScrollLogByWheelDelta(GetWheelDelta(wParam));
    }

    private IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && (uint)wParam == WmMouseWheel && _hwnd != IntPtr.Zero)
        {
            var info = Marshal.PtrToStructure<MouseHookStruct>(lParam);
            if (IsScreenPointInsideLogPanel(info.Point))
            {
                var delta = unchecked((short)((info.MouseData >> 16) & 0xffff));
                if (DispatcherQueue.HasThreadAccess)
                {
                    _ = ScrollLogByWheelDelta(delta);
                }
                else
                {
                    _ = DispatcherQueue.TryEnqueue(() => ScrollLogByWheelDelta(delta));
                }
                return 1;
            }
        }

        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private bool IsScreenPointInsideLogPanel(NativePoint screenPoint)
    {
        if (_hwnd == IntPtr.Zero) return false;

        var clientPoint = screenPoint;
        if (!ScreenToClient(_hwnd, ref clientPoint)) return false;

        var scale = RootGrid.XamlRoot?.RasterizationScale ?? 1.0;
        var rootPoint = new Windows.Foundation.Point(clientPoint.X / scale, clientPoint.Y / scale);
        return IsPointInsideElement(LogPanel, rootPoint);
    }

    private static int GetWheelDelta(IntPtr wParam)
    {
        return unchecked((short)((wParam.ToInt64() >> 16) & 0xffff));
    }

    private bool IsPointInsideElement(FrameworkElement element, Windows.Foundation.Point rootPoint)
    {
        if (element.ActualWidth <= 0 || element.ActualHeight <= 0) return false;

        var origin = element.TransformToVisual(RootGrid).TransformPoint(new Windows.Foundation.Point(0, 0));
        return rootPoint.X >= origin.X
            && rootPoint.Y >= origin.Y
            && rootPoint.X <= origin.X + element.ActualWidth
            && rootPoint.Y <= origin.Y + element.ActualHeight;
    }

    private double GetElementCenterX(FrameworkElement element)
    {
        if (element.ActualWidth <= 0) return double.NaN;

        var origin = element.TransformToVisual(RootGrid).TransformPoint(new Windows.Foundation.Point(0, 0));
        return origin.X + element.ActualWidth / 2;
    }

    private void OnWatcherExited(int? exitCode)
    {
        _ = DispatcherQueue.TryEnqueue(() =>
        {
            AppendLog($"监听进程已退出，退出码 {exitCode?.ToString() ?? "未知"}");
            _watcherConfigSignature = null;
            StatusText.Text = "监听未运行";
            UpdateStats();
        });
    }

    private string Redact(string value)
    {
        var text = value;
        if (!string.IsNullOrWhiteSpace(_redactionApiKey)) text = text.Replace(_redactionApiKey, "***");
        foreach (var name in new[] { "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY" })
        {
            text = text.Replace(Environment.GetEnvironmentVariable(name) ?? "\0", "***");
        }
        return text;
    }

    private void SetConfigApiKeyText(string value)
    {
        _syncingConfigApiKey = true;
        ConfigApiKeyPasswordBox.Password = value;
        ConfigApiKeyTextBox.Text = value;
        _syncingConfigApiKey = false;
    }

    private string WatcherConfigSignature(string provider)
    {
        var source = SelectedModelSource;
        return LauncherPaths.ShortHash(string.Join("\n", new[]
        {
            provider,
            source?.Id ?? "",
            source?.Format ?? "",
            source?.BaseUrl ?? "",
            source?.Model ?? "",
            LauncherConfigStore.UnprotectSecret(source?.ApiKeyProtected) ?? "",
            SkipTranslatedBox.IsChecked == true ? "skip-translated" : "overwrite-translated"
        }));
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

    private static string FormatPrice(decimal? saved, string? environmentValue)
    {
        if (saved.HasValue) return saved.Value.ToString("0.########", CultureInfo.InvariantCulture);
        if (decimal.TryParse(environmentValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var envPrice) && envPrice >= 0)
            return envPrice.ToString("0.########", CultureInfo.InvariantCulture);
        return "0";
    }

    private static decimal? ParseNullableDecimal(string value)
    {
        return decimal.TryParse(value.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) && parsed >= 0
            ? parsed
            : null;
    }

    private static string PriceArg(decimal? value)
    {
        return value.HasValue && value.Value >= 0 ? value.Value.ToString(CultureInfo.InvariantCulture) : "0";
    }

    private static string BuildPretranslateEstimateMessage(PretranslateEstimate estimate)
    {
        return string.Join(Environment.NewLine, new[]
        {
            "预翻译即将调用模型。请确认估算消耗：",
            "",
            $"扫描候选: {estimate.Scanned:N0}",
            $"可翻译候选: {estimate.Candidates:N0}",
            $"待模型翻译: {estimate.Queued:N0}",
            $"跳过缓存: {estimate.SkippedCached:N0}",
            $"跳过/仅记录: {estimate.SkippedUnsafe:N0}",
            $"内置写入: {estimate.BuiltIn:N0}",
            $"批次数: {estimate.BatchesTotal:N0}",
            "",
            $"预计输入 token: {estimate.EstimatedInputTokens:N0}",
            $"预计输出 token: {estimate.EstimatedOutputTokens:N0}",
            $"预计总 token: {estimate.EstimatedTotalTokens:N0}",
            "",
            $"输入价格/百万 token: {estimate.InputTokenPricePerMillion.ToString("0.########", CultureInfo.InvariantCulture)}",
            $"输出价格/百万 token: {estimate.OutputTokenPricePerMillion.ToString("0.########", CultureInfo.InvariantCulture)}",
            $"预计输入费用: {estimate.EstimatedInputCost.ToString("0.######", CultureInfo.InvariantCulture)}",
            $"预计输出费用: {estimate.EstimatedOutputCost.ToString("0.######", CultureInfo.InvariantCulture)}",
            $"预计总费用: {estimate.EstimatedTotalCost.ToString("0.######", CultureInfo.InvariantCulture)}",
            "",
            "是否继续正式预翻译？"
        });
    }

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    private delegate IntPtr LowLevelMouseProcDelegate(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseHookStruct
    {
        public NativePoint Point;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputDevice
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputHeader
    {
        public uint Type;
        public uint Size;
        public IntPtr Device;
        public IntPtr WParam;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct RawMouse
    {
        [FieldOffset(0)] public ushort Flags;
        [FieldOffset(4)] public uint Buttons;
        [FieldOffset(4)] public ushort ButtonFlags;
        [FieldOffset(6)] public ushort ButtonData;
        [FieldOffset(8)] public uint RawButtons;
        [FieldOffset(12)] public int LastX;
        [FieldOffset(16)] public int LastY;
        [FieldOffset(20)] public uint ExtraInformation;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInput
    {
        public RawInputHeader Header;
        public RawMouse Mouse;
    }

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProcDelegate lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out NativePoint lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ScreenToClient(IntPtr hWnd, ref NativePoint lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(
        RawInputDevice[] pRawInputDevices,
        uint uiNumDevices,
        uint cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputData(
        IntPtr hRawInput,
        uint uiCommand,
        IntPtr pData,
        ref uint pcbSize,
        uint cbSizeHeader);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint uFlags);
}
