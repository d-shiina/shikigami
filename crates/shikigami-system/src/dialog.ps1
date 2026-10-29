# The dialogs of dialog.message, dialog.input and dialog.selectFile.
#
# desktop.rs runs this in its own powershell.exe (-STA) per dialog, so a stop
# or timeout kills the process and the dialog closes with it. Values arrive
# only in SHIKIGAMI_* environment variables, never inside this text.
# Exit 0 prints the answer; exit 3 means cancelled.
#
# Message and input dialogs are drawn with WPF in Studio's look: a white
# sheet with navy text (the logo's colours), dark when Windows apps are dark,
# nearly square corners, Japanese glyphs (Yu Gothic UI) and the button labels
# in the Windows display language. File and folder pickers are the Windows
# Explorer ones.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$mode = $env:SHIKIGAMI_MODE

# SHIKIGAMI_LANG and SHIKIGAMI_THEME override Windows' settings (tests).
$language = if ($env:SHIKIGAMI_LANG) { $env:SHIKIGAMI_LANG } else { [Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName }
$ja = $language -eq 'ja'
$words = if ($ja) {
    @{ ok = 'OK'; cancel = 'キャンセル'; yes = 'はい'; no = 'いいえ'; close = '閉じる' }
} else {
    @{ ok = 'OK'; cancel = 'Cancel'; yes = 'Yes'; no = 'No'; close = 'Close' }
}

if ($mode -eq 'file') {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Application]::EnableVisualStyles()
    # A topmost owner, so the picker is not hidden behind the application
    # being automated.
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
    if ($env:SHIKIGAMI_KIND -eq 'folder') {
        # The Explorer folder picker (FolderBrowserDialog is the old tree).
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ShikigamiFolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

    // The chosen folder, or null when cancelled.
    public static string Pick(IntPtr owner, string title, string folder) {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
        if (!string.IsNullOrEmpty(folder)) {
            try {
                IShellItem start;
                SHCreateItemFromParsingName(folder, IntPtr.Zero, typeof(IShellItem).GUID, out start);
                dialog.SetFolder(start);
            } catch (Exception) {
                // A folder that is not there: open where Explorer would.
            }
        }
        int hr = dialog.Show(owner);
        if (hr == unchecked((int)0x800704C7)) return null; // ERROR_CANCELLED
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        IShellItem result;
        dialog.GetResult(out result);
        string path;
        result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
        return path;
    }
}
'@
        $path = [ShikigamiFolderPicker]::Pick($owner.Handle, $env:SHIKIGAMI_TITLE, $env:SHIKIGAMI_FOLDER)
        if ($null -eq $path) { exit 3 }
        Write-Output $path
        exit 0
    }
    if ($env:SHIKIGAMI_KIND -eq 'save') {
        $d = New-Object System.Windows.Forms.SaveFileDialog
    } else {
        $d = New-Object System.Windows.Forms.OpenFileDialog
        $d.Multiselect = ($env:SHIKIGAMI_KIND -eq 'files')
    }
    if ($env:SHIKIGAMI_TITLE) { $d.Title = $env:SHIKIGAMI_TITLE }
    if ($env:SHIKIGAMI_FOLDER) { $d.InitialDirectory = $env:SHIKIGAMI_FOLDER }
    if ($env:SHIKIGAMI_FILE) { $d.FileName = $env:SHIKIGAMI_FILE }
    if ($env:SHIKIGAMI_FILTER) { $d.Filter = $env:SHIKIGAMI_FILTER }
    if ($d.ShowDialog($owner) -ne 'OK') { exit 3 }
    $d.FileNames | ForEach-Object { Write-Output $_ }
    exit 0
}

# --- Message and input dialogs -------------------------------------------

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$dark = $env:SHIKIGAMI_THEME -eq 'dark'
if (-not $env:SHIKIGAMI_THEME) {
    try {
        $dark = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize').AppsUseLightTheme -eq 0
    } catch {
        # Older Windows: light.
    }
}

