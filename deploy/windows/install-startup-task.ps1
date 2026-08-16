param(
    [Parameter(Mandatory = $false)]
    [string]$DistroName = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$taskName = "GPUlink WSL Worker"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-d $DistroName -u root --exec systemctl start gpulink-worker.service"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the GPUlink worker inside WSL after Windows sign-in." `
    -Force | Out-Null

Write-Host "Installed scheduled task '$taskName' for $currentUser."
Write-Host "The task will start the worker after the next sign-in."
