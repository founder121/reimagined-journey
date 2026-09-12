# CM2 Server Diagnostics — double-click to run
# Saves output to cm2-diagnose-output.txt on your Desktop

$key = "$env:USERPROFILE\.ssh\cm2_server"
$server = "root@204.168.190.158"
$output = "$env:USERPROFILE\Desktop\cm2-diagnose-output.txt"

$cmd = @"
pm2 status
echo '=== HQ LOGS ==='
pm2 logs hq-server --lines 20 --nostream
echo '=== HEALTH CHECK ==='
curl -s http://localhost:3002/health
echo '=== HTTP STATUS ==='
curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:3002/
echo '=== SYNTAX CHECK ==='
node --check /home/cm2/app/hq/server.js 2>&1 && echo SYNTAX_OK
echo '=== NGINX STATUS ==='
systemctl status nginx --no-pager | head -10
echo '=== NGINX SITES ==='
ls /etc/nginx/sites-enabled/
echo '=== CERTBOT CERTS ==='
certbot certificates 2>/dev/null | grep -E 'Domains|Expiry|Path'
"@

Write-Host "Connecting to CM2 server..." -ForegroundColor Cyan
$result = ssh -i $key -o StrictHostKeyChecking=accept-new $server $cmd
$result | Tee-Object -FilePath $output
Write-Host ""
Write-Host "Output saved to: $output" -ForegroundColor Green
Write-Host "Copy that file's contents and paste back to Claude." -ForegroundColor Yellow
Read-Host "Press Enter to close"