# Studio's colour tokens (apps/studio/src/index.css).
$colors = if ($dark) {
    @{
        SHEET = '#131E2C'; PAPER = '#0B1420'; INK = '#E4EBF3'; MUTED = '#92A3B8'
        LINE = '#2A3A50'; FIELD = '#3A4C64'; HOVER = '#1F2D40'
        PRIMARY = '#E4EBF3'; PRIMARYHOVER = '#A3D4F3'; ONPRIMARY = '#0B1420'
        FOCUS = '#4AA8E0'; SHADOW = '0.5'
        INFO = '#4AA8E0'; WARNING = '#F79A48'; ERROR = '#F06A3C'
    }
} else {
    @{
        SHEET = '#FFFFFF'; PAPER = '#F4F7FB'; INK = '#0F1B2A'; MUTED = '#64748B'
        LINE = '#E2E8F0'; FIELD = '#CBD5E1'; HOVER = '#F1F5F9'
        PRIMARY = '#0F1B2A'; PRIMARYHOVER = '#0F3A66'; ONPRIMARY = '#F4F7FB'
        FOCUS = '#0A6FA8'; SHADOW = '0.28'
        INFO = '#0A6FA8'; WARNING = '#F5872A'; ERROR = '#E8501F'
    }
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" SizeToContent="WidthAndHeight" Topmost="True"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="True"
        UseLayoutRounding="True" SnapsToDevicePixels="True">
  <!-- Fonts, colours and styles live on this root rather than the window,
       so the sheet looks the same when tests draw it without a window. -->
  <Grid x:Name="Root" FontFamily="Yu Gothic UI, Meiryo UI, Segoe UI" FontSize="14"
        TextElement.Foreground="@INK@" Language="ja-JP" TextOptions.TextFormattingMode="Display">
  <Grid.Resources>
    <Style x:Key="Ring">
      <Setter Property="Control.Template">
        <Setter.Value>
          <ControlTemplate>
            <Border Margin="-3" BorderBrush="@FOCUS@" BorderThickness="2" CornerRadius="4"/>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Button" TargetType="Button">
      <Setter Property="Foreground" Value="@INK@"/>
      <Setter Property="Background" Value="@SHEET@"/>
      <Setter Property="BorderBrush" Value="@FIELD@"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="MinWidth" Value="84"/>
      <Setter Property="Height" Value="32"/>
      <Setter Property="Padding" Value="16,0"/>
      <Setter Property="Margin" Value="8,0,0,0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FocusVisualStyle" Value="{StaticResource Ring}"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="3">
              <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="@HOVER@"/>
        </Trigger>
      </Style.Triggers>
    </Style>
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Button}">
      <Setter Property="Foreground" Value="@ONPRIMARY@"/>
      <Setter Property="Background" Value="@PRIMARY@"/>
      <Setter Property="BorderBrush" Value="@PRIMARY@"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="@PRIMARYHOVER@"/>
          <Setter Property="BorderBrush" Value="@PRIMARYHOVER@"/>
        </Trigger>
      </Style.Triggers>
    </Style>
    <Style x:Key="Quiet" TargetType="Button" BasedOn="{StaticResource Button}">
      <Setter Property="Foreground" Value="@MUTED@"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderBrush" Value="Transparent"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Foreground" Value="@INK@"/>
          <Setter Property="Background" Value="@HOVER@"/>
        </Trigger>
      </Style.Triggers>
    </Style>
    <Style x:Key="Close" TargetType="Button" BasedOn="{StaticResource Quiet}">
      <Setter Property="MinWidth" Value="0"/>
      <Setter Property="Width" Value="28"/>
      <Setter Property="Height" Value="28"/>
      <Setter Property="Padding" Value="0"/>
      <Setter Property="Margin" Value="0"/>
      <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="10"/>
      <Setter Property="Content" Value="&#xE8BB;"/>
      <Setter Property="IsTabStop" Value="False"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Foreground" Value="@INK@"/>
      <Setter Property="Background" Value="@SHEET@"/>
      <Setter Property="BorderBrush" Value="@FIELD@"/>
      <Setter Property="CaretBrush" Value="@INK@"/>
      <Setter Property="SelectionBrush" Value="@FOCUS@"/>
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="TextBox">
            <Border x:Name="Box" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="1" CornerRadius="3" Padding="8,0">
              <ScrollViewer x:Name="PART_ContentHost" VerticalAlignment="Center" Focusable="False"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsKeyboardFocused" Value="True">
                <Setter TargetName="Box" Property="BorderBrush" Value="@FOCUS@"/>
                <Setter TargetName="Box" Property="BorderThickness" Value="2"/>
                <Setter TargetName="Box" Property="Padding" Value="7,0"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Grid.Resources>

  <!-- The margin leaves room for the dialog's shadow (24dp in Studio). -->
  <Border Margin="28,20,28,36" Background="@SHEET@" BorderBrush="@LINE@" BorderThickness="1" CornerRadius="4">
    <Border.Effect>
      <DropShadowEffect Color="#0F1B2A" BlurRadius="36" ShadowDepth="12" Direction="270" Opacity="@SHADOW@"/>
    </Border.Effect>
    <Grid MinWidth="380">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <Grid Margin="16,10,10,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Image x:Name="Mark" Width="16" Height="16" VerticalAlignment="Center" RenderOptions.BitmapScalingMode="HighQuality"/>
        <TextBlock Grid.Column="1" Margin="8,0" VerticalAlignment="Center" FontSize="12" Foreground="@MUTED@" Text="Shikigami"/>
        <Button x:Name="CloseButton" Grid.Column="2" Style="{StaticResource Close}"/>
      </Grid>

      <Grid Grid.Row="1" Margin="24,10,24,22">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
        </Grid.ColumnDefinitions>
        <TextBlock x:Name="Glyph" Margin="0,1,14,0" VerticalAlignment="Top" FontSize="22"
                   FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" Visibility="Collapsed"/>
        <StackPanel Grid.Column="1" MaxWidth="460">
          <TextBlock x:Name="Heading" Margin="0,0,0,6" FontSize="16" FontWeight="SemiBold" TextWrapping="Wrap" Visibility="Collapsed"/>
          <ScrollViewer MaxHeight="360" VerticalScrollBarVisibility="Auto" Focusable="False">
            <TextBlock x:Name="Message" TextWrapping="Wrap" LineHeight="22"/>
          </ScrollViewer>
          <TextBox x:Name="Answer" Margin="0,14,0,0" Height="34" Visibility="Collapsed"/>
        </StackPanel>
      </Grid>

      <Border Grid.Row="2" Background="@PAPER@" BorderBrush="@LINE@" BorderThickness="0,1,0,0"
              CornerRadius="0,0,4,4" Padding="16,12">
        <StackPanel x:Name="Buttons" Orientation="Horizontal" HorizontalAlignment="Right"/>
      </Border>
    </Grid>
  </Border>
  </Grid>
