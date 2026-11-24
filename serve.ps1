# Tiny local web server for BafoonsTunes (no installs needed - uses what's built into Windows).
# Chrome/Edge only allow MIDI and loading the sound files from a real http:// address,
# so this serves the app folder at http://localhost:8642/ and opens the browser.
param(
  [int]$Port = 8642,
  [switch]$NoBrowser
)

$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path)).TrimEnd('\') + '\'
$url = "http://localhost:$Port/"

function Open-Browser {
  if ($NoBrowser) { return }
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($chrome) { Start-Process $chrome $url }
  else { Start-Process "msedge.exe" $url }   # Edge ships with Windows and supports MIDI too
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
  $listener.Start()
} catch {
  Write-Host "BafoonsTunes already seems to be running - opening it."
  Open-Browser
  exit
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'
  '.mp3' = 'audio/mpeg'; '.m4a' = 'audio/mp4'; '.flac' = 'audio/flac'; '.wav' = 'audio/wav'; '.ogg' = 'audio/ogg'
}

Write-Host ""
Write-Host "  BafoonsTunes is running at $url"
Write-Host "  Keep this window open while you make music. Close it when you're done."
Write-Host ""
Open-Browser

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch { break }
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($full)) {
      $res.StatusCode = 404
      $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $res.Headers['Cache-Control'] = 'no-cache'
      $bytes = [IO.File]::ReadAllBytes($full)
    }
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    # browser cancelled the request - ignore
  } finally {
    try { $res.Close() } catch { }
  }
}
