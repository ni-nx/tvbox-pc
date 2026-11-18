param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Expr
)
$targets = Invoke-RestMethod ("http://127.0.0.1:{0}/json" -f $Port) -TimeoutSec 10
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' } | Select-Object -First 1
if (-not $page) { $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1 }
$ws = $page.webSocketDebuggerUrl
$c = New-Object System.Net.WebSockets.ClientWebSocket
$c.ConnectAsync([System.Uri]$ws, [System.Threading.CancellationToken]::None).Wait(8000)
$cmd = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expr; returnByValue = $true; awaitPromise = $true } } | ConvertTo-Json -Depth 6 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($cmd)
$c.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
Start-Sleep -Milliseconds 600
$buf = New-Object byte[] 131072
$res = $c.ReceiveAsync([System.ArraySegment[byte]]::new($buf), [System.Threading.CancellationToken]::None).Result
$txt = [Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
$obj = $txt | ConvertFrom-Json
$c.Dispose()
if ($obj.result.exceptions) { $obj.result.exceptions | ConvertTo-Json -Depth 4 }
$obj.result.result.value
