<#
.SYNOPSIS
  Rough estimate of how many people are in the office, by counting laptops on your local subnet.

.DESCRIPTION
  1. Finds your physical Wi-Fi/Ethernet adapter (skips VPN/virtual adapters).
  2. Pings every address on that subnet (throttled) so Windows fills its ARP table.
     Firewalled laptops ignore ping but still answer ARP, so they show up.
  3. Looks up each MAC's manufacturer in Wireshark's public OUI list (cached in manuf.txt,
     refreshed at most weekly as Wireshark asks) and sorts devices into:
       Laptop  - PC Wi-Fi/NIC makers (Intel, Liteon, Realtek, MediaTek, Qualcomm, Dell, Lenovo, HP...)
       Apple   - a Mac, or an iPhone/iPad with private address turned off
       Private - randomized MAC: almost always a phone (some Macs too)
       Other   - smart-home, printers, TVs, cameras, network gear
  4. People ~= Laptops + Apple (+ you). Phones and everything else are ignored.

  Only sees the subnet you're on. Other SSIDs on separate VLANs, or Wi-Fi with client
  isolation, are invisible. People on VPN are still counted (their laptop is still on the LAN).
  An always-on desktop PC looks like a laptop; use -SaveBaseline to drop those.

  Only runs on a GoMaterials Wi-Fi (SSID matching ssidPattern in headcount-config.json, default "gomaterials");
  anywhere else, home included, it exits without scanning. -AnySsid scans anyway (for testing) but never pushes.
  -Push sends the estimate to the GM Office relay, and the office TV uses it as today's headcount.
  install-headcount-task.ps1 schedules it (7:00-10:00 and 15:00-16:30 every 30 min, and at logon). Posts from
  2 pm on are afternoon counts: the TV keeps the lowest and winds the office down from there to 6 pm.

.EXAMPLE
  .\office-headcount.ps1                 # scan and estimate
  .\office-headcount.ps1 -ShowDevices    # list every device and how it was classified
  .\office-headcount.ps1 -SaveBaseline   # run when the office is empty: remember always-on devices
  .\office-headcount.ps1 -Log            # also append the result to headcount-log.csv
  .\office-headcount.ps1 -Push           # send the estimate to the office TV (what the scheduled task runs)
#>
param(
    [switch]$SaveBaseline,
    [switch]$ShowDevices,
    [switch]$Log,
    [switch]$Push,
    [switch]$AnySsid,
    [int]$TimeoutMs = 400,
    [int]$BatchSize = 64,
    [int]$MaxHosts = 1024
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$baselineFile = Join-Path $here 'headcount-baseline.json'
$logFile = Join-Path $here 'headcount-log.csv'
$manufFile = Join-Path $here 'manuf.txt'
$configFile = Join-Path $here 'headcount-config.json'   # { relay, token, ssidPattern }; never committed
$config = if (Test-Path $configFile) { Get-Content $configFile -Raw | ConvertFrom-Json } else { $null }
$ssidPattern = if ($config -and $config.ssidPattern) { $config.ssidPattern } else { 'gomaterials' }
$laptopVendors = 'Intel|Liteon|AzureWave|Realtek|MediaTek|Qualcomm|Atheros|Rivet Networks|Killer|Dell|Lenovo|Hewlett|HP Inc|Microsoft|Hon Hai|Foxconn|Cloud Network Technology|Compal|Quanta|Wistron|Pegatron|ASUSTek|Acer|Framework|Universal Global Scientific'
$infraNames = 'printer|print|brother|epson|canon|xerox|ricoh|kyocera|tv|roku|chromecast|sonos|camera|nvr|nas|synology|switch|^ap-|unifi|meraki|router|gateway'

function ConvertTo-Num([string]$ip) {
    $b = ([System.Net.IPAddress]::Parse($ip)).GetAddressBytes()
    [Array]::Reverse($b)
    [int64][BitConverter]::ToUInt32($b, 0)
}
function ConvertTo-Ip([int64]$n) {
    $b = [BitConverter]::GetBytes([uint32]$n)
    [Array]::Reverse($b)
    (New-Object System.Net.IPAddress (, $b)).ToString()
}

# --- Office Wi-Fi only ---------------------------------------------------------
$ssid = $null
try { $ssid = ((netsh wlan show interfaces) -match '^\s*SSID\s*:' | Select-Object -First 1) -replace '^\s*SSID\s*:\s*', '' } catch {}
$atOffice = [bool]($ssid -and $ssid -match $ssidPattern)
if (-not $atOffice -and -not $AnySsid) {
    Write-Host "Not on a GoMaterials Wi-Fi (SSID '$ssid'); not scanning."
    return
}

# --- Vendor list (Wireshark manuf, refreshed weekly at most) -----------------
$stale = -not (Test-Path $manufFile) -or ((Get-Date) - (Get-Item $manufFile).LastWriteTime).TotalDays -gt 7
if ($stale) {
    try { Invoke-WebRequest -UseBasicParsing 'https://www.wireshark.org/download/automated/data/manuf' -OutFile $manufFile }
    catch { Write-Warning "Couldn't refresh vendor list: $($_.Exception.Message)" }
}
$vendors = @{}   # key: hex prefix (6, 7 or 9 chars for /24, /28, /36 blocks)
if (Test-Path $manufFile) {
    foreach ($line in [System.IO.File]::ReadLines($manufFile)) {
        if ($line -match '^([0-9A-F:]+)(?:/(\d+))?\s+\S+\s+(.+)$') {
            $bits = if ($Matches[2]) { [int]$Matches[2] } else { 24 }
            $vendors[($Matches[1] -replace ':', '').Substring(0, $bits / 4)] = $Matches[3].Trim()
        }
    }
} else { Write-Warning 'No vendor list; every device will show as Other.' }
function Get-Vendor([string]$mac) {
    $hex = $mac -replace '-', ''
    foreach ($len in 9, 7, 6) { if ($vendors.ContainsKey($hex.Substring(0, $len))) { return $vendors[$hex.Substring(0, $len)] } }
    ''
}

# --- 1. Pick the physical adapter --------------------------------------------
$cfg = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and
                   $_.NetAdapter.InterfaceDescription -notmatch 'VPN|TAP|TUN|WireGuard|Virtual|Hyper-V|VMware|VirtualBox|Tailscale|ZeroTier|Cisco AnyConnect|Fortinet|GlobalProtect|Zscaler' } |
    Sort-Object { if ($_.InterfaceAlias -match 'Wi-?Fi|Wireless') { 0 } else { 1 } } |
    Select-Object -First 1
