<#
.SYNOPSIS
  Schedules office-headcount.ps1 -Push: every 30 min 7:00-10:00 (morning peak) and 15:00-16:30 (who's left when
  you go; the TV winds down from there to 6 pm), and 1 min after you log on.
  It runs hidden; off a GoMaterials Wi-Fi it exits without scanning. Re-run this to update the task,
  or pass -Remove to delete it.
#>
param([switch]$Remove)

$name = 'GM Office headcount'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "Removed '$name'."; return }

$script = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'office-headcount.ps1'
# conhost --headless: no console window flashing up
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Push -Log"

$morning = New-ScheduledTaskTrigger -Daily -At '7:00'
$morning.Repetition = (New-ScheduledTaskTrigger -Once -At '7:00' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 3 -Minutes 1)).Repetition
$afternoon = New-ScheduledTaskTrigger -Daily -At '15:00'
$afternoon.Repetition = (New-ScheduledTaskTrigger -Once -At '15:00' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 1 -Minutes 31)).Repetition
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logon.Delay = 'PT1M'   # give Wi-Fi a minute to connect

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $morning, $afternoon, $logon -Settings $settings `
    -Description 'Counts laptops on the office Wi-Fi and sends the estimate to the GM Office TV.' -Force | Out-Null
"Scheduled '$name': 7:00-10:00 and 15:00-16:30 every 30 min, and at logon."