</Window>
'@
foreach ($key in $colors.Keys) { $xaml = $xaml.Replace("@$key@", $colors[$key]) }
$window = [Windows.Markup.XamlReader]::Parse($xaml)

$title = $env:SHIKIGAMI_TITLE
$window.Title = if ($title) { "$title - Shikigami" } else { 'Shikigami' }
if ($title) {
    $window.FindName('Heading').Text = $title
    $window.FindName('Heading').Visibility = 'Visible'
}
$window.FindName('Message').Text = $env:SHIKIGAMI_MESSAGE

if ($env:SHIKIGAMI_MARK) {
    $mark = New-Object System.Windows.Media.Imaging.BitmapImage
    $mark.BeginInit()
    $mark.StreamSource = New-Object IO.MemoryStream(, [Convert]::FromBase64String($env:SHIKIGAMI_MARK))
    $mark.CacheOption = 'OnLoad'
    $mark.EndInit()
    $window.FindName('Mark').Source = $mark
    $window.Icon = $mark
}

# The buttons, left to right as in Studio: the quiet way out first, the
# answer that goes ahead last (filled, and pressed by Enter).
# Each: answer, style, Enter, Esc.
if ($mode -eq 'input') {
    $answer = $window.FindName('Answer')
    $answer.Text = $env:SHIKIGAMI_DEFAULT
    $answer.Visibility = 'Visible'
    $buttons = @(@('cancel', 'Quiet', $false, $true), @('ok', 'Primary', $true, $false))
    # The close button and Esc give this answer; $null: they are not offered.
    $dismiss = 'cancel'
} else {
    $glyphs = @{ info = [char]0xE946; warning = [char]0xE7BA; error = [char]0xEA39 }
    $level = if ($env:SHIKIGAMI_LEVEL) { $env:SHIKIGAMI_LEVEL } else { 'info' }
    $glyph = $window.FindName('Glyph')
    $glyph.Text = $glyphs[$level]
    $glyph.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($colors[$level.ToUpper()])
    $glyph.Visibility = 'Visible'
    switch ($env:SHIKIGAMI_BUTTONS) {
        'okCancel' {
            $buttons = @(@('cancel', 'Quiet', $false, $true), @('ok', 'Primary', $true, $false))
            $dismiss = 'cancel'
        }
        'yesNo' {
            # Like a Windows message box: an answer is required.
            $buttons = @(@('no', 'Button', $false, $false), @('yes', 'Primary', $true, $false))
            $dismiss = $null
        }
        'yesNoCancel' {
            $buttons = @(@('cancel', 'Quiet', $false, $true), @('no', 'Button', $false, $false), @('yes', 'Primary', $true, $false))
            $dismiss = 'cancel'
        }
        default {
            # The comma keeps the one button a list of one tuple.
            $buttons = @(, @('ok', 'Primary', $true, $true))
            $dismiss = 'ok'
        }
    }
}