if (-not $cfg) { throw 'No active physical network adapter with a gateway found.' }

$myIp    = $cfg.IPv4Address[0].IPAddress
$prefix  = $cfg.IPv4Address[0].PrefixLength
$gateway = $cfg.IPv4DefaultGateway[0].NextHop
$ifIndex = $cfg.InterfaceIndex

$size = [int64][math]::Pow(2, 32 - $prefix)
if ($size -gt $MaxHosts) {
    Write-Warning "Subnet /$prefix is large; scanning only the /24 around $myIp."
    $prefix = 24; $size = 256
}
$network = [int64]([math]::Floor((ConvertTo-Num $myIp) / $size) * $size)
$targets = for ($n = $network + 1; $n -lt $network + $size - 1; $n++) { ConvertTo-Ip $n }

Write-Host ("Adapter : {0} ({1})" -f $cfg.InterfaceAlias, $cfg.NetAdapter.InterfaceDescription)
if ($ssid) { Write-Host "SSID    : $ssid" }
Write-Host ("Subnet  : {0}/{1}  ({2} addresses)  me {3}, gw {4}" -f (ConvertTo-Ip $network), $prefix, $targets.Count, $myIp, $gateway)

# --- 2. Throttled ping sweep (fills the ARP table) ---------------------------
for ($i = 0; $i -lt $targets.Count; $i += $BatchSize) {
    $batch = $targets[$i..([math]::Min($i + $BatchSize, $targets.Count) - 1)]
    $tasks = foreach ($ip in $batch) { (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($ip, $TimeoutMs) }
    try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks) } catch {}
    Write-Progress -Activity 'Sweeping subnet' -PercentComplete ([math]::Min(100, 100 * ($i + $BatchSize) / $targets.Count))
    Start-Sleep -Milliseconds 100
}
Write-Progress -Activity 'Sweeping subnet' -Completed
Start-Sleep -Seconds 2   # let ARP replies land

# --- 3. Read the neighbour (ARP) table ---------------------------------------
$lo = $network; $hi = $network + $size
$neighbors = Get-NetNeighbor -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.State -in 'Reachable', 'Stale', 'Delay', 'Probe' -and
        $_.LinkLayerAddress -and $_.LinkLayerAddress -notmatch '^(00-){5}00$|^(FF-){5}FF$|^01-00-5E' -and
        $_.IPAddress -ne $gateway -and $_.IPAddress -ne $myIp -and
        (ConvertTo-Num $_.IPAddress) -ge $lo -and (ConvertTo-Num $_.IPAddress) -lt $hi
    }

