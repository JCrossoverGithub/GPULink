// WSL NAT deployment adapter. No user-provided script or shell interpolation.
import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';
const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const encoded = text => Buffer.from(text,'utf16le').toString('base64');
export function privateIp(ip) {
  if (!isIPv4(ip)) return false;
  const [a,b] = ip.split('.').map(Number);
  return a===10 || (a===172 && b>=16 && b<=31) || (a===192 && b===168);
}
export function sameSubnet(a,b,prefix) {
  if (!isIPv4(a)||!isIPv4(b)||!Number.isInteger(prefix)||prefix<1||prefix>32) return false;
  const n = ip => ip.split('.').reduce((v,x)=>(v*256+Number(x))>>>0,0);
  const mask=(0xffffffff << (32-prefix))>>>0;
  return (n(a)&mask)===(n(b)&mask);
}
function invoke(script,timeout=15000) {
  return execFileSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',encoded(`$ErrorActionPreference='Stop'; ${script}`)],{encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']}).trim();
}
export function discoverLan(peer) {
  if (!privateIp(peer)) throw new Error('Supply a private IPv4 peer address.');
  if (execFileSync('wslinfo',['--networking-mode'],{encoding:'utf8',timeout:5000}).trim()!=='nat') throw new Error('Managed setup supports WSL2 NAT only; use manual server setup otherwise.');
  const raw=invoke(`$out=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.AddressState -eq 'Preferred'} | ForEach-Object { $a=$_; $p=Get-NetConnectionProfile -InterfaceIndex $a.InterfaceIndex -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{ip=$a.IPAddress;prefix=$a.PrefixLength;index=$a.InterfaceIndex;profile=[string]$p.NetworkCategory}} }); ConvertTo-Json -InputObject $out -Compress`);
  const candidates=JSON.parse(raw).filter(x=>privateIp(x.ip)&&x.ip!==peer&&sameSubnet(x.ip,peer,x.prefix)&&['Public','Private'].includes(x.profile)&&Number.isSafeInteger(x.index));
  if(candidates.length!==1) throw new Error('No unique Windows LAN interface for that peer; verify both hosts share the LAN.');
  const routes=JSON.parse(execFileSync('ip',['-j','-4','addr','show','dev','eth0'],{encoding:'utf8',timeout:5000}));
  const ips=routes.flatMap(x=>x.addr_info??[]).filter(x=>x.scope==='global'&&privateIp(x.local));
  if(ips.length!==1) throw new Error('No unique WSL NAT IPv4 address.');
  return {listen:candidates[0].ip,peer,wsl:ips[0].local,index:candidates[0].index,profile:candidates[0].profile};
}
export function chooseLanPort(used,requested=null) {
  const available=p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&p!==8088&&!used.has(p);
  if(requested!==null){if(!available(requested))throw new Error('Requested HTTPS port is invalid or occupied.');return requested;}
  for(let p=8443;p<=8499;p++)if(available(p))return p;
  throw new Error('No free port in 8443–8499; specify --port.');
}
export function discoverLanPort(requested=null) {
  const windows=JSON.parse(invoke(`$ports=@(Get-NetTCPConnection -State Listen | ForEach-Object {[int]$_.LocalPort}); $reg='HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PortProxy\\v4tov4\\tcp'; if(Test-Path $reg){$ports+=@((Get-Item $reg).GetValueNames() | ForEach-Object {if($_ -match '/([0-9]+)$'){[int]$Matches[1]}})}; ConvertTo-Json -InputObject $ports -Compress`));
  const linux=execFileSync('ss',['-H','-ltn'],{encoding:'utf8',timeout:5000}).split('\n').filter(Boolean).map(line=>Number(line.trim().split(/\s+/)[3]?.split(':').at(-1)));
  return chooseLanPort(new Set([...windows,...linux]),requested);
}
export function validateNetwork(n) {
  if (!n || ![n.listen,n.peer,n.wsl].every(privateIp)||new Set([n.listen,n.peer,n.wsl]).size!==3 || !Number.isSafeInteger(n.index)||n.index<1||!['Public','Private'].includes(n.profile)||!Number.isSafeInteger(n.port)||n.port<1024||n.port>65535||n.port===8088||!/^GPULink-LAN-[a-f0-9]{32}$/.test(n.rule)) throw new Error('Invalid managed network plan.');
  return n;
}
// The elevated program is fully generated from validated scalar data. The
// unique firewall rule is an ownership marker; never adopt an existing proxy.
export function networkScript(n,action) {
  validateNetwork(n);
  if(!['apply','remove'].includes(action)) throw new Error('Unknown network operation.');
  const common=`$ErrorActionPreference='Stop'
$rule='${n.rule}'; $ip='${n.listen}'; $peer='${n.peer}'; $wsl='${n.wsl}'; $port=${n.port}; $idx=${n.index}; $netProfile='${n.profile}'
$reg='HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PortProxy\\v4tov4\\tcp'; $key="$ip/$port"; $target="$wsl/$port"
function ProxyTarget { if(Test-Path $reg){ (Get-ItemProperty -Path $reg -Name $key -ErrorAction SilentlyContinue).$key } }
function Rule { Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue }
function DeleteProxy { & (Join-Path $env:SystemRoot 'System32\\netsh.exe') interface portproxy delete v4tov4 listenaddress=$ip listenport=$port | Out-Null; if($LASTEXITCODE -ne 0 -or (ProxyTarget)){throw 'Portproxy removal failed'} }
`;
  const apply=`if(Rule){throw 'Existing firewall rule; refusing adoption'}
if(ProxyTarget){throw 'Existing forwarding entry; refusing adoption'}
if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){throw 'Windows port already listening'}
$a=Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ip -ErrorAction Stop
$p=Get-NetConnectionProfile -InterfaceIndex $idx
if($a.InterfaceIndex -ne $idx -or [string]$p.NetworkCategory -ne $netProfile){throw 'LAN changed; rerun setup'}
$adapter=Get-NetAdapter -InterfaceIndex $idx
New-NetFirewallRule -Name $rule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalAddress $ip -LocalPort $port -RemoteAddress $peer -InterfaceAlias $adapter.Name -Profile $netProfile -Action Allow | Out-Null
try { & (Join-Path $env:SystemRoot 'System32\\netsh.exe') interface portproxy add v4tov4 listenaddress=$ip listenport=$port connectaddress=$wsl connectport=$port | Out-Null; if($LASTEXITCODE -ne 0 -or (ProxyTarget) -ne $target){throw 'Forwarding creation failed'} }
catch { if((ProxyTarget) -eq $target){DeleteProxy}; Remove-NetFirewallRule -Name $rule; throw }
`;
  const remove=`$r=Rule; $t=ProxyTarget
if(!$r){if($t){throw 'Forwarding exists without ownership rule; inspect manually'}; exit 0}
if($t -and $t -ne $target){throw 'Forwarding target changed; refusing removal'}
$af=$r | Get-NetFirewallAddressFilter; $pf=$r | Get-NetFirewallPortFilter
if($r.Direction -ne 'Inbound' -or $r.Action -ne 'Allow' -or [string]$af.LocalAddress -notin @($ip,"$ip/32") -or [string]$af.RemoteAddress -notin @($peer,"$peer/32") -or [string]$pf.LocalPort -ne [string]$port -or [string]$pf.Protocol -notin @('TCP','6')){throw 'Firewall rule changed; refusing removal'}
if($t){DeleteProxy}
Remove-NetFirewallRule -Name $rule
`;
  return common+(action==='apply'?apply:remove);
}
export function changeNetwork(n,action) {
  const inner=encoded(`try { ${networkScript(n,action)}; exit 0 } catch { Write-Error $_ -ErrorAction Continue; exit 1 }`);
  // Only this specific inline program runs elevated; no writable script paths.
  try { invoke(`$p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}' -Wait -PassThru; if($p.ExitCode -ne 0){throw 'Elevated networking operation failed'}`,180000); } catch { throw new Error(`Windows elevated ${action} did not complete successfully; inspect the firewall/forwarding journal and UAC result.`); }
}