$panel = $window.FindName('Buttons')
$choose = { param($sender, $e) $window.Tag = $sender.Tag; $window.Close() }
foreach ($b in $buttons) {
    $button = New-Object System.Windows.Controls.Button
    $button.Tag = $b[0]
    $button.Content = $words[$b[0]]
    $button.Style = $window.FindName('Root').FindResource($b[1])
    $button.IsDefault = $b[2]
    $button.IsCancel = $b[3]
    $button.Add_Click($choose)
    [void]$panel.Children.Add($button)
}

$close = $window.FindName('CloseButton')
$close.ToolTip = $words.close
if ($null -eq $dismiss) {
    $close.Visibility = 'Hidden'
} else {
    $close.Tag = $dismiss
    $close.Add_Click($choose)
}

$window.Add_Closing({
    param($sender, $e)
    if ($null -ne $window.Tag) { return }
    if ($null -eq $dismiss) { $e.Cancel = $true } else { $window.Tag = $dismiss }
})
# Dragged anywhere that is not a button or the text box.
$window.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch { } })
# Ctrl+C copies the message, as in a Windows message box.
$window.Add_KeyDown({
    param($sender, $e)
    if ($e.Key -eq 'C' -and [System.Windows.Input.Keyboard]::Modifiers -eq 'Control' -and $mode -ne 'input') {
        [System.Windows.Clipboard]::SetText($env:SHIKIGAMI_MESSAGE)
    }
})
$window.Add_ContentRendered({
    $window.Activate() | Out-Null
    if ($mode -eq 'input') {
        $answer.Focus() | Out-Null
        $answer.SelectAll()
    }
})

if ($env:SHIKIGAMI_SNAPSHOT) {
    # Tests: draw the dialog into a PNG instead of showing it, and answer as
    # if the person pressed Enter.
    $sheet = $window.Content
    $window.Content = $null
    $sheet.Measure([System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
    $size = $sheet.DesiredSize
    $sheet.Arrange([System.Windows.Rect]::new($size))
    $sheet.UpdateLayout()
    $scale = 2
    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
        [int][Math]::Ceiling($size.Width * $scale), [int][Math]::Ceiling($size.Height * $scale), 96 * $scale, 96 * $scale,
        [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($sheet)
    $png = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $png.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $file = [IO.File]::Create($env:SHIKIGAMI_SNAPSHOT)
    try { $png.Save($file) } finally { $file.Dispose() }
    $window.Tag = ($panel.Children | Where-Object IsDefault | Select-Object -First 1).Tag
} else {
    [void]$window.ShowDialog()
}
$result = $window.Tag
if ($mode -eq 'input') {
    if ($result -ne 'ok') { exit 3 }
    Write-Output $answer.Text
} else {
    Write-Output $result
}
exit 0