# Reverse-DNS names in parallel, 1.5 s cap (offices often register laptop names in DNS)
$dns = @{}
foreach ($n in $neighbors) { $dns[$n.IPAddress] = [System.Net.Dns]::GetHostEntryAsync($n.IPAddress) }
if ($dns.Count) { try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($dns.Values), 1500) } catch {} }

$devices = @($neighbors | Group-Object LinkLayerAddress | ForEach-Object {
    $n = $_.Group[0]
    $t = $dns[$n.IPAddress]
    $mac = $n.LinkLayerAddress.ToUpper()
    $private = ('26AE' -match $mac[1])   # locally-administered bit = randomized MAC
    $vendor = if ($private) { '(randomized)' } else { Get-Vendor $mac }
    $type = if ($private) { 'Private' }
            elseif ($vendor -match 'Apple') { 'Apple' }
            elseif ($vendor -match $laptopVendors) { 'Laptop' }
            else { 'Other' }
    [pscustomobject]@{
        IP     = $n.IPAddress
        MAC    = $mac
        Vendor = $vendor
        Name   = if ($t.Status -eq 'RanToCompletion') { $t.Result.HostName } else { '' }
        Type   = $type
    }
})

if ($SaveBaseline) {
    $devices | Select-Object MAC, IP, Vendor, Name | ConvertTo-Json | Set-Content -Encoding UTF8 $baselineFile
    Write-Host "Saved $($devices.Count) devices as baseline (always-on) -> $baselineFile"
    return
}

# --- 4. Drop always-on devices and estimate ----------------------------------
$baseline = @{}
if (Test-Path $baselineFile) { (Get-Content $baselineFile -Raw | ConvertFrom-Json) | ForEach-Object { $baseline[$_.MAC] = $true } }
foreach ($d in $devices) {
    if ($baseline[$d.MAC]) { $d.Type = 'Baseline' }
    elseif ($d.Name -and $d.Name -match $infraNames) { $d.Type = 'Other' }
}

if ($ShowDevices) {
    $order = @{ Laptop = 0; Apple = 1; Private = 2; Other = 3; Baseline = 4 }
    $devices | Sort-Object { $order[$_.Type] }, { ConvertTo-Num $_.IP } | Format-Table Type, IP, MAC, Vendor, Name -AutoSize
}

$laptops = @($devices | Where-Object Type -eq 'Laptop').Count + 1   # +1 for this laptop
$apple   = @($devices | Where-Object Type -eq 'Apple').Count
$phones  = @($devices | Where-Object Type -eq 'Private').Count
$other   = @($devices | Where-Object { $_.Type -in 'Other', 'Baseline' }).Count
$est = $laptops + $apple

Write-Host ''
Write-Host ("Laptops (PC)     : {0}  (incl. you)" -f $laptops)
Write-Host ("Apple            : {0}  (Mac, or iPhone with private address off)" -f $apple)
Write-Host ("Ignored          : {0} phones/private MACs, {1} printers/TVs/IoT/always-on" -f $phones, $other) -ForegroundColor DarkGray
if ($apple) { Write-Host ("Estimated people : ~{0}  (range {1}-{0})" -f $est, $laptops) -ForegroundColor Green }
else        { Write-Host ("Estimated people : ~{0}" -f $est) -ForegroundColor Green }

if ($Log) {
    if (-not (Test-Path $logFile)) { 'Timestamp,SSID,Subnet,Laptops,Apple,Phones,Other,Estimate' | Set-Content -Encoding UTF8 $logFile }
    ('{0},{1},{2}/{3},{4},{5},{6},{7},{8}' -f (Get-Date -Format s), $ssid, (ConvertTo-Ip $network), $prefix, $laptops, $apple, $phones, $other, $est) | Add-Content -Encoding UTF8 $logFile
}

if ($Push) {
    if (-not $atOffice) { Write-Warning "Not pushing: SSID '$ssid' isn't a GoMaterials Wi-Fi." }
    elseif (-not ($config -and $config.relay -and $config.token)) { Write-Warning "Not pushing: no relay/token in $configFile." }
    else {
        try {
            $r = Invoke-RestMethod -Method Post -Uri $config.relay -ContentType 'application/json' -TimeoutSec 20 `
                -Headers @{ Authorization = "Bearer $($config.token)" } -Body (@{ n = $est } | ConvertTo-Json)
            Write-Host ("Pushed {0} to the office TV (today's peak {1})" -f $est, $r.n)
        } catch { Write-Warning "Push failed: $($_.Exception.Message)" }
    }
}
