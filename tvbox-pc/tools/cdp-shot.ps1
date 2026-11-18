param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Out
)
$targets = Invoke-RestMethod ("http://127.0.0.1:{0}/json" -f $Port) -TimeoutSec 10
$page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
$ws = $page.webSocketDebuggerUrl
$c = New-Object System.Net.WebSockets.ClientWebSocket
$c.ConnectAsync([System.Uri]$ws, [System.Threading.CancellationToken]::None).Wait(8000)
$cmd = @{ id = 1; method = 'Page.captureScreenshot'; params = @{ format = 'png' } } | ConvertTo-Json -Depth 4 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($cmd)
$c.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
Start-Sleep -Milliseconds 800
$buf = New-Object byte[] 8000000
$res = $c.ReceiveAsync([System.ArraySegment[byte]]::new($buf), [System.Threading.CancellationToken]::None).Result
$txt = [Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
$c.Dispose()
$obj = $txt | ConvertFrom-Json
[IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($obj.result.data))
"saved $Out $((Get-Item $Out).Length) bytes"
