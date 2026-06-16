using Microsoft.UI.Xaml;

namespace RPGMTransLauncher;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var initialExe = Environment.GetCommandLineArgs().Skip(1).FirstOrDefault();
        _window = new MainWindow(initialExe);
        _window.Activate();
    }
}
