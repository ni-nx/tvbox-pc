param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Expr,
  [string]$Selector = '.card'
)
$ErrorActionPreference = 'Stop'
$targets = Invoke-RestMethod ("http://127.0.0.1:{0}/json" -f $Port) -TimeoutSec 10
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' } | Select-Object -First 1
if (-not $page) { $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1 }
$ws = $page.webSocketDebuggerUrl
$c = New-Object System.Net.WebSockets.ClientWebSocket
$c.ConnectAsync([System.Uri]$ws, [System.Threading.CancellationToken]::None).Wait(8000)

$script:id = 0
function Send-Cdp($method, $params) {
  $script:id++
  $cmd = @{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($cmd)
  $c.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 262144
  $res = $c.ReceiveAsync([System.ArraySegment[byte]]::new($buf), [System.Threading.CancellationToken]::None).Result
  $txt = [Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
  return ($txt | ConvertFrom-Json)
}

# 1) document + query node first
$doc = Send-Cdp 'DOM.getDocument' @{ depth = 3 }
$root = $doc.result.root.nodeId
$q = Send-Cdp 'DOM.querySelector' @{ nodeId = $root; selector = $Selector }
$nodeId = $q.result.nodeId
if (-not $nodeId) { Write-Output "NO NODE for $Selector"; $c.Dispose(); exit }
# 2) add focus class via expression
if ($Expr) {
  [void](Send-Cdp 'Runtime.evaluate' @{ expression = $Expr; returnByValue = $true })
  Start-Sleep -Milliseconds 60
}
[void](Send-Cdp 'CSS.enable' @{})
$ms = Send-Cdp 'CSS.getMatchedStylesForNode' @{ nodeId = $nodeId }
$rules = $ms.result.matchedCSSRules
$out = @()
foreach ($mr in $rules) {
  $r = $mr.rule
  $props = @()
  foreach ($p in $r.style.cssProperties) {
    if ($p.name -in @('transform','border-top-width','border-width','border','outline-width','scale','translate')) {
      $props += ("{0}={1}({2})" -f $p.name, $p.value, $p.important)
    }
  }
  if ($props.Count -gt 0) {
    $out += [pscustomobject]@{ selector = $r.selectorList.text; props = ($props -join '; '); origin = $mr.origin }
  }
}
$out | Format-Table -AutoSize -Wrap | Out-String -Width 300
$c.Dispose()
