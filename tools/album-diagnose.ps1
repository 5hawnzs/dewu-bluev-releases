param(
  [string]$AdbPath,
  [ValidatePattern('^[A-Za-z0-9_.:-]*$')][string]$Serial,
  [string]$OutputPath = (Join-Path $PSScriptRoot 'album-diagnosis.json')
)
$ErrorActionPreference = 'Stop'
if (-not $AdbPath) {
  $candidates = @((Join-Path $PSScriptRoot '..\vendor\adb\adb.exe'))
  foreach ($application in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '得物蓝V|bluev' })) {
    if ($application.Path) { $candidates += Join-Path (Split-Path $application.Path) 'resources\adb\adb.exe' }
  }
  foreach ($folder in @('得物蓝V素材发布工具', 'dewu-bluev-publisher', 'bluev-publisher')) {
    $candidates += Join-Path $env:LOCALAPPDATA ('Programs\' + $folder + '\resources\adb\adb.exe')
  }
  $AdbPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $AdbPath) { $AdbPath = (Read-Host '未找到内置 ADB，请粘贴安装目录中 resources\adb\adb.exe 的完整路径').Trim('"') }
}
$adbFile = (Resolve-Path -LiteralPath $AdbPath).Path
Write-Output ('使用 ADB：' + $adbFile)
if (-not $Serial) {
  $inventoryStart = New-Object System.Diagnostics.ProcessStartInfo
  $inventoryStart.FileName = $adbFile
  $inventoryStart.Arguments = 'devices'
  $inventoryStart.UseShellExecute = $false
  $inventoryStart.CreateNoWindow = $true
  $inventoryStart.RedirectStandardOutput = $true
  $inventoryStart.RedirectStandardError = $true
  $inventory = New-Object System.Diagnostics.Process
  $inventory.StartInfo = $inventoryStart
  try {
    [void]$inventory.Start()
    $inventoryOut = $inventory.StandardOutput.ReadToEndAsync()
    $inventoryErr = $inventory.StandardError.ReadToEndAsync()
    if (-not $inventory.WaitForExit(8000)) {
      $inventory.Kill(); $inventory.WaitForExit()
      throw 'ADB 设备列表八秒内无响应；请把这条错误发回开发。'
    }
    $listing = $inventoryOut.GetAwaiter().GetResult()
    $listingError = $inventoryErr.GetAwaiter().GetResult()
    if ($inventory.ExitCode -ne 0) { throw ('ADB 设备列表失败：' + $listingError) }
    $devices = @($listing -split '\r?\n' | ForEach-Object {
      if ($_ -match '^([A-Za-z0-9_.:-]+)\s+device\s*$') { $matches[1] }
    })
  } finally { $inventory.Dispose() }
  if ($devices.Count -eq 0) { throw ('没有在线设备，请保持故障模拟器运行。原始列表：' + $listing) }
  if ($devices.Count -eq 1) { $Serial = $devices[0] }
  else {
    for ($index = 0; $index -lt $devices.Count; $index++) { Write-Output ($index.ToString() + '：' + $devices[$index]) }
    $choice = Read-Host '请输入故障设备左侧的编号'
    if ($choice -notmatch '^\d+$' -or [int]$choice -ge $devices.Count) { throw '设备编号无效，未执行诊断。' }
    $Serial = $devices[[int]$choice]
  }
}
Write-Output ('诊断设备：' + $Serial)
$checks = @(
  @{ Name = '设备响应'; Command = 'echo BLUEV_DIAG_OK' },
  @{ Name = '设备型号'; Command = 'getprop ro.product.model' },
  @{ Name = '目录状态'; Command = 'ls -ld /sdcard/DCIM/Camera /storage/emulated/0/DCIM/Camera' },
  @{ Name = '目录读取'; Command = 'ls -A /storage/emulated/0/DCIM/Camera' },
  @{ Name = '文件递归读取'; Command = 'find /storage/emulated/0/DCIM/Camera -type f' }
)
foreach ($table in @('images', 'video', 'audio', 'files')) {
  $checks += @{ Name = "媒体表 $table"; Command = "content query --uri content://media/external/$table/media --projection _id:_data" }
}
$results = @()
foreach ($check in $checks) {
  # 所有设备指令均为只读；每项最多等待八秒，不删除文件、不强停 App、不重启 ADB。
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $adbFile
  $start.Arguments = '-s ' + $Serial + ' shell "' + $check.Command + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit(8000)
    if (-not $completed) { $process.Kill(); $process.WaitForExit() }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $results += [pscustomobject]@{
      name = $check.Name; command = $check.Command; elapsedMs = $timer.ElapsedMilliseconds
      timedOut = -not $completed; exitCode = $process.ExitCode
      stdout = $stdout.Substring(0, [Math]::Min(2000, $stdout.Length))
      stderr = $stderr.Substring(0, [Math]::Min(2000, $stderr.Length))
    }
    Write-Output ($check.Name + '：' + $timer.ElapsedMilliseconds + 'ms，超时=' + (-not $completed) + '，退出码=' + $process.ExitCode)
  } finally { $process.Dispose() }
}
[pscustomobject]@{ capturedAt = [DateTimeOffset]::Now.ToString('o'); serial = $Serial; checks = $results } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output ('诊断结果：' + [System.IO.Path]::GetFullPath($OutputPath))
