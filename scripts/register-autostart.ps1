param(
    [ValidateSet('Inspect', 'Install', 'Start', 'Stop')][string]$Mode = 'Inspect',
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [string]$TaskName = 'OmniRoute Session Sync'
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($LauncherPath) -or $LauncherPath -match '["\r\n]') { throw 'Invalid startup launcher path.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$marker = 'Managed by OmniRoute Session Sync. Starts local OmniRoute and preserves browser pairing at Windows sign-in.'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = $marker
$definition.Principal.UserId = $userSid
$definition.Principal.LogonType = 3 # Existing interactive login; no stored password.
$definition.Principal.RunLevel = 0
$definition.Settings.Enabled = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.RunOnlyIfIdle = $false
$definition.Settings.RunOnlyIfNetworkAvailable = $false
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.RestartInterval = 'PT1M'
$definition.Settings.RestartCount = 999
$definition.Settings.MultipleInstances = 2 # Ignore a second launch while running.
$definition.Settings.AllowDemandStart = $true
$trigger = $definition.Triggers.Create(9) # Logon, for this Windows user only.
$trigger.UserId = $userSid
$trigger.Delay = 'PT20S'
$action = $definition.Actions.Create(0)
$action.Path = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action.Arguments = '//B //Nologo "' + $LauncherPath + '"'
$action.WorkingDirectory = Split-Path -Parent $LauncherPath

function Resolve-UserSid([string]$Value) {
    if ($Value -match '^S-1-') { return $Value }
    return ([Security.Principal.NTAccount]$Value).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Test-TaskMatches($Task) {
    if ($null -eq $Task) { return $false }
    $current = $Task.Definition
    if ($current.Actions.Count -ne 1 -or $current.Triggers.Count -ne 1) { return $false }
    $currentAction = $current.Actions.Item(1)
    $currentTrigger = $current.Triggers.Item(1)
    return ($Task.Enabled -and $currentAction.Path -eq $action.Path -and $currentAction.Arguments -eq $action.Arguments `
        -and $currentAction.WorkingDirectory -eq $action.WorkingDirectory `
        -and $current.Principal.LogonType -eq 3 -and $current.Principal.RunLevel -eq 0 `
        -and (Resolve-UserSid $current.Principal.UserId) -eq $userSid `
        -and $currentTrigger.Type -eq 9 -and $currentTrigger.Enabled -and $currentTrigger.Delay -eq 'PT20S' `
        -and (Resolve-UserSid $currentTrigger.UserId) -eq $userSid `
        -and $current.Settings.StartWhenAvailable -and -not $current.Settings.DisallowStartIfOnBatteries `
        -and -not $current.Settings.StopIfGoingOnBatteries -and -not $current.Settings.RunOnlyIfIdle `
        -and -not $current.Settings.RunOnlyIfNetworkAvailable -and $current.Settings.ExecutionTimeLimit -eq 'PT0S' `
        -and $current.Settings.RestartInterval -eq 'PT1M' -and $current.Settings.RestartCount -eq 999 `
        -and $current.Settings.MultipleInstances -eq 2 -and $current.Settings.AllowDemandStart)
}
$task = $null
try { $task = $folder.GetTask($TaskName) } catch {
    if ($_.Exception.HResult -ne -2147024894) { throw } # File not found is the only expected absence.
}
$owned = $null -eq $task -or $task.Definition.RegistrationInfo.Description -eq $marker
$matches = $owned -and (Test-TaskMatches $task)
$changed = $false
if ($Mode -ne 'Inspect' -and -not $owned) { throw 'An unrelated task already uses this name; it has not been changed.' }
if ($Mode -eq 'Install' -and -not $matches) {
    $task = $folder.RegisterTaskDefinition($TaskName, $definition, 6, $userSid, $null, 3, $null)
    $changed = $true
    $matches = Test-TaskMatches $task
    if (-not $matches) { throw 'Windows did not retain the requested startup settings.' }
}
if ($Mode -eq 'Start') {
    if (-not $matches) { throw 'Run embedded setup before starting the Windows task.' }
    if ($task.State -ne 4) { $null = $task.Run($null) }
}
if ($Mode -eq 'Stop' -and $null -ne $task) { $task.Stop(0) }
[pscustomobject]@{
    success = $true; taskName = $TaskName; exists = $null -ne $task; owned = $owned
    matches = $matches; changed = $changed; enabled = if ($task) { $task.Enabled } else { $false }
    state = if ($task) { $task.State } else { $null }
    lastResult = if ($task) { $task.LastTaskResult } else { $null }
    lastRunTime = if ($task) { $task.LastRunTime.ToString('o') } else { $null }
} | ConvertTo-Json -Compress
