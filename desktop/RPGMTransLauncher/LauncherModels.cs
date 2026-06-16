namespace RPGMTransLauncher;

internal sealed class LauncherConfig
{
    public string? Provider { get; set; }
    public string? TargetLang { get; set; }
    public string? SelectedModelSourceId { get; set; }
    public List<ModelSourceConfig> ModelSources { get; set; } = new();
    public string? DeepSeekBaseUrl { get; set; }
    public string? DeepSeekModel { get; set; }
    public string? DeepSeekApiKeyProtected { get; set; }
    public decimal? DeepSeekInputTokenPricePerMillion { get; set; }
    public decimal? DeepSeekOutputTokenPricePerMillion { get; set; }
    public string? OpenAiBaseUrl { get; set; }
    public string? OpenAiModel { get; set; }
    public string? OpenAiApiKeyProtected { get; set; }
    public decimal? OpenAiInputTokenPricePerMillion { get; set; }
    public decimal? OpenAiOutputTokenPricePerMillion { get; set; }
    public bool? SkipTranslated { get; set; }
}

internal sealed class ModelSourceConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Format { get; set; } = "openai-chat";
    public string? BaseUrl { get; set; }
    public string? Model { get; set; }
    public string? ApiKeyProtected { get; set; }
    public decimal? InputTokenPricePerMillion { get; set; }
    public decimal? OutputTokenPricePerMillion { get; set; }
}

internal sealed record TargetLanguageOption(string Label, string Code)
{
    public override string ToString() => Label;
}

internal sealed record ModelFormatOption(string Label, string Format)
{
    public override string ToString() => Label;
}

internal sealed record ModelSourceItem(ModelSourceConfig Source)
{
    public override string ToString() => string.IsNullOrWhiteSpace(Source.Name) ? "未命名模型源" : Source.Name;
}

internal sealed class PretranslateEstimate
{
    public int Scanned { get; set; }
    public int Candidates { get; set; }
    public int Queued { get; set; }
    public int SkippedCached { get; set; }
    public int SkippedUnsafe { get; set; }
    public int BuiltIn { get; set; }
    public int BatchesTotal { get; set; }
    public long EstimatedInputTokens { get; set; }
    public long EstimatedOutputTokens { get; set; }
    public long EstimatedTotalTokens { get; set; }
    public decimal InputTokenPricePerMillion { get; set; }
    public decimal OutputTokenPricePerMillion { get; set; }
    public decimal EstimatedInputCost { get; set; }
    public decimal EstimatedOutputCost { get; set; }
    public decimal EstimatedTotalCost { get; set; }
}

internal sealed class PretranslateStats
{
    public string Phase { get; set; } = "";
    public int Translated { get; set; }
    public int BatchesCompleted { get; set; }
    public int BatchesTotal { get; set; }
    public int InFlight { get; set; }
}

internal sealed class RuntimeManifestInfo
{
    public string? SourceRoot { get; set; }
    public string? TargetLang { get; set; }
}

internal sealed record DerivedPaths(
    string SourceRoot,
    string OutputRoot,
    string DbPath,
    string? TargetLang,
    bool HasRuntimeManifest);
